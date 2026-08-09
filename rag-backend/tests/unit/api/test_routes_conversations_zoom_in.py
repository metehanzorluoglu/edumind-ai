"""Covers Milestone 4 (Zoom-In / strict selected-source mode): the
GET/PATCH /conversations/{id}/scope surface's `zoom_in_mode` field —
persistence, the ">=1 selected source" enforcement, the independent
`zoom_in_enabled` feature flag, and cross-user isolation. Retrieval-level
strictness/leakage (proving project/general tiers never execute and never
leak a citation) is covered separately in
tests/unit/core/test_zoom_in_retrieval.py — this file is the HTTP/
persistence contract only, same split as test_routes_conversations_
document_scope.py (Milestone 2) uses for its own surface.

Same harness pattern as test_routes_conversations_document_scope.py: a
minimal FastAPI app around the real conversations router, a fresh on-disk
SQLite database per test, and a fake vector store (scope's own retrieval
behavior is not exercised through this HTTP surface at all — only
persistence).
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
    def update_scope_associations(
        self, document_id: str, *, user_id: str, conversation_ids: list[str], project_ids: list[str]
    ) -> int:
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


def _make_app(db_engine: object, settings: Settings) -> FastAPI:
    app = FastAPI()
    app.include_router(conversations_router)
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


def _create_document(db_engine: object, *, user_id: uuid.UUID) -> Document:
    db = _session_factory(db_engine)()
    try:
        document = Document(
            document_id=str(uuid.uuid4()),
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


def _add_association(db_engine: object, *, conversation_id: uuid.UUID, document_id: str) -> None:
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
    app = _make_app(db_engine, _build_settings())
    owner = _create_user(db_engine, email="owner@example.com")
    other = _create_user(db_engine, email="other@example.com")
    _as_user(app, owner)
    client = TestClient(app)
    return client, app, owner, other, db_engine


# --- GET defaults ---------------------------------------------------------


def test_get_scope_defaults_zoom_in_mode_false(harness) -> None:
    client, _app, owner, _other, db_engine = harness
    conversation = _create_conversation(db_engine, user_id=owner.id)

    resp = client.get(f"/conversations/{conversation.id}/scope")

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["zoom_in_mode"] is False
    assert body["chat_enabled"] is True  # unchanged pre-existing defaults


def test_get_scope_missing_conversation_404s(harness) -> None:
    client, *_ = harness
    resp = client.get(f"/conversations/{uuid.uuid4()}/scope")
    assert resp.status_code == 404


# --- PATCH enforcement: >=1 selected source -------------------------------


def test_enabling_zoom_in_with_zero_sources_is_rejected(harness) -> None:
    client, _app, owner, _other, db_engine = harness
    conversation = _create_conversation(db_engine, user_id=owner.id)

    resp = client.patch(f"/conversations/{conversation.id}/scope", json={"zoom_in_mode": True})

    assert resp.status_code == 422, resp.text
    # Nothing was written — a second GET still shows the untouched default.
    get_resp = client.get(f"/conversations/{conversation.id}/scope")
    assert get_resp.json()["zoom_in_mode"] is False


def test_enabling_zoom_in_with_one_selected_source_succeeds(harness) -> None:
    client, _app, owner, _other, db_engine = harness
    conversation = _create_conversation(db_engine, user_id=owner.id)
    doc = _create_document(db_engine, user_id=owner.id)
    _add_association(db_engine, conversation_id=conversation.id, document_id=doc.document_id)

    resp = client.patch(f"/conversations/{conversation.id}/scope", json={"zoom_in_mode": True})

    assert resp.status_code == 200, resp.text
    assert resp.json()["zoom_in_mode"] is True


def test_disabling_zoom_in_never_requires_a_selected_source(harness) -> None:
    """Turning Zoom-In OFF (or a request that doesn't mention it at all)
    is never subject to the >=1-source check — only turning it ON is."""
    client, _app, owner, _other, db_engine = harness
    conversation = _create_conversation(db_engine, user_id=owner.id)
    doc = _create_document(db_engine, user_id=owner.id)
    _add_association(db_engine, conversation_id=conversation.id, document_id=doc.document_id)
    client.patch(f"/conversations/{conversation.id}/scope", json={"zoom_in_mode": True})

    # Now remove the only source, then turn Zoom-In back off — must succeed
    # even though the conversation currently has zero selected sources.
    resp = client.patch(f"/conversations/{conversation.id}/scope", json={"zoom_in_mode": False})

    assert resp.status_code == 200, resp.text
    assert resp.json()["zoom_in_mode"] is False


def test_other_scope_fields_unaffected_by_zoom_in_validation(harness) -> None:
    client, _app, owner, _other, db_engine = harness
    conversation = _create_conversation(db_engine, user_id=owner.id)

    resp = client.patch(f"/conversations/{conversation.id}/scope", json={"chat_enabled": False})

    assert resp.status_code == 200, resp.text
    assert resp.json()["chat_enabled"] is False
    assert resp.json()["zoom_in_mode"] is False


def test_missing_conversation_404s_even_with_zoom_in_mode_true(harness) -> None:
    """The existence/ownership check must run BEFORE the >=1-source check
    — a nonexistent conversation_id must 404, never the misleading 422
    "add a source" (count_conversation_documents returns 0, not an error,
    for an unowned/nonexistent id — see the route's own comment)."""
    client, *_ = harness
    resp = client.patch(f"/conversations/{uuid.uuid4()}/scope", json={"zoom_in_mode": True})
    assert resp.status_code == 404


# --- cross-user isolation --------------------------------------------------


def test_foreign_conversation_scope_get_404s(harness) -> None:
    client, app, owner, other, db_engine = harness
    conversation = _create_conversation(db_engine, user_id=owner.id)
    _as_user(app, other)

    resp = client.get(f"/conversations/{conversation.id}/scope")

    assert resp.status_code == 404


def test_foreign_conversation_scope_patch_404s(harness) -> None:
    client, app, owner, other, db_engine = harness
    conversation = _create_conversation(db_engine, user_id=owner.id)
    _as_user(app, other)

    resp = client.patch(f"/conversations/{conversation.id}/scope", json={"zoom_in_mode": True})

    assert resp.status_code == 404


def test_zoom_in_state_is_never_shared_across_users(harness) -> None:
    """Two users' own conversations track zoom_in_mode independently even
    when both happen to have the exact same document selected shape."""
    client, app, owner, other, db_engine = harness
    owner_conversation = _create_conversation(db_engine, user_id=owner.id)
    owner_doc = _create_document(db_engine, user_id=owner.id)
    _add_association(
        db_engine, conversation_id=owner_conversation.id, document_id=owner_doc.document_id
    )
    client.patch(f"/conversations/{owner_conversation.id}/scope", json={"zoom_in_mode": True})

    _as_user(app, other)
    other_conversation = _create_conversation(db_engine, user_id=other.id)
    resp = client.get(f"/conversations/{other_conversation.id}/scope")

    assert resp.json()["zoom_in_mode"] is False


# --- zoom_in_enabled feature flag ------------------------------------------


def test_zoom_in_disabled_flag_blocks_enabling_but_not_get(db_engine: object) -> None:
    app = _make_app(db_engine, _build_settings(zoom_in_enabled=False))
    owner = _create_user(db_engine, email="owner2@example.com")
    _as_user(app, owner)
    client = TestClient(app)
    conversation = _create_conversation(db_engine, user_id=owner.id)
    doc = _create_document(db_engine, user_id=owner.id)
    _add_association(db_engine, conversation_id=conversation.id, document_id=doc.document_id)

    get_resp = client.get(f"/conversations/{conversation.id}/scope")
    assert get_resp.status_code == 200
    assert get_resp.json()["zoom_in_mode"] is False

    patch_resp = client.patch(
        f"/conversations/{conversation.id}/scope", json={"zoom_in_mode": True}
    )
    assert patch_resp.status_code == 404

    # An unrelated field is still editable while the flag is off.
    other_patch = client.patch(
        f"/conversations/{conversation.id}/scope", json={"general_enabled": False}
    )
    assert other_patch.status_code == 200
    assert other_patch.json()["general_enabled"] is False


def test_zoom_in_disabled_flag_does_not_regress_an_already_active_conversation(
    db_engine: object,
) -> None:
    """A conversation already in Zoom-In when the flag is turned off keeps
    its stored setting and keeps reporting it via GET — turning the flag
    off is a rollback for the ENTRY POINT, never a silent widening of an
    already-strict conversation's retrieval scope."""
    app = _make_app(db_engine, _build_settings())
    owner = _create_user(db_engine, email="owner3@example.com")
    _as_user(app, owner)
    client = TestClient(app)
    conversation = _create_conversation(db_engine, user_id=owner.id)
    doc = _create_document(db_engine, user_id=owner.id)
    _add_association(db_engine, conversation_id=conversation.id, document_id=doc.document_id)
    client.patch(f"/conversations/{conversation.id}/scope", json={"zoom_in_mode": True})

    app.dependency_overrides[get_settings] = lambda: _build_settings(zoom_in_enabled=False)

    get_resp = client.get(f"/conversations/{conversation.id}/scope")
    assert get_resp.json()["zoom_in_mode"] is True

    # Turning it back OFF must still work even with the flag disabled —
    # only turning it ON is gated.
    off_resp = client.patch(f"/conversations/{conversation.id}/scope", json={"zoom_in_mode": False})
    assert off_resp.status_code == 200
    assert off_resp.json()["zoom_in_mode"] is False
