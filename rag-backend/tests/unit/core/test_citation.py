"""Covers app/core/citation.py: build_citations (pre-existing, brief
regression) and build_attachment_citations (Frontend/Platform Milestone
3.2.2 Part C) — the fix for a message attachment being able to generate a
false "[S1 — unavailable]" citation even when correctly grounded in the
attachment. See that function's docstring for the full root-cause
writeup.
"""

import uuid
from dataclasses import dataclass

from app.core.citation import build_attachment_citations, build_citations
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


# Deterministic, distinct, human-readable-by-int fake ids — real uuid.UUID
# values (matching MessageAttachmentRecord.id's actual type, so
# AttachmentLike's Protocol match is genuine, not just duck-typed) without
# any test depending on real randomness.
ATT_1 = uuid.UUID(int=1)
ATT_2 = uuid.UUID(int=2)


@dataclass
class _FakeAttachment:
    """Matches app/core/citation.py's AttachmentLike Protocol — a stand-in
    for app/db/conversations_repository.py's MessageAttachmentRecord that
    doesn't require a live database."""

    id: uuid.UUID
    original_filename: str
    page_range_start: int | None = None
    page_range_end: int | None = None


class TestBuildCitations:
    def test_assigns_s1_s2_in_order_and_marks_every_field_as_a_document(self) -> None:
        citations = build_citations([_chunk(document_id="a"), _chunk(document_id="b")])
        assert [c.source_id for c in citations] == ["S1", "S2"]
        assert all(c.source_kind == "document" for c in citations)
        assert citations[0].document_id == "a"
        assert citations[0].attachment_id is None
        assert citations[0].display_name is None


class TestBuildAttachmentCitations:
    def test_assigns_labels_starting_at_start_index(self) -> None:
        attachments = [
            _FakeAttachment(id=ATT_1, original_filename="notes.pdf"),
            _FakeAttachment(id=ATT_2, original_filename="photo.jpg"),
        ]
        citations = build_attachment_citations(attachments, start_index=3)
        assert [c.source_id for c in citations] == ["S3", "S4"]

    def test_never_collides_with_corpus_citation_numbers_in_a_mixed_message(self) -> None:
        corpus_citations = build_citations([_chunk(document_id="a"), _chunk(document_id="b")])
        attachment_citations = build_attachment_citations(
            [_FakeAttachment(id=ATT_1, original_filename="notes.pdf")],
            start_index=len(corpus_citations) + 1,
        )
        all_ids = [c.source_id for c in corpus_citations + attachment_citations]
        assert all_ids == ["S1", "S2", "S3"]
        assert len(set(all_ids)) == len(all_ids)  # no duplicate labels

    def test_marks_source_kind_attachment_and_sets_attachment_id_and_display_name(self) -> None:
        [citation] = build_attachment_citations(
            [_FakeAttachment(id=ATT_1, original_filename="my report.pdf")], start_index=1
        )
        assert citation.source_kind == "attachment"
        assert citation.attachment_id == str(ATT_1)
        assert citation.display_name == "my report.pdf"

    def test_never_fabricates_a_document_id_document_type_chunk_id_or_score(self) -> None:
        [citation] = build_attachment_citations(
            [_FakeAttachment(id=ATT_1, original_filename="notes.pdf")], start_index=1
        )
        assert citation.document_id is None
        assert citation.document_type is None
        assert citation.chunk_id is None
        assert citation.score is None

    def test_carries_a_page_range_when_the_attachment_has_one(self) -> None:
        [citation] = build_attachment_citations(
            [
                _FakeAttachment(
                    id=ATT_1,
                    original_filename="notes.pdf",
                    page_range_start=4,
                    page_range_end=6,
                )
            ],
            start_index=1,
        )
        assert citation.page_start == 4
        assert citation.page_end == 6

    def test_unique_stable_ids_across_multiple_attachments_no_collisions(self) -> None:
        attachment_ids = [uuid.UUID(int=i) for i in range(5)]
        attachments = [
            _FakeAttachment(id=attachment_id, original_filename=f"file-{i}.pdf")
            for i, attachment_id in enumerate(attachment_ids)
        ]
        citations = build_attachment_citations(attachments, start_index=1)
        ids = [c.source_id for c in citations]
        assert ids == ["S1", "S2", "S3", "S4", "S5"]
        assert len(set(ids)) == 5
        # Each citation's attachment_id stays paired with its own
        # attachment — never mixed up under enumeration.
        assert [c.attachment_id for c in citations] == [str(a) for a in attachment_ids]
