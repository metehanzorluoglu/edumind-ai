"""Milestone 4.1 §32 — regression test for a gap found during production
validation: app.api.routes_conversations._message_response freshened
`message.sources[].title` (etc.) from the current `documents` row but NOT
`message.citations[].title` — a separate, raw-JSON snapshot the frontend's
visible inline citation cards actually render from (see SourceCard.tsx).
A user's manual title correction (or a future enrichment) would silently
never reach what a user actually sees under an answer.

Covers `_freshened_citations` and `_canonical_documents_for_messages`
directly as pure functions — no HTTP/DB harness needed for the former;
the latter needs only a minimal fake DocumentsRepository.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime

from app.api.routes_conversations import (
    _canonical_documents_for_messages,
    _freshened_citations,
)
from app.db.conversations_repository import MessageSourceRecord
from app.db.documents_repository import DocumentRecord


def _make_document_record(**overrides: object) -> DocumentRecord:
    defaults: dict[str, object] = {
        "document_id": "doc-1",
        "user_id": uuid.uuid4(),
        "folder_id": None,
        "sha256": "0" * 64,
        "source_filename": "paper.pdf",
        "title": "Current Canonical Title",
        "authors": ["Current Author"],
        "publication_year": 2022,
        "source_venue": "Current Venue",
        "doi": "10.1000/current",
        "source_url": "https://doi.org/10.1000/current",
        "document_type": "journal_article",
        "journal_quartile": None,
        "chunk_count": 1,
        "page_count": 1,
        "file_format": "pdf",
        "ingested_at": datetime.now(UTC),
        "storage_key": None,
        "original_mime_type": None,
        "original_file_size_bytes": None,
        "volume": None,
        "issue": None,
        "page_start": None,
        "page_end": None,
        "publisher": None,
        "abstract": None,
        "keywords": [],
        "language": None,
        "metadata_sources": {},
        "last_enriched_at": None,
        "enrichment_provider": None,
        "enrichment_status": None,
    }
    defaults.update(overrides)
    return DocumentRecord(**defaults)  # type: ignore[arg-type]


def _make_citation(**overrides: object) -> dict[str, object]:
    citation: dict[str, object] = {
        "source_id": "S1",
        "source_kind": "document",
        "document_id": "doc-1",
        "chunk_id": "chunk-1",
        "attachment_id": None,
        "display_name": None,
        "title": "Stale Snapshot Title",
        "authors": ["Stale Author"],
        "publication_year": 2019,
        "source_venue": "Stale Venue",
        "document_type": "journal_article",
        "journal_quartile": None,
        "page_start": 1,
        "page_end": 2,
        "doi": "10.1000/current",
        "source_url": "https://doi.org/10.1000/stale",
        "score": 0.9,
        "scope": "general",
    }
    citation.update(overrides)
    return citation


class TestFreshenedCitations:
    def test_overlays_current_title_and_authors_onto_a_stale_citation(self) -> None:
        canonical = {"doc-1": _make_document_record()}
        result = _freshened_citations([_make_citation()], canonical)
        assert result[0]["title"] == "Current Canonical Title"
        assert result[0]["authors"] == ["Current Author"]
        assert result[0]["publication_year"] == 2022
        assert result[0]["source_venue"] == "Current Venue"
        assert result[0]["source_url"] == "https://doi.org/10.1000/current"

    def test_never_touches_provenance_fields(self) -> None:
        canonical = {"doc-1": _make_document_record()}
        result = _freshened_citations([_make_citation()], canonical)
        assert result[0]["chunk_id"] == "chunk-1"
        assert result[0]["score"] == 0.9
        assert result[0]["page_start"] == 1
        assert result[0]["page_end"] == 2
        assert result[0]["scope"] == "general"
        # document_type/journal_quartile are deliberately excluded from
        # the freshenable set (they double as retrieval-filter fields).
        assert result[0]["document_type"] == "journal_article"

    def test_attachment_kind_citation_with_no_document_id_is_untouched(self) -> None:
        canonical = {"doc-1": _make_document_record()}
        attachment_citation = _make_citation(
            source_kind="attachment", document_id=None, attachment_id="att-1", title="my-file.pdf"
        )
        result = _freshened_citations([attachment_citation], canonical)
        assert result[0]["title"] == "my-file.pdf"

    def test_unknown_document_id_leaves_citation_unchanged(self) -> None:
        canonical: dict[str, DocumentRecord] = {}
        result = _freshened_citations([_make_citation()], canonical)
        assert result[0]["title"] == "Stale Snapshot Title"

    def test_never_blanks_a_field_the_canonical_record_lacks(self) -> None:
        canonical = {"doc-1": _make_document_record(source_venue=None)}
        result = _freshened_citations([_make_citation()], canonical)
        # Canonical has no venue — the snapshot's own venue is preserved,
        # never blanked just because the current record happens to lack it.
        assert result[0]["source_venue"] == "Stale Venue"

    def test_non_list_input_is_returned_unchanged(self) -> None:
        assert _freshened_citations(None, {}) is None
        non_list_input: object = "not-a-list"
        result: object = _freshened_citations(non_list_input, {})
        assert result == "not-a-list"


class _FakeDocumentsRepository:
    def __init__(self, records: dict[str, DocumentRecord]) -> None:
        self._records = records
        self.calls: list[str] = []

    def get(self, user_id: uuid.UUID, document_id: str) -> DocumentRecord | None:
        self.calls.append(document_id)
        return self._records.get(document_id)


@dataclass
class _FakeMessage:
    sources: list[MessageSourceRecord]
    citations: list[dict[str, object]] | None


class TestCanonicalDocumentsForMessages:
    def test_collects_document_ids_from_both_sources_and_citations(self) -> None:
        repo = _FakeDocumentsRepository(
            {
                "doc-1": _make_document_record(document_id="doc-1"),
                "doc-2": _make_document_record(document_id="doc-2"),
            }
        )
        message = _FakeMessage(
            sources=[],
            citations=[_make_citation(document_id="doc-2")],
        )
        canonical = _canonical_documents_for_messages(
            uuid.uuid4(), [message], repo  # type: ignore[list-item, arg-type]
        )
        assert set(canonical) == {"doc-2"}
        assert canonical["doc-2"].document_id == "doc-2"

    def test_deduplicates_lookups_across_sources_and_citations(self) -> None:
        repo = _FakeDocumentsRepository({"doc-1": _make_document_record(document_id="doc-1")})
        source = MessageSourceRecord(
            rank=1,
            document_id="doc-1",
            chunk_id="c1",
            chunk_index=0,
            page_number=1,
            score=0.5,
            snippet_text="...",
            title="x",
            authors=[],
            publication_year=None,
            source_venue=None,
            document_type="journal_article",
            journal_quartile=None,
            doi=None,
            source_url=None,
            source_filename="f.pdf",
            scope="general",
        )
        message = _FakeMessage(sources=[source], citations=[_make_citation(document_id="doc-1")])
        _canonical_documents_for_messages(uuid.uuid4(), [message], repo)  # type: ignore[list-item, arg-type]
        assert repo.calls.count("doc-1") == 1

    def test_ignores_attachment_citations_with_no_document_id(self) -> None:
        repo = _FakeDocumentsRepository({})
        message = _FakeMessage(
            sources=[], citations=[_make_citation(document_id=None, source_kind="attachment")]
        )
        canonical = _canonical_documents_for_messages(
            uuid.uuid4(), [message], repo  # type: ignore[list-item, arg-type]
        )
        assert canonical == {}
        assert repo.calls == []
