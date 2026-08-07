"""Splits a PDF into page batches for the batched vision-analysis pipeline
(see app/services/vision_batch_orchestrator.py) — pure, synchronous,
Ollama-free page classification and grouping, so the batching policy
itself is unit-testable without any network/model dependency.

Replaces the old "render at most min(vision_max_pdf_pages,
vision_max_images_per_message) pages, silently drop the rest" behavior
(app/services/vision_service.py's render_attachments_to_images, still used
unchanged for a bare image attachment or a PDF with an explicit,
user-chosen page range) for a PDF attachment with no explicit range:
instead of one oversized vision call, the whole document — up to
vision_batch_max_pages, a much higher safety ceiling than the old limit,
see app/config.py — is split into small sequential batches the
orchestrator processes one at a time. That one-batch-at-a-time contract is
also what keeps memory bounded for a very large document: only one
batch's rendered page images are ever in memory at once, never the whole
document's.

Two optimizations live here, both purely about *deciding what a page
needs*, never about calling a model:

- Blank-page skip: a page with no extractable text and no embedded image
  contributes nothing and is dropped before batching — it never occupies
  a batch slot, is never rendered, and is never sent to any model.
- Text/vision routing: a page with a real digital text layer and no
  embedded image is analyzed directly from its extracted text by the fast
  text model, never rendered to an image or sent to the much slower
  vision model at all — the majority case for an ordinary research paper,
  book, or report. A batch is "vision" mode if *any* of its pages need
  it (a single vision call can only take images, so a mixed batch renders
  every page in it, text-safe or not, rather than splitting further); a
  batch is "text" mode only when every page in it is a clean digital-text
  page.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

import pymupdf

from app.core.errors import VisionErrorCategory, VisionServiceError

PageMode = Literal["blank", "text", "vision"]

# A page with fewer extracted characters than this (and no embedded image)
# is treated as blank — deliberately small and separate from
# `text_min_chars` (the "good enough to skip vision" threshold): this only
# catches genuinely empty pages (a chapter divider, a running header/
# footer with nothing else), not merely sparse ones, which fall through to
# "vision" instead (see PageClassification's docstring) rather than being
# guessed at from too little text.
_BLANK_TEXT_THRESHOLD = 3


@dataclass(frozen=True)
class PageClassification:
    """One page's content shape, decided purely from what PyMuPDF can
    extract from the PDF's own text/image layers — nothing is rendered to
    an image yet at this point.

    - "blank": no extractable text (or fewer than `_BLANK_TEXT_THRESHOLD`
      characters) and no embedded image — skipped entirely.
    - "text": at least `text_min_chars` of extractable text and no
      embedded image — analyzed directly from `text` by the fast text
      model, never rendered or sent to the vision model.
    - "vision": everything else — a scanned page with too little/no
      extractable text, or any page carrying an embedded image (a figure,
      photo, chart, or scanned diagram) — rendered to an image and
      analyzed by the vision model. A plain vector-drawn table/rule
      (no embedded raster image) still classifies as "text" here: a text
      extraction of its cell contents is a faithful, much cheaper
      representation, and treating every hairline rule as "needs vision"
      would defeat the whole optimization on ordinary text pages.
    """

    page_number: int  # 1-indexed
    mode: PageMode
    text: str


@dataclass(frozen=True)
class PageBatch:
    """A contiguous run of non-blank pages processed together as one
    model call."""

    start_page: int
    end_page: int
    mode: Literal["text", "vision"]
    pages: tuple[PageClassification, ...]

    @property
    def page_count(self) -> int:
        return len(self.pages)


@dataclass(frozen=True)
class BatchPlan:
    """The whole document's batching decision. `total_page_count` is
    always the PDF's real page count, even when `truncated` is True — the
    caller/UI can always report "analyzed the first N of M pages"
    honestly rather than silently pretending the document was shorter
    than it is (see VISION_BATCH_MAX_PAGES's docstring for why analysis
    still has a ceiling instead of no limit at all)."""

    total_page_count: int
    analyzed_page_count: int  # pages actually included in `batches` — excludes blanks and anything past the truncation ceiling
    truncated: bool
    skipped_blank_pages: tuple[int, ...]
    batches: tuple[PageBatch, ...]

    @property
    def needs_batching(self) -> bool:
        """False for a document that fits in a single batch (including a
        zero-batch, all-blank-pages document) — the orchestrator's
        single-call fast path (see vision_batch_orchestrator.py) applies
        whenever this is False, preserving today's plain single-shot
        vision latency/UX for anything that doesn't actually need
        splitting."""
        return len(self.batches) > 1


def plan_pdf_batches(
    data: bytes,
    *,
    batch_size: int,
    max_pages: int,
    text_min_chars: int = 40,
) -> BatchPlan:
    """Opens `data` once, classifies up to `max_pages` of its pages (see
    BatchPlan.truncated when the document has more), drops blank pages,
    and groups what's left into batches of up to `batch_size` pages each.

    Raises VisionServiceError only if the PDF itself can't be opened or
    has zero pages — mirroring app/services/vision_service.py's
    render_pdf_pages error contract for those two cases. Never raises for
    "too many pages": that's the entire point of this module over the
    single-call path it replaces (see the module docstring) — an
    oversized document is truncated at `max_pages`, not rejected.
    """
    if batch_size < 1:
        raise ValueError(f"batch_size must be >= 1, got {batch_size}")

    try:
        document = pymupdf.open(stream=data, filetype="pdf")  # type: ignore[no-untyped-call]
    except Exception as exc:
        raise VisionServiceError(
            f"Could not read PDF data: {exc}", category=VisionErrorCategory.PREPROCESSING_FAILURE
        ) from exc

    with document:
        total_page_count = document.page_count
        if total_page_count == 0:
            raise VisionServiceError(
                "PDF has no pages", category=VisionErrorCategory.PREPROCESSING_FAILURE
            )

        truncated = total_page_count > max_pages
        pages_to_classify = min(total_page_count, max_pages)

        classifications: list[PageClassification] = []
        for index in range(pages_to_classify):
            page = document[index]  # type: ignore[no-untyped-call]
            text = page.get_text("text").strip()  # type: ignore[no-untyped-call]
            has_embedded_image = bool(page.get_images())  # type: ignore[no-untyped-call]

            mode: PageMode
            if len(text) < _BLANK_TEXT_THRESHOLD and not has_embedded_image:
                mode = "blank"
            elif len(text) >= text_min_chars and not has_embedded_image:
                mode = "text"
            else:
                mode = "vision"
            classifications.append(PageClassification(page_number=index + 1, mode=mode, text=text))

    skipped_blank_pages = tuple(p.page_number for p in classifications if p.mode == "blank")
    content_pages = [p for p in classifications if p.mode != "blank"]

    batches: list[PageBatch] = []
    for start in range(0, len(content_pages), batch_size):
        chunk = content_pages[start : start + batch_size]
        batch_mode: Literal["text", "vision"] = (
            "vision" if any(p.mode == "vision" for p in chunk) else "text"
        )
        batches.append(
            PageBatch(
                start_page=chunk[0].page_number,
                end_page=chunk[-1].page_number,
                mode=batch_mode,
                pages=tuple(chunk),
            )
        )

    return BatchPlan(
        total_page_count=total_page_count,
        analyzed_page_count=len(content_pages),
        truncated=truncated,
        skipped_blank_pages=skipped_blank_pages,
        batches=tuple(batches),
    )
