"""Covers Milestone 1 (Document Library / Folder Management): folder CRUD
(app/api/routes_folders.py), the folder-aware additions to
app/api/routes_documents.py (upload-into-folder, PATCH move), and the
regression surface this milestone must not break (plain document upload/
list/delete still work; a move never touches the vector store).

Builds a minimal FastAPI app around the real documents + folders routers,
backed by a fresh on-disk SQLite database per test (Base.metadata.
create_all — the full Alembic migration chain is covered separately by
running `alembic upgrade head` against a scratch DB, see the milestone
report). Ollama/Qdrant are replaced with in-process fakes — this suite
never makes network I/O.
"""

import io
import os
import tempfile
import uuid
from collections.abc import Iterator

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.api.routes_documents import router as documents_router
from app.api.routes_folders import router as folders_router
from app.config import Settings, get_settings
from app.core.security import get_current_user
from app.db.base import Base
from app.db.models_auth import User
from app.db.session import get_db, get_engine, get_session_factory
from app.deps import get_embedding_provider, get_vector_store

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
    """Records every call instead of touching a real Qdrant — lets tests
    assert the Milestone 1 "folders never touch retrieval/vectors"
    guarantee directly (see test_move_document_does_not_touch_vector_store)."""

    def __init__(self) -> None:
        self.upsert_calls = 0
        self.delete_calls: list[str] = []

    def upsert_chunks(self, metadata, chunks, embeddings, *, user_id: str) -> None:
        self.upsert_calls += 1

    def delete_document(self, document_id: str, *, user_id: str) -> int:
        self.delete_calls.append(document_id)
        return 3


@pytest.fixture
def db_engine(monkeypatch: pytest.MonkeyPatch) -> Iterator[object]:
    """A fresh on-disk SQLite database. Also wired as the process-wide
    DATABASE_URL (with app.config.get_settings/app.db.session.get_engine/
    get_session_factory's lru_caches cleared): app/core/document_ingestion_jobs.py's
    background job opens its own DB session via the bare global
    get_session_factory() (never through a FastAPI Depends — it runs after
    the request that started it has already returned, see that module's
    docstring), so it cannot be redirected via app.dependency_overrides the
    way every request-scoped repository dependency below is. Pointing the
    global settings at this same file is the only way an uploaded
    document's background completion (embedding -> Qdrant -> the final
    `documents` row) is visible to this test at all."""
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
    app.include_router(folders_router)
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
    """One shared app/client (folders' dependency_overrides can be swapped
    between requests), plus two distinct users for cross-user isolation
    tests — `owner` is the identity most tests act as; `other` proves a
    folder/document never leaks across users."""
    vector_store = _FakeVectorStore()
    app = _make_app(db_engine, _build_settings(), vector_store)
    owner = _create_user(db_engine, email="owner@example.com")
    other = _create_user(db_engine, email="other@example.com")
    _as_user(app, owner)
    client = TestClient(app)
    return client, app, owner, other, vector_store


# --- folder CRUD ------------------------------------------------------


def test_create_root_folder(harness) -> None:
    client, *_ = harness
    resp = client.post("/folders", json={"name": "Research"})
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["name"] == "Research"
    assert body["parent_id"] is None
    assert body["folder_count"] == 0
    assert body["document_count"] == 0


def test_create_nested_folder(harness) -> None:
    client, *_ = harness
    parent = client.post("/folders", json={"name": "Research"}).json()
    resp = client.post("/folders", json={"name": "AI Education", "parent_id": parent["id"]})
    assert resp.status_code == 201, resp.text
    child = resp.json()
    assert child["parent_id"] == parent["id"]

    # The parent's own folder_count now reflects the new child.
    contents = client.get("/folders/contents").json()
    assert contents["folders"][0]["folder_count"] == 1


def test_duplicate_name_same_parent_conflicts(harness) -> None:
    client, *_ = harness
    client.post("/folders", json={"name": "Research"})
    resp = client.post("/folders", json={"name": "Research"})
    assert resp.status_code == 409, resp.text


def test_same_name_allowed_in_different_parents(harness) -> None:
    client, *_ = harness
    a = client.post("/folders", json={"name": "A"}).json()
    b = client.post("/folders", json={"name": "B"}).json()
    resp1 = client.post("/folders", json={"name": "Notes", "parent_id": a["id"]})
    resp2 = client.post("/folders", json={"name": "Notes", "parent_id": b["id"]})
    assert resp1.status_code == 201
    assert resp2.status_code == 201


def test_create_folder_under_missing_parent_404(harness) -> None:
    client, *_ = harness
    resp = client.post("/folders", json={"name": "X", "parent_id": str(uuid.uuid4())})
    assert resp.status_code == 404


def test_create_folder_empty_name_rejected(harness) -> None:
    client, *_ = harness
    resp = client.post("/folders", json={"name": "   "})
    assert resp.status_code == 422


def test_rename_folder(harness) -> None:
    client, *_ = harness
    folder = client.post("/folders", json={"name": "Old"}).json()
    resp = client.patch(f"/folders/{folder['id']}", json={"name": "New"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["name"] == "New"


def test_rename_folder_conflict(harness) -> None:
    client, *_ = harness
    client.post("/folders", json={"name": "Taken"})
    folder = client.post("/folders", json={"name": "Other"}).json()
    resp = client.patch(f"/folders/{folder['id']}", json={"name": "Taken"})
    assert resp.status_code == 409


def test_move_folder(harness) -> None:
    client, *_ = harness
    a = client.post("/folders", json={"name": "A"}).json()
    b = client.post("/folders", json={"name": "B"}).json()
    resp = client.patch(f"/folders/{b['id']}", json={"parent_id": a["id"]})
    assert resp.status_code == 200, resp.text
    assert resp.json()["parent_id"] == a["id"]


def test_move_folder_to_root(harness) -> None:
    client, *_ = harness
    a = client.post("/folders", json={"name": "A"}).json()
    b = client.post("/folders", json={"name": "B", "parent_id": a["id"]}).json()
    resp = client.patch(f"/folders/{b['id']}", json={"parent_id": None})
    assert resp.status_code == 200, resp.text
    assert resp.json()["parent_id"] is None


def test_circular_folder_reference_rejected(harness) -> None:
    client, *_ = harness
    a = client.post("/folders", json={"name": "A"}).json()
    b = client.post("/folders", json={"name": "B", "parent_id": a["id"]}).json()

    # A cannot become a child of its own child B.
    resp = client.patch(f"/folders/{a['id']}", json={"parent_id": b["id"]})
    assert resp.status_code == 400

    # A folder cannot become its own parent either.
    resp2 = client.patch(f"/folders/{a['id']}", json={"parent_id": a["id"]})
    assert resp2.status_code == 400


def test_breadcrumbs_and_nested_listing(harness) -> None:
    client, *_ = harness
    research = client.post("/folders", json={"name": "Research"}).json()
    ai_ed = client.post(
        "/folders", json={"name": "AI Education", "parent_id": research["id"]}
    ).json()

    contents = client.get("/folders/contents", params={"folder_id": ai_ed["id"]}).json()
    assert [b["name"] for b in contents["breadcrumbs"]] == ["Research", "AI Education"]
    assert contents["folder"]["id"] == ai_ed["id"]

    root_contents = client.get("/folders/contents").json()
    assert root_contents["folder"] is None
    assert root_contents["breadcrumbs"] == []
    assert [f["name"] for f in root_contents["folders"]] == ["Research"]


# --- cross-user isolation ----------------------------------------------


def test_cannot_read_another_users_folder(harness) -> None:
    client, app, owner, other, _ = harness
    folder = client.post("/folders", json={"name": "Private"}).json()

    _as_user(app, other)
    resp = client.get("/folders/contents", params={"folder_id": folder["id"]})
    assert resp.status_code == 404

    resp2 = client.patch(f"/folders/{folder['id']}", json={"name": "Hijacked"})
    assert resp2.status_code == 404

    resp3 = client.delete(f"/folders/{folder['id']}")
    assert resp3.status_code == 404
    _as_user(app, owner)


def test_cannot_create_folder_under_another_users_parent(harness) -> None:
    client, app, owner, other, _ = harness
    folder = client.post("/folders", json={"name": "Owner folder"}).json()

    _as_user(app, other)
    resp = client.post("/folders", json={"name": "Sneaky", "parent_id": folder["id"]})
    assert resp.status_code == 404
    _as_user(app, owner)


# --- delete safety -------------------------------------------------------


def test_delete_empty_folder_succeeds(harness) -> None:
    client, *_ = harness
    folder = client.post("/folders", json={"name": "Empty"}).json()
    resp = client.delete(f"/folders/{folder['id']}")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["deleted"] is True
    assert body["moved_folders"] == 0
    assert body["moved_documents"] == 0

    assert client.get("/folders/contents", params={"folder_id": folder["id"]}).status_code == 404


def test_delete_non_empty_folder_blocked_by_default(harness) -> None:
    client, *_ = harness
    parent = client.post("/folders", json={"name": "Parent"}).json()
    client.post("/folders", json={"name": "Child", "parent_id": parent["id"]})

    resp = client.delete(f"/folders/{parent['id']}")
    assert resp.status_code == 409

    # Never silently deleted the child — it's still there afterward.
    contents = client.get("/folders/contents", params={"folder_id": parent["id"]}).json()
    assert len(contents["folders"]) == 1


def test_delete_with_move_contents_to_root(harness) -> None:
    client, *_ = harness
    parent = client.post("/folders", json={"name": "Parent"}).json()
    child = client.post("/folders", json={"name": "Child", "parent_id": parent["id"]}).json()

    resp = client.delete(f"/folders/{parent['id']}", params={"move_contents_to_root": "true"})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["moved_folders"] == 1
    assert body["moved_documents"] == 0

    # Child now lives at root, never deleted.
    root_contents = client.get("/folders/contents").json()
    assert any(f["id"] == child["id"] for f in root_contents["folders"])


# --- document upload / move ---------------------------------------------


def _upload(
    client: TestClient,
    *,
    folder_id: str | None = None,
    filename: str = "notes.txt",
    doi: str | None = None,
):
    data = {"document_type": "report"}
    if folder_id is not None:
        data["folder_id"] = folder_id
    if doi is not None:
        data["doi"] = doi
    return client.post(
        "/documents",
        data=data,
        files={"file": (filename, io.BytesIO(b"Some plain text content for ingestion."), "text/plain")},
    )


def test_upload_into_active_folder(harness) -> None:
    client, _, _, _, vector_store = harness
    folder = client.post("/folders", json={"name": "Research"}).json()

    resp = _upload(client, folder_id=folder["id"])
    assert resp.status_code == 202, resp.text
    job_id = resp.json()["job_id"]

    job = client.get(f"/documents/jobs/{job_id}").json()
    assert job["status"] == "completed"
    assert job["document"]["folder_id"] == folder["id"]
    assert vector_store.upsert_calls == 1

    contents = client.get("/folders/contents", params={"folder_id": folder["id"]}).json()
    assert contents["documents_total"] == 1


def test_folder_contents_includes_full_bibliographic_and_enrichment_fields(harness) -> None:
    """Regression test for a bug found during Milestone 4.1's real-browser
    validation: GET /folders/contents used to build DocumentSummary via its
    own second, never-updated copy of _document_summary() that silently
    dropped volume/issue/page_start/page_end/publisher/abstract/keywords/
    language/metadata_sources (Milestone 4) and last_enriched_at/
    enrichment_provider/enrichment_status/has_usable_doi (Milestone 4.1)
    from every document reached through the folder-library listing —
    while GET /documents (the non-folder listing) always had them."""
    client, *_ = harness
    resp = _upload(client, doi="10.1000/abc123")
    assert resp.status_code == 202, resp.text
    document_id = client.get(f"/documents/jobs/{resp.json()['job_id']}").json()["document"][
        "document_id"
    ]
    client.patch(
        f"/documents/{document_id}/metadata",
        json={"volume": "12", "issue": "3", "publisher": "A Publisher"},
    )

    contents = client.get("/folders/contents").json()
    assert contents["documents_total"] == 1
    document = contents["documents"][0]
    assert document["doi"] == "10.1000/abc123"
    assert document["volume"] == "12"
    assert document["issue"] == "3"
    assert document["publisher"] == "A Publisher"
    assert document["metadata_sources"]["volume"] == "user"
    assert document["has_usable_doi"] is True
    assert "last_enriched_at" in document
    assert "enrichment_status" in document


def test_upload_without_folder_lands_at_root(harness) -> None:
    client, *_ = harness
    resp = _upload(client)
    assert resp.status_code == 202, resp.text
    job = client.get(f"/documents/jobs/{resp.json()['job_id']}").json()
    assert job["document"]["folder_id"] is None

    # Existing flat GET /documents behavior is unaffected by this milestone.
    listing = client.get("/documents").json()
    assert listing["total"] == 1
    assert listing["documents"][0]["folder_id"] is None


def test_upload_into_missing_folder_404s_before_ingestion(harness) -> None:
    client, _, _, _, vector_store = harness
    resp = _upload(client, folder_id=str(uuid.uuid4()))
    assert resp.status_code == 404
    # Fails fast — never even started embedding/indexing.
    assert vector_store.upsert_calls == 0


def test_upload_into_another_users_folder_404s(harness) -> None:
    client, app, owner, other, _ = harness
    folder = client.post("/folders", json={"name": "Owner only"}).json()
    _as_user(app, other)
    resp = _upload(client, folder_id=folder["id"])
    assert resp.status_code == 404
    _as_user(app, owner)


def test_move_document_between_folders(harness) -> None:
    client, _, _, _, vector_store = harness
    folder_a = client.post("/folders", json={"name": "A"}).json()
    folder_b = client.post("/folders", json={"name": "B"}).json()
    job = _upload(client, folder_id=folder_a["id"]).json()
    document_id = client.get(f"/documents/jobs/{job['job_id']}").json()["document"]["document_id"]

    resp = client.patch(f"/documents/{document_id}", json={"folder_id": folder_b["id"]})
    assert resp.status_code == 200, resp.text
    assert resp.json()["folder_id"] == folder_b["id"]

    a_contents = client.get("/folders/contents", params={"folder_id": folder_a["id"]}).json()
    b_contents = client.get("/folders/contents", params={"folder_id": folder_b["id"]}).json()
    assert a_contents["documents_total"] == 0
    assert b_contents["documents_total"] == 1


def test_move_document_to_root(harness) -> None:
    client, *_ = harness
    folder = client.post("/folders", json={"name": "A"}).json()
    job = _upload(client, folder_id=folder["id"]).json()
    document_id = client.get(f"/documents/jobs/{job['job_id']}").json()["document"]["document_id"]

    resp = client.patch(f"/documents/{document_id}", json={"folder_id": None})
    assert resp.status_code == 200
    assert resp.json()["folder_id"] is None


def test_move_document_does_not_touch_vector_store(harness) -> None:
    """Milestone 1's core Qdrant-safety requirement: moving a document
    between folders is pure SQL metadata — it must never re-embed, re-
    upsert, or otherwise call into the vector store."""
    client, _, _, _, vector_store = harness
    folder_a = client.post("/folders", json={"name": "A"}).json()
    folder_b = client.post("/folders", json={"name": "B"}).json()
    job = _upload(client, folder_id=folder_a["id"]).json()
    document_id = client.get(f"/documents/jobs/{job['job_id']}").json()["document"]["document_id"]

    calls_before = vector_store.upsert_calls
    client.patch(f"/documents/{document_id}", json={"folder_id": folder_b["id"]})
    client.patch(f"/documents/{document_id}", json={"folder_id": None})
    assert vector_store.upsert_calls == calls_before
    assert vector_store.delete_calls == []


def test_move_document_into_another_users_folder_404s(harness) -> None:
    client, app, owner, other, _ = harness
    job = _upload(client).json()
    document_id = client.get(f"/documents/jobs/{job['job_id']}").json()["document"]["document_id"]

    _as_user(app, other)
    other_folder = client.post("/folders", json={"name": "Other's folder"}).json()
    _as_user(app, owner)

    resp = client.patch(f"/documents/{document_id}", json={"folder_id": other_folder["id"]})
    assert resp.status_code == 404


def test_document_deletion_still_removes_vector_chunks(harness) -> None:
    """Regression: Milestone 1 must not disturb existing delete behavior —
    still calls vector_store.delete_document for the right document_id."""
    client, _, _, _, vector_store = harness
    folder = client.post("/folders", json={"name": "A"}).json()
    job = _upload(client, folder_id=folder["id"]).json()
    document_id = client.get(f"/documents/jobs/{job['job_id']}").json()["document"]["document_id"]

    resp = client.delete(f"/documents/{document_id}")
    assert resp.status_code == 200, resp.text
    assert resp.json()["deleted"] is True
    assert vector_store.delete_calls == [document_id]

    # Also gone from the folder listing.
    contents = client.get("/folders/contents", params={"folder_id": folder["id"]}).json()
    assert contents["documents_total"] == 0


# --- feature flag ---------------------------------------------------------


def test_disabled_flag_404s_every_folder_endpoint(db_engine) -> None:
    vector_store = _FakeVectorStore()
    settings = _build_settings(folder_library_enabled=False)
    app = _make_app(db_engine, settings, vector_store)
    owner = _create_user(db_engine, email="owner2@example.com")
    _as_user(app, owner)
    client = TestClient(app)

    assert client.post("/folders", json={"name": "X"}).status_code == 404
    assert client.get("/folders/contents").status_code == 404
    assert client.patch(f"/folders/{uuid.uuid4()}", json={"name": "Y"}).status_code == 404
    assert client.delete(f"/folders/{uuid.uuid4()}").status_code == 404

    # Plain upload/list/delete still work exactly as before this milestone —
    # folder_id is silently ignored rather than erroring.
    resp = _upload(client, folder_id=str(uuid.uuid4()))
    assert resp.status_code == 202, resp.text
    job = client.get(f"/documents/jobs/{resp.json()['job_id']}").json()
    assert job["document"]["folder_id"] is None

    document_id = job["document"]["document_id"]
    assert client.patch(f"/documents/{document_id}", json={"folder_id": None}).status_code == 404
