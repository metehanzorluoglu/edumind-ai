"""Covers app/services/vision_service.py: image resize/format behavior,
PDF rendering, the render_attachments_to_images safety-limit checks (item
10 of the vision-timeout investigation task), and VisionService.stream_chat
— including the dual-timeout (time-to-first-token vs. generation-stall)
enforcement and error classification this task added (see that module's
docstring for why an async client is used).

Every fake image/PDF here is generated on the fly with pymupdf (already a
hard dependency of the module under test) rather than checked-in binary
fixtures.
"""

import asyncio
from dataclasses import dataclass

import pymupdf
import pytest

from app.core.errors import VisionErrorCategory, VisionServiceError
from app.core.request_timing import RequestTimer
from app.services.vision_service import (
    AttachmentForVision,
    VisionService,
    render_attachments_to_images,
    render_pdf_pages,
    resize_image,
    validate_image,
)


def _make_png(width: int, height: int) -> bytes:
    doc = pymupdf.open()
    page = doc.new_page(width=width, height=height)
    page.draw_rect(pymupdf.Rect(0, 0, width, height), color=(1, 1, 1), fill=(1, 1, 1))
    pix = page.get_pixmap(matrix=pymupdf.Matrix(1, 1))
    data = bytes(pix.tobytes("png"))
    doc.close()
    return data


def _make_pdf(page_count: int, *, width: float = 200, height: float = 200) -> bytes:
    doc = pymupdf.open()
    for _ in range(page_count):
        doc.new_page(width=width, height=height)
    data = doc.tobytes()
    doc.close()
    return data


def _dims(png_bytes: bytes) -> tuple[int, int]:
    pix = pymupdf.Pixmap(png_bytes)
    return pix.width, pix.height


class TestResizeImage:
    def test_downscales_an_oversized_image_preserving_aspect_ratio(self) -> None:
        data = _make_png(2000, 1000)
        resized = resize_image(data, max_dimension=1000)
        width, height = _dims(resized)
        assert width == 1000
        assert height == 500

    def test_never_upscales_an_image_already_within_the_limit(self) -> None:
        data = _make_png(400, 300)
        resized = resize_image(data, max_dimension=1000)
        assert _dims(resized) == (400, 300)

    def test_defaults_to_png_output(self) -> None:
        data = _make_png(400, 300)
        resized = resize_image(data, max_dimension=1000)
        assert resized.startswith(b"\x89PNG\r\n\x1a\n")

    def test_can_output_jpeg_when_explicitly_requested(self) -> None:
        data = _make_png(400, 300)
        resized = resize_image(data, max_dimension=1000, output_format="jpeg", jpeg_quality=80)
        assert resized.startswith(b"\xff\xd8\xff")  # JPEG magic bytes

    def test_raises_a_categorized_error_for_undecodable_data(self) -> None:
        with pytest.raises(VisionServiceError) as exc_info:
            resize_image(b"not an image", max_dimension=1000)
        assert exc_info.value.category == VisionErrorCategory.PREPROCESSING_FAILURE


class TestValidateImage:
    def test_accepts_a_well_formed_image_within_limits(self) -> None:
        data = _make_png(100, 100)
        validate_image(data, max_bytes=1_000_000, max_pixels=1_000_000)  # must not raise

    def test_rejects_empty_data(self) -> None:
        with pytest.raises(VisionServiceError) as exc_info:
            validate_image(b"", max_bytes=1_000_000)
        assert exc_info.value.category == VisionErrorCategory.PREPROCESSING_FAILURE

    def test_rejects_data_over_the_byte_limit_before_decoding(self) -> None:
        data = _make_png(100, 100)
        with pytest.raises(VisionServiceError) as exc_info:
            validate_image(data, max_bytes=10)
        assert exc_info.value.category == VisionErrorCategory.REQUEST_TOO_LARGE

    def test_rejects_an_image_that_decodes_over_the_pixel_limit(self) -> None:
        data = _make_png(500, 500)  # 250,000 pixels
        with pytest.raises(VisionServiceError) as exc_info:
            validate_image(data, max_bytes=10_000_000, max_pixels=100_000)
        assert exc_info.value.category == VisionErrorCategory.REQUEST_TOO_LARGE

    def test_pixel_limit_is_optional(self) -> None:
        data = _make_png(500, 500)
        validate_image(data, max_bytes=10_000_000)  # no max_pixels -> must not raise


class TestRenderPdfPages:
    def test_renders_the_requested_page_range(self) -> None:
        data = _make_pdf(3)
        pages = render_pdf_pages(data, max_pages=10, first_page=1, last_page=2)
        assert len(pages) == 2

    def test_defaults_to_just_the_first_page(self) -> None:
        data = _make_pdf(3)
        pages = render_pdf_pages(data, max_pages=10)
        assert len(pages) == 1

    def test_rejects_a_range_wider_than_max_pages_with_too_many_pages_category(self) -> None:
        data = _make_pdf(5)
        with pytest.raises(VisionServiceError) as exc_info:
            render_pdf_pages(data, max_pages=2, first_page=1, last_page=5)
        assert exc_info.value.category == VisionErrorCategory.TOO_MANY_PAGES

    def test_rejects_a_first_page_beyond_the_documents_page_count(self) -> None:
        # pymupdf itself refuses to save a genuinely zero-page PDF (there
        # is no way to legitimately construct render_pdf_pages'
        # page_count==0 case through its own API), so this exercises the
        # adjacent, constructible "asked for a page that doesn't exist"
        # defensive check instead.
        data = _make_pdf(2)
        with pytest.raises(VisionServiceError) as exc_info:
            render_pdf_pages(data, max_pages=10, first_page=5)
        assert exc_info.value.category == VisionErrorCategory.PREPROCESSING_FAILURE


class TestRenderAttachmentsToImages:
    def test_a_single_image_attachment_passes_through_resized(self) -> None:
        data = _make_png(2000, 1000)
        images = render_attachments_to_images(
            [AttachmentForVision(mime="image/png", data=data)],
            max_images=4,
            max_pdf_pages=10,
            max_image_dimension=500,
        )
        assert len(images) == 1
        assert _dims(images[0]) == (500, 250)

    def test_a_pdf_attachment_without_an_explicit_range_renders_the_whole_document(self) -> None:
        # No page_range_start/_end set -> the *whole* document, automatically
        # (see render_attachments_to_images' own docstring) — capped at
        # min(max_pdf_pages, max_images) below, not "just the first page"
        # (that default belongs to render_pdf_pages alone, one layer down).
        data = _make_pdf(3)
        images = render_attachments_to_images(
            [AttachmentForVision(mime="application/pdf", data=data)],
            max_images=4,
            max_pdf_pages=10,
        )
        assert len(images) == 3

    def test_an_oversized_pdf_attachment_is_capped_at_min_of_max_pdf_pages_and_max_images(
        self,
    ) -> None:
        data = _make_pdf(6)
        images = render_attachments_to_images(
            [AttachmentForVision(mime="application/pdf", data=data)],
            max_images=4,
            max_pdf_pages=10,
        )
        assert len(images) == 4  # min(max_pdf_pages=10, max_images=4)

    def test_an_explicit_page_range_is_honored_over_the_automatic_whole_document_default(
        self,
    ) -> None:
        data = _make_pdf(5)
        images = render_attachments_to_images(
            [
                AttachmentForVision(
                    mime="application/pdf", data=data, page_range_start=2, page_range_end=3
                )
            ],
            max_images=4,
            max_pdf_pages=10,
        )
        assert len(images) == 2

    def test_rejects_more_images_than_max_images_with_request_too_large_category(self) -> None:
        small = _make_png(50, 50)
        attachments = [AttachmentForVision(mime="image/png", data=small) for _ in range(5)]
        with pytest.raises(VisionServiceError) as exc_info:
            render_attachments_to_images(attachments, max_images=4, max_pdf_pages=10)
        assert exc_info.value.category == VisionErrorCategory.REQUEST_TOO_LARGE

    def test_rejects_a_single_image_over_the_per_image_pixel_limit(self) -> None:
        data = _make_png(1000, 1000)  # 1,000,000 pixels
        with pytest.raises(VisionServiceError) as exc_info:
            render_attachments_to_images(
                [AttachmentForVision(mime="image/png", data=data)],
                max_images=4,
                max_pdf_pages=10,
                max_image_pixels=100_000,
            )
        assert exc_info.value.category == VisionErrorCategory.REQUEST_TOO_LARGE

    def test_rejects_a_combined_total_over_the_aggregate_pixel_limit(self) -> None:
        # Two images, each individually under a per-image cap, but
        # together over the aggregate cap.
        data = _make_png(300, 300)  # 90,000 pixels each
        attachments = [
            AttachmentForVision(mime="image/png", data=data),
            AttachmentForVision(mime="image/png", data=data),
        ]
        with pytest.raises(VisionServiceError) as exc_info:
            render_attachments_to_images(
                attachments,
                max_images=4,
                max_pdf_pages=10,
                max_image_pixels=100_000,
                max_total_pixels=150_000,
            )
        assert exc_info.value.category == VisionErrorCategory.REQUEST_TOO_LARGE

    def test_pixel_limits_are_optional_and_do_not_reject_by_default(self) -> None:
        data = _make_png(2000, 2000)
        images = render_attachments_to_images(
            [AttachmentForVision(mime="image/png", data=data)],
            max_images=4,
            max_pdf_pages=10,
            max_image_dimension=4096,
        )
        assert len(images) == 1

    def test_output_format_and_quality_are_threaded_through_to_resize(self) -> None:
        data = _make_png(50, 50)
        images = render_attachments_to_images(
            [AttachmentForVision(mime="image/png", data=data)],
            max_images=4,
            max_pdf_pages=10,
            output_format="jpeg",
            jpeg_quality=70,
        )
        assert images[0].startswith(b"\xff\xd8\xff")


@dataclass
class _FakeMessage:
    content: str | None


@dataclass
class _FakeChunk:
    message: _FakeMessage
    load_duration: int | None = None
    prompt_eval_duration: int | None = None
    eval_count: int | None = None
    eval_duration: int | None = None


class _FakeAsyncStream:
    """An async-iterable of chunks, with an optional per-chunk delay so
    tests can exercise VisionService.stream_chat's two independently
    enforced deadlines without waiting on anything close to real
    Ollama-scale durations."""

    def __init__(self, chunks: list[_FakeChunk], *, delay_s: float = 0.0) -> None:
        self._chunks = chunks
        self._delay_s = delay_s

    def __aiter__(self) -> "_FakeAsyncStream":
        self._iterator = iter(self._chunks)
        return self

    async def __anext__(self) -> _FakeChunk:
        if self._delay_s:
            await asyncio.sleep(self._delay_s)
        try:
            return next(self._iterator)
        except StopIteration:
            raise StopAsyncIteration from None


class _FakeAsyncClient:
    def __init__(self, stream: _FakeAsyncStream | Exception) -> None:
        self._stream = stream
        self.calls: list[dict[str, object]] = []

    async def chat(self, *, model, messages, stream, options=None):
        self.calls.append(
            {"model": model, "messages": messages, "stream": stream, "options": options}
        )
        if isinstance(self._stream, Exception):
            raise self._stream
        return self._stream


def _tiny_image() -> bytes:
    return _make_png(2, 2)


class TestVisionServiceStreamChat:
    async def test_streams_tokens_and_records_metrics_on_the_timer(self) -> None:
        chunks = [
            _FakeChunk(message=_FakeMessage(content="A")),
            _FakeChunk(
                message=_FakeMessage(content=" cat."),
                load_duration=1_000_000_000,
                prompt_eval_duration=2_000_000_000,
                eval_count=10,
                eval_duration=1_000_000_000,
            ),
        ]
        client = _FakeAsyncClient(_FakeAsyncStream(chunks))
        service = VisionService(model="qwen2.5vl:7b", client=client)
        timer = RequestTimer(enabled=True, label="test")

        tokens = [
            token
            async for token in service.stream_chat(
                prompt="What is this?", images=[_tiny_image()], timer=timer
            )
        ]

        assert tokens == ["A", " cat."]
        metrics = timer.as_dict()
        assert metrics["vision_model_load_ms"] == 1000.0
        assert metrics["vision_prompt_eval_ms"] == 2000.0
        assert metrics["vision_completion_tokens"] == 10
        assert metrics["vision_decode_tokens_per_second"] == 10.0
        assert "vision_time_to_first_token_ms" in metrics

    async def test_requires_at_least_one_image(self) -> None:
        client = _FakeAsyncClient(_FakeAsyncStream([]))
        service = VisionService(model="qwen2.5vl:7b", client=client)

        with pytest.raises(VisionServiceError) as exc_info:
            async for _ in service.stream_chat(prompt="hi", images=[]):
                pass
        assert exc_info.value.category == VisionErrorCategory.PREPROCESSING_FAILURE

    async def test_passes_num_predict_and_system_prompt_through_unchanged(self) -> None:
        chunks = [_FakeChunk(message=_FakeMessage(content="ok"))]
        client = _FakeAsyncClient(_FakeAsyncStream(chunks))
        service = VisionService(model="qwen2.5vl:7b", client=client, num_predict=64)

        async for _ in service.stream_chat(
            prompt="describe", images=[_tiny_image()], system_prompt="You are helpful."
        ):
            pass

        call = client.calls[0]
        assert call["options"] == {"num_predict": 64}
        assert call["messages"][0] == {"role": "system", "content": "You are helpful."}
        assert call["messages"][1]["content"] == "describe"

    async def test_timeout_before_any_token_is_classified_as_model_load_or_prompt_eval(
        self,
    ) -> None:
        # A first-chunk delay longer than timeout_seconds: no output ever
        # streamed, so this must classify as the "still loading/evaluating"
        # category, not a generation stall.
        chunks = [_FakeChunk(message=_FakeMessage(content="late"))]
        client = _FakeAsyncClient(_FakeAsyncStream(chunks, delay_s=0.2))
        service = VisionService(
            model="qwen2.5vl:7b",
            client=client,
            timeout_seconds=0.02,
            generation_timeout_seconds=5.0,
        )

        with pytest.raises(VisionServiceError) as exc_info:
            async for _ in service.stream_chat(prompt="hi", images=[_tiny_image()]):
                pass
        assert exc_info.value.category == VisionErrorCategory.MODEL_LOAD_OR_PROMPT_EVAL_TIMEOUT

    async def test_timeout_after_a_token_has_streamed_is_classified_as_generation_timeout(
        self,
    ) -> None:
        # First chunk arrives fast (real content), second chunk stalls
        # past generation_timeout_seconds (but well within the much
        # larger timeout_seconds) — must classify as a generation stall,
        # not a load/prompt-eval timeout, proving the two deadlines are
        # independently enforced, not just one shared value.
        chunks = [
            _FakeChunk(message=_FakeMessage(content="first")),
            _FakeChunk(message=_FakeMessage(content="stalled")),
        ]

        class _StaggeredStream:
            def __init__(self) -> None:
                self._index = 0

            def __aiter__(self) -> "_StaggeredStream":
                return self

            async def __anext__(self) -> _FakeChunk:
                if self._index >= len(chunks):
                    raise StopAsyncIteration
                delay = 0.0 if self._index == 0 else 0.2
                self._index += 1
                await asyncio.sleep(delay)
                return chunks[self._index - 1]

        client = _FakeAsyncClient(_StaggeredStream())
        service = VisionService(
            model="qwen2.5vl:7b",
            client=client,
            timeout_seconds=5.0,
            generation_timeout_seconds=0.02,
        )

        received = []
        with pytest.raises(VisionServiceError) as exc_info:
            async for token in service.stream_chat(prompt="hi", images=[_tiny_image()]):
                received.append(token)
        assert received == ["first"]
        assert exc_info.value.category == VisionErrorCategory.GENERATION_TIMEOUT

    async def test_a_real_cancellation_propagates_as_cancelled_error_not_a_timeout(self) -> None:
        # Simulates what a client disconnect delivers at the exact await
        # point inside stream_chat's loop (see StreamingResponse's native
        # async-generator cancellation, documented in
        # app/api/routes_conversations.py's _stream_vision_reply) — must
        # propagate untouched, never misreported as
        # MODEL_LOAD_OR_PROMPT_EVAL_TIMEOUT/GENERATION_TIMEOUT, and must
        # not be swallowed by stream_chat's `except Exception` handling.
        class _HangingStream:
            def __aiter__(self) -> "_HangingStream":
                return self

            async def __anext__(self) -> _FakeChunk:
                await asyncio.sleep(100)  # cancelled long before this would fire
                raise AssertionError("should have been cancelled")

        client = _FakeAsyncClient(_HangingStream())
        service = VisionService(model="qwen2.5vl:7b", client=client, timeout_seconds=100.0)

        async def consume() -> None:
            async for _ in service.stream_chat(prompt="hi", images=[_tiny_image()]):
                pass

        task = asyncio.ensure_future(consume())
        await asyncio.sleep(0.01)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    async def test_ollama_unreachable_is_classified_as_ollama_unavailable(self) -> None:
        client = _FakeAsyncClient(ConnectionError("Connection refused"))
        service = VisionService(model="qwen2.5vl:7b", client=client)

        with pytest.raises(VisionServiceError) as exc_info:
            async for _ in service.stream_chat(prompt="hi", images=[_tiny_image()]):
                pass
        assert exc_info.value.category == VisionErrorCategory.OLLAMA_UNAVAILABLE

    async def test_never_retries_a_failed_request(self) -> None:
        # No automatic duplicate retry (task requirement): exactly one
        # chat() call is ever made, even on failure.
        client = _FakeAsyncClient(ConnectionError("boom"))
        service = VisionService(model="qwen2.5vl:7b", client=client)

        with pytest.raises(VisionServiceError):
            async for _ in service.stream_chat(prompt="hi", images=[_tiny_image()]):
                pass
        assert len(client.calls) == 1

    async def test_timer_none_by_default_records_nothing_and_does_not_crash(self) -> None:
        chunks = [
            _FakeChunk(
                message=_FakeMessage(content="ok"), eval_count=1, eval_duration=1_000_000_000
            )
        ]
        client = _FakeAsyncClient(_FakeAsyncStream(chunks))
        service = VisionService(model="qwen2.5vl:7b", client=client)

        tokens = [
            token async for token in service.stream_chat(prompt="hi", images=[_tiny_image()])
        ]
        assert tokens == ["ok"]
