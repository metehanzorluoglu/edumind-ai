"""Milestone 4.1 (Authoritative Metadata Enrichment & Duplicate Awareness)
§36 — API-level coverage for:
  - POST /documents/{id}/enrich (the "Refresh metadata" action)
  - POST /documents/metadata-preview's new `duplicate_candidate` field
    (exact-DOI duplicate awareness, Section 23/24)
  - SHA-256 duplicate regression (Section 25 — must be unchanged: still a
    hard 409 at actual upload time)

Same harness pattern as test_routes_documents_metadata.py (real on-disk
SQLite, fake embedding provider, fake in-process Qdrant), plus a fake
CrossrefProvider wired in via dependency override so no real network call
is ever made.
"""

from __future__ import annotations

import io
import os
import tempfile
from collections.abc import Iterator
from pathlib import Path

import pymupdf
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.api.routes_documents import router as documents_router
from app.config import Settings, get_settings
from app.core.bibliographic_enrichment import (
    CrossrefProvider,
    CrossrefWork,
    EnrichmentLookupOutcome,
    NormalizedAuthor,
)
from app.core.security import get_current_user
from app.db.base import Base
from app.db.models_auth import User
from app.db.session import get_db, get_engine, get_session_factory
from app.deps import (
    get_bibliographic_provider,
    get_document_file_storage,
    get_embedding_provider,
    get_vector_store,
)
from app.services.document_file_storage import DocumentFileStorage
from app.vectorstore.qdrant_client import _point_id
from app.vectorstore.schemas import DocumentChunkContent

_TEST_JWT_SECRET = "test-only-secret-not-a-real-credential-32chars"


def _build_settings(**overrides: object) -> Settings:
    defaults: dict[str, object] = {
        "jwt_secret": _TEST_JWT_SECRET,
        "app_env": "test",
        "bibliographic_enrichment_enabled": True,
    }
    defaults.update(overrides)
    return Settings(**defaults)  # type: ignore[arg-type]


def _make_pdf_bytes(text: str) -> bytes:
    doc = pymupdf.open()
    page = doc.new_page()
    page.insert_text((72, 72), text)
    data = doc.tobytes()
    doc.close()
    return data


class _FakeEmbeddingProvider:
    dimensions = 4

    def embed_batch(self, texts: list[str]) -> list[list[float]]:
        return [[0.1, 0.2, 0.3, 0.4] for _ in texts]


class _FakeVectorStore:
    def __init__(self) -> None:
        self.update_chunk_metadata_calls: list[dict[str, object]] = []
        self._chunks: dict[str, dict[str, list[DocumentChunkContent]]] = {}

    def upsert_chunks(self, metadata, chunks, embeddings, *, user_id: str) -> None:
        by_user = self._chunks.setdefault(metadata.document_id, {})
        stored = by_user.setdefault(user_id, [])
        for chunk in chunks:
            stored.append(
                DocumentChunkContent(
                    chunk_id=_point_id(metadata.document_id, chunk.chunk_index),
                    chunk_index=chunk.chunk_index,
                    page_number=chunk.page_number,
                    text=chunk.text,
                )
            )
        stored.sort(key=lambda c: c.chunk_index)

    def get_document_chunks(self, document_id: str, *, user_id: str) -> list[DocumentChunkContent]:
        return list(self._chunks.get(document_id, {}).get(user_id, []))

    def update_chunk_metadata(self, document_id: str, *, user_id: str, updates: dict) -> int:
        self.update_chunk_metadata_calls.append(
            {"document_id": document_id, "user_id": user_id, "updates": updates}
        )
        return 1

    def delete_document(self, document_id: str, *, user_id: str) -> int:
        removed = self._chunks.get(document_id, {}).pop(user_id, [])
        return len(removed)


class _FakeProvider(CrossrefProvider):
    """Bypasses CrossrefProvider.__init__ — scripts one outcome per call,
    consumed in order (FIFO), so a test can script a sequence across
    multiple /enrich calls if it needs to."""

    def __init__(self, outcomes: list[EnrichmentLookupOutcome]) -> None:
        self._outcomes = list(outcomes)
        self.calls: list[str] = []

    def lookup_by_doi(self, doi: str) -> EnrichmentLookupOutcome:
        self.calls.append(doi)
        return self._outcomes.pop(0) if self._outcomes else EnrichmentLookupOutcome(
            ok=False, failure="unknown_error"
        )


def _work(**overrides: object) -> CrossrefWork:
    defaults: dict[str, object] = {
        "doi": "10.1234/x",
        "title": "Authoritative Title",
        "authors": (NormalizedAuthor("Jane Smith"),),
        "publication_year": 2021,
        "venue": "Journal of Things",
    }
    defaults.update(overrides)
    return CrossrefWork(**defaults)  # type: ignore[arg-type]


@pytest.fixture
def db_engine(monkeypatch: pytest.MonkeyPatch) -> Iterator[object]:
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    monkeypatch.setenv("JWT_SECRET", _TEST_JWT_SECRET)
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{path}")
    get_settings.cache_clear()
    get_engine.cache_clear()
    get_session_factory.cache_clear()

    engine = create_engine(f"sqlite:///{path}", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    try:
        yield engine
    finally:
        engine.dispose()
        get_settings.cache_clear()
        get_engine.cache_clear()
        get_session_factory.cache_clear()
        os.remove(path)


@pytest.fixture
def storage_root(tmp_path: Path) -> Path:
    return tmp_path / "document-files"


def _make_app(
    db_engine: object,
    settings: Settings,
    vector_store: _FakeVectorStore,
    embedding_provider: _FakeEmbeddingProvider,
    file_storage: DocumentFileStorage,
    provider: _FakeProvider,
) -> FastAPI:
    app = FastAPI()
    app.include_router(documents_router)
    factory = sessionmaker(bind=db_engine, autoflush=False, expire_on_commit=False)

    def override_get_db() -> Iterator[object]:
        db = factory()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_settings] = lambda: settings
    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[get_embedding_provider] = lambda: embedding_provider
    app.dependency_overrides[get_vector_store] = lambda: vector_store
    app.dependency_overrides[get_document_file_storage] = lambda: file_storage
    app.dependency_overrides[get_bibliographic_provider] = lambda: provider
    return app


def _create_user(db_engine: object, *, email: str) -> User:
    factory = sessionmaker(bind=db_engine, autoflush=False, expire_on_commit=False)
    db = factory()
    try:
        user = User(email=email, email_verified=True)
        db.add(user)
        db.commit()
        db.refresh(user)
        db.expunge(user)
        return user
    finally:
        db.close()


def _as_user(app: FastAPI, user: User) -> None:
    app.dependency_overrides[get_current_user] = lambda: user


@pytest.fixture
def harness(db_engine: object, storage_root: Path):
    vector_store = _FakeVectorStore()
    embedding_provider = _FakeEmbeddingProvider()
    file_storage = DocumentFileStorage(root_dir=str(storage_root))
    provider = _FakeProvider([])
    app = _make_app(
        db_engine, _build_settings(), vector_store, embedding_provider, file_storage, provider
    )
    owner = _create_user(db_engine, email="owner@example.com")
    other = _create_user(db_engine, email="other@example.com")
    _as_user(app, owner)
    client = TestClient(app)
    return client, app, owner, other, vector_store, provider


def _upload_pdf(
    client: TestClient,
    *,
    text: str = "Students completed a twelve week program.",
    filename: str = "paper.pdf",
    **form_fields: str,
) -> dict:
    resp = client.post(
        "/documents",
        data={"document_type": "report", **form_fields},
        files={"file": (filename, io.BytesIO(_make_pdf_bytes(text)), "application/pdf")},
    )
    assert resp.status_code == 202, resp.text
    job = client.get(f"/documents/jobs/{resp.json()['job_id']}").json()
    assert job["status"] == "completed", job
    return job["document"]


class TestEnrichRoute:
    def test_missing_document_is_404(self, harness) -> None:
        client, *_ = harness
        resp = client.post("/documents/does-not-exist/enrich")
        assert resp.status_code == 404

    def test_document_owned_by_another_user_is_404(self, harness) -> None:
        client, app, _owner, other, _vs, _provider = harness
        document = _upload_pdf(client, doi="10.1234/owned-by-owner")
        _as_user(app, other)
        resp = client.post(f"/documents/{document['document_id']}/enrich")
        assert resp.status_code == 404

    def test_no_doi_reports_no_doi_status_without_error(self, harness) -> None:
        client, *_ = harness
        document = _upload_pdf(client)
        assert document["doi"] is None
        resp = client.post(f"/documents/{document['document_id']}/enrich")
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["ok"] is False
        assert body["status"] == "no_doi"

    def test_successful_enrichment_updates_document_and_reports_summary(self, harness) -> None:
        client, _app, _owner, _other, vector_store, provider = harness
        document = _upload_pdf(client, doi="10.1234/paper-one")
        provider._outcomes = [EnrichmentLookupOutcome(ok=True, work=_work(doi="10.1234/paper-one"))]

        resp = client.post(f"/documents/{document['document_id']}/enrich")
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["ok"] is True
        assert body["status"] == "succeeded"
        assert "title" in body["fields_updated"]
        assert body["document"]["title"] == "Authoritative Title"
        assert body["document"]["enrichment_status"] == "succeeded"
        assert body["document"]["enrichment_provider"] == "crossref"
        assert body["document"]["last_enriched_at"] is not None
        # Qdrant sync happened as part of the same call.
        assert len(vector_store.update_chunk_metadata_calls) == 1

    def test_manual_title_is_preserved_across_refresh(self, harness) -> None:
        client, *_rest, provider = harness
        document = _upload_pdf(client, doi="10.1234/paper-two")
        client.patch(
            f"/documents/{document['document_id']}/metadata",
            json={"title": "My Manually Corrected Title"},
        )
        provider._outcomes = [
            EnrichmentLookupOutcome(ok=True, work=_work(doi="10.1234/paper-two"))
        ]
        resp = client.post(f"/documents/{document['document_id']}/enrich")
        body = resp.json()
        assert body["ok"] is True
        assert "title" not in body["fields_updated"]
        assert body["manual_fields_preserved"] >= 1
        assert body["document"]["title"] == "My Manually Corrected Title"

    def test_provider_not_found_leaves_metadata_untouched(self, harness) -> None:
        client, *_rest, provider = harness
        document = _upload_pdf(client, doi="10.1234/missing-from-crossref", title="Original")
        provider._outcomes = [EnrichmentLookupOutcome(ok=False, failure="not_found")]

        resp = client.post(f"/documents/{document['document_id']}/enrich")
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["ok"] is False
        assert body["status"] == "not_found"
        assert body["document"]["title"] == document["title"]
        assert body["document"]["enrichment_status"] == "not_found"

    def test_provider_timeout_leaves_metadata_untouched(self, harness) -> None:
        client, *_rest, provider = harness
        document = _upload_pdf(client, doi="10.1234/times-out")
        provider._outcomes = [EnrichmentLookupOutcome(ok=False, failure="timeout")]

        resp = client.post(f"/documents/{document['document_id']}/enrich")
        body = resp.json()
        assert body["ok"] is False
        assert body["status"] == "timeout"
        assert body["document"]["doi"] == document["doi"]

    def test_disabled_feature_reports_disabled_status(self, db_engine, storage_root) -> None:
        vector_store = _FakeVectorStore()
        embedding_provider = _FakeEmbeddingProvider()
        file_storage = DocumentFileStorage(root_dir=str(storage_root))
        provider = _FakeProvider([])
        app = _make_app(
            db_engine,
            _build_settings(bibliographic_enrichment_enabled=False),
            vector_store,
            embedding_provider,
            file_storage,
            provider,
        )
        owner = _create_user(db_engine, email="disabled-owner@example.com")
        _as_user(app, owner)
        client = TestClient(app)
        document = _upload_pdf(client, doi="10.1234/whatever")

        resp = client.post(f"/documents/{document['document_id']}/enrich")
        body = resp.json()
        assert body["ok"] is False
        assert body["status"] == "disabled"
        assert provider.calls == []


class TestExactDoiDuplicateCandidate:
    def test_no_candidate_when_doi_is_unique(self, harness) -> None:
        client, *_ = harness
        pdf_bytes = _make_pdf_bytes("A completely novel paper with doi 10.9999/unique-one")
        resp = client.post(
            "/documents/metadata-preview",
            files={"file": ("novel.pdf", io.BytesIO(pdf_bytes), "application/pdf")},
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["duplicate_candidate"] is None

    def test_candidate_surfaced_when_doi_matches_an_owned_document(self, harness) -> None:
        client, *_ = harness
        existing = _upload_pdf(client, doi="10.4321/shared-doi", filename="first.pdf")

        # A different file, embedding the same DOI in its extractable text,
        # previewed (not yet uploaded) by the same user.
        pdf_bytes = _make_pdf_bytes("Some other document text. DOI: 10.4321/shared-doi")
        resp = client.post(
            "/documents/metadata-preview",
            files={"file": ("second.pdf", io.BytesIO(pdf_bytes), "application/pdf")},
        )
        assert resp.status_code == 200, resp.text
        candidate = resp.json()["duplicate_candidate"]
        assert candidate is not None
        assert candidate["document_id"] == existing["document_id"]
        assert candidate["match_type"] == "exact_doi"
        assert candidate["source_filename"] == "first.pdf"

    def test_no_candidate_when_doi_belongs_to_a_different_user(self, harness) -> None:
        client, app, owner, other, _vs, _provider = harness
        _as_user(app, other)
        _upload_pdf(client, doi="10.5555/owned-by-other", filename="others.pdf")
        _as_user(app, owner)

        pdf_bytes = _make_pdf_bytes("My own paper. DOI: 10.5555/owned-by-other")
        resp = client.post(
            "/documents/metadata-preview",
            files={"file": ("mine.pdf", io.BytesIO(pdf_bytes), "application/pdf")},
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["duplicate_candidate"] is None

    def test_keep_both_still_allows_the_second_upload_to_succeed(self, harness) -> None:
        """Section 24/28: a DOI duplicate is a non-blocking warning — the
        actual POST /documents upload for a byte-DIFFERENT file always
        succeeds regardless of the metadata-preview candidate."""
        client, *_ = harness
        _upload_pdf(client, doi="10.7777/keep-both", filename="first.pdf")
        second = _upload_pdf(
            client,
            text="A different file with the same DOI.",
            filename="second.pdf",
            doi="10.7777/keep-both",
        )
        assert second["doi"] == "10.7777/keep-both"


class TestShaDuplicateRegression:
    def test_identical_file_upload_is_still_rejected(self, harness) -> None:
        client, *_ = harness
        # Same exact bytes reused for both uploads — pymupdf embeds
        # non-deterministic internal ids/timestamps, so two SEPARATELY
        # generated PDFs of identical text are not byte-identical, and
        # this test is specifically about the SHA-256 (byte-identical)
        # path, not the DOI-duplicate path covered above.
        pdf_bytes = _make_pdf_bytes("Exact same bytes.")
        first = client.post(
            "/documents",
            data={"document_type": "report"},
            files={"file": ("a.pdf", io.BytesIO(pdf_bytes), "application/pdf")},
        )
        assert first.status_code == 202, first.text

        resp = client.post(
            "/documents",
            data={"document_type": "report"},
            files={"file": ("b.pdf", io.BytesIO(pdf_bytes), "application/pdf")},
        )
        assert resp.status_code == 409
