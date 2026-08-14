"""Covers app/services/vision_batch_orchestrator.py: the sequential
map-then-reduce pipeline that replaces a single oversized vision call for
a multi-batch PDF — per-batch retry, graceful skip-and-continue on a
batch that still fails, vision-vs-text routing per batch, and the final
reduce step's real token streaming.

Every fake PDF here is generated on the fly with pymupdf (same convention
as test_vision_service.py / test_pdf_batch_planner.py); the vision/text
model calls are both faked with simple scripted-outcome doubles rather
than touching Ollama.
"""

from collections.abc import AsyncIterator

import pymupdf
import pytest

from app.core.errors import VisionErrorCategory, VisionServiceError
from app.core.generation_events import GenProgress, GenToken
from app.services.pdf_batch_planner import plan_pdf_batches
from app.services.vision_batch_orchestrator import stream_batched_pdf_analysis


def _text_pdf(page_count: int) -> bytes:
    doc = pymupdf.open()
    for i in range(page_count):
        page = doc.new_page(width=400, height=600)
        page.insert_text((50, 72), f"Page {i + 1}. " + ("Real body text. " * 10), fontsize=11)
    data = doc.tobytes()
    doc.close()
    return data


def _png_bytes() -> bytes:
    doc = pymupdf.open()
    page = doc.new_page(width=40, height=40)
    page.draw_rect(pymupdf.Rect(0, 0, 40, 40), color=(0, 0, 0), fill=(0.2, 0.4, 0.8))
    pix = page.get_pixmap(matrix=pymupdf.Matrix(1, 1))
    data = bytes(pix.tobytes("png"))
    doc.close()
    return data


def _image_pdf(page_count: int) -> bytes:
    png = _png_bytes()
    doc = pymupdf.open()
    for _ in range(page_count):
        page = doc.new_page(width=400, height=600)
        page.insert_image(pymupdf.Rect(50, 50, 350, 350), stream=png)
    data = doc.tobytes()
    doc.close()
    return data


class _FakeVisionService:
    """`outcomes` is consumed one entry per stream_chat call, in order —
    each entry is either an Exception (raised) or a list[str] (yielded as
    tokens)."""

    def __init__(self, outcomes: list[object]) -> None:
        self._outcomes = list(outcomes)
        self.calls: list[dict[str, object]] = []

    async def stream_chat(
        self, *, system_prompt: str, prompt: str, images: list[bytes], timer=None
    ) -> AsyncIterator[str]:
        self.calls.append({"system_prompt": system_prompt, "prompt": prompt, "images": images})
        outcome = self._outcomes.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        for token in outcome:  # type: ignore[union-attr]
            yield token


class _FakeTextProvider:
    def __init__(self, outcomes: list[object]) -> None:
        self._outcomes = list(outcomes)
        self.calls: list[dict[str, object]] = []

    def stream_chat(self, *, system_prompt: str, user_prompt: str, timer=None):
        self.calls.append({"system_prompt": system_prompt, "user_prompt": user_prompt})
        outcome = self._outcomes.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        return iter(outcome)  # type: ignore[arg-type]


async def _collect(agen) -> list[object]:
    return [item async for item in agen]


async def test_a_multi_batch_text_only_document_never_calls_the_vision_model() -> None:
    data = _text_pdf(6)
    plan = plan_pdf_batches(data, batch_size=3, max_pages=100)
    assert plan.needs_batching is True
    assert all(b.mode == "text" for b in plan.batches)

    vision = _FakeVisionService(outcomes=[])
    text = _FakeTextProvider(
        outcomes=[
            ["batch one summary"],
            ["batch two summary"],
            ["Final ", "answer."],
        ]
    )

    updates = await _collect(
        stream_batched_pdf_analysis(
            pdf_data=data,
            plan=plan,
            query="Summarize this document",
            sources=[],
            attachment_citations=[],
            project_context=None,
            vision_service=vision,
            text_provider=text,
            max_retries=2,
        )
    )

    assert vision.calls == []  # never touched — every batch was text-mode
    assert len(text.calls) == 3  # 2 batches + 1 reduce call

    tokens = [u.text for u in updates if isinstance(u, GenToken)]
    assert "".join(tokens) == "Final answer."
    progress_lines = [u.detail for u in updates if isinstance(u, GenProgress)]
    assert any("1/2" in line for line in progress_lines)
    assert any("2/2" in line for line in progress_lines)
    assert any("Combining findings" in line for line in progress_lines)
    assert any("Generating final response" in line for line in progress_lines)

    # No progress ever appears after the first token — mirrors the SSE
    # layer's own "progress only ever precedes tokens" contract (see
    # app/schemas/chat.py's ChatProgressEvent docstring).
    first_token_index = next(i for i, u in enumerate(updates) if isinstance(u, GenToken))
    assert all(isinstance(u, GenToken) for u in updates[first_token_index:])


async def test_a_vision_mode_batch_renders_and_calls_the_vision_model() -> None:
    data = _image_pdf(2)
    plan = plan_pdf_batches(data, batch_size=5, max_pages=100)
    assert plan.batches[0].mode == "vision"

    vision = _FakeVisionService(outcomes=[["saw two figures"]])
    text = _FakeTextProvider(outcomes=[["Final answer about the figures."]])

    updates = await _collect(
        stream_batched_pdf_analysis(
            pdf_data=data,
            plan=plan,
            query="Describe the figures",
            sources=[],
            attachment_citations=[],
            project_context=None,
            vision_service=vision,
            text_provider=text,
            max_retries=1,
        )
    )

    assert len(vision.calls) == 1
    assert len(vision.calls[0]["images"]) == 2  # both pages of the one batch
    tokens = "".join(u.text for u in updates if isinstance(u, GenToken))
    assert tokens == "Final answer about the figures."


async def test_a_batch_that_fails_then_succeeds_is_retried_transparently() -> None:
    data = _text_pdf(3)
    plan = plan_pdf_batches(data, batch_size=10, max_pages=100)  # exactly one batch
    assert len(plan.batches) == 1

    text = _FakeTextProvider(
        outcomes=[
            VisionServiceError("transient", category=VisionErrorCategory.OTHER),
            ["batch summary after retry"],
            ["Final answer."],
        ]
    )
    vision = _FakeVisionService(outcomes=[])

    updates = await _collect(
        stream_batched_pdf_analysis(
            pdf_data=data,
            plan=plan,
            query="q",
            sources=[],
            attachment_citations=[],
            project_context=None,
            vision_service=vision,
            text_provider=text,
            max_retries=2,
        )
    )

    assert len(text.calls) == 3  # 1 failed attempt + 1 successful retry for the batch, + 1 reduce call
    progress_lines = [u.detail for u in updates if isinstance(u, GenProgress)]
    assert not any("could not be analyzed" in line for line in progress_lines)
    tokens = "".join(u.text for u in updates if isinstance(u, GenToken))
    assert tokens == "Final answer."


async def test_a_batch_that_exhausts_retries_is_skipped_not_fatal() -> None:
    data = _text_pdf(6)
    plan = plan_pdf_batches(data, batch_size=3, max_pages=100)
    assert len(plan.batches) == 2

    always_fails = VisionServiceError("down", category=VisionErrorCategory.OTHER)
    text = _FakeTextProvider(
        outcomes=[
            always_fails,
            always_fails,  # batch 1: 1 initial attempt + 1 retry (max_retries=1), both fail
            ["batch two summary"],  # batch 2 succeeds on its first attempt
            ["Final answer using only batch two."],  # reduce
        ]
    )
    vision = _FakeVisionService(outcomes=[])

    updates = await _collect(
        stream_batched_pdf_analysis(
            pdf_data=data,
            plan=plan,
            query="q",
            sources=[],
            attachment_citations=[],
            project_context=None,
            vision_service=vision,
            text_provider=text,
            max_retries=1,
        )
    )

    progress_lines = [u.detail for u in updates if isinstance(u, GenProgress)]
    assert any("could not be analyzed" in line for line in progress_lines)
    tokens = "".join(u.text for u in updates if isinstance(u, GenToken))
    assert tokens == "Final answer using only batch two."

    # The reduce prompt must mention the failed range so the user-facing
    # answer can honestly note the gap rather than silently hiding it.
    reduce_call = text.calls[-1]
    assert "could not be analyzed" in reduce_call["user_prompt"] or "1-3" in str(
        reduce_call["user_prompt"]
    )


async def test_every_batch_failing_raises_instead_of_producing_an_empty_answer() -> None:
    data = _text_pdf(3)
    plan = plan_pdf_batches(data, batch_size=10, max_pages=100)
    assert len(plan.batches) == 1

    always_fails = VisionServiceError("down", category=VisionErrorCategory.OTHER)
    text = _FakeTextProvider(outcomes=[always_fails, always_fails])  # 1 attempt + 1 retry
    vision = _FakeVisionService(outcomes=[])

    with pytest.raises(VisionServiceError):
        await _collect(
            stream_batched_pdf_analysis(
                pdf_data=data,
                plan=plan,
                query="q",
                sources=[],
                attachment_citations=[],
                project_context=None,
                vision_service=vision,
                text_provider=text,
                max_retries=1,
            )
        )
