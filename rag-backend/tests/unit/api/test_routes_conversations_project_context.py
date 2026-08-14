"""Covers Frontend Milestone 2.1: GET /conversations/{id}'s new `projects`
field — the authoritative "which project(s) does this conversation
actually belong to" signal the frontend now uses instead of inferring
membership from the conversation-scope `project_enabled` toggle (which
defaults true for every conversation, project or not — see that
milestone's report for the full truthfulness gap this closes).

Same harness pattern as test_routes_conversations_zoom_in.py: a minimal
FastAPI app around the real conversations router, a fresh on-disk SQLite
database per test, and a fake vector store/embedding provider (retrieval
is not exercised through this HTTP surface at all — only persistence and
the response shape).
"""

import os
import tempfile
import uuid
from collections.abc import Iterator

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
from app.db.models_projects import Project, ProjectConversation
from app.db.projects_repository import ProjectsRepository
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


def _create_project(db_engine: object, *, user_id: uuid.UUID, name: str) -> Project:
    db = _session_factory(db_engine)()
    try:
        project = Project(user_id=user_id, name=name)
        db.add(project)
        db.commit()
        db.refresh(project)
        db.expunge(project)
        return project
    finally:
        db.close()


def _associate(db_engine: object, *, project_id: uuid.UUID, conversation_id: uuid.UUID) -> None:
    db = _session_factory(db_engine)()
    try:
        db.add(ProjectConversation(project_id=project_id, conversation_id=conversation_id))
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


def test_ordinary_conversation_has_empty_projects_list(harness) -> None:
    client, _app, owner, _other, db_engine = harness
    conversation = _create_conversation(db_engine, user_id=owner.id)

    resp = client.get(f"/conversations/{conversation.id}")

    assert resp.status_code == 200, resp.text
    assert resp.json()["projects"] == []


def test_project_associated_conversation_reports_id_and_name(harness) -> None:
    client, _app, owner, _other, db_engine = harness
    conversation = _create_conversation(db_engine, user_id=owner.id)
    project = _create_project(db_engine, user_id=owner.id, name="AI Literacy Study")
    _associate(db_engine, project_id=project.id, conversation_id=conversation.id)

    resp = client.get(f"/conversations/{conversation.id}")

    assert resp.status_code == 200, resp.text
    assert resp.json()["projects"] == [{"id": str(project.id), "name": "AI Literacy Study"}]


def test_conversation_in_multiple_projects_reports_all_of_them_sorted_by_name(harness) -> None:
    client, _app, owner, _other, db_engine = harness
    conversation = _create_conversation(db_engine, user_id=owner.id)
    project_b = _create_project(db_engine, user_id=owner.id, name="Reading Group")
    project_a = _create_project(db_engine, user_id=owner.id, name="AI Literacy Study")
    _associate(db_engine, project_id=project_b.id, conversation_id=conversation.id)
    _associate(db_engine, project_id=project_a.id, conversation_id=conversation.id)

    resp = client.get(f"/conversations/{conversation.id}")

    assert resp.status_code == 200, resp.text
    names = [p["name"] for p in resp.json()["projects"]]
    # Never an arbitrary "first" project — every association is reported,
    # in a stable (alphabetical) order, never insertion order.
    assert names == ["AI Literacy Study", "Reading Group"]


def test_another_users_project_association_never_leaks(harness) -> None:
    """Defense in depth: even if a (project, conversation) association row
    existed pointing at a project owned by a different user than the
    conversation's own owner — which the real add_conversation() endpoint
    can never create, since it checks both sides' ownership — the read
    path must still never surface it. Proves the repository join filters
    on Project.user_id, not just the caller's access to the conversation."""
    client, _app, owner, other, db_engine = harness
    conversation = _create_conversation(db_engine, user_id=owner.id)
    others_project = _create_project(db_engine, user_id=other.id, name="Not Yours")
    _associate(db_engine, project_id=others_project.id, conversation_id=conversation.id)

    resp = client.get(f"/conversations/{conversation.id}")

    assert resp.status_code == 200, resp.text
    assert resp.json()["projects"] == []


def test_get_conversation_missing_conversation_404s(harness) -> None:
    client, *_ = harness
    resp = client.get(f"/conversations/{uuid.uuid4()}")
    assert resp.status_code == 404


# --- Repository unit tests -------------------------------------------------


def test_repository_get_project_refs_returns_empty_list_for_unassociated_conversation(
    db_engine: object,
) -> None:
    owner = _create_user(db_engine, email="owner2@example.com")
    conversation = _create_conversation(db_engine, user_id=owner.id)
    db = _session_factory(db_engine)()
    try:
        repo = ProjectsRepository(db)
        assert repo.get_project_refs_for_conversation(owner.id, conversation.id) == []
    finally:
        db.close()


def test_repository_get_project_refs_orders_by_name(db_engine: object) -> None:
    owner = _create_user(db_engine, email="owner3@example.com")
    conversation = _create_conversation(db_engine, user_id=owner.id)
    project_z = _create_project(db_engine, user_id=owner.id, name="Zoology Notes")
    project_a = _create_project(db_engine, user_id=owner.id, name="Anatomy Notes")
    _associate(db_engine, project_id=project_z.id, conversation_id=conversation.id)
    _associate(db_engine, project_id=project_a.id, conversation_id=conversation.id)

    db = _session_factory(db_engine)()
    try:
        repo = ProjectsRepository(db)
        refs = repo.get_project_refs_for_conversation(owner.id, conversation.id)
    finally:
        db.close()

    assert [r.name for r in refs] == ["Anatomy Notes", "Zoology Notes"]
    assert [r.id for r in refs] == [project_a.id, project_z.id]
