"""Covers Milestone 2 (conversation document scope): the bulk
selection-management surface added this milestone (GET/POST/PUT
/conversations/{id}/documents) plus regression coverage for what already
shipped and must stay correct (DELETE single-remove, cross-user isolation,
document/conversation deletion cleanup, folder moves not touching scope,
project associations remaining intact, and the conversation_scope_enabled
feature flag).

Builds a minimal FastAPI app around the real conversations + documents
routers, backed by a fresh on-disk SQLite database per test — same
Base.metadata.create_all pattern as test_routes_auth.py/
test_routes_folders.py. Conversations and Documents are inserted directly
via the ORM (bypassing the real ingestion/chat pipeline entirely, which
this milestone's scope-management surface has no dependency on) — a fake
Qdrant vector store records every call instead, so tests can assert the
"scope changes never touch vectors" guarantee directly.
"""

import os
import tempfile
import uuid
from collections.abc import Iterator
from datetime import UTC, datetime

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.api.routes_conversations import router as conversations_router
from app.api.routes_documents import router as documents_router
from app.api.routes_folders import router as folders_router
from app.config import Settings, get_settings
from app.core.security import get_current_user
from app.db.base import Base
from app.db.models_auth import User
from app.db.models_conversations import Conversation
from app.db.models_documents import Document
from app.db.models_scopes import ConversationDocument
from app.db.session import get_db
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
    """Records every call — lets tests assert Milestone 2's core Qdrant-
    safety requirement directly: a scope change is only ever a
    set_payload-shaped resync (update_scope_associations), never
    upsert_chunks (which would mean re-embedding) or delete_document."""

    def __init__(self) -> None:
        self.upsert_calls = 0
        self.delete_calls: list[str] = []
        self.scope_sync_calls: list[dict[str, object]] = []

    def upsert_chunks(self, metadata, chunks, embeddings, *, user_id: str) -> None:
        self.upsert_calls += 1

    def delete_document(self, document_id: str, *, user_id: str) -> int:
        self.delete_calls.append(document_id)
        return 1

    def update_scope_associations(
        self, document_id: str, *, user_id: str, conversation_ids: list[str], project_ids: list[str]
    ) -> int:
        self.scope_sync_calls.append(
            {
                "document_id": document_id,
                "user_id": user_id,
                "conversation_ids": list(conversation_ids),
                "project_ids": list(project_ids),
            }
        )
        return 1


@pytest.fixture
def db_engine() -> Iterator[object]:
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    engine = create_engine(f"sqlite:///{path}", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    try:
        yield engine
    finally:
        engine.dispose()
        os.remove(path)


def _make_app(db_engine: object, settings: Settings, vector_store: _FakeVectorStore) -> FastAPI:
    app = FastAPI()
    app.include_router(conversations_router)
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


def _session_factory(db_engine: object):
    return sessionmaker(bind=db_engine, autoflush=False, expire_on_commit=False)


def _create_user(db_engine: object, *, email: str) -> User:
    db = _session_factory(db_engine)()
    try:
        user = User(email=email, email_verified=True)
        db.add(user)
        db.commit()
        db.refresh(user)
        db.expunge(user)
        return user
    finally:
        db.close()


def _create_conversation(db_engine: object, *, user_id: uuid.UUID) -> Conversation:
    db = _session_factory(db_engine)()
    try:
        conversation = Conversation(user_id=user_id)
        db.add(conversation)
        db.commit()
        db.refresh(conversation)
        db.expunge(conversation)
        return conversation
    finally:
        db.close()


def _create_document(
    db_engine: object, *, user_id: uuid.UUID, document_id: str | None = None
) -> Document:
    db = _session_factory(db_engine)()
    try:
        document = Document(
            document_id=document_id or str(uuid.uuid4()),
            user_id=user_id,
            sha256=uuid.uuid4().hex + uuid.uuid4().hex[:32],
            source_filename="paper.pdf",
            authors=[],
            document_type="report",
            chunk_count=3,
            page_count=1,
            file_format="pdf",
            ingested_at=datetime.now(UTC),
        )
        db.add(document)
        db.commit()
        db.refresh(document)
        db.expunge(document)
        return document
    finally:
        db.close()


def _seed_association_directly(
    db_engine: object, *, conversation_id: uuid.UUID, document_id: str
) -> None:
    """Inserts a conversation_documents row without going through any
    route — used only to test DELETE's behavior on an association that
    already exists independent of how it got there (e.g. seeded before
    conversation_scope_enabled was ever turned off)."""
    db = _session_factory(db_engine)()
    try:
        db.add(ConversationDocument(conversation_id=conversation_id, document_id=document_id))
        db.commit()
    finally:
        db.close()


def _as_user(app: FastAPI, user: User) -> None:
    app.dependency_overrides[get_current_user] = lambda: user


@pytest.fixture
def harness(db_engine: object):
    """One shared app/client, two users (`owner` acts through `client` by
    default; `other` proves cross-user isolation), and a fake vector store
    whose call log tests assert against directly."""
    vector_store = _FakeVectorStore()
    app = _make_app(db_engine, _build_settings(), vector_store)
    owner = _create_user(db_engine, email="owner@example.com")
    other = _create_user(db_engine, email="other@example.com")
    _as_user(app, owner)
    client = TestClient(app)
    return client, app, owner, other, vector_store, db_engine


# --- list / add / replace / remove --------------------------------------


def test_list_empty_scope(harness) -> None:
    client, _app, owner, *_ = harness
    conversation = _create_conversation(harness[5], user_id=owner.id)

    resp = client.get(f"/conversations/{conversation.id}/documents")

    assert resp.status_code == 200, resp.text
    assert resp.json() == {"documents": [], "total": 0}


def test_add_one_document(harness) -> None:
    client, _app, owner, *_ , db_engine = harness
    conversation = _create_conversation(db_engine, user_id=owner.id)
    doc = _create_document(db_engine, user_id=owner.id)

    resp = client.post(
        f"/conversations/{conversation.id}/documents", json={"document_ids": [doc.document_id]}
    )

    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["total"] == 1
    assert body["documents"][0]["document_id"] == doc.document_id


def test_add_multiple_documents_in_one_call(harness) -> None:
    client, _app, owner, *_ , db_engine = harness
    conversation = _create_conversation(db_engine, user_id=owner.id)
    doc_a = _create_document(db_engine, user_id=owner.id)
    doc_b = _create_document(db_engine, user_id=owner.id)

    resp = client.post(
        f"/conversations/{conversation.id}/documents",
        json={"document_ids": [doc_a.document_id, doc_b.document_id]},
    )

    assert resp.status_code == 201, resp.text
    ids = {d["document_id"] for d in resp.json()["documents"]}
    assert ids == {doc_a.document_id, doc_b.document_id}


def test_duplicate_add_is_idempotent(harness) -> None:
    client, _app, owner, *_ , db_engine = harness
    conversation = _create_conversation(db_engine, user_id=owner.id)
    doc = _create_document(db_engine, user_id=owner.id)

    client.post(
        f"/conversations/{conversation.id}/documents", json={"document_ids": [doc.document_id]}
    )
    resp = client.post(
        f"/conversations/{conversation.id}/documents", json={"document_ids": [doc.document_id]}
    )

    assert resp.status_code == 201
    assert resp.json()["total"] == 1  # never duplicated


def test_duplicate_ids_within_one_request_are_deduplicated(harness) -> None:
    client, _app, owner, *_ , db_engine = harness
    conversation = _create_conversation(db_engine, user_id=owner.id)
    doc = _create_document(db_engine, user_id=owner.id)

    resp = client.post(
        f"/conversations/{conversation.id}/documents",
        json={"document_ids": [doc.document_id, doc.document_id, doc.document_id]},
    )

    assert resp.status_code == 201
    assert resp.json()["total"] == 1


def test_remove_one_document(harness) -> None:
    client, _app, owner, *_ , db_engine = harness
    conversation = _create_conversation(db_engine, user_id=owner.id)
    doc = _create_document(db_engine, user_id=owner.id)
    client.post(
        f"/conversations/{conversation.id}/documents", json={"document_ids": [doc.document_id]}
    )

    resp = client.delete(f"/conversations/{conversation.id}/documents/{doc.document_id}")

    assert resp.status_code == 204
    listing = client.get(f"/conversations/{conversation.id}/documents").json()
    assert listing["total"] == 0


def test_replace_scope(harness) -> None:
    client, _app, owner, *_ , db_engine = harness
    conversation = _create_conversation(db_engine, user_id=owner.id)
    doc_a = _create_document(db_engine, user_id=owner.id)
    doc_b = _create_document(db_engine, user_id=owner.id)
    doc_c = _create_document(db_engine, user_id=owner.id)
    client.post(
        f"/conversations/{conversation.id}/documents",
        json={"document_ids": [doc_a.document_id, doc_b.document_id]},
    )

    resp = client.put(
        f"/conversations/{conversation.id}/documents",
        json={"document_ids": [doc_b.document_id, doc_c.document_id]},
    )

    assert resp.status_code == 200, resp.text
    ids = {d["document_id"] for d in resp.json()["documents"]}
    assert ids == {doc_b.document_id, doc_c.document_id}  # a removed, c added, b untouched


def test_replace_with_empty_list_clears_scope(harness) -> None:
    client, _app, owner, *_ , db_engine = harness
    conversation = _create_conversation(db_engine, user_id=owner.id)
    doc = _create_document(db_engine, user_id=owner.id)
    client.post(
        f"/conversations/{conversation.id}/documents", json={"document_ids": [doc.document_id]}
    )

    resp = client.put(f"/conversations/{conversation.id}/documents", json={"document_ids": []})

    assert resp.status_code == 200
    assert resp.json() == {"documents": [], "total": 0}


def test_replace_does_not_resync_documents_that_stay_in_scope(harness) -> None:
    """Efficiency guarantee: a document present both before and after a
    replace must not get a redundant Qdrant resync call."""
    client, _app, owner, _, vector_store, db_engine = harness
    conversation = _create_conversation(db_engine, user_id=owner.id)
    doc_a = _create_document(db_engine, user_id=owner.id)
    doc_b = _create_document(db_engine, user_id=owner.id)
    client.post(
        f"/conversations/{conversation.id}/documents",
        json={"document_ids": [doc_a.document_id, doc_b.document_id]},
    )
    calls_before = len(vector_store.scope_sync_calls)

    client.put(
        f"/conversations/{conversation.id}/documents",
        json={"document_ids": [doc_a.document_id, doc_b.document_id]},  # unchanged set
    )

    assert len(vector_store.scope_sync_calls) == calls_before  # no new syncs


def test_missing_conversation_404s(harness) -> None:
    client, _app, owner, *_ , db_engine = harness
    doc = _create_document(db_engine, user_id=owner.id)

    assert client.get(f"/conversations/{uuid.uuid4()}/documents").status_code == 404
    assert (
        client.post(
            f"/conversations/{uuid.uuid4()}/documents", json={"document_ids": [doc.document_id]}
        ).status_code
        == 404
    )
    assert (
        client.put(
            f"/conversations/{uuid.uuid4()}/documents", json={"document_ids": [doc.document_id]}
        ).status_code
        == 404
    )


def test_missing_document_404s_and_applies_nothing(harness) -> None:
    """Atomic validation: a bulk request naming one real + one fake
    document_id must add NEITHER — never a partial apply."""
    client, _app, owner, *_ , db_engine = harness
    conversation = _create_conversation(db_engine, user_id=owner.id)
    real_doc = _create_document(db_engine, user_id=owner.id)

    resp = client.post(
        f"/conversations/{conversation.id}/documents",
        json={"document_ids": [real_doc.document_id, "does-not-exist"]},
    )

    assert resp.status_code == 404
    listing = client.get(f"/conversations/{conversation.id}/documents").json()
    assert listing["total"] == 0  # the valid id was NOT added


def test_replace_missing_document_404s_and_applies_nothing(harness) -> None:
    client, _app, owner, *_ , db_engine = harness
    conversation = _create_conversation(db_engine, user_id=owner.id)
    real_doc = _create_document(db_engine, user_id=owner.id)
    client.post(
        f"/conversations/{conversation.id}/documents", json={"document_ids": [real_doc.document_id]}
    )

    resp = client.put(
        f"/conversations/{conversation.id}/documents",
        json={"document_ids": ["does-not-exist"]},
    )

    assert resp.status_code == 404
    listing = client.get(f"/conversations/{conversation.id}/documents").json()
    assert listing["total"] == 1  # unchanged — the original document is still there


# --- security -------------------------------------------------------------


def test_foreign_conversation_rejected(harness) -> None:
    client, app, owner, other, _, db_engine = harness
    conversation = _create_conversation(db_engine, user_id=owner.id)
    doc = _create_document(db_engine, user_id=owner.id)

    _as_user(app, other)
    assert client.get(f"/conversations/{conversation.id}/documents").status_code == 404
    assert (
        client.post(
            f"/conversations/{conversation.id}/documents", json={"document_ids": [doc.document_id]}
        ).status_code
        == 404
    )
    assert (
        client.put(
            f"/conversations/{conversation.id}/documents", json={"document_ids": [doc.document_id]}
        ).status_code
        == 404
    )
    assert (
        client.delete(f"/conversations/{conversation.id}/documents/{doc.document_id}").status_code
        == 404
    )
    _as_user(app, owner)


def test_foreign_document_rejected(harness) -> None:
    """User A cannot scope User B's document — even though A owns the
    conversation, B's document_id must be rejected (see
    InvalidDocumentIdsError)."""
    client, _app, owner, other, _, db_engine = harness
    conversation = _create_conversation(db_engine, user_id=owner.id)
    foreign_doc = _create_document(db_engine, user_id=other.id)

    resp = client.post(
        f"/conversations/{conversation.id}/documents",
        json={"document_ids": [foreign_doc.document_id]},
    )

    assert resp.status_code == 404
    listing = client.get(f"/conversations/{conversation.id}/documents").json()
    assert listing["total"] == 0


def test_cross_user_association_impossible_even_with_valid_ids_on_both_sides(harness) -> None:
    """User A cannot modify User B's conversation scope — proven with a
    conversation AND document that both genuinely exist, just owned by
    different users than the caller."""
    client, _app, owner, other, _, db_engine = harness
    others_conversation = _create_conversation(db_engine, user_id=other.id)
    owners_doc = _create_document(db_engine, user_id=owner.id)

    # owner tries to scope their OWN document into OTHER's conversation.
    resp = client.post(
        f"/conversations/{others_conversation.id}/documents",
        json={"document_ids": [owners_doc.document_id]},
    )
    assert resp.status_code == 404


# --- lifecycle --------------------------------------------------------------


def test_delete_document_removes_conversation_association(harness) -> None:
    client, _app, owner, *_ , db_engine = harness
    conversation = _create_conversation(db_engine, user_id=owner.id)
    doc = _create_document(db_engine, user_id=owner.id)
    client.post(
        f"/conversations/{conversation.id}/documents", json={"document_ids": [doc.document_id]}
    )

    resp = client.delete(f"/documents/{doc.document_id}")
    assert resp.status_code == 200, resp.text

    listing = client.get(f"/conversations/{conversation.id}/documents").json()
    assert listing["total"] == 0  # orphan association removed, not left dangling


def test_delete_conversation_removes_its_document_associations(harness) -> None:
    """No direct way to observe conversation_documents post-delete via the
    API (the conversation itself is gone) — this proves the *document*
    survives (still listable/usable elsewhere) and the conversation
    endpoints now 404, which is the externally-observable half of "the
    association row is gone too" (the DB-level cleanup itself is covered
    by ConversationsRepository's own existing docstring/behavior, unchanged
    by this milestone)."""
    client, _app, owner, *_ , db_engine = harness
    conversation = _create_conversation(db_engine, user_id=owner.id)
    doc = _create_document(db_engine, user_id=owner.id)
    client.post(
        f"/conversations/{conversation.id}/documents", json={"document_ids": [doc.document_id]}
    )

    resp = client.delete(f"/conversations/{conversation.id}")
    assert resp.status_code == 204

    assert client.get(f"/conversations/{conversation.id}/documents").status_code == 404
    # The document itself is untouched — still a real document a NEW
    # conversation could scope.
    another_conversation = _create_conversation(db_engine, user_id=owner.id)
    resp2 = client.post(
        f"/conversations/{another_conversation.id}/documents",
        json={"document_ids": [doc.document_id]},
    )
    assert resp2.status_code == 201


def test_project_association_unaffected_by_conversation_scope_changes(harness) -> None:
    """Adding/removing a document from a conversation's scope must never
    touch that same document's project associations — proven via the fake
    vector store's scope_sync_calls, which always carries whatever
    project_ids currently exist (empty here, since none were ever added)
    alongside the conversation_ids being changed."""
    client, _app, owner, _, vector_store, db_engine = harness
    conversation = _create_conversation(db_engine, user_id=owner.id)
    doc = _create_document(db_engine, user_id=owner.id)

    client.post(
        f"/conversations/{conversation.id}/documents", json={"document_ids": [doc.document_id]}
    )

    assert vector_store.scope_sync_calls[-1]["project_ids"] == []
    assert vector_store.scope_sync_calls[-1]["conversation_ids"] == [str(conversation.id)]


def test_moving_document_between_folders_does_not_affect_conversation_scope(harness) -> None:
    """Milestone 1 x Milestone 2 interaction: folder_id (organizational,
    Milestone 1) and conversation_documents (retrieval scope, Milestone 2)
    are fully independent — moving a document between folders must never
    add, remove, or resync its conversation associations."""
    client, _app, owner, _, vector_store, db_engine = harness
    conversation = _create_conversation(db_engine, user_id=owner.id)
    doc = _create_document(db_engine, user_id=owner.id)
    client.post(
        f"/conversations/{conversation.id}/documents", json={"document_ids": [doc.document_id]}
    )
    folder = client.post("/folders", json={"name": "Research"}).json()
    calls_before = len(vector_store.scope_sync_calls)

    resp = client.patch(f"/documents/{doc.document_id}", json={"folder_id": folder["id"]})

    assert resp.status_code == 200, resp.text
    assert len(vector_store.scope_sync_calls) == calls_before  # no scope resync from a folder move
    listing = client.get(f"/conversations/{conversation.id}/documents").json()
    assert listing["total"] == 1  # still scoped to the conversation
    assert listing["documents"][0]["document_id"] == doc.document_id


# --- Qdrant safety: scope changes never touch vectors ----------------------


def test_add_remove_replace_never_call_upsert_or_delete(harness) -> None:
    client, _app, owner, _, vector_store, db_engine = harness
    conversation = _create_conversation(db_engine, user_id=owner.id)
    doc_a = _create_document(db_engine, user_id=owner.id)
    doc_b = _create_document(db_engine, user_id=owner.id)

    client.post(
        f"/conversations/{conversation.id}/documents",
        json={"document_ids": [doc_a.document_id, doc_b.document_id]},
    )
    client.delete(f"/conversations/{conversation.id}/documents/{doc_a.document_id}")
    client.put(
        f"/conversations/{conversation.id}/documents", json={"document_ids": [doc_b.document_id]}
    )

    assert vector_store.upsert_calls == 0
    assert vector_store.delete_calls == []
    assert len(vector_store.scope_sync_calls) > 0  # only ever payload resyncs


# --- feature flag -----------------------------------------------------------


def test_disabled_flag_404s_list_add_replace_but_not_delete(db_engine) -> None:
    vector_store = _FakeVectorStore()
    settings = _build_settings(conversation_scope_enabled=False)
    app = _make_app(db_engine, settings, vector_store)
    owner = _create_user(db_engine, email="owner2@example.com")
    _as_user(app, owner)
    client = TestClient(app)
    conversation = _create_conversation(db_engine, user_id=owner.id)
    doc = _create_document(db_engine, user_id=owner.id)
    # Seeded directly (never through the now-gated POST) — an association
    # that already existed before conversation_scope_enabled was turned
    # off, or created some other way; DELETE must still be able to remove
    # it regardless.
    _seed_association_directly(
        db_engine, conversation_id=conversation.id, document_id=doc.document_id
    )

    assert client.get(f"/conversations/{conversation.id}/documents").status_code == 404
    assert (
        client.post(
            f"/conversations/{conversation.id}/documents", json={"document_ids": [doc.document_id]}
        ).status_code
        == 404
    )
    assert (
        client.put(
            f"/conversations/{conversation.id}/documents", json={"document_ids": [doc.document_id]}
        ).status_code
        == 404
    )
    # DELETE pre-dates this milestone and is deliberately NOT gated (see
    # app/config.py's conversation_scope_enabled docstring) — existing
    # chat/scope behavior must remain functional when the new bulk surface
    # is disabled.
    assert (
        client.delete(f"/conversations/{conversation.id}/documents/{doc.document_id}").status_code
        == 204
    )
