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
"""

import contextlib
import tempfile
from collections.abc import Iterable, Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, Protocol

import ollama
import pymupdf

from app.core.errors import VisionServiceError
from app.core.ollama_errors import classify_ollama_error

# Matches common multimodal-model guidance for the largest side of an
# input image before returns diminish — resizing beyond this just costs
# more tokens/latency without adding usable detail for the model.
DEFAULT_MAX_IMAGE_DIMENSION = 1568

# 150 DPI is a reasonable default for rendering a PDF page to an image a
# vision model can read text from — high enough for body text to stay
# legible, low enough that a page doesn't produce an enormous image.
DEFAULT_RENDER_DPI = 150


def validate_image(data: bytes, *, max_bytes: int) -> None:
    """Raises VisionServiceError if `data` is empty, exceeds `max_bytes`,
    or isn't a decodable raster image. Checks size *before* attempting to
    decode, so an oversized upload is rejected cheaply rather than after
    doing real decode work on it."""
    if not data:
        raise VisionServiceError("Image data is empty")
    if len(data) > max_bytes:
        raise VisionServiceError(f"Image is {len(data)} bytes, exceeds the {max_bytes}-byte limit")
    try:
        pymupdf.Pixmap(data)  # type: ignore[no-untyped-call]
    except Exception as exc:
        raise VisionServiceError(f"Could not decode image data: {exc}") from exc


def resize_image(data: bytes, *, max_dimension: int = DEFAULT_MAX_IMAGE_DIMENSION) -> bytes:
    """Downscales an image so neither dimension exceeds `max_dimension`,
    preserving aspect ratio — never upscales. An image already within the
    limit is still re-decoded/re-encoded as PNG, so a caller always gets a
    consistent, known-good format regardless of the input's original
    encoding."""
    try:
        pixmap = pymupdf.Pixmap(data)  # type: ignore[no-untyped-call]
    except Exception as exc:
        raise VisionServiceError(f"Could not decode image data: {exc}") from exc

    longest_side = max(pixmap.width, pixmap.height)
    if longest_side <= max_dimension:
        return bytes(pixmap.tobytes("png"))  # type: ignore[no-untyped-call]

    scale = max_dimension / longest_side
    new_width = max(1, round(pixmap.width * scale))
    new_height = max(1, round(pixmap.height * scale))
    resized = pymupdf.Pixmap(pixmap, new_width, new_height)  # type: ignore[no-untyped-call]
    return bytes(resized.tobytes("png"))  # type: ignore[no-untyped-call]


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
        raise VisionServiceError(f"first_page must be >= 1, got {first_page}")
    if last_page is not None and last_page < first_page:
        raise VisionServiceError(f"last_page ({last_page}) must be >= first_page ({first_page})")

    try:
        document = pymupdf.open(stream=data, filetype="pdf")  # type: ignore[no-untyped-call]
    except Exception as exc:
        raise VisionServiceError(f"Could not read PDF data: {exc}") from exc

    with document:
        page_count = document.page_count
        if page_count == 0:
            raise VisionServiceError("PDF has no pages")
        if first_page > page_count:
            raise VisionServiceError(
                f"first_page ({first_page}) exceeds the document's {page_count} page(s)"
            )

        end_page = min(last_page if last_page is not None else first_page, page_count)
        requested_pages = list(range(first_page, end_page + 1))
        if len(requested_pages) > max_pages:
            raise VisionServiceError(
                f"Requested {len(requested_pages)} page(s), exceeds the {max_pages}-page limit"
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
    """
    images: list[tuple[bytes, bool]] = []
    for attachment in attachments:
        if attachment.mime == "application/pdf":
            has_explicit_range = attachment.page_range_end is not None
            last_page = (
                attachment.page_range_end if has_explicit_range else min(max_pdf_pages, max_images)
            )
            # Always a freshly rendered PNG (see render_pdf_pages) —
            # always safe to resize.
            images.extend(
                (page, True)
                for page in render_pdf_pages(
                    attachment.data,
                    max_pages=max_pdf_pages,
                    first_page=attachment.page_range_start or 1,
                    last_page=last_page,
                )
            )
        else:
            images.append((attachment.data, attachment.mime in _RESIZABLE_MIMES))

    if len(images) > max_images:
        raise VisionServiceError(
            f"This message's attachments render to {len(images)} image(s) total, exceeds the "
            f"{max_images}-image limit for a single vision request"
        )
    return [
        resize_image(data, max_dimension=max_image_dimension) if resizable else data
        for data, resizable in images
    ]


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


class _VisionCapableClient(Protocol):
    def chat(
        self,
        *,
        model: str,
        messages: list[dict[str, object]],
        stream: Literal[True],
    ) -> Iterable[_VisionChatChunkLike]: ...


class VisionService:
    """Streams a chat completion from a vision-capable Ollama model given
    a text prompt and one or more images. Mirrors
    app/core/llm_provider.py's OllamaLLMProvider shape (same
    injectable-client pattern for testing, same wrap-every-failure-into-
    one-error-type convention) but is a distinct class, not a drop-in
    replacement: its `stream_chat` takes images, and a vision model is
    never used as a substitute for the text model (see
    app/core/model_routing.py)."""

    def __init__(
        self,
        *,
        model: str,
        base_url: str = "http://localhost:11434",
        timeout_seconds: float = 180.0,
        client: _VisionCapableClient | None = None,
    ) -> None:
        self._model = model
        self._client: _VisionCapableClient = (
            client if client is not None else ollama.Client(host=base_url, timeout=timeout_seconds)
        )

    def stream_chat(
        self, *, prompt: str, images: list[bytes], system_prompt: str | None = None
    ) -> Iterator[str]:
        if not images:
            raise VisionServiceError("At least one image is required for a vision chat call")

        messages: list[dict[str, object]] = []
        if system_prompt is not None:
            messages.append({"role": "system", "content": system_prompt})
        messages.append({"role": "user", "content": prompt, "images": images})
        try:
            stream = self._client.chat(model=self._model, messages=messages, stream=True)
            for chunk in stream:
                content = chunk.message.content
                if content:
                    yield content
        except VisionServiceError:
            raise
        except Exception as exc:
            raise VisionServiceError(classify_ollama_error(exc, model=self._model)) from exc
