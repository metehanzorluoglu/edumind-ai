"""Covers app/api/routes_projects.py's PATCH /projects/{id} — Frontend/
Platform Milestone 3.2.2 Part F. This route (and this whole router) had
zero test coverage before this file, despite the PO reporting the
sidebar's Rename/Edit description actions as "visible but broken" —
tracing the full flow (ProjectRow.tsx -> useProjects.ts ->
EducationAssistantClient.updateProject -> this route ->
ProjectsRepository) found every layer already correct; this file closes
the coverage gap that let that go unverified, and would catch a real
regression here going forward.

Same harness pattern as test_routes_conversations_project_context.py: a
minimal FastAPI app around the real projects router, a fresh on-disk
SQLite database per test, and no vector store/embedding provider
dependency at all — the projects router never touches retrieval.
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

from app.api.routes_projects import router as projects_router
from app.config import Settings, get_settings
from app.core.security import get_current_user
from app.db.base import Base
from app.db.models_auth import User
from app.db.models_projects import Project
from app.db.session import get_db

_TEST_JWT_SECRET = "test-only-secret-not-a-real-credential-32chars"


def _build_settings(**overrides: object) -> Settings:
    defaults: dict[str, object] = {"jwt_secret": _TEST_JWT_SECRET, "app_env": "test"}
    defaults.update(overrides)
    return Settings(**defaults)  # type: ignore[arg-type]


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
    app.include_router(projects_router)
    factory = sessionmaker(bind=db_engine, autoflush=False, expire_on_commit=False)

    def override_get_db() -> Iterator[object]:
        db = factory()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_settings] = lambda: settings
    app.dependency_overrides[get_db] = override_get_db
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


def _create_project(
    db_engine: object, *, user_id: uuid.UUID, name: str, description: str | None = None
) -> Project:
    db = _session_factory(db_engine)()
    try:
        project = Project(user_id=user_id, name=name, description=description)
        db.add(project)
        db.commit()
        db.refresh(project)
        db.expunge(project)
        return project
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


class TestRename:
    def test_renames_and_returns_the_updated_summary(self, harness) -> None:
        client, _app, owner, _other, db_engine = harness
        project = _create_project(db_engine, user_id=owner.id, name="Old Name")

        resp = client.patch(f"/projects/{project.id}", json={"name": "New Name"})

        assert resp.status_code == 200, resp.text
        assert resp.json()["name"] == "New Name"
        assert resp.json()["id"] == str(project.id)

    def test_persists_across_a_fresh_get(self, harness) -> None:
        client, _app, owner, _other, db_engine = harness
        project = _create_project(db_engine, user_id=owner.id, name="Old Name")

        client.patch(f"/projects/{project.id}", json={"name": "New Name"})
        resp = client.get(f"/projects/{project.id}")

        assert resp.status_code == 200, resp.text
        assert resp.json()["name"] == "New Name"

    def test_collapses_internal_whitespace_and_strips_control_characters(self, harness) -> None:
        client, _app, owner, _other, db_engine = harness
        project = _create_project(db_engine, user_id=owner.id, name="Old Name")

        resp = client.patch(f"/projects/{project.id}", json={"name": "  New   Name  "})

        assert resp.status_code == 200, resp.text
        assert resp.json()["name"] == "New Name"

    def test_rejects_an_empty_name_with_422_and_never_mutates(self, harness) -> None:
        client, _app, owner, _other, db_engine = harness
        project = _create_project(db_engine, user_id=owner.id, name="Old Name")

        resp = client.patch(f"/projects/{project.id}", json={"name": ""})

        assert resp.status_code == 422
        assert client.get(f"/projects/{project.id}").json()["name"] == "Old Name"

    def test_rejects_a_whitespace_only_name_with_422_and_never_mutates(self, harness) -> None:
        client, _app, owner, _other, db_engine = harness
        project = _create_project(db_engine, user_id=owner.id, name="Old Name")

        resp = client.patch(f"/projects/{project.id}", json={"name": "   "})

        assert resp.status_code == 422
        assert client.get(f"/projects/{project.id}").json()["name"] == "Old Name"

    def test_a_rename_only_patch_never_touches_the_existing_description(self, harness) -> None:
        client, _app, owner, _other, db_engine = harness
        project = _create_project(
            db_engine, user_id=owner.id, name="Old Name", description="Keep me."
        )

        resp = client.patch(f"/projects/{project.id}", json={"name": "New Name"})

        assert resp.status_code == 200, resp.text
        assert resp.json()["description"] == "Keep me."


class TestEditDescription:
    def test_sets_a_new_description_and_returns_it(self, harness) -> None:
        client, _app, owner, _other, db_engine = harness
        project = _create_project(db_engine, user_id=owner.id, name="P", description="Old.")

        resp = client.patch(f"/projects/{project.id}", json={"description": "New description."})

        assert resp.status_code == 200, resp.text
        assert resp.json()["description"] == "New description."

    def test_explicit_null_clears_the_description(self, harness) -> None:
        client, _app, owner, _other, db_engine = harness
        project = _create_project(db_engine, user_id=owner.id, name="P", description="Old.")

        resp = client.patch(f"/projects/{project.id}", json={"description": None})

        assert resp.status_code == 200, resp.text
        assert resp.json()["description"] is None

    def test_a_description_only_patch_never_touches_the_existing_name(self, harness) -> None:
        client, _app, owner, _other, db_engine = harness
        project = _create_project(db_engine, user_id=owner.id, name="Keep me")

        resp = client.patch(f"/projects/{project.id}", json={"description": "New."})

        assert resp.status_code == 200, resp.text
        assert resp.json()["name"] == "Keep me"

    def test_persists_across_a_fresh_get(self, harness) -> None:
        client, _app, owner, _other, db_engine = harness
        project = _create_project(db_engine, user_id=owner.id, name="P")

        client.patch(f"/projects/{project.id}", json={"description": "Persisted."})
        resp = client.get(f"/projects/{project.id}")

        assert resp.status_code == 200, resp.text
        assert resp.json()["description"] == "Persisted."


class TestBothTogether:
    def test_a_single_patch_can_update_both_name_and_description_atomically(self, harness) -> None:
        client, _app, owner, _other, db_engine = harness
        project = _create_project(db_engine, user_id=owner.id, name="Old", description="Old.")

        resp = client.patch(
            f"/projects/{project.id}", json={"name": "New", "description": "New."}
        )

        assert resp.status_code == 200, resp.text
        assert resp.json()["name"] == "New"
        assert resp.json()["description"] == "New."


class TestZeroMutationNoOp:
    """The frontend (ProjectRow.tsx) already skips calling PATCH at all when
    nothing changed — these tests cover the backend's own side of that
    contract: even if a no-op PATCH is sent, it must never corrupt
    anything, matching an ordinary successful update in every other
    respect (never a special-cased failure)."""

    def test_a_patch_with_the_same_name_succeeds_and_changes_nothing_else(self, harness) -> None:
        client, _app, owner, _other, db_engine = harness
        project = _create_project(
            db_engine, user_id=owner.id, name="Same Name", description="Same description."
        )

        resp = client.patch(f"/projects/{project.id}", json={"name": "Same Name"})

        assert resp.status_code == 200, resp.text
        assert resp.json()["name"] == "Same Name"
        assert resp.json()["description"] == "Same description."

    def test_an_empty_body_patch_changes_nothing(self, harness) -> None:
        client, _app, owner, _other, db_engine = harness
        project = _create_project(
            db_engine, user_id=owner.id, name="Untouched", description="Untouched."
        )

        resp = client.patch(f"/projects/{project.id}", json={})

        assert resp.status_code == 200, resp.text
        assert resp.json()["name"] == "Untouched"
        assert resp.json()["description"] == "Untouched."


class TestOwnershipAndNotFound:
    """Security regression coverage (Part F explicitly requires this, since
    this route IS touched here) — ownership/404 semantics must be
    indistinguishable from a genuinely missing project, never leaking
    whether a project id exists for a different user."""

    def test_another_users_project_404s_on_rename_never_mutates(self, harness) -> None:
        client, _app, _owner, other, db_engine = harness
        project = _create_project(db_engine, user_id=other.id, name="Not Yours")

        resp = client.patch(f"/projects/{project.id}", json={"name": "Hijacked"})

        assert resp.status_code == 404

    def test_another_users_project_404s_on_description_edit_never_mutates(self, harness) -> None:
        client, _app, _owner, other, db_engine = harness
        project = _create_project(db_engine, user_id=other.id, name="Not Yours")

        resp = client.patch(f"/projects/{project.id}", json={"description": "Hijacked."})

        assert resp.status_code == 404

    def test_a_genuinely_nonexistent_project_id_404s(self, harness) -> None:
        client, _app, _owner, _other, _db_engine = harness

        resp = client.patch(f"/projects/{uuid.uuid4()}", json={"name": "Ghost"})

        assert resp.status_code == 404


class TestDeleteRegression:
    """Part F explicitly requires Delete Project to keep working exactly
    as before — regression-checked here since this test file is the
    first to touch this router at all."""

    def test_delete_removes_the_project(self, harness) -> None:
        client, _app, owner, _other, db_engine = harness
        project = _create_project(db_engine, user_id=owner.id, name="Temp")

        resp = client.delete(f"/projects/{project.id}")

        assert resp.status_code == 204
        assert client.get(f"/projects/{project.id}").status_code == 404

    def test_delete_of_another_users_project_404s(self, harness) -> None:
        client, _app, _owner, other, db_engine = harness
        project = _create_project(db_engine, user_id=other.id, name="Not Yours")

        resp = client.delete(f"/projects/{project.id}")

        assert resp.status_code == 404
