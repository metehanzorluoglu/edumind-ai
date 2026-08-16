"""Milestone 4.1 (Authoritative Metadata Enrichment & Duplicate Awareness)
§36 — tests for app/core/bibliographic_enrichment_service.py::
enrich_document, the one orchestration function both trigger paths call.
Uses a real DocumentsRepository against a temp on-disk SQLite DB (same
"real repository, fake everything external" convention as
tests/unit/core/test_document_ingestion_jobs.py) and a scripted fake
CrossrefProvider (bypasses CrossrefProvider.__init__ entirely — no real
httpx.Client — same pattern test_evidence_shadow.py uses for
EvidenceClient)."""

from __future__ import annotations

import os
import tempfile
import uuid
from collections.abc import Iterator
from datetime import UTC, datetime

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.config import Settings
from app.core.bibliographic_enrichment import (
    CrossrefProvider,
    CrossrefWork,
    EnrichmentLookupOutcome,
    NormalizedAuthor,
)
from app.core.bibliographic_enrichment_service import enrich_document, has_usable_doi
from app.db.base import Base
from app.db.documents_repository import DocumentsRepository
from app.db.models_auth import User
from app.ingestion.loaders.base import ExtractionSource
from app.ingestion.metadata_schema import DocumentMetadata

_JWT_SECRET = "x" * 32


class _FakeProvider(CrossrefProvider):
    """Bypasses CrossrefProvider.__init__ (no real httpx.Client) — scripts
    one outcome per lookup_by_doi() call and records what it was asked to
    look up."""

    def __init__(self, outcome: EnrichmentLookupOutcome) -> None:
        self._outcome = outcome
        self.calls: list[str] = []

    def lookup_by_doi(self, doi: str) -> EnrichmentLookupOutcome:
        self.calls.append(doi)
        return self._outcome


class _FakeVectorStore:
    def __init__(self, *, raises: Exception | None = None) -> None:
        self._raises = raises
        self.calls: list[dict[str, object]] = []

    def update_chunk_metadata(
        self, document_id: str, *, user_id: str, updates: dict[str, object]
    ) -> int:
        self.calls.append({"document_id": document_id, "user_id": user_id, "updates": updates})
        if self._raises is not None:
            raise self._raises
        return 1


def _settings(*, enabled: bool = True) -> Settings:
    return Settings(jwt_secret=_JWT_SECRET, bibliographic_enrichment_enabled=enabled)


def _work(**overrides: object) -> CrossrefWork:
    defaults: dict[str, object] = {
        "doi": "10.1234/x",
        "title": "Authoritative Title",
        "authors": (NormalizedAuthor("Jane Smith"),),
        "publication_year": 2021,
        "venue": "Journal of Things",
        "document_type": "journal_article",
    }
    defaults.update(overrides)
    return CrossrefWork(**defaults)  # type: ignore[arg-type]


@pytest.fixture
def db_session() -> Iterator[Session]:
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    engine = create_engine(f"sqlite:///{path}", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    session = factory()
    try:
        yield session
    finally:
        session.close()
        engine.dispose()
        os.remove(path)


def _make_user(db_session: Session) -> uuid.UUID:
    user = User(id=uuid.uuid4(), email=f"{uuid.uuid4()}@example.com")
    db_session.add(user)
    db_session.commit()
    return user.id


def _make_document(
    db_session: Session,
    user_id: uuid.UUID,
    *,
    doi: str | None = "10.1234/x",
    title: str | None = None,
    title_source: str | None = None,
    document_type: str = "unknown",
) -> str:
    repository = DocumentsRepository(db_session)
    document_id = str(uuid.uuid4())
    sources: dict[str, str] = {}
    if title_source:
        sources["title"] = title_source
    metadata = DocumentMetadata(
        document_id=document_id,
        source_filename="paper.pdf",
        file_format="pdf",
        sha256=uuid.uuid4().hex + uuid.uuid4().hex,
        file_size_bytes=1000,
        page_count=3,
        document_type=document_type,  # type: ignore[arg-type]
        title=title,
        doi=doi,
        metadata_sources=sources,
        ingested_at=datetime.now(UTC),
    )
    repository.create(user_id=user_id, metadata=metadata, chunk_count=3)
    return document_id


class TestDisabledAndEligibility:
    def test_disabled_returns_early_without_touching_repository(self, db_session: Session) -> None:
        user_id = _make_user(db_session)
        document_id = _make_document(db_session, user_id)
        provider = _FakeProvider(EnrichmentLookupOutcome(ok=True, work=_work()))

        result = enrich_document(
            user_id=user_id,
            document_id=document_id,
            documents_repository=DocumentsRepository(db_session),
            provider=provider,
            settings=_settings(enabled=False),
        )

        assert result.ok is False
        assert result.status == "disabled"
        assert provider.calls == []

    def test_no_doi_returns_early_without_calling_provider(self, db_session: Session) -> None:
        user_id = _make_user(db_session)
        document_id = _make_document(db_session, user_id, doi=None)
        provider = _FakeProvider(EnrichmentLookupOutcome(ok=True, work=_work()))

        result = enrich_document(
            user_id=user_id,
            document_id=document_id,
            documents_repository=DocumentsRepository(db_session),
            provider=provider,
            settings=_settings(),
        )

        assert result.ok is False
        assert result.status == "no_doi"
        assert provider.calls == []

    def test_missing_document_reports_not_found(self, db_session: Session) -> None:
        user_id = _make_user(db_session)
        provider = _FakeProvider(EnrichmentLookupOutcome(ok=True, work=_work()))

        result = enrich_document(
            user_id=user_id,
            document_id="does-not-exist",
            documents_repository=DocumentsRepository(db_session),
            provider=provider,
            settings=_settings(),
        )

        assert result.ok is False
        assert result.status == "not_found_document"


class TestSuccessfulEnrichment:
    def test_fills_missing_fields_and_records_status(self, db_session: Session) -> None:
        user_id = _make_user(db_session)
        document_id = _make_document(db_session, user_id)
        provider = _FakeProvider(EnrichmentLookupOutcome(ok=True, work=_work()))
        repository = DocumentsRepository(db_session)

        result = enrich_document(
            user_id=user_id,
            document_id=document_id,
            documents_repository=repository,
            provider=provider,
            settings=_settings(),
        )

        assert result.ok is True
        assert result.status == "succeeded"
        assert "title" in result.fields_updated
        assert "document_type" in result.fields_updated

        record = repository.get(user_id, document_id)
        assert record is not None
        assert record.title == "Authoritative Title"
        assert record.document_type == "journal_article"
        assert record.metadata_sources["title"] == ExtractionSource.AUTHORITATIVE.value
        assert record.enrichment_status == "succeeded"
        assert record.enrichment_provider == "crossref"
        assert record.last_enriched_at is not None

    def test_user_sourced_title_is_preserved(self, db_session: Session) -> None:
        user_id = _make_user(db_session)
        document_id = _make_document(
            db_session,
            user_id,
            title="My Manually Corrected Title",
            title_source=ExtractionSource.USER.value,
        )
        provider = _FakeProvider(EnrichmentLookupOutcome(ok=True, work=_work()))
        repository = DocumentsRepository(db_session)

        result = enrich_document(
            user_id=user_id,
            document_id=document_id,
            documents_repository=repository,
            provider=provider,
            settings=_settings(),
        )

        assert "title" not in result.fields_updated
        assert result.manual_fields_preserved == 1
        record = repository.get(user_id, document_id)
        assert record is not None
        assert record.title == "My Manually Corrected Title"
        assert record.metadata_sources["title"] == ExtractionSource.USER.value

    def test_concrete_existing_document_type_is_not_overwritten(self, db_session: Session) -> None:
        user_id = _make_user(db_session)
        document_id = _make_document(db_session, user_id, document_type="book")
        provider = _FakeProvider(
            EnrichmentLookupOutcome(ok=True, work=_work(document_type="journal_article"))
        )
        repository = DocumentsRepository(db_session)

        enrich_document(
            user_id=user_id,
            document_id=document_id,
            documents_repository=repository,
            provider=provider,
            settings=_settings(),
        )

        record = repository.get(user_id, document_id)
        assert record is not None
        assert record.document_type == "book"

    def test_qdrant_sync_receives_only_display_fields(self, db_session: Session) -> None:
        user_id = _make_user(db_session)
        document_id = _make_document(db_session, user_id)
        provider = _FakeProvider(EnrichmentLookupOutcome(ok=True, work=_work()))
        vector_store = _FakeVectorStore()

        result = enrich_document(
            user_id=user_id,
            document_id=document_id,
            documents_repository=DocumentsRepository(db_session),
            provider=provider,
            settings=_settings(),
            vector_store=vector_store,  # type: ignore[arg-type]
        )

        assert result.qdrant_sync_failed is False
        assert len(vector_store.calls) == 1
        synced = vector_store.calls[0]
        assert synced["document_id"] == document_id
        assert synced["user_id"] == str(user_id)
        # document_type changed too, but must NOT be mirrored to Qdrant
        # (Section 30 — never a retrieval-filter field).
        assert "document_type" not in synced["updates"]  # type: ignore[operator]
        assert synced["updates"]["title"] == "Authoritative Title"  # type: ignore[index]

    def test_qdrant_sync_failure_does_not_lose_the_sql_update(self, db_session: Session) -> None:
        from app.vectorstore.errors import VectorStoreError

        user_id = _make_user(db_session)
        document_id = _make_document(db_session, user_id)
        provider = _FakeProvider(EnrichmentLookupOutcome(ok=True, work=_work()))
        vector_store = _FakeVectorStore(raises=VectorStoreError("qdrant down"))
        repository = DocumentsRepository(db_session)

        result = enrich_document(
            user_id=user_id,
            document_id=document_id,
            documents_repository=repository,
            provider=provider,
            settings=_settings(),
            vector_store=vector_store,  # type: ignore[arg-type]
        )

        assert result.ok is True
        assert result.qdrant_sync_failed is True
        record = repository.get(user_id, document_id)
        assert record is not None
        assert record.title == "Authoritative Title"  # SQL update NOT rolled back

    def test_no_vector_store_provided_skips_sync_cleanly(self, db_session: Session) -> None:
        user_id = _make_user(db_session)
        document_id = _make_document(db_session, user_id)
        provider = _FakeProvider(EnrichmentLookupOutcome(ok=True, work=_work()))

        result = enrich_document(
            user_id=user_id,
            document_id=document_id,
            documents_repository=DocumentsRepository(db_session),
            provider=provider,
            settings=_settings(),
            vector_store=None,
        )

        assert result.ok is True
        assert result.qdrant_sync_failed is False

    def test_already_current_metadata_updates_status_but_no_fields(
        self, db_session: Session
    ) -> None:
        user_id = _make_user(db_session)
        document_id = _make_document(db_session, user_id)
        repository = DocumentsRepository(db_session)
        provider = _FakeProvider(EnrichmentLookupOutcome(ok=True, work=_work()))
        enrich_document(
            user_id=user_id,
            document_id=document_id,
            documents_repository=repository,
            provider=provider,
            settings=_settings(),
        )

        # Second run, same provider data — nothing left to change.
        provider2 = _FakeProvider(EnrichmentLookupOutcome(ok=True, work=_work()))
        result = enrich_document(
            user_id=user_id,
            document_id=document_id,
            documents_repository=repository,
            provider=provider2,
            settings=_settings(),
        )
        assert result.ok is True
        assert result.fields_updated == ()

    def test_refresh_picks_up_updated_authoritative_data(self, db_session: Session) -> None:
        user_id = _make_user(db_session)
        document_id = _make_document(db_session, user_id)
        repository = DocumentsRepository(db_session)
        enrich_document(
            user_id=user_id,
            document_id=document_id,
            documents_repository=repository,
            provider=_FakeProvider(EnrichmentLookupOutcome(ok=True, work=_work())),
            settings=_settings(),
        )

        updated_work = _work(title="A Corrected Crossref Title")
        result = enrich_document(
            user_id=user_id,
            document_id=document_id,
            documents_repository=repository,
            provider=_FakeProvider(EnrichmentLookupOutcome(ok=True, work=updated_work)),
            settings=_settings(),
        )
        assert result.fields_updated == ("title",)
        record = repository.get(user_id, document_id)
        assert record is not None
        assert record.title == "A Corrected Crossref Title"


class TestFailedLookup:
    @pytest.mark.parametrize(
        "failure", ["not_found", "timeout", "unavailable", "rate_limited", "malformed_response"]
    )
    def test_failure_leaves_metadata_untouched_and_records_status(
        self, db_session: Session, failure: str
    ) -> None:
        user_id = _make_user(db_session)
        document_id = _make_document(db_session, user_id, title="Original Title")
        repository = DocumentsRepository(db_session)
        provider = _FakeProvider(EnrichmentLookupOutcome(ok=False, failure=failure))  # type: ignore[arg-type]

        result = enrich_document(
            user_id=user_id,
            document_id=document_id,
            documents_repository=repository,
            provider=provider,
            settings=_settings(),
        )

        assert result.ok is False
        assert result.status == failure
        record = repository.get(user_id, document_id)
        assert record is not None
        assert record.title == "Original Title"
        assert record.enrichment_status == failure
        assert record.enrichment_provider == "crossref"
        assert record.last_enriched_at is not None


class TestHasUsableDoi:
    def test_true_for_a_normalizable_doi(self, db_session: Session) -> None:
        user_id = _make_user(db_session)
        document_id = _make_document(db_session, user_id, doi="10.1234/abc")
        record = DocumentsRepository(db_session).get(user_id, document_id)
        assert record is not None
        assert has_usable_doi(record) is True

    def test_false_when_no_doi(self, db_session: Session) -> None:
        user_id = _make_user(db_session)
        document_id = _make_document(db_session, user_id, doi=None)
        record = DocumentsRepository(db_session).get(user_id, document_id)
        assert record is not None
        assert has_usable_doi(record) is False
