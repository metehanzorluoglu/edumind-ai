"""Milestone 5.4 (LaTeX Templates & Project Import) — HTTP-level coverage
for /writing-templates: list/detail/create-from-template, and Part 16
("after creation there is no template-specific behavior anywhere") —
the created project must be indistinguishable from any normal
WritingProject at the API level."""

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
from app.api.routes_writing_files import router as writing_files_router
from app.api.routes_writing_templates import router as writing_templates_router
from app.config import Settings, get_settings
from app.core.security import get_current_user
from app.db.base import Base
from app.db.models_auth import User
from app.db.session import get_db, get_engine, get_session_factory
from app.deps import get_writing_project_file_storage
from app.services.writing_project_file_storage import WritingProjectFileStorage

_TEST_JWT_SECRET = "test-only-secret-not-a-real-credential-32chars"


def _build_settings(**overrides: object) -> Settings:
    defaults: dict[str, object] = {"jwt_secret": _TEST_JWT_SECRET, "app_env": "test"}
    defaults.update(overrides)
    return Settings(**defaults)  # type: ignore[arg-type]


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


def _make_app(db_engine: object, writing_file_storage: WritingProjectFileStorage) -> FastAPI:
    app = FastAPI()
    app.include_router(writing_router)
    app.include_router(writing_files_router)
    app.include_router(writing_templates_router)
    factory = sessionmaker(bind=db_engine, autoflush=False, expire_on_commit=False)

    def override_get_db() -> Iterator[object]:
        db = factory()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_settings] = lambda: _build_settings()
    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[get_writing_project_file_storage] = lambda: writing_file_storage
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


@pytest.fixture
def harness(db_engine: object, tmp_path: Path):
    file_storage = WritingProjectFileStorage(root_dir=str(tmp_path / "writing-files"))
    app = _make_app(db_engine, file_storage)
    owner = _create_user(db_engine, email="owner@example.com")
    other = _create_user(db_engine, email="other@example.com")
    app.dependency_overrides[get_current_user] = lambda: owner
    client = TestClient(app)
    return client, app, owner, other


class TestListAndDetail:
    def test_list_returns_five_curated_templates(self, harness) -> None:
        client, *_ = harness
        resp = client.get("/writing-templates")
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["total"] == 5
        assert {t["id"] for t in body["templates"]} == {
            "blank-article",
            "academic-article",
            "two-column-paper",
            "thesis-starter",
            "research-proposal",
        }
        # Part 48 — list response has no file bodies.
        for t in body["templates"]:
            assert "files" not in t

    def test_detail_returns_files_and_root(self, harness) -> None:
        client, *_ = harness
        resp = client.get("/writing-templates/academic-article")
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["root"] == "main.tex"
        assert any(f["path"] == "main.tex" for f in body["files"])

    def test_detail_404_for_unknown_template(self, harness) -> None:
        client, *_ = harness
        resp = client.get("/writing-templates/does-not-exist")
        assert resp.status_code == 404

    def test_templates_require_authentication(self, db_engine: object, tmp_path: Path) -> None:
        file_storage = WritingProjectFileStorage(root_dir=str(tmp_path / "writing-files"))
        app = _make_app(db_engine, file_storage)
        client = TestClient(app)
        resp = client.get("/writing-templates")
        assert resp.status_code in (401, 403)


class TestCreateFromTemplate:
    def test_create_returns_a_normal_writing_project(self, harness) -> None:
        client, *_ = harness
        resp = client.post(
            "/writing-templates/academic-article/create",
            json={"title": "My Thesis Paper", "description": "from template"},
        )
        assert resp.status_code == 201, resp.text
        project = resp.json()
        assert project["title"] == "My Thesis Paper"
        assert project["description"] == "from template"
        assert project["root_file_id"] is not None
        assert "\\documentclass" in project["main_tex_content"]

    def test_created_project_has_a_full_multi_file_tree_reachable_via_writing_files_api(self, harness) -> None:
        client, *_ = harness
        resp = client.post("/writing-templates/academic-article/create", json={"title": "Paper"})
        project_id = resp.json()["id"]
        tree_resp = client.get(f"/writing-projects/{project_id}/files")
        assert tree_resp.status_code == 200, tree_resp.text
        tree = tree_resp.json()
        assert tree["file_count"] >= 6  # main.tex + sections folder + 5 section files

    def test_create_from_blank_article_template_matches_single_file_shape(self, harness) -> None:
        client, *_ = harness
        resp = client.post("/writing-templates/blank-article/create", json={"title": "Blank"})
        assert resp.status_code == 201, resp.text
        project_id = resp.json()["id"]
        tree = client.get(f"/writing-projects/{project_id}/files").json()
        assert tree["file_count"] == 1

    def test_create_requires_a_title(self, harness) -> None:
        client, *_ = harness
        resp = client.post("/writing-templates/blank-article/create", json={"title": ""})
        assert resp.status_code == 422

    def test_create_404_for_unknown_template(self, harness) -> None:
        client, *_ = harness
        resp = client.post("/writing-templates/does-not-exist/create", json={"title": "X"})
        assert resp.status_code == 404

    def test_created_project_appears_in_the_owners_project_list(self, harness) -> None:
        client, *_ = harness
        create_resp = client.post("/writing-templates/blank-article/create", json={"title": "Findable"})
        project_id = create_resp.json()["id"]
        list_resp = client.get("/writing-projects")
        assert list_resp.status_code == 200
        ids = [p["id"] for p in list_resp.json()["projects"]]
        assert project_id in ids

    def test_two_creations_from_the_same_template_are_fully_independent(self, harness) -> None:
        # Part 20 — template updates (or a second use) must never couple
        # two created projects together.
        client, *_ = harness
        first = client.post("/writing-templates/blank-article/create", json={"title": "Copy One"}).json()
        second = client.post("/writing-templates/blank-article/create", json={"title": "Copy Two"}).json()
        assert first["id"] != second["id"]

        patch_resp = client.patch(
            f"/writing-projects/{first['id']}", json={"main_tex_content": "\\documentclass{article} EDITED"}
        )
        assert patch_resp.status_code == 200, patch_resp.text
        second_after = client.get(f"/writing-projects/{second['id']}").json()
        assert "EDITED" not in second_after["main_tex_content"]

    def test_other_user_cannot_see_first_users_created_project(self, harness) -> None:
        client, app, owner, other = harness
        create_resp = client.post("/writing-templates/blank-article/create", json={"title": "Private"})
        project_id = create_resp.json()["id"]

        app.dependency_overrides[get_current_user] = lambda: other
        other_client = TestClient(app)
        resp = other_client.get(f"/writing-projects/{project_id}")
        assert resp.status_code == 404
