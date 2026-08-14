"""Covers Frontend Milestone 3 (Document Reader, Highlights & Ask-About-
Selection): GET /documents/{id}/content and the
GET/POST/PATCH/DELETE /documents/{id}/highlights CRUD surface.

Builds a minimal FastAPI app around the real documents router, backed by a
fresh on-disk SQLite database per test (Base.metadata.create_all — same
pattern as test_routes_folders.py). Ollama is replaced with an in-process
fake; Qdrant is replaced with an in-process fake that actually stores what
upsert_chunks writes (not just a call counter) so get_document_chunks and
the highlight-anchor validation are exercised against real chunk data,
including the real deterministic point-id scheme (_point_id) — this suite
never makes network I/O, but it does exercise the full real
upload -> chunk -> content -> highlight pipeline end to end.
"""

import io
import os
import tempfile
import uuid
from collections.abc import Iterator

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from app.api.routes_documents import router as documents_router
from app.config import Settings, get_settings
from app.core.security import get_current_user
from app.db.base import Base
from app.db.models_auth import User
from app.db.models_documents import DocumentHighlight
from app.db.session import get_db, get_engine, get_session_factory
from app.deps import get_embedding_provider, get_vector_store
from app.vectorstore.qdrant_client import _point_id
from app.vectorstore.schemas import DocumentChunkContent

_TEST_JWT_SECRET = "test-only-secret-not-a-real-credential-32chars"


def _build_settings(**overrides: object) -> Settings:
    defaults: dict[str, object] = {"jwt_secret": _TEST_JWT_SECRET, "app_env": "test"}
    defaults.update(overrides)
    return Settings(**defaults)  # type: ignore[arg-type]


class _FakeEmbeddingProvider:
    dimensions = 4

    def embed_batch(self, texts: list[str]) -> list[list[float]]:
        return [[0.1, 0.2, 0.3, 0.4] for _ in texts]


class _FakeVectorStore:
    """Unlike test_routes_folders.py's own fake (a call counter), this one
    actually stores what upsert_chunks writes, keyed the same way the real
    QdrantVectorStore keys points — (document_id, chunk_index) ->
    deterministic point id via the real _point_id function — so
    get_document_chunks and the create-highlight anchor validation are
    exercised against real, reading-order chunk data."""

    def __init__(self) -> None:
        self.upsert_calls = 0
        self.delete_calls: list[str] = []
        # document_id -> user_id -> list[DocumentChunkContent]
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

    def delete_document(self, document_id: str, *, user_id: str) -> int:
        self.delete_calls.append(document_id)
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


def _make_app(db_engine: object, settings: Settings, vector_store: _FakeVectorStore) -> FastAPI:
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
    app.dependency_overrides[get_vector_store] = lambda: vector_store
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
def harness(db_engine: object) -> tuple[TestClient, FastAPI, User, User, _FakeVectorStore]:
    vector_store = _FakeVectorStore()
    app = _make_app(db_engine, _build_settings(), vector_store)
    owner = _create_user(db_engine, email="owner@example.com")
    other = _create_user(db_engine, email="other@example.com")
    _as_user(app, owner)
    client = TestClient(app)
    return client, app, owner, other, vector_store


def _upload(
    client: TestClient, *, text: bytes = b"Page one text content here.", filename: str = "notes.txt"
):
    resp = client.post(
        "/documents",
        data={"document_type": "report"},
        files={"file": (filename, io.BytesIO(text), "text/plain")},
    )
    assert resp.status_code == 202, resp.text
    job = client.get(f"/documents/jobs/{resp.json()['job_id']}").json()
    assert job["status"] == "completed", job
    return job["document"]["document_id"]


# --- GET .../content -------------------------------------------------------


def test_get_content_returns_real_chunks_in_reading_order(harness) -> None:
    client, *_ = harness
    document_id = _upload(client, text=b"First sentence. Second sentence.")

    resp = client.get(f"/documents/{document_id}/content")

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["document_id"] == document_id
    assert body["source_filename"] == "notes.txt"
    assert body["page_count"] >= 1
    assert len(body["chunks"]) >= 1
    assert body["chunks"][0]["chunk_index"] == 0
    assert body["chunks"][0]["page_number"] == 1
    assert "First sentence" in body["chunks"][0]["text"]
    # Deterministic — same id a citation for this chunk would carry.
    assert body["chunks"][0]["chunk_id"] == _point_id(document_id, 0)


def test_get_content_404s_for_missing_document(harness) -> None:
    client, *_ = harness
    resp = client.get(f"/documents/{uuid.uuid4()}/content")
    assert resp.status_code == 404


def test_get_content_404s_for_another_users_document(harness) -> None:
    client, app, _owner, other, _vs = harness
    document_id = _upload(client)

    _as_user(app, other)
    resp = client.get(f"/documents/{document_id}/content")
    assert resp.status_code == 404


# --- Highlights CRUD ---------------------------------------------------------


def test_create_and_list_highlight(harness) -> None:
    client, *_ = harness
    document_id = _upload(client, text=b"Students completed a 12-week program.")
    chunk = client.get(f"/documents/{document_id}/content").json()["chunks"][0]

    resp = client.post(
        f"/documents/{document_id}/highlights",
        json={
            "chunk_id": chunk["chunk_id"],
            "chunk_index": chunk["chunk_index"],
            "page_number": chunk["page_number"],
            "selected_text": "Students completed a 12-week program.",
        },
    )
    assert resp.status_code == 201, resp.text
    created = resp.json()
    assert created["document_id"] == document_id
    assert created["selected_text"] == "Students completed a 12-week program."
    assert created["note_text"] is None

    listing = client.get(f"/documents/{document_id}/highlights").json()
    assert len(listing["highlights"]) == 1
    assert listing["highlights"][0]["id"] == created["id"]


def test_create_highlight_with_note(harness) -> None:
    client, *_ = harness
    document_id = _upload(client)
    chunk = client.get(f"/documents/{document_id}/content").json()["chunks"][0]

    resp = client.post(
        f"/documents/{document_id}/highlights",
        json={
            "chunk_id": chunk["chunk_id"],
            "chunk_index": chunk["chunk_index"],
            "page_number": chunk["page_number"],
            "selected_text": "Page one text content here.",
            "note_text": "Worth revisiting.",
        },
    )
    assert resp.status_code == 201, resp.text
    assert resp.json()["note_text"] == "Worth revisiting."


def test_create_highlight_rejects_a_forged_anchor_not_matching_a_real_chunk(harness) -> None:
    client, *_ = harness
    document_id = _upload(client)

    resp = client.post(
        f"/documents/{document_id}/highlights",
        json={
            "chunk_id": str(uuid.uuid4()),  # not a real chunk of this document
            "chunk_index": 0,
            "page_number": 1,
            "selected_text": "Fabricated text.",
        },
    )
    assert resp.status_code == 422, resp.text


def test_create_highlight_rejects_mismatched_chunk_index_for_a_real_chunk_id(harness) -> None:
    client, *_ = harness
    document_id = _upload(client)
    chunk = client.get(f"/documents/{document_id}/content").json()["chunks"][0]

    resp = client.post(
        f"/documents/{document_id}/highlights",
        json={
            "chunk_id": chunk["chunk_id"],
            "chunk_index": chunk["chunk_index"] + 1,  # real id, wrong index
            "page_number": chunk["page_number"],
            "selected_text": "Mismatch.",
        },
    )
    assert resp.status_code == 422, resp.text


def test_create_highlight_404s_for_another_users_document(harness) -> None:
    client, app, _owner, other, _vs = harness
    document_id = _upload(client)
    chunk = client.get(f"/documents/{document_id}/content").json()["chunks"][0]

    _as_user(app, other)
    resp = client.post(
        f"/documents/{document_id}/highlights",
        json={
            "chunk_id": chunk["chunk_id"],
            "chunk_index": chunk["chunk_index"],
            "page_number": chunk["page_number"],
            "selected_text": "Should not be creatable.",
        },
    )
    assert resp.status_code == 404


def test_update_highlight_note(harness) -> None:
    client, *_ = harness
    document_id = _upload(client)
    chunk = client.get(f"/documents/{document_id}/content").json()["chunks"][0]
    created = client.post(
        f"/documents/{document_id}/highlights",
        json={
            "chunk_id": chunk["chunk_id"],
            "chunk_index": chunk["chunk_index"],
            "page_number": chunk["page_number"],
            "selected_text": "Page one text content here.",
        },
    ).json()

    resp = client.patch(
        f"/documents/{document_id}/highlights/{created['id']}",
        json={"note_text": "Updated note."},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["note_text"] == "Updated note."

    resp = client.patch(
        f"/documents/{document_id}/highlights/{created['id']}",
        json={"note_text": None},
    )
    assert resp.status_code == 200
    assert resp.json()["note_text"] is None


def test_update_highlight_404s_for_another_users_highlight(harness) -> None:
    client, app, _owner, other, _vs = harness
    document_id = _upload(client)
    chunk = client.get(f"/documents/{document_id}/content").json()["chunks"][0]
    created = client.post(
        f"/documents/{document_id}/highlights",
        json={
            "chunk_id": chunk["chunk_id"],
            "chunk_index": chunk["chunk_index"],
            "page_number": chunk["page_number"],
            "selected_text": "Page one text content here.",
        },
    ).json()

    _as_user(app, other)
    resp = client.patch(
        f"/documents/{document_id}/highlights/{created['id']}",
        json={"note_text": "Should not work."},
    )
    assert resp.status_code == 404


def test_delete_highlight(harness) -> None:
    client, *_ = harness
    document_id = _upload(client)
    chunk = client.get(f"/documents/{document_id}/content").json()["chunks"][0]
    created = client.post(
        f"/documents/{document_id}/highlights",
        json={
            "chunk_id": chunk["chunk_id"],
            "chunk_index": chunk["chunk_index"],
            "page_number": chunk["page_number"],
            "selected_text": "Page one text content here.",
        },
    ).json()

    resp = client.delete(f"/documents/{document_id}/highlights/{created['id']}")
    assert resp.status_code == 204, resp.text

    listing = client.get(f"/documents/{document_id}/highlights").json()
    assert listing["highlights"] == []

    # Deleting again 404s — not a silent no-op.
    resp = client.delete(f"/documents/{document_id}/highlights/{created['id']}")
    assert resp.status_code == 404


def test_delete_highlight_404s_for_another_users_highlight(harness) -> None:
    client, app, _owner, other, _vs = harness
    document_id = _upload(client)
    chunk = client.get(f"/documents/{document_id}/content").json()["chunks"][0]
    created = client.post(
        f"/documents/{document_id}/highlights",
        json={
            "chunk_id": chunk["chunk_id"],
            "chunk_index": chunk["chunk_index"],
            "page_number": chunk["page_number"],
            "selected_text": "Page one text content here.",
        },
    ).json()

    _as_user(app, other)
    resp = client.delete(f"/documents/{document_id}/highlights/{created['id']}")
    assert resp.status_code == 404


def test_list_highlights_404s_for_another_users_document(harness) -> None:
    client, app, _owner, other, _vs = harness
    document_id = _upload(client)

    _as_user(app, other)
    resp = client.get(f"/documents/{document_id}/highlights")
    assert resp.status_code == 404


# --- Document deletion cascades to highlights -------------------------------


def test_deleting_a_document_removes_its_highlights(harness, db_engine: object) -> None:
    client, *_ = harness
    document_id = _upload(client)
    chunk = client.get(f"/documents/{document_id}/content").json()["chunks"][0]
    client.post(
        f"/documents/{document_id}/highlights",
        json={
            "chunk_id": chunk["chunk_id"],
            "chunk_index": chunk["chunk_index"],
            "page_number": chunk["page_number"],
            "selected_text": "Page one text content here.",
        },
    )

    resp = client.delete(f"/documents/{document_id}")
    assert resp.status_code == 200, resp.text

    # The document itself is gone (content 404s)...
    assert client.get(f"/documents/{document_id}/content").status_code == 404
    # ...and its highlight row was actually deleted, not left as an
    # orphaned row pointing at a document_id that no longer exists —
    # checked directly against SQL, bypassing the (now 404ing) API.
    factory = sessionmaker(bind=db_engine, autoflush=False, expire_on_commit=False)
    db = factory()
    try:
        remaining = (
            db.execute(
                select(DocumentHighlight).where(DocumentHighlight.document_id == document_id)
            )
            .scalars()
            .all()
        )
        assert remaining == []
    finally:
        db.close()
