"""Runs the batched PDF-analysis pipeline for a PDF attachment whose page
count doesn't fit in one vision call (see app/services/pdf_batch_planner.py
for how a document is split into batches, and app/api/routes_conversations.py
for where this is invoked instead of the older single-call
render_attachments_to_images path — only ever for a plan with 2+ batches;
a document that fits in one batch keeps using that older, unchanged path,
so nothing about today's latency/UX changes for an ordinary small
attachment).

Pipeline, sequential and "map, then reduce":

1. For each batch (in page order): render just that batch's pages (a
   vision-mode batch) or use their already-extracted text (a text-mode
   batch, no rendering, no vision call at all — see the planner's
   docstring), and ask the appropriate model for a short, factual,
   citation-free summary of what's relevant to the user's question. A
   batch that still fails after `max_retries` extra attempts is skipped
   (not aborted): the pipeline continues with the rest of the document
   and the reduce step is told which ranges are missing, so one bad
   batch never sinks the whole answer.
2. Once every batch has been attempted, the per-batch summaries (plus any
   retrieved corpus sources) are handed to the fast *text* model — the
   images are gone by this point, so there is no reason to pay vision
   latency again — which streams the single, comprehensive, citation-
   aware answer the user actually reads.

Only one batch's rendered page images are ever held in memory at once
(discarded before the next batch starts) — this, not any special "memory
optimization," is what keeps this pipeline's memory footprint roughly
constant regardless of document length; a 500-page document costs about
the same peak memory as a 20-page one, only more wall-clock time.

Yields GenerationUpdate items (see app/core/generation_events.py):
GenProgress before and between every batch and during the reduce step,
GenToken only for the final reduce answer's real output — progress and
tokens are never interleaved within the same phase, which is what lets
the SSE layer (routes_conversations.py) map this straight onto the
existing "progress events only ever precede token events" ChatEvent
contract (app/schemas/chat.py) without changing it.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Protocol

from app.core.citation import Citation
from app.core.errors import LLMProviderError, VisionErrorCategory, VisionServiceError
from app.core.generation_events import GenerationUpdate, GenProgress, GenToken
from app.core.request_timing import RequestTimer
from app.core.retrieval_schemas import RetrievedChunk
from app.core.vision_batch_prompt_builder import build_batch_prompt, build_reduce_prompt
from app.services.pdf_batch_planner import BatchPlan, PageBatch
from app.services.vision_service import (
    DEFAULT_MAX_IMAGE_DIMENSION,
    DEFAULT_RENDER_DPI,
    VisionService,
    render_pdf_page_list,
    resize_image,
)


class TextChatProvider(Protocol):
    """The one method of app.core.llm_provider.OllamaLLMProvider this
    module actually calls — a Protocol (not that concrete class) so a
    test can supply a trivial fake, matching this codebase's existing
    convention (see e.g. VisionService's own _AsyncVisionCapableClient)."""

    def stream_chat(
        self, *, system_prompt: str, user_prompt: str, timer: RequestTimer | None = None
    ) -> object: ...  # returns Iterator[str]; typed as object to keep this Protocol import-light


def _range_label(start_page: int, end_page: int) -> str:
    return f"page {start_page}" if start_page == end_page else f"pages {start_page}-{end_page}"


def _render_batch_images(
    pdf_data: bytes,
    batch: PageBatch,
    *,
    dpi: int,
    max_image_dimension: int,
    timer: RequestTimer | None,
) -> list[bytes]:
    page_numbers = [p.page_number for p in batch.pages]
    if timer is not None:
        with timer.stage("vision_batch_render"):
            rendered = render_pdf_page_list(pdf_data, page_numbers, dpi=dpi)
    else:
        rendered = render_pdf_page_list(pdf_data, page_numbers, dpi=dpi)
    return [resize_image(page, max_dimension=max_image_dimension) for page in rendered]


async def _run_batch_with_retry(
    batch: PageBatch,
    *,
    pdf_data: bytes,
    query: str,
    total_pages: int,
    vision_service: VisionService,
    text_provider: TextChatProvider,
    max_retries: int,
    render_dpi: int,
    max_image_dimension: int,
    timer: RequestTimer | None,
) -> str | None:
    """Attempts this one batch's analysis call up to `max_retries + 1`
    times total. Returns the batch's summary text, or None once every
    attempt has failed (a transient VisionServiceError/LLMProviderError —
    e.g. a stalled/overloaded model — each time) or every attempt
    produced empty output. Never raises: a batch that cannot be analyzed
    is the caller's (stream_batched_pdf_analysis's) concern to record and
    continue past, not this function's to escalate."""
    page_text = (
        "\n\n".join(f"[page {p.page_number}]\n{p.text}" for p in batch.pages)
        if batch.mode == "text"
        else ""
    )
    system_prompt, user_prompt = build_batch_prompt(
        query,
        start_page=batch.start_page,
        end_page=batch.end_page,
        total_pages=total_pages,
        mode=batch.mode,
        page_text=page_text,
    )

    for _attempt in range(max_retries + 1):
        try:
            if batch.mode == "vision":
                images = _render_batch_images(
                    pdf_data,
                    batch,
                    dpi=render_dpi,
                    max_image_dimension=max_image_dimension,
                    timer=timer,
                )
                parts = [
                    token
                    async for token in vision_service.stream_chat(
                        system_prompt=system_prompt, prompt=user_prompt, images=images, timer=timer
                    )
                ]
            else:
                parts = list(
                    text_provider.stream_chat(  # type: ignore[attr-defined]
                        system_prompt=system_prompt, user_prompt=user_prompt, timer=timer
                    )
                )
            summary = "".join(parts).strip()
            return summary or None
        except (VisionServiceError, LLMProviderError):
            continue
    return None


async def stream_batched_pdf_analysis(
    *,
    pdf_data: bytes,
    plan: BatchPlan,
    query: str,
    sources: list[RetrievedChunk],
    attachment_citations: list[Citation],
    project_context: str | None,
    vision_service: VisionService,
    text_provider: TextChatProvider,
    max_retries: int,
    render_dpi: int = DEFAULT_RENDER_DPI,
    max_image_dimension: int = DEFAULT_MAX_IMAGE_DIMENSION,
    timer: RequestTimer | None = None,
) -> AsyncIterator[GenerationUpdate]:
    """Only ever called for `plan.needs_batching` (2+ batches) — a 0- or
    1-batch plan is handled by the older single-call path instead (see
    the module docstring), so this function does not special-case either.

    Raises VisionServiceError only if literally every batch fails (there
    is nothing left to reduce) — any smaller number of failures is
    reported to the reduce step as a gap (see build_reduce_prompt's
    `failed_ranges`) and the pipeline still produces a best-effort answer
    from whatever did succeed."""
    batch_summaries: list[tuple[int, int, str]] = []
    failed_ranges: list[tuple[int, int]] = []
    total_batches = len(plan.batches)

    for index, batch in enumerate(plan.batches, start=1):
        label = _range_label(batch.start_page, batch.end_page)
        yield GenProgress(
            detail=f"Analyzing {label} of {plan.total_page_count} ({index}/{total_batches})…"
        )

        summary = await _run_batch_with_retry(
            batch,
            pdf_data=pdf_data,
            query=query,
            total_pages=plan.total_page_count,
            vision_service=vision_service,
            text_provider=text_provider,
            max_retries=max_retries,
            render_dpi=render_dpi,
            max_image_dimension=max_image_dimension,
            timer=timer,
        )
        if summary is None:
            failed_ranges.append((batch.start_page, batch.end_page))
            yield GenProgress(detail=f"{label} could not be analyzed — continuing")
        else:
            batch_summaries.append((batch.start_page, batch.end_page, summary))
            yield GenProgress(detail=f"✓ {label} processed ({index}/{total_batches})")

    if timer is not None and timer.enabled:
        timer.record_metric("vision_batch_count", total_batches)
        timer.record_metric("vision_batch_failed_count", len(failed_ranges))

    if not batch_summaries:
        raise VisionServiceError(
            "This document's pages could not be analyzed — the model failed on every part. "
            "Try again, or with a smaller document.",
            category=VisionErrorCategory.OTHER,
        )

    yield GenProgress(detail="Combining findings…")
    reduce_system, reduce_user = build_reduce_prompt(
        query,
        sources=sources,
        attachment_citations=attachment_citations,
        batch_summaries=batch_summaries,
        failed_ranges=failed_ranges,
        truncated_at_page=plan.analyzed_page_count if plan.truncated else None,
        total_pages=plan.total_page_count,
        project_context=project_context,
    )

    yield GenProgress(detail="Generating final response…")
    for token in text_provider.stream_chat(  # type: ignore[attr-defined]
        system_prompt=reduce_system, user_prompt=reduce_user, timer=timer
    ):
        yield GenToken(text=token)
