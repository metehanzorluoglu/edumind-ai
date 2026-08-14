"""Covers app/core/vision_prompt_builder.py — in particular Frontend/
Platform Milestone 3.2.2 Part C's fix: every attachment is now listed
with a real, sanctioned [S<n>] label the model may cite, instead of
being told citing an attachment is always forbidden (the old rule a live
smoke test already showed some vision models disobey — see this
module's own docstring for the full root-cause writeup).
"""

import uuid

from app.core.citation import build_attachment_citations, build_citations
from app.core.retrieval_schemas import RetrievedChunk
from app.core.vision_prompt_builder import build_vision_prompt, format_attachment_labels_block

ATT_1 = uuid.UUID(int=1)
ATT_2 = uuid.UUID(int=2)
ATT_3 = uuid.UUID(int=3)


def _chunk(**overrides) -> RetrievedChunk:
    defaults = {
        "score": 0.9,
        "text": "Some evidence.",
        "document_id": "doc-1",
        "chunk_id": "chunk-1",
        "document_type": "journal_article",
        "source_filename": "doc.pdf",
        "chunk_index": 0,
        "page_number": 1,
    }
    defaults.update(overrides)
    return RetrievedChunk(**defaults)


class _FakeAttachment:
    def __init__(
        self, id: uuid.UUID, filename: str, start: int | None = None, end: int | None = None
    ) -> None:
        self.id = id
        self.original_filename = filename
        self.page_range_start = start
        self.page_range_end = end


class TestFormatAttachmentLabelsBlock:
    def test_lists_each_attachment_with_its_label(self) -> None:
        citations = build_attachment_citations(
            [_FakeAttachment(ATT_1, "notes.pdf"), _FakeAttachment(ATT_2, "photo.jpg")],
            start_index=1,
        )
        block = format_attachment_labels_block(citations)
        assert "[S1] notes.pdf" in block
        assert "[S2] photo.jpg" in block

    def test_shows_a_page_range_only_when_the_attachment_has_one(self) -> None:
        [citation] = build_attachment_citations(
            [_FakeAttachment(ATT_1, "notes.pdf", start=4, end=6)], start_index=1
        )
        block = format_attachment_labels_block([citation])
        assert "[S1] notes.pdf (pages 4-6)" in block

    def test_shows_a_single_page_singular(self) -> None:
        [citation] = build_attachment_citations(
            [_FakeAttachment(ATT_1, "notes.pdf", start=4, end=4)], start_index=1
        )
        block = format_attachment_labels_block([citation])
        assert "[S1] notes.pdf (page 4)" in block


class TestBuildVisionPrompt:
    def test_vision_only_lists_the_attachment_and_permits_citing_it(self) -> None:
        attachment_citations = build_attachment_citations(
            [_FakeAttachment(ATT_1, "notes.pdf")], start_index=1
        )
        system_prompt, user_prompt = build_vision_prompt(
            "Summarize this.", [], attachment_citations
        )
        assert "[S1] notes.pdf" in user_prompt
        # The old flat prohibition is gone — the model is now told it MAY
        # cite the labeled attachment.
        assert "never write a citation marker like [S1]" not in system_prompt
        assert "S1" in system_prompt or "label" in system_prompt

    def test_vision_plus_corpus_numbers_attachments_after_corpus_sources(self) -> None:
        corpus_citations = build_citations([_chunk()])
        attachment_citations = build_attachment_citations(
            [_FakeAttachment(ATT_1, "notes.pdf")], start_index=len(corpus_citations) + 1
        )
        _, user_prompt = build_vision_prompt(
            "Summarize this.", [_chunk()], attachment_citations
        )
        assert '<source id="S1">' in user_prompt
        assert "[S2] notes.pdf" in user_prompt

    def test_multiple_attachments_all_listed_with_unique_labels(self) -> None:
        attachment_citations = build_attachment_citations(
            [
                _FakeAttachment(ATT_1, "a.pdf"),
                _FakeAttachment(ATT_2, "b.pdf"),
                _FakeAttachment(ATT_3, "c.pdf"),
            ],
            start_index=1,
        )
        _, user_prompt = build_vision_prompt("Compare these.", [], attachment_citations)
        assert "[S1] a.pdf" in user_prompt
        assert "[S2] b.pdf" in user_prompt
        assert "[S3] c.pdf" in user_prompt

    def test_question_is_the_last_thing_in_the_user_prompt(self) -> None:
        attachment_citations = build_attachment_citations(
            [_FakeAttachment(ATT_1, "notes.pdf")], start_index=1
        )
        _, user_prompt = build_vision_prompt("What is X?", [], attachment_citations)
        assert user_prompt.endswith("Question: What is X?")

    def test_project_context_still_prepended_and_rule_still_added(self) -> None:
        attachment_citations = build_attachment_citations(
            [_FakeAttachment(ATT_1, "notes.pdf")], start_index=1
        )
        system_prompt, user_prompt = build_vision_prompt(
            "Summarize.", [], attachment_citations, project_context="Studying X."
        )
        assert "<project_context>" in user_prompt
        assert "Project context rule:" in system_prompt
