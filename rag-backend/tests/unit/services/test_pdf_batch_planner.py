"""Covers app/services/pdf_batch_planner.py: page classification (blank /
text / vision) and batch grouping — the pure, Ollama-free policy behind
the "remove the artificial PDF page limit" pipeline
(app/services/vision_batch_orchestrator.py actually runs the batches this
module plans).

Every fake PDF here is generated on the fly with pymupdf, same convention
as test_vision_service.py.
"""

import pymupdf
import pytest

from app.core.errors import VisionServiceError
from app.services.pdf_batch_planner import plan_pdf_batches


def _text_pdf(page_count: int, *, chars_per_page: int = 200) -> bytes:
    """A PDF whose every page has a real, decently-sized digital text
    layer and no embedded images — the "text" classification case."""
    doc = pymupdf.open()
    body = ("Lorem ipsum dolor sit amet. " * 20)[:chars_per_page]
    for i in range(page_count):
        page = doc.new_page(width=400, height=600)
        page.insert_text((50, 72), f"Page {i + 1}\n{body}", fontsize=11)
    data = doc.tobytes()
    doc.close()
    return data


def _blank_pdf(page_count: int) -> bytes:
    doc = pymupdf.open()
    for _ in range(page_count):
        doc.new_page(width=400, height=600)
    data = doc.tobytes()
    doc.close()
    return data


def _png_bytes(width: int = 40, height: int = 40) -> bytes:
    doc = pymupdf.open()
    page = doc.new_page(width=width, height=height)
    page.draw_rect(pymupdf.Rect(0, 0, width, height), color=(0, 0, 0), fill=(0.2, 0.4, 0.8))
    pix = page.get_pixmap(matrix=pymupdf.Matrix(1, 1))
    data = bytes(pix.tobytes("png"))
    doc.close()
    return data


def _image_pdf(page_count: int) -> bytes:
    """A PDF whose every page carries an embedded raster image — the
    "vision" classification case (a figure/photo/scanned page)."""
    png = _png_bytes()
    doc = pymupdf.open()
    for _ in range(page_count):
        page = doc.new_page(width=400, height=600)
        page.insert_image(pymupdf.Rect(50, 50, 350, 350), stream=png)
    data = doc.tobytes()
    doc.close()
    return data


def _mixed_pdf(modes: list[str]) -> bytes:
    """One page per entry in `modes` ("text" | "blank" | "vision")."""
    png = _png_bytes()
    doc = pymupdf.open()
    for mode in modes:
        page = doc.new_page(width=400, height=600)
        if mode == "text":
            page.insert_text((50, 72), "Real body text. " * 10, fontsize=11)
        elif mode == "vision":
            page.insert_image(pymupdf.Rect(50, 50, 350, 350), stream=png)
        # "blank": nothing drawn
    data = doc.tobytes()
    doc.close()
    return data


class TestPageClassification:
    def test_a_page_with_real_text_and_no_image_is_classified_text(self) -> None:
        plan = plan_pdf_batches(_text_pdf(1), batch_size=10, max_pages=100)
        assert plan.batches[0].mode == "text"
        assert plan.batches[0].pages[0].mode == "text"

    def test_a_page_with_an_embedded_image_is_classified_vision(self) -> None:
        plan = plan_pdf_batches(_image_pdf(1), batch_size=10, max_pages=100)
        assert plan.batches[0].mode == "vision"
        assert plan.batches[0].pages[0].mode == "vision"

    def test_a_page_with_no_text_and_no_image_is_classified_blank_and_skipped(self) -> None:
        plan = plan_pdf_batches(_blank_pdf(3), batch_size=10, max_pages=100)
        assert plan.skipped_blank_pages == (1, 2, 3)
        assert plan.analyzed_page_count == 0
        assert plan.batches == ()

    def test_a_page_with_too_little_text_and_no_image_falls_back_to_vision(self) -> None:
        # A handful of characters — enough to not be "blank" (see
        # _BLANK_TEXT_THRESHOLD), but well under text_min_chars, so this
        # must never be trusted as "text" mode; it's conservatively routed
        # to vision instead of guessed at from too little text.
        doc = pymupdf.open()
        page = doc.new_page(width=400, height=600)
        page.insert_text((50, 72), "Fig. 3", fontsize=11)
        data = doc.tobytes()
        doc.close()

        plan = plan_pdf_batches(data, batch_size=10, max_pages=100, text_min_chars=40)
        assert plan.batches[0].mode == "vision"
        assert plan.batches[0].pages[0].mode == "vision"


class TestBatchGrouping:
    def test_a_document_that_fits_in_one_batch_needs_no_batching(self) -> None:
        plan = plan_pdf_batches(_text_pdf(3), batch_size=8, max_pages=100)
        assert len(plan.batches) == 1
        assert plan.needs_batching is False

    def test_a_document_longer_than_batch_size_is_split_into_multiple_batches(self) -> None:
        plan = plan_pdf_batches(_text_pdf(10), batch_size=4, max_pages=100)
        assert plan.needs_batching is True
        assert [b.page_count for b in plan.batches] == [4, 4, 2]
        assert plan.batches[0].start_page == 1
        assert plan.batches[0].end_page == 4
        assert plan.batches[-1].start_page == 9
        assert plan.batches[-1].end_page == 10

    def test_blank_pages_are_excluded_from_batches_but_do_not_break_numbering(self) -> None:
        # pages: text, blank, text, text — the blank one must never occupy
        # a batch slot or appear in any batch's `pages`.
        data = _mixed_pdf(["text", "blank", "text", "text"])
        plan = plan_pdf_batches(data, batch_size=2, max_pages=100)
        all_pages = [p.page_number for batch in plan.batches for p in batch.pages]
        assert 2 not in all_pages
        assert plan.skipped_blank_pages == (2,)
        assert plan.analyzed_page_count == 3

    def test_a_batch_is_vision_mode_if_any_page_in_it_needs_vision(self) -> None:
        data = _mixed_pdf(["text", "vision"])
        plan = plan_pdf_batches(data, batch_size=2, max_pages=100)
        assert len(plan.batches) == 1
        assert plan.batches[0].mode == "vision"

    def test_a_pure_text_batch_stays_text_mode(self) -> None:
        data = _mixed_pdf(["text", "text"])
        plan = plan_pdf_batches(data, batch_size=2, max_pages=100)
        assert plan.batches[0].mode == "text"

    def test_document_longer_than_max_pages_is_truncated_not_rejected(self) -> None:
        plan = plan_pdf_batches(_text_pdf(50), batch_size=8, max_pages=20)
        assert plan.truncated is True
        assert plan.total_page_count == 50
        assert plan.analyzed_page_count == 20
        assert sum(b.page_count for b in plan.batches) == 20

    def test_document_within_max_pages_is_not_truncated(self) -> None:
        plan = plan_pdf_batches(_text_pdf(5), batch_size=8, max_pages=20)
        assert plan.truncated is False
        assert plan.total_page_count == 5


class TestErrorHandling:
    def test_unreadable_bytes_raise_a_preprocessing_error(self) -> None:
        with pytest.raises(VisionServiceError):
            plan_pdf_batches(b"not a pdf", batch_size=4, max_pages=100)

    def test_batch_size_must_be_positive(self) -> None:
        with pytest.raises(ValueError):
            plan_pdf_batches(_text_pdf(1), batch_size=0, max_pages=100)


class TestVeryLargeDocumentsDontBlowUpPlanningAlone:
    """Planning itself never renders a single page image — it's pure
    text/metadata inspection — so it should stay fast and cheap even for
    a document with hundreds of pages, unlike the old single-call path
    this replaces."""

    def test_a_300_page_document_plans_without_error(self) -> None:
        plan = plan_pdf_batches(_text_pdf(300, chars_per_page=60), batch_size=8, max_pages=500)
        assert plan.total_page_count == 300
        assert plan.truncated is False
        assert len(plan.batches) == pytest.approx(300 / 8, abs=1)
