"""Milestone 5.3 (LaTeX Project Workspace & File Management) — API-level
coverage for the /writing-projects/{id}/files router: tree, create,
upload, rename, move, delete, root-file selection, ownership, path
security, and size/count limits. Same harness pattern as
test_routes_writing.py (real on-disk SQLite, real writing router mounted
alongside the new files router, a temp dir for binary asset storage)."""

from __future__ import annotations

import io
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
from app.config import Settings, get_settings
from app.core.security import get_current_user
from app.db.base import Base
from app.db.models_auth import User
from app.db.session import get_db, get_engine, get_session_factory
from app.deps import get_writing_project_file_storage
from app.services.writing_project_file_storage import WritingProjectFileStorage

_TEST_JWT_SECRET = "test-only-secret-not-a-real-credential-32chars"

#: A real, tiny, valid 1x1 PNG — used everywhere a "real image upload"
#: fixture is needed (never a fake extension on arbitrary bytes, since
#: the route sniffs real signatures — Part 11).
_PNG_BYTES = bytes.fromhex(
    "89504e470d0a1a0a0000000d494844520000000100000001080600000"
    "01f15c4890000000a49444154789c6300010000050001"
    "0d0a2db40000000049454e44ae426082"
)
_JPEG_BYTES = b"\xff\xd8\xff\xe0" + b"\x00" * 100
_PDF_BYTES = b"%PDF-1.4\n%..." + b"\x00" * 20


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


def _make_app(db_engine: object, settings: Settings, file_storage: WritingProjectFileStorage) -> FastAPI:
    app = FastAPI()
    app.include_router(writing_router)
    app.include_router(writing_files_router)
    factory = sessionmaker(bind=db_engine, autoflush=False, expire_on_commit=False)

    def override_get_db() -> Iterator[object]:
        db = factory()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_settings] = lambda: settings
    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[get_writing_project_file_storage] = lambda: file_storage
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
def harness(db_engine: object, tmp_path: Path):
    file_storage = WritingProjectFileStorage(root_dir=str(tmp_path / "writing-project-files"))
    app = _make_app(db_engine, _build_settings(), file_storage)
    owner = _create_user(db_engine, email="owner@example.com")
    other = _create_user(db_engine, email="other@example.com")
    _as_user(app, owner)
    client = TestClient(app)
    return client, app, owner, other


def _create_project(client: TestClient, *, title: str = "My Paper") -> dict:
    resp = client.post("/writing-projects", json={"title": title})
    assert resp.status_code == 201, resp.text
    return resp.json()


def _create_folder(client: TestClient, project_id: str, name: str, parent_id: str | None = None) -> dict:
    resp = client.post(
        f"/writing-projects/{project_id}/files/folders",
        json={"name": name, "parent_id": parent_id},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["file"]


def _create_text_file(
    client: TestClient, project_id: str, name: str, *, parent_id: str | None = None, content: str = ""
) -> dict:
    resp = client.post(
        f"/writing-projects/{project_id}/files/text",
        json={"name": name, "parent_id": parent_id, "content_text": content},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["file"]


def _upload(client: TestClient, project_id: str, filename: str, data: bytes, *, parent_id: str | None = None):
    form = {}
    if parent_id:
        form["parent_id"] = parent_id
    return client.post(
        f"/writing-projects/{project_id}/files/upload",
        data=form,
        files={"file": (filename, io.BytesIO(data), "application/octet-stream")},
    )


class TestTreeAndCreate:
    def test_new_project_tree_has_main_tex_as_root(self, harness) -> None:
        client, *_ = harness
        project = _create_project(client)
        resp = client.get(f"/writing-projects/{project['id']}/files")
        assert resp.status_code == 200
        body = resp.json()
        assert body["file_count"] == 1
        assert body["files"][0]["name"] == "main.tex"
        assert body["files"][0]["is_root"] is True
        assert body["root_file_id"] == body["files"][0]["id"]

    def test_generated_references_bib_always_present_and_read_only(self, harness) -> None:
        client, *_ = harness
        project = _create_project(client)
        body = client.get(f"/writing-projects/{project['id']}/files").json()
        assert len(body["generated"]) == 1
        assert body["generated"][0]["name"] == "references.bib"
        assert body["generated"][0]["read_only"] is True

    def test_create_folder_and_nested_text_file(self, harness) -> None:
        client, *_ = harness
        project = _create_project(client)
        folder = _create_folder(client, project["id"], "sections")
        assert folder["kind"] == "folder"
        assert folder["path"] == "sections"
        f = _create_text_file(
            client, project["id"], "introduction.tex", parent_id=folder["id"], content="Hello."
        )
        assert f["path"] == "sections/introduction.tex"
        assert f["kind"] == "text"

    def test_create_text_file_rejects_disallowed_extension(self, harness) -> None:
        client, *_ = harness
        project = _create_project(client)
        resp = client.post(
            f"/writing-projects/{project['id']}/files/text",
            json={"name": "script.sh", "content_text": "evil"},
        )
        assert resp.status_code == 422

    def test_duplicate_name_in_same_folder_conflicts(self, harness) -> None:
        client, *_ = harness
        project = _create_project(client)
        _create_folder(client, project["id"], "sections")
        resp = client.post(
            f"/writing-projects/{project['id']}/files/folders", json={"name": "sections"}
        )
        assert resp.status_code == 409

    def test_cannot_create_file_named_references_bib(self, harness) -> None:
        client, *_ = harness
        project = _create_project(client)
        resp = client.post(
            f"/writing-projects/{project['id']}/files/text",
            json={"name": "references.bib", "content_text": "@article{x,}"},
        )
        assert resp.status_code == 422

    @pytest.mark.parametrize(
        "bad_name",
        ["../secret.tex", "a/b.tex", "..", ".", "", "a\x00.tex"],
    )
    def test_path_traversal_and_invalid_names_rejected(self, harness, bad_name: str) -> None:
        client, *_ = harness
        project = _create_project(client)
        resp = client.post(
            f"/writing-projects/{project['id']}/files/text",
            json={"name": bad_name, "content_text": ""},
        )
        assert resp.status_code in (422, 404)

    def test_create_folder_404s_for_nonexistent_project(self, harness) -> None:
        client, *_ = harness
        resp = client.post(
            f"/writing-projects/{uuid.uuid4()}/files/folders", json={"name": "sections"}
        )
        assert resp.status_code == 404


class TestUpload:
    def test_upload_real_png_succeeds(self, harness) -> None:
        client, *_ = harness
        project = _create_project(client)
        folder = _create_folder(client, project["id"], "figures")
        resp = _upload(client, project["id"], "framework.png", _PNG_BYTES, parent_id=folder["id"])
        assert resp.status_code == 200, resp.text
        body = resp.json()["file"]
        assert body["kind"] == "binary"
        assert body["mime_type"] == "image/png"
        assert body["path"] == "figures/framework.png"

    def test_upload_real_jpeg_succeeds(self, harness) -> None:
        client, *_ = harness
        project = _create_project(client)
        resp = _upload(client, project["id"], "scan.jpg", _JPEG_BYTES)
        assert resp.status_code == 200, resp.text
        assert resp.json()["file"]["mime_type"] == "image/jpeg"

    def test_upload_real_pdf_succeeds(self, harness) -> None:
        client, *_ = harness
        project = _create_project(client)
        resp = _upload(client, project["id"], "results.pdf", _PDF_BYTES)
        assert resp.status_code == 200, resp.text
        assert resp.json()["file"]["mime_type"] == "application/pdf"

    def test_upload_rejects_content_that_does_not_match_extension(self, harness) -> None:
        """Part 11 — never trust the client's declared extension/MIME;
        this uploads plain text bytes with a .png name."""
        client, *_ = harness
        project = _create_project(client)
        resp = _upload(client, project["id"], "fake.png", b"not a real png at all")
        assert resp.status_code == 422

    def test_upload_rejects_disallowed_extension(self, harness) -> None:
        client, *_ = harness
        project = _create_project(client)
        resp = _upload(client, project["id"], "payload.exe", b"MZ\x90\x00" + b"\x00" * 50)
        assert resp.status_code == 422

    def test_upload_text_file_via_upload_endpoint(self, harness) -> None:
        client, *_ = harness
        project = _create_project(client)
        resp = _upload(client, project["id"], "methods.tex", b"\\section{Methods}")
        assert resp.status_code == 200, resp.text
        assert resp.json()["file"]["kind"] == "text"

    def test_uploaded_binary_content_downloadable_byte_for_byte(self, harness) -> None:
        client, *_ = harness
        project = _create_project(client)
        upload_resp = _upload(client, project["id"], "framework.png", _PNG_BYTES)
        file_id = upload_resp.json()["file"]["id"]
        resp = client.get(f"/writing-projects/{project['id']}/files/{file_id}/content")
        assert resp.status_code == 200
        assert resp.content == _PNG_BYTES


class TestRenameMoveDelete:
    def test_rename_updates_path(self, harness) -> None:
        client, *_ = harness
        project = _create_project(client)
        f = _create_text_file(client, project["id"], "draft.tex", content="x")
        resp = client.post(
            f"/writing-projects/{project['id']}/files/{f['id']}/rename", json={"name": "final.tex"}
        )
        assert resp.status_code == 200
        assert resp.json()["file"]["path"] == "final.tex"

    def test_rename_to_existing_sibling_name_conflicts(self, harness) -> None:
        client, *_ = harness
        project = _create_project(client)
        _create_text_file(client, project["id"], "a.tex", content="")
        b = _create_text_file(client, project["id"], "b.tex", content="")
        resp = client.post(
            f"/writing-projects/{project['id']}/files/{b['id']}/rename", json={"name": "a.tex"}
        )
        assert resp.status_code == 409

    def test_move_file_into_folder(self, harness) -> None:
        client, *_ = harness
        project = _create_project(client)
        folder = _create_folder(client, project["id"], "sections")
        f = _create_text_file(client, project["id"], "intro.tex", content="")
        resp = client.post(
            f"/writing-projects/{project['id']}/files/{f['id']}/move",
            json={"new_parent_id": folder["id"]},
        )
        assert resp.status_code == 200
        assert resp.json()["file"]["path"] == "sections/intro.tex"

    def test_cannot_move_folder_into_itself(self, harness) -> None:
        client, *_ = harness
        project = _create_project(client)
        folder = _create_folder(client, project["id"], "sections")
        resp = client.post(
            f"/writing-projects/{project['id']}/files/{folder['id']}/move",
            json={"new_parent_id": folder["id"]},
        )
        assert resp.status_code == 422

    def test_cannot_move_folder_into_its_own_descendant(self, harness) -> None:
        client, *_ = harness
        project = _create_project(client)
        parent = _create_folder(client, project["id"], "parent")
        child = _create_folder(client, project["id"], "child", parent_id=parent["id"])
        resp = client.post(
            f"/writing-projects/{project['id']}/files/{parent['id']}/move",
            json={"new_parent_id": child["id"]},
        )
        assert resp.status_code == 422

    def test_delete_folder_is_recursive(self, harness) -> None:
        client, *_ = harness
        project = _create_project(client)
        folder = _create_folder(client, project["id"], "sections")
        f = _create_text_file(client, project["id"], "intro.tex", parent_id=folder["id"], content="")
        resp = client.delete(f"/writing-projects/{project['id']}/files/{folder['id']}")
        assert resp.status_code == 204
        tree = client.get(f"/writing-projects/{project['id']}/files").json()
        remaining_ids = {n["id"] for n in tree["files"]}
        assert folder["id"] not in remaining_ids
        assert f["id"] not in remaining_ids

    def test_cannot_delete_root_file(self, harness) -> None:
        client, *_ = harness
        project = _create_project(client)
        root_id = project["root_file_id"]
        resp = client.delete(f"/writing-projects/{project['id']}/files/{root_id}")
        assert resp.status_code == 409

    def test_cannot_delete_folder_containing_root_file(self, harness) -> None:
        """Part 16 — the root file's containing folder is protected too,
        not just the root file's own row."""
        client, *_ = harness
        project = _create_project(client)
        folder = _create_folder(client, project["id"], "top")
        root_id = project["root_file_id"]
        move_resp = client.post(
            f"/writing-projects/{project['id']}/files/{root_id}/move",
            json={"new_parent_id": folder["id"]},
        )
        assert move_resp.status_code == 200
        resp = client.delete(f"/writing-projects/{project['id']}/files/{folder['id']}")
        assert resp.status_code == 409


class TestRootFile:
    def test_set_root_to_another_tex_file(self, harness) -> None:
        client, *_ = harness
        project = _create_project(client)
        f = _create_text_file(client, project["id"], "paper.tex", content="\\documentclass{article}")
        resp = client.put(
            f"/writing-projects/{project['id']}/root-file", json={"file_id": f["id"]}
        )
        assert resp.status_code == 200
        assert resp.json()["file"]["is_root"] is True
        updated_project = client.get(f"/writing-projects/{project['id']}").json()
        assert updated_project["root_file_id"] == f["id"]

    def test_set_root_rejects_non_tex_file(self, harness) -> None:
        client, *_ = harness
        project = _create_project(client)
        f = _create_text_file(client, project["id"], "journal.cls", content="")
        resp = client.put(
            f"/writing-projects/{project['id']}/root-file", json={"file_id": f["id"]}
        )
        assert resp.status_code == 422

    def test_set_root_rejects_folder(self, harness) -> None:
        client, *_ = harness
        project = _create_project(client)
        folder = _create_folder(client, project["id"], "sections")
        resp = client.put(
            f"/writing-projects/{project['id']}/root-file", json={"file_id": folder["id"]}
        )
        assert resp.status_code == 422


class TestOwnership:
    def test_another_user_cannot_list_files(self, harness) -> None:
        client, app, _owner, other = harness
        project = _create_project(client)
        _as_user(app, other)
        resp = client.get(f"/writing-projects/{project['id']}/files")
        assert resp.status_code == 404

    def test_another_user_cannot_create_file(self, harness) -> None:
        client, app, _owner, other = harness
        project = _create_project(client)
        _as_user(app, other)
        resp = client.post(
            f"/writing-projects/{project['id']}/files/text",
            json={"name": "evil.tex", "content_text": ""},
        )
        assert resp.status_code == 404

    def test_another_user_cannot_read_file_content(self, harness) -> None:
        client, app, _owner, other = harness
        project = _create_project(client)
        f = _create_text_file(client, project["id"], "secret.tex", content="private data")
        _as_user(app, other)
        resp = client.get(f"/writing-projects/{project['id']}/files/{f['id']}")
        assert resp.status_code == 404

    def test_another_user_cannot_delete_file(self, harness) -> None:
        client, app, _owner, other = harness
        project = _create_project(client)
        f = _create_text_file(client, project["id"], "secret.tex", content="x")
        _as_user(app, other)
        resp = client.delete(f"/writing-projects/{project['id']}/files/{f['id']}")
        assert resp.status_code == 404

    def test_another_user_cannot_rename_file(self, harness) -> None:
        client, app, _owner, other = harness
        project = _create_project(client)
        f = _create_text_file(client, project["id"], "secret.tex", content="x")
        _as_user(app, other)
        resp = client.post(
            f"/writing-projects/{project['id']}/files/{f['id']}/rename", json={"name": "hacked.tex"}
        )
        assert resp.status_code == 404

    def test_guessed_file_id_in_own_project_404s(self, harness) -> None:
        client, *_ = harness
        project = _create_project(client)
        resp = client.get(f"/writing-projects/{project['id']}/files/{uuid.uuid4()}")
        assert resp.status_code == 404


class TestUpdateContent:
    def test_update_root_file_content_syncs_main_tex_content(self, harness) -> None:
        """Part 2 — the write-through mirror between the file row and
        the legacy `main_tex_content` column."""
        client, *_ = harness
        project = _create_project(client)
        root_id = project["root_file_id"]
        new_content = "\\documentclass{article}\\begin{document}Updated.\\end{document}"
        resp = client.patch(
            f"/writing-projects/{project['id']}/files/{root_id}",
            json={"content_text": new_content},
        )
        assert resp.status_code == 200
        updated_project = client.get(f"/writing-projects/{project['id']}").json()
        assert updated_project["main_tex_content"] == new_content

    def test_update_via_legacy_endpoint_syncs_root_file_row(self, harness) -> None:
        """The reverse direction — PATCH /writing-projects/{id} with
        main_tex_content still keeps the file row in sync."""
        client, *_ = harness
        project = _create_project(client)
        new_content = "\\documentclass{article}\\begin{document}Via legacy.\\end{document}"
        resp = client.patch(f"/writing-projects/{project['id']}", json={"main_tex_content": new_content})
        assert resp.status_code == 200
        root_id = project["root_file_id"]
        file_resp = client.get(f"/writing-projects/{project['id']}/files/{root_id}")
        assert file_resp.json()["content_text"] == new_content


def _set_root_content(client: TestClient, project_id: str, root_id: str, content: str) -> None:
    resp = client.patch(
        f"/writing-projects/{project_id}/files/{root_id}", json={"content_text": content}
    )
    assert resp.status_code == 200, resp.text


class TestReferenceMode:
    """Bibliography Source Detection — GET .../reference-mode and POST
    .../reference-mode/switch-to-edum8, route-level (ownership,
    HTTP-status mapping, end-to-end wiring against real project files
    created through this same router) — the DETECTION algorithm itself
    is unit-tested directly against real fixture content in
    tests/unit/core/test_reference_mode.py; these tests deliberately
    don't re-litigate that, only that the route wires it up correctly.
    """

    def test_a_blank_new_project_defaults_to_edum8_library_mode(self, harness) -> None:
        client, *_ = harness
        project = _create_project(client)
        resp = client.get(f"/writing-projects/{project['id']}/reference-mode")
        assert resp.status_code == 200
        body = resp.json()
        assert body["mode"] == "edum8_library"
        assert body["bibliography_source"] == "references.bib"
        assert body["citation_key_source"] == "edum8"
        assert body["keys"] == []
        assert body["edum8_available"] is False
        assert body["edum8_switch_proposal"] is None
        assert body["edum8_switch_instructions"] is None

    def test_imported_bib_database_is_detected_end_to_end(self, harness) -> None:
        client, *_ = harness
        project = _create_project(client)
        root_id = project["root_file_id"]
        _set_root_content(
            client,
            project["id"],
            root_id,
            "\\documentclass{article}\n\\bibliography{mydb}\n\\begin{document}\\end{document}",
        )
        _create_text_file(
            client,
            project["id"],
            "mydb.bib",
            content='@article{smith2020,\n  title = "A Real Title",\n  year = "2020"\n}\n',
        )
        resp = client.get(f"/writing-projects/{project['id']}/reference-mode")
        assert resp.status_code == 200
        body = resp.json()
        assert body["mode"] == "imported_bib"
        assert body["bibliography_source"] == "mydb.bib"
        assert body["citation_key_source"] == "bib_file"
        assert body["keys"] == [{"key": "smith2020", "title": "A Real Title"}]
        assert body["edum8_switch_proposal"] == {
            "file_path": "main.tex",
            "find": "\\bibliography{mydb}",
            "replace": "\\bibliography{references}",
        }
        assert body["edum8_switch_instructions"] is None

    def test_template_tex_bibliography_is_detected_end_to_end(self, harness) -> None:
        client, *_ = harness
        project = _create_project(client)
        root_id = project["root_file_id"]
        _set_root_content(
            client,
            project["id"],
            root_id,
            "\\documentclass{book}\n\\begin{document}\n\\include{Bibliography}\n\\end{document}",
        )
        _create_text_file(
            client,
            project["id"],
            "Bibliography.tex",
            content=(
                "\\begin{thebibliography}{9}\n"
                "\\bibitem{example1}\nAuthor, A. Title.\n"
                "\\end{thebibliography}\n"
            ),
        )
        resp = client.get(f"/writing-projects/{project['id']}/reference-mode")
        assert resp.status_code == 200
        body = resp.json()
        assert body["mode"] == "template_tex"
        assert body["bibliography_source"] == "Bibliography.tex"
        assert body["citation_key_source"] == "bibitem"
        assert [k["key"] for k in body["keys"]] == ["example1"]
        # No safe automatic rewrite exists for a thebibliography block —
        # instructions only, never a proposal.
        assert body["edum8_switch_proposal"] is None
        assert body["edum8_switch_instructions"] is not None
        assert "Bibliography.tex" in body["edum8_switch_instructions"]

    def test_another_users_project_404s(self, harness) -> None:
        client, app, _owner, other = harness
        project = _create_project(client)
        _as_user(app, other)
        resp = client.get(f"/writing-projects/{project['id']}/reference-mode")
        assert resp.status_code == 404

    def test_switch_to_edum8_applies_exactly_the_proposed_substitution(self, harness) -> None:
        client, *_ = harness
        project = _create_project(client)
        root_id = project["root_file_id"]
        _set_root_content(
            client,
            project["id"],
            root_id,
            "\\documentclass{article}\n\\bibliography{mydb}\n\\begin{document}\\end{document}",
        )
        _create_text_file(client, project["id"], "mydb.bib", content="@article{x,\ntitle={y}\n}")
        proposal = client.get(f"/writing-projects/{project['id']}/reference-mode").json()[
            "edum8_switch_proposal"
        ]
        assert proposal is not None
        resp = client.post(
            f"/writing-projects/{project['id']}/reference-mode/switch-to-edum8", json=proposal
        )
        assert resp.status_code == 200, resp.text
        updated_content = client.get(f"/writing-projects/{project['id']}/files/{root_id}").json()[
            "content_text"
        ]
        assert "\\bibliography{references}" in updated_content
        assert "mydb" not in updated_content
        # The old .bib file is never deleted — it simply stops being
        # referenced.
        tree = client.get(f"/writing-projects/{project['id']}/files").json()
        assert any(f["name"] == "mydb.bib" for f in tree["files"])
        # Re-checking reference-mode now reports edum8_library.
        mode_after = client.get(f"/writing-projects/{project['id']}/reference-mode").json()
        assert mode_after["mode"] == "edum8_library"

    def test_switch_to_edum8_409s_if_the_file_changed_since_the_proposal(self, harness) -> None:
        client, *_ = harness
        project = _create_project(client)
        root_id = project["root_file_id"]
        _set_root_content(
            client,
            project["id"],
            root_id,
            "\\documentclass{article}\n\\bibliography{mydb}\n\\begin{document}\\end{document}",
        )
        _create_text_file(client, project["id"], "mydb.bib", content="@article{x,\ntitle={y}\n}")
        proposal = client.get(f"/writing-projects/{project['id']}/reference-mode").json()[
            "edum8_switch_proposal"
        ]
        # The user edits the file themselves before confirming.
        _set_root_content(
            client,
            project["id"],
            root_id,
            "\\documentclass{article}\n\\bibliography{somethingelse}\n\\begin{document}\\end{document}",
        )
        resp = client.post(
            f"/writing-projects/{project['id']}/reference-mode/switch-to-edum8", json=proposal
        )
        assert resp.status_code == 409

    def test_switch_to_edum8_422s_for_a_stale_file_path(self, harness) -> None:
        client, *_ = harness
        project = _create_project(client)
        resp = client.post(
            f"/writing-projects/{project['id']}/reference-mode/switch-to-edum8",
            json={"file_path": "no-such-file.tex", "find": "x", "replace": "y"},
        )
        assert resp.status_code == 422

    def test_switch_to_edum8_404s_for_another_users_project(self, harness) -> None:
        client, app, _owner, other = harness
        project = _create_project(client)
        _as_user(app, other)
        resp = client.post(
            f"/writing-projects/{project['id']}/reference-mode/switch-to-edum8",
            json={"file_path": "main.tex", "find": "x", "replace": "y"},
        )
        assert resp.status_code == 404
