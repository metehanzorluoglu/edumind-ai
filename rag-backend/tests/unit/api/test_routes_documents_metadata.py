"""Milestone 4 (Reference Library & Bibliographic Metadata Foundation) —
API-level coverage for PATCH /documents/{id}/metadata: the "Edit metadata"
action. Same harness pattern as test_routes_documents_original_file.py (real
on-disk SQLite, fake embedding provider, fake in-process Qdrant), trimmed
to just what this endpoint needs.
"""

from __future__ import annotations

import io
import os
import tempfile
import uuid
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
from app.core.security import get_current_user
from app.db.base import Base
from app.db.models_auth import User
from app.db.session import get_db, get_engine, get_session_factory
from app.deps import get_document_file_storage, get_embedding_provider, get_vector_store
from app.services.document_file_storage import DocumentFileStorage
from app.vectorstore.qdrant_client import _point_id
from app.vectorstore.schemas import DocumentChunkContent

_TEST_JWT_SECRET = "test-only-secret-not-a-real-credential-32chars"


def _build_settings(**overrides: object) -> Settings:
    defaults: dict[str, object] = {"jwt_secret": _TEST_JWT_SECRET, "app_env": "test"}
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
    """Tracks every call so tests can assert a metadata edit never touches
    it (Milestone 4's "no Qdrant mutation" constraint) — see
    test_editing_metadata_never_calls_the_vector_store below."""

    def __init__(self) -> None:
        self.upsert_calls = 0
        self.update_chunk_metadata_calls = 0
        self._chunks: dict[str, dict[str, list[DocumentChunkContent]]] = {}

    def upsert_chunks(self, metadata, chunks, embeddings, *, user_id: str) -> None:
        self.upsert_calls += 1
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
        self.update_chunk_metadata_calls += 1
        return 0

    def delete_document(self, document_id: str, *, user_id: str) -> int:
        removed = self._chunks.get(document_id, {}).pop(user_id, [])
        return len(removed)


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
    app = _make_app(db_engine, _build_settings(), vector_store, embedding_provider, file_storage)
    owner = _create_user(db_engine, email="owner@example.com")
    other = _create_user(db_engine, email="other@example.com")
    _as_user(app, owner)
    client = TestClient(app)
    return client, app, owner, other, vector_store


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


class TestUpdateDocumentMetadata:
    def test_partial_update_only_touches_the_field_sent(self, harness) -> None:
        client, *_ = harness
        document = _upload_pdf(client, doi="10.1000/xyz123")
        resp = client.patch(
            f"/documents/{document['document_id']}/metadata", json={"doi": "10.1000/abc999"}
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["doi"] == "10.1000/abc999"
        # Untouched fields (title, in particular) survive unchanged.
        assert body["title"] == document["title"]

    def test_explicit_null_clears_an_optional_field(self, harness) -> None:
        client, *_ = harness
        document = _upload_pdf(client, source_venue="Journal of Testing")
        assert document["source_venue"] == "Journal of Testing"
        resp = client.patch(
            f"/documents/{document['document_id']}/metadata", json={"source_venue": None}
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["source_venue"] is None

    def test_title_cannot_be_blanked_to_null(self, harness) -> None:
        client, *_ = harness
        document = _upload_pdf(client)
        resp = client.patch(
            f"/documents/{document['document_id']}/metadata", json={"title": None}
        )
        assert resp.status_code == 422

    def test_title_cannot_be_blanked_to_empty_string(self, harness) -> None:
        client, *_ = harness
        document = _upload_pdf(client)
        resp = client.patch(
            f"/documents/{document['document_id']}/metadata", json={"title": "   "}
        )
        assert resp.status_code == 422

    def test_document_type_cannot_be_cleared_to_null(self, harness) -> None:
        client, *_ = harness
        document = _upload_pdf(client)
        resp = client.patch(
            f"/documents/{document['document_id']}/metadata", json={"document_type": None}
        )
        assert resp.status_code == 422

    def test_document_type_can_be_corrected_to_another_valid_value(self, harness) -> None:
        client, *_ = harness
        document = _upload_pdf(client)
        resp = client.patch(
            f"/documents/{document['document_id']}/metadata",
            json={"document_type": "conference_paper"},
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["document_type"] == "conference_paper"

    def test_new_bibliographic_fields_can_be_set(self, harness) -> None:
        client, *_ = harness
        document = _upload_pdf(client)
        resp = client.patch(
            f"/documents/{document['document_id']}/metadata",
            json={
                "volume": "12",
                "issue": "3",
                "page_start": 100,
                "page_end": 120,
                "publisher": "Example Press",
                "abstract": "This study examines...",
                "keywords": ["education", "assessment"],
                "language": "en",
            },
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["volume"] == "12"
        assert body["issue"] == "3"
        assert body["page_start"] == 100
        assert body["page_end"] == 120
        assert body["publisher"] == "Example Press"
        assert body["abstract"] == "This study examines..."
        assert body["keywords"] == ["education", "assessment"]
        assert body["language"] == "en"

    def test_edited_fields_get_user_provenance_and_others_are_preserved(self, harness) -> None:
        client, *_ = harness
        document = _upload_pdf(client, doi="10.1000/xyz123")
        assert document["metadata_sources"].get("doi") == "user"  # explicit upload form field

        resp = client.patch(
            f"/documents/{document['document_id']}/metadata",
            json={"source_venue": "A Corrected Venue"},
        )
        assert resp.status_code == 200, resp.text
        sources = resp.json()["metadata_sources"]
        assert sources["source_venue"] == "user"
        # doi's provenance from the original upload survives untouched.
        assert sources.get("doi") == "user"

    def test_empty_body_is_a_no_op_and_returns_current_state(self, harness) -> None:
        client, *_ = harness
        document = _upload_pdf(client, doi="10.1000/xyz123")
        resp = client.patch(f"/documents/{document['document_id']}/metadata", json={})
        assert resp.status_code == 200, resp.text
        assert resp.json()["doi"] == "10.1000/xyz123"

    def test_editing_metadata_never_calls_the_vector_store(self, harness) -> None:
        client, *_, vector_store = harness
        document = _upload_pdf(client)
        upserts_before = vector_store.upsert_calls
        resp = client.patch(
            f"/documents/{document['document_id']}/metadata", json={"doi": "10.1000/xyz123"}
        )
        assert resp.status_code == 200, resp.text
        assert vector_store.upsert_calls == upserts_before
        assert vector_store.update_chunk_metadata_calls == 0

    def test_editing_metadata_preserves_chunk_count(self, harness) -> None:
        client, *_ = harness
        document = _upload_pdf(client)
        resp = client.patch(
            f"/documents/{document['document_id']}/metadata", json={"doi": "10.1000/xyz123"}
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["chunk_count"] == document["chunk_count"]

    def test_cross_user_edit_denied_with_404_never_403(self, harness) -> None:
        client, app, _owner, other, *_ = harness
        document = _upload_pdf(client)
        _as_user(app, other)
        resp = client.patch(
            f"/documents/{document['document_id']}/metadata", json={"doi": "10.1000/xyz123"}
        )
        assert resp.status_code == 404

    def test_nonexistent_document_404s(self, harness) -> None:
        client, *_ = harness
        resp = client.patch(
            f"/documents/{uuid.uuid4()}/metadata", json={"doi": "10.1000/xyz123"}
        )
        assert resp.status_code == 404

    def test_invalid_doi_pattern_rejected(self, harness) -> None:
        client, *_ = harness
        document = _upload_pdf(client)
        resp = client.patch(
            f"/documents/{document['document_id']}/metadata", json={"doi": "not-a-doi"}
        )
        assert resp.status_code == 422

    def test_authors_list_can_be_replaced_wholesale(self, harness) -> None:
        client, *_ = harness
        document = _upload_pdf(client)
        resp = client.patch(
            f"/documents/{document['document_id']}/metadata",
            json={"authors": ["Ada Lovelace", "Grace Hopper"]},
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["authors"] == ["Ada Lovelace", "Grace Hopper"]

    def test_unicode_title_round_trips(self, harness) -> None:
        client, *_ = harness
        document = _upload_pdf(client)
        title = "\u00dcber die Wirkung von Bildung \u2013 \u00e9tude \u6559\u80b2"
        resp = client.patch(
            f"/documents/{document['document_id']}/metadata", json={"title": title}
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["title"] == title

    def test_doi_org_url_is_normalized_on_edit(self, harness) -> None:
        client, *_ = harness
        document = _upload_pdf(client)
        resp = client.patch(
            f"/documents/{document['document_id']}/metadata",
            json={"doi": "https://doi.org/10.1234/abcd"},
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["doi"] == "10.1234/abcd"

    def test_doi_colon_prefix_is_normalized_on_edit(self, harness) -> None:
        client, *_ = harness
        document = _upload_pdf(client)
        resp = client.patch(
            f"/documents/{document['document_id']}/metadata",
            json={"doi": "doi:10.1234/abcd"},
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["doi"] == "10.1234/abcd"


class TestBibliographicSearch:
    """Milestone 4 Section 7: GET /documents?q=... extended beyond title/
    filename to also match author, publication year, venue, and DOI."""

    def test_search_matches_author_name(self, harness) -> None:
        client, *_ = harness
        _upload_pdf(client, filename="a.pdf", authors="Ada Lovelace, Grace Hopper")
        _upload_pdf(client, filename="b.pdf", authors="Someone Else")

        resp = client.get("/documents", params={"q": "Lovelace"})
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["total"] == 1
        assert body["documents"][0]["source_filename"] == "a.pdf"

    def test_search_matches_publication_year(self, harness) -> None:
        client, *_ = harness
        _upload_pdf(client, filename="a.pdf", publication_year="2019")
        _upload_pdf(client, filename="b.pdf", publication_year="2022")

        resp = client.get("/documents", params={"q": "2019"})
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["total"] == 1
        assert body["documents"][0]["source_filename"] == "a.pdf"

    def test_search_matches_source_venue(self, harness) -> None:
        client, *_ = harness
        _upload_pdf(client, filename="a.pdf", source_venue="Journal of Testing")
        _upload_pdf(client, filename="b.pdf")

        resp = client.get("/documents", params={"q": "Journal of Testing"})
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["total"] == 1
        assert body["documents"][0]["source_filename"] == "a.pdf"

    def test_search_matches_doi(self, harness) -> None:
        client, *_ = harness
        _upload_pdf(client, filename="a.pdf", doi="10.1000/xyz123")
        _upload_pdf(client, filename="b.pdf")

        resp = client.get("/documents", params={"q": "10.1000/xyz123"})
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["total"] == 1
        assert body["documents"][0]["source_filename"] == "a.pdf"

    def test_search_still_matches_title_and_filename(self, harness) -> None:
        client, *_ = harness
        _upload_pdf(client, filename="unique-name.pdf")
        _upload_pdf(client, filename="other.pdf")

        resp = client.get("/documents", params={"q": "unique-name"})
        assert resp.status_code == 200, resp.text
        assert resp.json()["total"] == 1

    def test_search_after_a_metadata_edit_finds_the_corrected_value(self, harness) -> None:
        client, *_ = harness
        document = _upload_pdf(client, filename="a.pdf")
        client.patch(
            f"/documents/{document['document_id']}/metadata",
            json={"source_venue": "A Newly Corrected Venue"},
        )

        resp = client.get("/documents", params={"q": "Newly Corrected Venue"})
        assert resp.status_code == 200, resp.text
        assert resp.json()["total"] == 1
