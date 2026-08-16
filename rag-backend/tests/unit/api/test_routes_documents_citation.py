"""Milestone 4.2 (Citation & BibTeX Foundation) — API-level coverage for
GET /documents/{id}/citation, GET /documents/{id}/bibtex, and POST
/documents/bibtex-export. Same harness pattern as
test_routes_documents_metadata.py (real on-disk SQLite, fake embedding
provider, fake in-process vector store), trimmed to just what these
endpoints need.
"""

from __future__ import annotations

import io
import os
import tempfile
import uuid
from collections.abc import Iterator
from pathlib import Path

import bibtexparser
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
    def upsert_chunks(self, metadata, chunks, embeddings, *, user_id: str) -> None:
        pass

    def get_document_chunks(self, document_id: str, *, user_id: str) -> list:
        return []

    def update_chunk_metadata(self, document_id: str, *, user_id: str, updates: dict) -> int:
        return 0

    def delete_document(self, document_id: str, *, user_id: str) -> int:
        return 0


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


def _make_app(db_engine: object, settings: Settings, file_storage: DocumentFileStorage) -> FastAPI:
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
    app.dependency_overrides[get_embedding_provider] = lambda: _FakeEmbeddingProvider()
    app.dependency_overrides[get_vector_store] = lambda: _FakeVectorStore()
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
    file_storage = DocumentFileStorage(root_dir=str(storage_root))
    app = _make_app(db_engine, _build_settings(), file_storage)
    owner = _create_user(db_engine, email="owner@example.com")
    other = _create_user(db_engine, email="other@example.com")
    _as_user(app, owner)
    client = TestClient(app)
    return client, app, owner, other


def _upload_pdf(
    client: TestClient,
    *,
    text: str = "Body text.",
    filename: str | None = None,
    **form_fields: str,
) -> dict:
    resp = client.post(
        "/documents",
        data={"document_type": "journal_article", **form_fields},
        files={
            "file": (
                filename or f"{uuid.uuid4()}.pdf",
                io.BytesIO(_make_pdf_bytes(text)),
                "application/pdf",
            )
        },
    )
    assert resp.status_code == 202, resp.text
    job = client.get(f"/documents/jobs/{resp.json()['job_id']}").json()
    assert job["status"] == "completed", job
    return job["document"]


class TestGetDocumentCitation:
    def test_apa_style(self, harness) -> None:
        client, *_ = harness
        doc = _upload_pdf(
            client,
            title="A Sample Study",
            authors="Jane Doe",
            publication_year="2020",
            source_venue="Journal of Testing",
        )
        resp = client.get(f"/documents/{doc['document_id']}/citation", params={"style": "apa7"})
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["style"] == "apa7"
        assert "Doe, J." in body["formatted"]
        assert "2020" in body["formatted"]
        assert "A Sample Study" in body["formatted"]

    def test_ieee_style(self, harness) -> None:
        client, *_ = harness
        doc = _upload_pdf(
            client,
            title="A Sample Study",
            authors="Jane Doe",
            publication_year="2020",
            source_venue="Journal of Testing",
        )
        resp = client.get(f"/documents/{doc['document_id']}/citation", params={"style": "ieee"})
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["style"] == "ieee"
        assert body["formatted"].startswith("[1]")

    def test_invalid_style_is_422(self, harness) -> None:
        client, *_ = harness
        doc = _upload_pdf(client)
        resp = client.get(f"/documents/{doc['document_id']}/citation", params={"style": "mla"})
        assert resp.status_code == 422

    def test_missing_style_is_422(self, harness) -> None:
        client, *_ = harness
        doc = _upload_pdf(client)
        resp = client.get(f"/documents/{doc['document_id']}/citation")
        assert resp.status_code == 422

    def test_404_for_nonexistent_document(self, harness) -> None:
        client, *_ = harness
        resp = client.get("/documents/nonexistent/citation", params={"style": "apa7"})
        assert resp.status_code == 404

    def test_404_for_another_users_document(self, harness) -> None:
        client, app, _owner, other = harness
        doc = _upload_pdf(client)
        _as_user(app, other)
        resp = client.get(f"/documents/{doc['document_id']}/citation", params={"style": "apa7"})
        assert resp.status_code == 404

    def test_incomplete_metadata_still_returns_a_citation(self, harness) -> None:
        client, *_ = harness
        doc = _upload_pdf(client, title="Untitled Upload")
        resp = client.get(f"/documents/{doc['document_id']}/citation", params={"style": "apa7"})
        assert resp.status_code == 200
        assert resp.json()["formatted"]

    def test_reflects_current_metadata_after_an_edit(self, harness) -> None:
        client, *_ = harness
        doc = _upload_pdf(client, title="Original Title", authors="Jane Doe")
        client.patch(f"/documents/{doc['document_id']}/metadata", json={"title": "Edited Title"})
        resp = client.get(f"/documents/{doc['document_id']}/citation", params={"style": "apa7"})
        assert "Edited Title" in resp.json()["formatted"]
        assert "Original Title" not in resp.json()["formatted"]


class TestGetDocumentBibtex:
    def test_returns_a_valid_entry_and_a_key(self, harness) -> None:
        client, *_ = harness
        doc = _upload_pdf(
            client, title="A Sample Study", authors="Jane Doe", publication_year="2020"
        )
        resp = client.get(f"/documents/{doc['document_id']}/bibtex")
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["citation_key"]
        parsed = bibtexparser.loads(body["bibtex"])
        assert len(parsed.entries) == 1
        assert parsed.entries[0]["ID"] == body["citation_key"]

    def test_citation_key_matches_document_summarys_own_field(self, harness) -> None:
        client, *_ = harness
        doc = _upload_pdf(client, title="A Study", authors="Jane Doe")
        assert doc["citation_key"] is None  # not yet generated at upload time
        bibtex_resp = client.get(f"/documents/{doc['document_id']}/bibtex").json()
        summary_resp = client.get("/documents").json()
        summary = next(d for d in summary_resp["documents"] if d["document_id"] == doc["document_id"])
        assert summary["citation_key"] == bibtex_resp["citation_key"]

    def test_key_is_stable_across_repeated_calls(self, harness) -> None:
        client, *_ = harness
        doc = _upload_pdf(client, title="A Study", authors="Jane Doe")
        first = client.get(f"/documents/{doc['document_id']}/bibtex").json()
        second = client.get(f"/documents/{doc['document_id']}/bibtex").json()
        assert first["citation_key"] == second["citation_key"]

    def test_key_stable_after_a_metadata_edit(self, harness) -> None:
        client, *_ = harness
        doc = _upload_pdf(client, title="Original Title", authors="Jane Doe")
        first = client.get(f"/documents/{doc['document_id']}/bibtex").json()
        client.patch(f"/documents/{doc['document_id']}/metadata", json={"title": "New Title"})
        second = client.get(f"/documents/{doc['document_id']}/bibtex").json()
        assert first["citation_key"] == second["citation_key"]
        assert "New Title" in second["bibtex"]

    def test_404_for_another_users_document(self, harness) -> None:
        client, app, _owner, other = harness
        doc = _upload_pdf(client)
        _as_user(app, other)
        resp = client.get(f"/documents/{doc['document_id']}/bibtex")
        assert resp.status_code == 404


class TestBibtexExport:
    def test_exports_multiple_valid_entries(self, harness) -> None:
        client, *_ = harness
        doc_a = _upload_pdf(client, title="Apple Study", authors="Amy Alpha", publication_year="2020")
        doc_b = _upload_pdf(client, title="Zebra Study", authors="Zara Zeta", publication_year="2021")
        resp = client.post(
            "/documents/bibtex-export",
            json={"document_ids": [doc_a["document_id"], doc_b["document_id"]]},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["count"] == 2
        assert body["skipped_document_ids"] == []
        parsed = bibtexparser.loads(body["bibtex"])
        assert len(parsed.entries) == 2

    def test_deterministic_alphabetical_key_order(self, harness) -> None:
        client, *_ = harness
        doc_z = _upload_pdf(client, title="Zebra Study", authors="Zara Zeta", publication_year="2020")
        doc_a = _upload_pdf(client, title="Apple Study", authors="Amy Alpha", publication_year="2020")
        resp = client.post(
            "/documents/bibtex-export",
            json={"document_ids": [doc_z["document_id"], doc_a["document_id"]]},
        )
        parsed = bibtexparser.loads(resp.json()["bibtex"])
        ids = [e["ID"] for e in parsed.entries]
        assert ids == sorted(ids)

    def test_duplicate_ids_in_request_collapse_to_one_entry(self, harness) -> None:
        client, *_ = harness
        doc = _upload_pdf(client, title="A Study", authors="Jane Doe")
        resp = client.post(
            "/documents/bibtex-export",
            json={"document_ids": [doc["document_id"], doc["document_id"]]},
        )
        assert resp.json()["count"] == 1

    def test_nonexistent_id_is_skipped_not_a_hard_failure(self, harness) -> None:
        client, *_ = harness
        doc = _upload_pdf(client, title="A Study", authors="Jane Doe")
        resp = client.post(
            "/documents/bibtex-export",
            json={"document_ids": [doc["document_id"], "nonexistent-id"]},
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["count"] == 1
        assert body["skipped_document_ids"] == ["nonexistent-id"]

    def test_another_users_document_is_skipped_not_leaked(self, harness) -> None:
        client, app, _owner, other = harness
        doc = _upload_pdf(client, title="A Study", authors="Jane Doe")
        _as_user(app, other)
        resp = client.post(
            "/documents/bibtex-export", json={"document_ids": [doc["document_id"]]}
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["count"] == 0
        assert body["skipped_document_ids"] == [doc["document_id"]]

    def test_same_doi_different_documents_both_exported_distinctly(self, harness) -> None:
        client, *_ = harness
        doc_a = _upload_pdf(
            client, title="Shared Study A", authors="Jane Doe",
            publication_year="2020", doi="10.1000/shared",
        )
        doc_b = _upload_pdf(
            client, title="Shared Study B", authors="Jane Doe",
            publication_year="2020", doi="10.1000/shared",
        )
        resp = client.post(
            "/documents/bibtex-export",
            json={"document_ids": [doc_a["document_id"], doc_b["document_id"]]},
        )
        body = resp.json()
        assert body["count"] == 2
        parsed = bibtexparser.loads(body["bibtex"])
        keys = [e["ID"] for e in parsed.entries]
        assert len(set(keys)) == 2  # both unique despite the shared DOI

    def test_empty_document_ids_is_422(self, harness) -> None:
        client, *_ = harness
        resp = client.post("/documents/bibtex-export", json={"document_ids": []})
        assert resp.status_code == 422

    def test_utf8_response(self, harness) -> None:
        client, *_ = harness
        doc = _upload_pdf(client, title="Étude thermodynamique", authors="Hans Müller")
        resp = client.post(
            "/documents/bibtex-export", json={"document_ids": [doc["document_id"]]}
        )
        bibtex_text = resp.json()["bibtex"]
        assert "Étude" in bibtex_text
        assert "Müller" in bibtex_text
        bibtex_text.encode("utf-8")  # must not raise
