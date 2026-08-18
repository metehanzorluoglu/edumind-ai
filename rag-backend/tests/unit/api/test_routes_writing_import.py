"""Milestone 5.4 (LaTeX Templates & Project Import) — HTTP-level coverage
for the /writing-projects/import/* upload -> inspect -> confirm/cancel
flow: Part 9 (inspection before anything is created), Part 15 (atomic
creation), Part 31 (ownership — a guessed session_id belonging to
another user 404s identically to a nonexistent one), Part 32 (TTL sweep
— no unbounded accumulation), and the release-critical security
fixtures from Part 46 exercised through the real HTTP boundary rather
than just the underlying pure function."""

from __future__ import annotations

import io
import os
import tempfile
import uuid
import zipfile
from collections.abc import Iterator
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.api.routes_writing import router as writing_router
from app.api.routes_writing_files import router as writing_files_router
from app.api.routes_writing_import import router as writing_import_router
from app.config import Settings, get_settings
from app.core.security import get_current_user
from app.db.base import Base
from app.db.models_auth import User
from app.db.session import get_db, get_engine, get_session_factory
from app.deps import get_writing_import_storage, get_writing_project_file_storage
from app.services.writing_import_storage import WritingImportStorage
from app.services.writing_project_file_storage import WritingProjectFileStorage

_TEST_JWT_SECRET = "test-only-secret-not-a-real-credential-32chars"


def _build_settings(**overrides: object) -> Settings:
    defaults: dict[str, object] = {"jwt_secret": _TEST_JWT_SECRET, "app_env": "test"}
    defaults.update(overrides)
    return Settings(**defaults)  # type: ignore[arg-type]


def _zip_bytes(entries: dict[str, bytes]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for name, data in entries.items():
            zf.writestr(name, data)
    return buf.getvalue()


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


def _make_app(
    db_engine: object,
    writing_file_storage: WritingProjectFileStorage,
    import_storage: WritingImportStorage,
) -> FastAPI:
    app = FastAPI()
    app.include_router(writing_router)
    app.include_router(writing_files_router)
    app.include_router(writing_import_router)
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
    app.dependency_overrides[get_writing_import_storage] = lambda: import_storage
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
    import_storage = WritingImportStorage(root_dir=str(tmp_path / "import-staging"))
    app = _make_app(db_engine, file_storage, import_storage)
    owner = _create_user(db_engine, email="owner@example.com")
    other = _create_user(db_engine, email="other@example.com")
    app.dependency_overrides[get_current_user] = lambda: owner
    client = TestClient(app)
    return client, app, owner, other, import_storage


def _upload(client: TestClient, data: bytes, filename: str = "project.zip"):
    return client.post(
        "/writing-projects/import/inspect", files={"file": (filename, io.BytesIO(data), "application/zip")}
    )


class TestInspect:
    def test_valid_multi_file_zip_inspected_successfully(self, harness) -> None:
        client, *_ = harness
        data = _zip_bytes(
            {
                "main.tex": b"\\documentclass{article}\\input{sections/intro}",
                "sections/intro.tex": b"Intro.",
                "figure.png": b"\x89PNG" + b"0" * 40,
                "mystyle.sty": b"\\ProvidesPackage{mystyle}",
            }
        )
        resp = _upload(client, data)
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["preselected_root"] == "main.tex"
        paths = {f["path"] for f in body["files"]}
        assert paths == {"main.tex", "sections/intro.tex", "figure.png", "mystyle.sty"}
        assert body["warnings"] == []
        assert uuid.UUID(body["session_id"])

    def test_non_zip_extension_rejected_before_any_session_created(self, harness) -> None:
        client, *_ = harness
        resp = client.post(
            "/writing-projects/import/inspect",
            files={"file": ("project.rar", io.BytesIO(b"fake"), "application/octet-stream")},
        )
        assert resp.status_code == 422

    def test_zip_slip_archive_rejected_with_422(self, harness) -> None:
        client, *_ = harness
        data = _zip_bytes({"../../etc/passwd": b"pwned"})
        resp = _upload(client, data)
        assert resp.status_code == 422

    def test_symlink_archive_rejected_with_422(self, harness) -> None:
        client, *_ = harness
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            info = zipfile.ZipInfo("link.tex")
            info.external_attr = (0o120777 & 0xFFFF) << 16
            zf.writestr(info, "/etc/passwd")
        resp = _upload(client, buf.getvalue())
        assert resp.status_code == 422

    def test_zip_bomb_ratio_rejected_with_422_and_no_resource_exhaustion(self, harness) -> None:
        client, *_ = harness
        data = _zip_bytes({"bomb.txt": b"\x00" * (10 * 1024 * 1024)})
        resp = _upload(client, data)
        assert resp.status_code == 422

    def test_references_bib_excluded_with_warning_not_rejection(self, harness) -> None:
        client, *_ = harness
        data = _zip_bytes({"main.tex": b"\\documentclass{article}", "references.bib": b"@article{x,}"})
        resp = _upload(client, data)
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert {f["path"] for f in body["files"]} == {"main.tex"}
        assert body["warnings"][0]["path"] == "references.bib"

    def test_multiple_root_candidates_reported_with_no_preselection(self, harness) -> None:
        client, *_ = harness
        data = _zip_bytes(
            {"main.tex": b"\\documentclass{article}", "alt.tex": b"\\documentclass{article}"}
        )
        resp = _upload(client, data)
        body = resp.json()
        assert body["preselected_root"] is None
        assert set(body["root_candidates"]) == {"main.tex", "alt.tex"}

    def test_rejected_archive_leaves_no_staged_bytes(self, harness) -> None:
        client, *_, import_storage = harness
        data = _zip_bytes({"../escape.tex": b"x"})
        resp = _upload(client, data)
        assert resp.status_code == 422
        assert list(import_storage._root.rglob("*.zip")) == []  # noqa: SLF001 — test-only introspection

    def test_inspect_requires_authentication(self, db_engine: object, tmp_path: Path) -> None:
        file_storage = WritingProjectFileStorage(root_dir=str(tmp_path / "writing-files"))
        import_storage = WritingImportStorage(root_dir=str(tmp_path / "import-staging"))
        app = _make_app(db_engine, file_storage, import_storage)
        client = TestClient(app)
        resp = _upload(client, _zip_bytes({"main.tex": b"\\documentclass{article}"}))
        assert resp.status_code in (401, 403)


class TestConfirm:
    def test_confirm_creates_a_normal_writing_project(self, harness) -> None:
        client, *_ = harness
        data = _zip_bytes(
            {
                "main.tex": b"\\documentclass{article}\\input{sections/intro}",
                "sections/intro.tex": b"Intro.",
                "figure.png": b"\x89PNG" + b"0" * 40,
            }
        )
        session_id = _upload(client, data).json()["session_id"]
        resp = client.post(
            f"/writing-projects/import/{session_id}/confirm",
            json={"title": "Imported Paper", "description": "from zip"},
        )
        assert resp.status_code == 201, resp.text
        project = resp.json()
        assert project["title"] == "Imported Paper"
        assert project["root_file_id"] is not None
        assert "\\documentclass" in project["main_tex_content"]

        tree = client.get(f"/writing-projects/{project['id']}/files").json()
        # main.tex + sections/ (folder) + sections/intro.tex + figure.png
        assert tree["file_count"] == 4

    def test_confirm_with_a_wrapper_folder_and_a_binary_file(self, harness) -> None:
        """Real-world regression: the Springer Nature journal template
        ships every file under a common "sn-article-template/" wrapper
        folder AND includes a binary `sn-article.pdf`. Inspection
        (_normalize_common_wrapper_prefix, M5.5.2 Part 14) strips that
        wrapper from every accepted file's `path` — but confirm's own
        binary-content re-read previously looked entries up by their RAW
        (un-stripped) zip path, so it could never find a match and 500'd
        with "Staged archive is missing a previously-inspected entry"
        for every project with BOTH a wrapper folder and a binary file.
        Found via real-browser testing against the actual fixture, not a
        synthetic case."""
        client, *_ = harness
        data = _zip_bytes(
            {
                "sn-article-template/sn-article.tex": b"\\documentclass{article}",
                "sn-article-template/sn-article.pdf": b"%PDF-1.4" + b"0" * 40,
            }
        )
        session_id = _upload(client, data).json()["session_id"]
        resp = client.post(
            f"/writing-projects/import/{session_id}/confirm",
            json={"title": "Sn Article"},
        )
        assert resp.status_code == 201, resp.text
        project = resp.json()
        tree = client.get(f"/writing-projects/{project['id']}/files").json()
        paths = {f["path"] for f in tree["files"]}
        # The wrapper folder is stripped from both files' paths.
        assert paths == {"sn-article.tex", "sn-article.pdf"}

    def test_confirm_deletes_the_session_and_staged_bytes(self, harness) -> None:
        client, *_, import_storage = harness
        data = _zip_bytes({"main.tex": b"\\documentclass{article}"})
        session_id = _upload(client, data).json()["session_id"]
        confirm_resp = client.post(
            f"/writing-projects/import/{session_id}/confirm", json={"title": "Once"}
        )
        assert confirm_resp.status_code == 201
        assert list(import_storage._root.rglob("*.zip")) == []  # noqa: SLF001

        # Confirming the same session a second time now 404s.
        second_resp = client.post(
            f"/writing-projects/import/{session_id}/confirm", json={"title": "Twice"}
        )
        assert second_resp.status_code == 404

    def test_confirm_with_explicit_root_when_multiple_candidates(self, harness) -> None:
        client, *_ = harness
        data = _zip_bytes(
            {"main.tex": b"\\documentclass{article}", "alt.tex": b"\\documentclass{article}"}
        )
        session_id = _upload(client, data).json()["session_id"]
        no_root_resp = client.post(
            f"/writing-projects/import/{session_id}/confirm", json={"title": "Ambiguous"}
        )
        assert no_root_resp.status_code == 422

        resolved_resp = client.post(
            f"/writing-projects/import/{session_id}/confirm",
            json={"title": "Resolved", "root_path": "alt.tex"},
        )
        assert resolved_resp.status_code == 201, resolved_resp.text
        assert resolved_resp.json()["main_tex_content"] == "\\documentclass{article}"

    def test_confirm_rejects_a_root_path_not_in_the_inspected_files(self, harness) -> None:
        client, *_ = harness
        data = _zip_bytes({"main.tex": b"\\documentclass{article}"})
        session_id = _upload(client, data).json()["session_id"]
        resp = client.post(
            f"/writing-projects/import/{session_id}/confirm",
            json={"title": "X", "root_path": "not-a-real-file.tex"},
        )
        assert resp.status_code == 422

    def test_confirm_404_for_unknown_session(self, harness) -> None:
        client, *_ = harness
        resp = client.post(
            f"/writing-projects/import/{uuid.uuid4()}/confirm", json={"title": "Ghost"}
        )
        assert resp.status_code == 404

    def test_confirm_404_for_malformed_session_id(self, harness) -> None:
        client, *_ = harness
        resp = client.post("/writing-projects/import/not-a-uuid/confirm", json={"title": "X"})
        assert resp.status_code == 404


class TestOwnership:
    """Part 31 — a session belongs to the uploading user only."""

    def test_other_user_cannot_confirm_first_users_session(self, harness) -> None:
        client, app, owner, other, _ = harness
        data = _zip_bytes({"main.tex": b"\\documentclass{article}"})
        session_id = _upload(client, data).json()["session_id"]

        app.dependency_overrides[get_current_user] = lambda: other
        other_client = TestClient(app)
        resp = other_client.post(
            f"/writing-projects/import/{session_id}/confirm", json={"title": "Stolen"}
        )
        assert resp.status_code == 404

    def test_other_user_cannot_cancel_first_users_session(self, harness) -> None:
        client, app, owner, other, _ = harness
        data = _zip_bytes({"main.tex": b"\\documentclass{article}"})
        session_id = _upload(client, data).json()["session_id"]

        app.dependency_overrides[get_current_user] = lambda: other
        other_client = TestClient(app)
        resp = other_client.delete(f"/writing-projects/import/{session_id}")
        assert resp.status_code == 404

        # Original owner can still confirm it afterwards — the failed
        # cross-user cancel attempt was a true no-op.
        app.dependency_overrides[get_current_user] = lambda: owner
        owner_client = TestClient(app)
        confirm_resp = owner_client.post(
            f"/writing-projects/import/{session_id}/confirm", json={"title": "Still Mine"}
        )
        assert confirm_resp.status_code == 201


class TestCancel:
    def test_cancel_deletes_session_and_staged_bytes(self, harness) -> None:
        client, *_, import_storage = harness
        data = _zip_bytes({"main.tex": b"\\documentclass{article}"})
        session_id = _upload(client, data).json()["session_id"]
        resp = client.delete(f"/writing-projects/import/{session_id}")
        assert resp.status_code == 204
        assert list(import_storage._root.rglob("*.zip")) == []  # noqa: SLF001

        confirm_resp = client.post(
            f"/writing-projects/import/{session_id}/confirm", json={"title": "Gone"}
        )
        assert confirm_resp.status_code == 404

    def test_cancel_404_for_unknown_session(self, harness) -> None:
        client, *_ = harness
        resp = client.delete(f"/writing-projects/import/{uuid.uuid4()}")
        assert resp.status_code == 404


class TestExpirySweep:
    def test_expired_session_cannot_be_confirmed_and_is_swept(self, harness, db_engine: object) -> None:
        client, *_, import_storage = harness
        data = _zip_bytes({"main.tex": b"\\documentclass{article}"})
        session_id = _upload(client, data).json()["session_id"]

        from app.db.models_writing import WritingImportSession

        factory = sessionmaker(bind=db_engine, autoflush=False, expire_on_commit=False)
        db = factory()
        try:
            row = db.get(WritingImportSession, uuid.UUID(session_id))
            row.expires_at = datetime.now(timezone.utc) - timedelta(minutes=1)
            db.commit()
        finally:
            db.close()

        resp = client.post(
            f"/writing-projects/import/{session_id}/confirm", json={"title": "Too Late"}
        )
        assert resp.status_code == 404

        # The next inspect call's sweep should have cleaned up the
        # expired staged bytes too (Part 32).
        second_upload = _upload(client, _zip_bytes({"other.tex": b"\\documentclass{article}"}))
        assert second_upload.status_code == 200
        remaining = list(import_storage._root.rglob("*.zip"))
        assert len(remaining) == 1  # only the second, still-fresh upload
