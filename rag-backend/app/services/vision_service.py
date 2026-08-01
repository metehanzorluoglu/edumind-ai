"""Vision-model support: validating/resizing images, rendering PDF pages
to images, and streaming a chat completion from a vision-capable Ollama
model (see app/core/model_routing.py for when this is used instead of the
text model).

Every image-decoding/resizing/rendering function here uses PyMuPDF alone
(already a dependency for document ingestion — see
app/ingestion/loaders/pdf_loader.py) — no Pillow or other imaging library
is required: `pymupdf.Pixmap` can decode a raster image directly from
bytes, produce a scaled copy, and re-encode it, and `pymupdf.open()`
accepts an in-memory PDF byte stream directly via `stream=`. Nothing here
needs an on-disk temporary file for that reason; `temporary_upload_file`
below exists for a future caller that receives a file it must hand to
something requiring a real path (mirroring
app/api/routes_documents.py's `_read_upload_to_tempfile`), with
guaranteed cleanup via a context manager.

VisionService.stream_chat uses `ollama.AsyncClient`, not the sync
`ollama.Client` app/core/llm_provider.py's text pipeline uses — a
deliberate difference, not an inconsistency. A live performance
investigation on the Oracle CPU host (VM.Standard.A1.Flex, ARM64, 4
OCPUs) found vision prompt-evaluation taking 114-232+ seconds even fully
warm for a single modest image, which surfaced two problems the sync
client cannot solve: (1) a single httpx timeout value applies uniformly
to every read, so "waiting for the first token" (which must tolerate a
slow cold model load *and* slow image evaluation) and "waiting for the
next token once generation has actually started" (which should be
detected as stalled much sooner) cannot have different budgets; and (2) a
sync generator iterated via Starlette's `iterate_in_threadpool` runs in a
background thread that cannot be cancelled mid-`next()` — a client
disconnect during that 114-232+ second wait does not stop the wasted
Ollama compute on this already CPU-constrained host. `AsyncClient` +
`asyncio.wait_for()` solves both: see stream_chat below.
"""

import asyncio
import contextlib
import tempfile
import time
from collections.abc import AsyncIterator, Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, Protocol

import ollama
import pymupdf

from app.core.errors import VisionErrorCategory, VisionServiceError
from app.core.ollama_errors import classify_ollama_error, classify_vision_error_category
from app.core.request_timing import RequestTimer, get_current_timer

# Matches common multimodal-model guidance for the largest side of an
# input image before returns diminish — resizing beyond this just costs
# more tokens/latency without adding usable detail for the model. Lowered
# from an original 1568 — see Settings.vision_max_image_dimension's
# docstring (app/config.py) for the live measurement behind this default;
# this module-level constant exists only as the fallback for a caller
# that doesn't pass one explicitly (e.g. a direct test).
DEFAULT_MAX_IMAGE_DIMENSION = 1024

# 120 DPI keeps body text legible while rendering measurably fewer pixels
# than the original 150 — a US Letter page (612x792pt) at 150 DPI already
# exceeds DEFAULT_MAX_IMAGE_DIMENSION before any resizing (1275x1650px),
# meaning the render-then-immediately-downscale round trip was pure waste
# for most documents; 120 DPI (990x1275px) is much closer to landing
# under the resize cap on its own. See app/config.py's
# vision_max_image_dimension docstring for the measurement this and that
# default share.
DEFAULT_RENDER_DPI = 120


def validate_image(data: bytes, *, max_bytes: int, max_pixels: int | None = None) -> None:
    """Raises VisionServiceError if `data` is empty, exceeds `max_bytes`,
    isn't a decodable raster image, or (when `max_pixels` is given)
    decodes to more than `max_pixels` total pixels. Checks byte size
    *before* attempting to decode, so an oversized upload is rejected
    cheaply rather than after doing real decode work on it; the pixel
    check runs immediately after decode, before any further processing —
    see Settings.vision_max_image_pixels's docstring for why this is a
    separate check from the byte-size one (a small file can still decode
    to an enormous pixmap)."""
    if not data:
        raise VisionServiceError("Image data is empty", category=VisionErrorCategory.PREPROCESSING_FAILURE)
    if len(data) > max_bytes:
        raise VisionServiceError(
            f"Image is {len(data)} bytes, exceeds the {max_bytes}-byte limit",
            category=VisionErrorCategory.REQUEST_TOO_LARGE,
        )
    try:
        pixmap = pymupdf.Pixmap(data)  # type: ignore[no-untyped-call]
    except Exception as exc:
        raise VisionServiceError(
            f"Could not decode image data: {exc}", category=VisionErrorCategory.PREPROCESSING_FAILURE
        ) from exc
    if max_pixels is not None and pixmap.width * pixmap.height > max_pixels:
        raise VisionServiceError(
            f"Image decodes to {pixmap.width}x{pixmap.height} "
            f"({pixmap.width * pixmap.height} pixels), exceeds the {max_pixels}-pixel limit",
            category=VisionErrorCategory.REQUEST_TOO_LARGE,
        )


def resize_image(
    data: bytes,
    *,
    max_dimension: int = DEFAULT_MAX_IMAGE_DIMENSION,
    output_format: Literal["png", "jpeg"] = "png",
    jpeg_quality: int = 85,
) -> bytes:
    """Downscales an image so neither dimension exceeds `max_dimension`,
    preserving aspect ratio — never upscales. An image already within the
    limit is still re-decoded/re-encoded, so a caller always gets a
    consistent, known-good format regardless of the input's original
    encoding.

    `output_format` defaults to PNG deliberately, not JPEG, despite JPEG
    usually being assumed "the smaller format": a live measurement during
    this task's investigation encoded the same synthetic screenshot (flat
    background, sharp text/UI edges — representative of this app's real
    attachment content, which is screenshots and document pages, never
    photos) at both formats and found PNG *smaller* than JPEG quality 85
    (252,923 vs 440,435 bytes) for exactly that reason: JPEG's DCT
    compression is tuned for photographic gradients and performs worse
    than PNG's lossless filters on flat, sharp-edged content. JPEG is
    offered as an option (a caller that knows its content is
    photographic can opt in) but is not assumed to be an improvement.
    More importantly, neither format choice materially affects the actual
    bottleneck measured on this host: prompt-evaluation time tracks
    *decoded pixel count*, not encoded file size — Ollama decodes the
    image back to raw pixels before feeding its vision encoder either
    way, so `max_dimension` (which bounds decoded pixels directly) is the
    lever that matters; format/quality only affect request-body size and
    the cheap preprocessing step's own cost."""
    try:
        pixmap = pymupdf.Pixmap(data)  # type: ignore[no-untyped-call]
    except Exception as exc:
        raise VisionServiceError(
            f"Could not decode image data: {exc}", category=VisionErrorCategory.PREPROCESSING_FAILURE
        ) from exc

    longest_side = max(pixmap.width, pixmap.height)
    if longest_side > max_dimension:
        scale = max_dimension / longest_side
        new_width = max(1, round(pixmap.width * scale))
        new_height = max(1, round(pixmap.height * scale))
        pixmap = pymupdf.Pixmap(pixmap, new_width, new_height)  # type: ignore[no-untyped-call]

    if output_format == "jpeg":
        return bytes(pixmap.tobytes("jpg", jpg_quality=jpeg_quality))  # type: ignore[no-untyped-call]
    return bytes(pixmap.tobytes("png"))  # type: ignore[no-untyped-call]


def render_pdf_pages(
    data: bytes,
    *,
    max_pages: int,
    first_page: int = 1,
    last_page: int | None = None,
    dpi: int = DEFAULT_RENDER_DPI,
) -> list[bytes]:
    """Renders pages `first_page..last_page` (1-indexed, inclusive) of a
    PDF to PNG images. `last_page=None` (the default) renders just
    `first_page` alone — the common "just look at the first page" case.
    Raises VisionServiceError (rather than silently truncating) if the
    requested range is wider than `max_pages`: a caller that asked for
    pages 1-50 must be told its request was rejected, not silently handed
    only the first `max_pages` of them without any indication that
    happened."""
    if first_page < 1:
        raise VisionServiceError(
            f"first_page must be >= 1, got {first_page}",
            category=VisionErrorCategory.PREPROCESSING_FAILURE,
        )
    if last_page is not None and last_page < first_page:
        raise VisionServiceError(
            f"last_page ({last_page}) must be >= first_page ({first_page})",
            category=VisionErrorCategory.PREPROCESSING_FAILURE,
        )

    try:
        document = pymupdf.open(stream=data, filetype="pdf")  # type: ignore[no-untyped-call]
    except Exception as exc:
        raise VisionServiceError(
            f"Could not read PDF data: {exc}", category=VisionErrorCategory.PREPROCESSING_FAILURE
        ) from exc

    with document:
        page_count = document.page_count
        if page_count == 0:
            raise VisionServiceError(
                "PDF has no pages", category=VisionErrorCategory.PREPROCESSING_FAILURE
            )
        if first_page > page_count:
            raise VisionServiceError(
                f"first_page ({first_page}) exceeds the document's {page_count} page(s)",
                category=VisionErrorCategory.PREPROCESSING_FAILURE,
            )

        end_page = min(last_page if last_page is not None else first_page, page_count)
        requested_pages = list(range(first_page, end_page + 1))
        if len(requested_pages) > max_pages:
            raise VisionServiceError(
                f"Requested {len(requested_pages)} page(s), exceeds the {max_pages}-page limit",
                category=VisionErrorCategory.TOO_MANY_PAGES,
            )

        zoom = dpi / 72  # a PDF's native unit is 72 DPI
        matrix = pymupdf.Matrix(zoom, zoom)  # type: ignore[no-untyped-call]
        return [
            bytes(
                document[page_number - 1]  # type: ignore[no-untyped-call]
                .get_pixmap(matrix=matrix)
                .tobytes("png")
            )
            for page_number in requested_pages
        ]


@dataclass
class AttachmentForVision:
    """One chat attachment's validated bytes (milestone V2's
    ValidatedAttachment), ready to be turned into vision-model input —
    used by render_attachments_to_images below. `page_range_start`/`_end`
    only matter for a PDF (see MessageAttachment's docs); they are ignored
    for an image attachment."""

    mime: str
    data: bytes
    page_range_start: int | None = None
    page_range_end: int | None = None


_RESIZABLE_MIMES = frozenset({"image/png", "image/jpeg"})


def render_attachments_to_images(
    attachments: list[AttachmentForVision],
    *,
    max_images: int,
    max_pdf_pages: int,
    max_image_dimension: int = DEFAULT_MAX_IMAGE_DIMENSION,
    max_image_pixels: int | None = None,
    max_total_pixels: int | None = None,
    output_format: Literal["png", "jpeg"] = "png",
    jpeg_quality: int = 85,
) -> list[bytes]:
    """Flattens a message's attachments into the list of raw image bytes a
    vision-model call actually sends: an image attachment contributes
    itself (Ollama/qwen2.5vl decodes PNG/JPEG/WEBP/HEIC directly); a PDF
    attachment contributes one rendered PNG per selected page (see
    render_pdf_pages) — the attachment's own page_range_start/_end if a
    caller explicitly set one (kept only for API backward compatibility;
    no current frontend UI lets a user choose a range), otherwise the
    *whole* document, automatically, capped at `min(max_pdf_pages,
    max_images)` pages. That inner min() is deliberate, not just
    max_pdf_pages alone: max_images is the real ceiling on how many images
    a single vision call may ultimately send (see
    Settings.vision_max_images_per_message's docs), so capping the
    automatic page count there too means an oversized PDF is always
    gracefully truncated to its first N pages — never the "exceeds
    max_images" error below, which an explicit, deliberately-chosen range
    can still legitimately hit.

    Every PNG/JPEG-shaped image — whether uploaded directly or just
    rendered from a PDF page above — is then downscaled to
    `max_image_dimension` if larger (milestone V4: smaller images mean a
    smaller request body and a faster vision-model forward pass, i.e.
    directly lower latency; see resize_image). WEBP/HEIC are passed
    through at their original size — pymupdf (this project's only
    imaging dependency) cannot decode either format to resize it, the
    same limitation documented in app/services/attachment_storage.py.

    Raises VisionServiceError (rather than silently truncating) if the
    combined image count across every attachment still exceeds
    `max_images` — same "tell the caller, don't silently drop data"
    convention as render_pdf_pages' own max_pages check. This can still
    happen with multiple attachments (e.g. several images plus a PDF) even
    though the automatic single-PDF case above is now self-limiting.

    `max_image_pixels`/`max_total_pixels` (both optional, see
    Settings.vision_max_image_pixels/vision_max_total_pixels) are checked
    against each rendered/original image's *decoded* pixel count — a
    defense-in-depth aggregate cap that max_images/max_pdf_pages alone
    cannot express (e.g. four maximally-sized images each individually
    under max_image_pixels but enormous in aggregate).

    Wrapped in the ambient RequestTimer's "pdf_render"/"image_preprocessing"
    stages (see app/core/request_timing.py) when profiling is enabled —
    this function always runs synchronously before a StreamingResponse
    begins (see app/api/routes_conversations.py's _handle_conversation_message),
    still inside the FastAPI dependency-resolution window where the
    ambient accessor is valid, the same reasoning RagService.prepare()
    documents for its own internal stages.
    """
    timer = get_current_timer()
    images: list[tuple[bytes, bool]] = []
    total_pixels = 0
    for attachment in attachments:
        if attachment.mime == "application/pdf":
            has_explicit_range = attachment.page_range_end is not None
            last_page = (
                attachment.page_range_end if has_explicit_range else min(max_pdf_pages, max_images)
            )
            with timer.stage("pdf_render"):
                rendered_pages = render_pdf_pages(
                    attachment.data,
                    max_pages=max_pdf_pages,
                    first_page=attachment.page_range_start or 1,
                    last_page=last_page,
                )
            # Always a freshly rendered PNG (see render_pdf_pages) —
            # always safe to resize.
            images.extend((page, True) for page in rendered_pages)
        else:
            images.append((attachment.data, attachment.mime in _RESIZABLE_MIMES))

    if len(images) > max_images:
        raise VisionServiceError(
            f"This message's attachments render to {len(images)} image(s) total, exceeds the "
            f"{max_images}-image limit for a single vision request",
            category=VisionErrorCategory.REQUEST_TOO_LARGE,
        )

    processed: list[bytes] = []
    with timer.stage("image_preprocessing"):
        for data, resizable in images:
            if max_image_pixels is not None or max_total_pixels is not None:
                try:
                    pixmap = pymupdf.Pixmap(data)  # type: ignore[no-untyped-call]
                except Exception as exc:
                    raise VisionServiceError(
                        f"Could not decode image data: {exc}",
                        category=VisionErrorCategory.PREPROCESSING_FAILURE,
                    ) from exc
                pixel_count = pixmap.width * pixmap.height
                if max_image_pixels is not None and pixel_count > max_image_pixels:
                    raise VisionServiceError(
                        f"An image decodes to {pixmap.width}x{pixmap.height} "
                        f"({pixel_count} pixels), exceeds the {max_image_pixels}-pixel limit",
                        category=VisionErrorCategory.REQUEST_TOO_LARGE,
                    )
                total_pixels += pixel_count
                if max_total_pixels is not None and total_pixels > max_total_pixels:
                    raise VisionServiceError(
                        f"This message's attachments total {total_pixels} pixels, exceeds the "
                        f"{max_total_pixels}-pixel combined limit",
                        category=VisionErrorCategory.REQUEST_TOO_LARGE,
                    )
            processed.append(
                resize_image(
                    data,
                    max_dimension=max_image_dimension,
                    output_format=output_format,
                    jpeg_quality=jpeg_quality,
                )
                if resizable
                else data
            )
    return processed


@contextlib.contextmanager
def temporary_upload_file(data: bytes, *, suffix: str) -> Iterator[Path]:
    """Writes `data` to a real on-disk temporary file and always deletes
    it afterward, even if the caller's block raises. Not used by
    render_pdf_pages/resize_image above (both work directly on in-memory
    bytes) — this exists for a future caller (e.g. a multipart upload
    route) that needs to hand a real file path to something requiring
    one."""
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp_file:
        tmp_file.write(data)
        tmp_path = Path(tmp_file.name)
    try:
        yield tmp_path
    finally:
        tmp_path.unlink(missing_ok=True)


class _VisionMessageLike(Protocol):
    @property
    def content(self) -> str | None: ...


class _VisionChatChunkLike(Protocol):
    @property
    def message(self) -> _VisionMessageLike: ...


class _AsyncVisionCapableClient(Protocol):
    async def chat(
        self,
        *,
        model: str,
        messages: list[dict[str, object]],
        stream: Literal[True],
        options: dict[str, object] | None = None,
    ) -> AsyncIterator[_VisionChatChunkLike]: ...


def _record_vision_metrics(timer: RequestTimer, final_chunk: object) -> None:
    """Same extraction as app/core/llm_provider.py's
    _record_ollama_metrics, under vision_-prefixed metric names (see
    app/config.py's PERFORMANCE_PROFILING requirements) — kept as a
    separate function rather than shared/reused since the two pipelines'
    metric name prefixes (and, with this task's changes, their client
    classes — sync vs async) differ and there is no other logic to share.
    Never raises: a profiling extraction failure must never break a real
    vision response."""
    try:
        load_duration_ns = getattr(final_chunk, "load_duration", None)
        if isinstance(load_duration_ns, int | float):
            timer.record("vision_model_load_ms", load_duration_ns / 1_000_000)

        prompt_eval_duration_ns = getattr(final_chunk, "prompt_eval_duration", None)
        if isinstance(prompt_eval_duration_ns, int | float):
            timer.record("vision_prompt_eval_ms", prompt_eval_duration_ns / 1_000_000)

        eval_count = getattr(final_chunk, "eval_count", None)
        if isinstance(eval_count, int | float):
            timer.record_metric("vision_completion_tokens", eval_count)

        eval_duration_ns = getattr(final_chunk, "eval_duration", None)
        if (
            isinstance(eval_count, int | float)
            and isinstance(eval_duration_ns, int | float)
            and eval_duration_ns > 0
        ):
            decode_tokens_per_second = eval_count / (eval_duration_ns / 1_000_000_000)
            timer.record_metric("vision_decode_tokens_per_second", round(decode_tokens_per_second, 2))
    except Exception:
        pass


class VisionService:
    """Streams a chat completion from a vision-capable Ollama model given
    a text prompt and one or more images. Mirrors
    app/core/llm_provider.py's OllamaLLMProvider shape (same
    injectable-client pattern for testing, same wrap-every-failure-into-
    one-error-type convention) but is a distinct class, not a drop-in
    replacement: its `stream_chat` takes images and is async (see the
    module docstring for why), and a vision model is never used as a
    substitute for the text model (see app/core/model_routing.py)."""

    def __init__(
        self,
        *,
        model: str,
        base_url: str = "http://localhost:11434",
        timeout_seconds: float = 300.0,
        generation_timeout_seconds: float = 60.0,
        num_predict: int | None = 512,
        client: _AsyncVisionCapableClient | None = None,
    ) -> None:
        """`timeout_seconds` bounds time-to-first-token (cold model load +
        prompt/image evaluation combined — see
        Settings.vision_request_timeout_seconds's docstring for why these
        can't be split). `generation_timeout_seconds` separately bounds
        the gap between two already-streaming chunks once generation has
        started (see Settings.vision_generation_timeout_seconds) —
        enforced in Python via asyncio.wait_for() around each iteration
        step below, not by the underlying httpx client's own timeout
        (which is set to `timeout_seconds`, the larger of the two, purely
        as a safety-net floor)."""
        self._model = model
        self._timeout_seconds = timeout_seconds
        self._generation_timeout_seconds = generation_timeout_seconds
        self._options: dict[str, object] | None = (
            {"num_predict": num_predict} if num_predict is not None else None
        )
        self._client: _AsyncVisionCapableClient = (
            client
            if client is not None
            else ollama.AsyncClient(host=base_url, timeout=timeout_seconds)
        )

    async def stream_chat(
        self,
        *,
        prompt: str,
        images: list[bytes],
        system_prompt: str | None = None,
        timer: RequestTimer | None = None,
    ) -> AsyncIterator[str]:
        """`timer`, when given, receives the same load/prompt-eval/decode
        metrics app/core/llm_provider.py's stream_chat records for text
        (see _record_vision_metrics above), plus vision_time_to_first_token_ms
        (measured here directly — Ollama's own reported fields don't
        include a wall-clock "time until this process actually handed
        back a token" figure, only its own internal load/eval durations).
        Optional and additive: omitting it changes nothing about token
        delivery."""
        if not images:
            raise VisionServiceError(
                "At least one image is required for a vision chat call",
                category=VisionErrorCategory.PREPROCESSING_FAILURE,
            )

        messages: list[dict[str, object]] = []
        if system_prompt is not None:
            messages.append({"role": "system", "content": system_prompt})
        messages.append({"role": "user", "content": prompt, "images": images})

        start = time.monotonic()
        received_first_token = False
        last_chunk: _VisionChatChunkLike | None = None
        try:
            stream = await self._client.chat(
                model=self._model, messages=messages, stream=True, options=self._options
            )
            aiterator = stream.__aiter__()
            while True:
                deadline = (
                    self._generation_timeout_seconds
                    if received_first_token
                    else self._timeout_seconds
                )
                try:
                    chunk = await asyncio.wait_for(aiterator.__anext__(), timeout=deadline)
                except StopAsyncIteration:
                    break
                last_chunk = chunk
                if not received_first_token and timer is not None and timer.enabled:
                    timer.record("vision_time_to_first_token_ms", (time.monotonic() - start) * 1000)
                content = chunk.message.content
                if content:
                    received_first_token = True
                    yield content
        except VisionServiceError:
            raise
        except TimeoutError as exc:
            # asyncio.wait_for's own TimeoutError (Python 3.11+: the same
            # class as builtins.TimeoutError) — not an httpx exception, so
            # classify_vision_error_category's httpx.TimeoutException
            # branch wouldn't match it; handled explicitly here instead,
            # same received_first_token-based distinction. Deliberately
            # not `except Exception` above this: asyncio.CancelledError
            # (raised at this same await point on a real client
            # disconnect — see the module docstring) is a BaseException,
            # not an Exception, so it already propagates untouched by
            # either this clause or the one below — a cancellation is
            # never misreported as a timeout.
            category = (
                VisionErrorCategory.GENERATION_TIMEOUT
                if received_first_token
                else VisionErrorCategory.MODEL_LOAD_OR_PROMPT_EVAL_TIMEOUT
            )
            raise VisionServiceError(_timeout_message(self._model), category=category) from exc
        except Exception as exc:
            category = classify_vision_error_category(exc, received_first_token=received_first_token)
            raise VisionServiceError(
                classify_ollama_error(exc, model=self._model, action="Vision chat generation"),
                category=category,
            ) from exc

        if timer is not None and timer.enabled and last_chunk is not None:
            _record_vision_metrics(timer, last_chunk)


def _timeout_message(model: str) -> str:
    return (
        f"The '{model}' model did not respond in time. It may be overloaded, or this "
        "request (e.g. a large image or many PDF pages) may be too big to process "
        "quickly — try again, or with a smaller attachment."
    )
