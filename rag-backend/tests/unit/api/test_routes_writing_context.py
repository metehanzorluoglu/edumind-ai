"""Milestone 6.1 (Writing Context Engine) Part 25 — the API/service
boundary. HTTP-level tests: auth-gating, project-not-found/other-user
isolation, and that a real request returns a well-formed packet through
the full FastAPI dependency chain (not just the engine function directly,
which test_writing_context_engine.py already covers thoroughly)."""

from __future__ import annotations

import os
import tempfile
import uuid
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.api.routes_writing import router as writing_router
from app.api.routes_writing_context import router as writing_context_router
from app.core.retrieval_schemas import RetrievedChunk
from app.core.security import get_current_user
from app.db.base import Base
from app.db.models_auth import User
from app.db.session import get_db, get_engine, get_session_factory
from app.deps import get_retriever
from app.db.writing_projects_repository import WritingProjectsRepository


class _EmptyRetriever:
    def retrieve(
        self, query: str, *, user_id: str, top_k: int = 8, filters: object | None = None
    ) -> list[RetrievedChunk]:
        return []


@pytest.fixture
def harness(tmp_path: Path) -> Iterator[tuple[TestClient, uuid.UUID]]:
    fd, db_path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    engine = create_engine(f"sqlite:///{db_path}", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)

    session = factory()
    user = User(id=uuid.uuid4(), email=f"{uuid.uuid4()}@example.com")
    session.add(user)
    session.commit()
    user_id = user.id
    session.close()

    app = FastAPI()
    app.include_router(writing_router)
    app.include_router(writing_context_router)

    def _get_db() -> Iterator[object]:
        db = factory()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = _get_db
    app.dependency_overrides[get_engine] = lambda: engine
    app.dependency_overrides[get_session_factory] = lambda: factory
    app.dependency_overrides[get_current_user] = lambda: session_user(factory, user_id)
    app.dependency_overrides[get_retriever] = lambda: _EmptyRetriever()

    client = TestClient(app)
    try:
        yield client, user_id
    finally:
        engine.dispose()
        os.remove(db_path)


def session_user(factory, user_id: uuid.UUID) -> User:
    db = factory()
    try:
        return db.get(User, user_id)
    finally:
        db.close()


def _make_project(client: TestClient) -> str:
    resp = client.post(
        "/writing-projects",
        json={"title": "Context Test Project", "description": None},
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


class TestWritingContextEndpoint:
    def test_requires_authentication(self, harness: tuple[TestClient, uuid.UUID]) -> None:
        client, _user_id = harness
        client.app.dependency_overrides.pop(get_current_user, None)
        resp = client.post(
            "/writing-projects/not-a-real-id/context", json={"project_id": "x", "user_request": ""}
        )
        assert resp.status_code in (401, 403)

    def test_unknown_project_returns_404(self, harness: tuple[TestClient, uuid.UUID]) -> None:
        client, _user_id = harness
        fake_id = str(uuid.uuid4())
        resp = client.post(
            f"/writing-projects/{fake_id}/context",
            json={"project_id": fake_id, "user_request": "hi"},
        )
        assert resp.status_code == 404

    def test_real_request_returns_well_formed_packet(
        self, harness: tuple[TestClient, uuid.UUID]
    ) -> None:
        client, _user_id = harness
        project_id = _make_project(client)
        resp = client.post(
            f"/writing-projects/{project_id}/context",
            json={"project_id": project_id, "user_request": "Improve the grammar."},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["policy"] == "local_edit"
        assert "budget" in body
        assert "diagnostics" in body
        assert body["diagnostics"]["llm_calls_made"] == 0

    def test_url_project_id_is_authoritative_over_body(
        self, harness: tuple[TestClient, uuid.UUID]
    ) -> None:
        client, _user_id = harness
        real_project_id = _make_project(client)
        resp = client.post(
            f"/writing-projects/{real_project_id}/context",
            json={"project_id": "some-other-id-entirely", "user_request": "hi"},
        )
        assert resp.status_code == 200, resp.text
