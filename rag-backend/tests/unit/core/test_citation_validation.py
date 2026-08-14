"""Covers app/core/citation_validation.py's validate_citations — both its
pre-existing corpus-only behavior and its interaction with
build_attachment_citations (Frontend/Platform Milestone 3.2.2 Part C):
an attachment citation must be recognized as known (no more false
"[S<n> — unavailable]" for a correctly-grounded attachment citation)
while a genuinely invalid id is still flagged exactly as strictly as
before — attachments must never weaken this check.
"""

import uuid

from app.core.citation import build_attachment_citations, build_citations
from app.core.citation_validation import validate_citations
from app.core.retrieval_schemas import RetrievedChunk


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


ATT_1 = uuid.UUID(int=1)
ATT_2 = uuid.UUID(int=2)


class _FakeAttachment:
    def __init__(self, id: uuid.UUID, filename: str) -> None:
        self.id = id
        self.original_filename = filename
        self.page_range_start: int | None = None
        self.page_range_end: int | None = None


class TestPreExistingCorpusBehavior:
    def test_a_citation_for_a_never_offered_source_is_flagged_unknown(self) -> None:
        result = validate_citations("The finding is clear [S1].", citations=[])
        assert result.unknown_source_ids == ["S1"]
        assert result.is_valid is False

    def test_a_citation_matching_an_offered_source_is_valid(self) -> None:
        citations = build_citations([_chunk()])
        result = validate_citations("The finding is clear [S1].", citations)
        assert result.unknown_source_ids == []
        assert result.is_valid is True


class TestAttachmentCitations:
    def test_a_citation_for_a_registered_attachment_is_recognized_as_known(self) -> None:
        attachment_citations = build_attachment_citations(
            [_FakeAttachment(ATT_1, "notes.pdf")], start_index=1
        )
        result = validate_citations("As shown in the attached file [S1].", attachment_citations)
        assert result.unknown_source_ids == []
        assert result.is_valid is True

    def test_mixed_corpus_and_attachment_citations_both_resolve(self) -> None:
        corpus_citations = build_citations([_chunk()])
        attachment_citations = build_attachment_citations(
            [_FakeAttachment(ATT_1, "notes.pdf")], start_index=len(corpus_citations) + 1
        )
        all_citations = corpus_citations + attachment_citations
        result = validate_citations(
            "The corpus says X [S1]. The attachment shows Y [S2].", all_citations
        )
        assert result.unknown_source_ids == []
        assert result.is_valid is True

    def test_a_genuinely_invalid_id_is_still_flagged_even_alongside_valid_attachment_citations(
        self,
    ) -> None:
        """The exact regression this fix must never introduce: registering
        attachments as citeable must not make validation more lenient in
        general — a model citing a label nobody ever assigned (corpus or
        attachment) is still a real hallucination and must still be
        caught."""
        attachment_citations = build_attachment_citations(
            [_FakeAttachment(ATT_1, "notes.pdf")], start_index=1
        )
        result = validate_citations(
            "As shown in the attached file [S1], and also [S99].", attachment_citations
        )
        assert result.unknown_source_ids == ["S99"]
        assert result.is_valid is False

    def test_two_attachments_never_collide_and_both_resolve(self) -> None:
        attachment_citations = build_attachment_citations(
            [_FakeAttachment(ATT_1, "a.pdf"), _FakeAttachment(ATT_2, "b.pdf")], start_index=1
        )
        result = validate_citations("See [S1] and [S2].", attachment_citations)
        assert result.unknown_source_ids == []
        assert result.is_valid is True
