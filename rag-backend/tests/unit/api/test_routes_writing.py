"""Milestone 5 (Academic Writing & LaTeX Foundation) — API-level coverage
for the /writing-projects router: CRUD, ownership, reference association,
bibliography generation, and project export. Same harness pattern as
test_routes_documents_citation.py (real on-disk SQLite, fake embedding
provider, fake in-process vector store) — both the documents router (to
create real Documents to reference) and the writing router are mounted.
"""

from __future__ import annotations

import io
import os
import tempfile
import uuid
import zipfile
from collections.abc import Iterator
from pathlib import Path

import bibtexparser
import pymupdf
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.api.routes_documents import router as documents_router
from app.api.routes_writing import router as writing_router
from app.api.routes_writing_files import router as writing_files_router
from app.config import Settings, get_settings
from app.core.security import get_current_user
from app.db.base import Base
from app.db.models_auth import User
from app.db.session import get_db, get_engine, get_session_factory
from app.deps import (
    get_document_file_storage,
    get_embedding_provider,
    get_vector_store,
    get_writing_project_file_storage,
)
from app.services.document_file_storage import DocumentFileStorage
from app.services.writing_project_file_storage import WritingProjectFileStorage

_TEST_JWT_SECRET = "test-only-secret-not-a-real-credential-32chars"


def _build_settings(**overrides: object) -> Settings:
    defaults: dict[str, object] = {"jwt_secret": _TEST_JWT_SECRET, "app_env": "test"}
    defaults.update(overrides)
    return Settings(**defaults)  # type: ignore[arg-type]


def _make_pdf_bytes(text: str) -> bytes:
    doc = pymupdf.open()
    page = doc.new_page()
    page.insert_text((72, 72), text)
    data = doc.tobytes()
    doc.close()
    return data


class _FakeEmbeddingProvider:
    dimensions = 4

    def embed_batch(self, texts: list[str]) -> list[list[float]]:
        return [[0.1, 0.2, 0.3, 0.4] for _ in texts]


class _FakeVectorStore:
    def upsert_chunks(self, metadata, chunks, embeddings, *, user_id: str) -> None:
        pass

    def get_document_chunks(self, document_id: str, *, user_id: str) -> list:
        return []

    def update_chunk_metadata(self, document_id: str, *, user_id: str, updates: dict) -> int:
        return 0

    def delete_document(self, document_id: str, *, user_id: str) -> int:
        return 0


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


@pytest.fixture
def storage_root(tmp_path: Path) -> Path:
    return tmp_path / "document-files"


def _make_app(
    db_engine: object,
    settings: Settings,
    file_storage: DocumentFileStorage,
    writing_file_storage: WritingProjectFileStorage | None = None,
) -> FastAPI:
    app = FastAPI()
    app.include_router(documents_router)
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
    app.dependency_overrides[get_embedding_provider] = lambda: _FakeEmbeddingProvider()
    app.dependency_overrides[get_vector_store] = lambda: _FakeVectorStore()
    app.dependency_overrides[get_document_file_storage] = lambda: file_storage
    # A single shared instance for the whole app's lifetime (mirrors
    # get_writing_project_file_storage's own @lru_cache in deps.py) — a
    # fresh `WritingProjectFileStorage(root_dir=tempfile.mkdtemp())`
    # INSIDE the override lambda would mint a brand-new temp directory on
    # every single request (FastAPI calls an override callable fresh per
    # request unless it's cached), so an upload in one request would
    # write into a directory a LATER request's compile could never read
    # back from — resolved here once, outside the lambda.
    resolved_writing_file_storage = writing_file_storage or WritingProjectFileStorage(
        root_dir=tempfile.mkdtemp()
    )
    app.dependency_overrides[get_writing_project_file_storage] = lambda: resolved_writing_file_storage
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
def harness(db_engine: object, storage_root: Path):
    file_storage = DocumentFileStorage(root_dir=str(storage_root))
    app = _make_app(db_engine, _build_settings(), file_storage)
    owner = _create_user(db_engine, email="owner@example.com")
    other = _create_user(db_engine, email="other@example.com")
    _as_user(app, owner)
    client = TestClient(app)
    return client, app, owner, other


def _upload_pdf(
    client: TestClient,
    *,
    text: str = "Body text.",
    filename: str | None = None,
    **form_fields: str,
) -> dict:
    resp = client.post(
        "/documents",
        data={"document_type": "journal_article", **form_fields},
        files={
            "file": (
                filename or f"{uuid.uuid4()}.pdf",
                io.BytesIO(_make_pdf_bytes(text)),
                "application/pdf",
            )
        },
    )
    assert resp.status_code == 202, resp.text
    job = client.get(f"/documents/jobs/{resp.json()['job_id']}").json()
    assert job["status"] == "completed", job
    return job["document"]


def _create_project(client: TestClient, *, title: str = "My Paper", **fields: object) -> dict:
    resp = client.post("/writing-projects", json={"title": title, **fields})
    assert resp.status_code == 201, resp.text
    return resp.json()


def _add_reference(client: TestClient, project_id: str, document_id: str):
    return client.post(
        f"/writing-projects/{project_id}/references", json={"document_ids": [document_id]}
    )


class TestCreateGetUpdateDelete:
    def test_create_returns_default_template(self, harness) -> None:
        client, *_ = harness
        project = _create_project(client, title="Thesis")
        assert project["title"] == "Thesis"
        assert project["description"] is None
        assert "\\documentclass{article}" in project["main_tex_content"]
        assert "\\title{Thesis}" in project["main_tex_content"]
        # Section 8 — never fake authors/affiliations/content.
        assert "\\author" not in project["main_tex_content"]

    def test_create_requires_a_title(self, harness) -> None:
        client, *_ = harness
        resp = client.post("/writing-projects", json={"title": ""})
        assert resp.status_code == 422

    def test_get_returns_the_created_project(self, harness) -> None:
        client, *_ = harness
        project = _create_project(client)
        resp = client.get(f"/writing-projects/{project['id']}")
        assert resp.status_code == 200
        assert resp.json()["id"] == project["id"]

    def test_get_404_for_nonexistent_project(self, harness) -> None:
        client, *_ = harness
        resp = client.get(f"/writing-projects/{uuid.uuid4()}")
        assert resp.status_code == 404

    def test_get_404_for_malformed_id(self, harness) -> None:
        client, *_ = harness
        resp = client.get("/writing-projects/not-a-uuid")
        assert resp.status_code == 404

    def test_get_404_for_another_users_project(self, harness) -> None:
        client, app, _owner, other = harness
        project = _create_project(client)
        _as_user(app, other)
        resp = client.get(f"/writing-projects/{project['id']}")
        assert resp.status_code == 404

    def test_list_only_shows_own_projects(self, harness) -> None:
        client, app, _owner, other = harness
        _create_project(client, title="Owner's")
        _as_user(app, other)
        resp = client.get("/writing-projects")
        assert resp.status_code == 200
        assert resp.json()["projects"] == []
        assert resp.json()["total"] == 0

    def test_list_never_includes_main_tex_content(self, harness) -> None:
        client, *_ = harness
        _create_project(client)
        resp = client.get("/writing-projects")
        assert "main_tex_content" not in resp.json()["projects"][0]

    def test_patch_updates_only_main_tex_content(self, harness) -> None:
        client, *_ = harness
        project = _create_project(client, title="T", description="D")
        resp = client.patch(
            f"/writing-projects/{project['id']}", json={"main_tex_content": "\\cite{X}"}
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["main_tex_content"] == "\\cite{X}"
        assert body["title"] == "T"
        assert body["description"] == "D"

    def test_patch_can_clear_description(self, harness) -> None:
        client, *_ = harness
        project = _create_project(client, description="D")
        resp = client.patch(f"/writing-projects/{project['id']}", json={"description": None})
        assert resp.status_code == 200
        assert resp.json()["description"] is None

    def test_patch_rejects_clearing_title(self, harness) -> None:
        client, *_ = harness
        project = _create_project(client)
        resp = client.patch(f"/writing-projects/{project['id']}", json={"title": None})
        assert resp.status_code == 422

    def test_patch_404_for_another_users_project(self, harness) -> None:
        client, app, _owner, other = harness
        project = _create_project(client)
        _as_user(app, other)
        resp = client.patch(f"/writing-projects/{project['id']}", json={"title": "Hijacked"})
        assert resp.status_code == 404

    def test_delete_removes_the_project(self, harness) -> None:
        client, *_ = harness
        project = _create_project(client)
        resp = client.delete(f"/writing-projects/{project['id']}")
        assert resp.status_code == 204
        assert client.get(f"/writing-projects/{project['id']}").status_code == 404

    def test_delete_404_for_another_users_project(self, harness) -> None:
        client, app, _owner, other = harness
        project = _create_project(client)
        _as_user(app, other)
        resp = client.delete(f"/writing-projects/{project['id']}")
        assert resp.status_code == 404
        _as_user(app, harness[2])
        assert client.get(f"/writing-projects/{project['id']}").status_code == 200

    def test_deleting_a_project_never_deletes_its_referenced_document(self, harness) -> None:
        """Milestone 5 Section 30 — deletes only the project's own rows."""
        client, *_ = harness
        project = _create_project(client)
        doc = _upload_pdf(client, title="A Study", authors="Jane Doe")
        _add_reference(client, project["id"], doc["document_id"])
        client.delete(f"/writing-projects/{project['id']}")
        document_ids = [d["document_id"] for d in client.get("/documents").json()["documents"]]
        assert doc["document_id"] in document_ids


class TestReferences:
    def test_add_and_list_references(self, harness) -> None:
        client, *_ = harness
        project = _create_project(client)
        doc = _upload_pdf(client, title="A Study", authors="Jane Doe", publication_year="2020")
        resp = client.post(
            f"/writing-projects/{project['id']}/references",
            json={"document_ids": [doc["document_id"]]},
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["results"] == [{"document_id": doc["document_id"], "outcome": "added"}]

        listed = client.get(f"/writing-projects/{project['id']}/references")
        assert listed.status_code == 200
        body = listed.json()
        assert body["total"] == 1
        ref = body["references"][0]
        assert ref["document_id"] == doc["document_id"]
        assert ref["title"] == "A Study"
        assert ref["authors"] == ["Jane Doe"]
        assert ref["cited"] is False

    def test_reference_reflects_live_metadata_edits(self, harness) -> None:
        client, *_ = harness
        project = _create_project(client)
        doc = _upload_pdf(client, title="Original Title", authors="Jane Doe")
        client.post(
            f"/writing-projects/{project['id']}/references",
            json={"document_ids": [doc["document_id"]]},
        )
        client.patch(f"/documents/{doc['document_id']}/metadata", json={"title": "Edited Title"})
        listed = client.get(f"/writing-projects/{project['id']}/references").json()
        assert listed["references"][0]["title"] == "Edited Title"

    def test_cited_flag_reflects_current_main_tex_content(self, harness) -> None:
        client, *_ = harness
        project = _create_project(client)
        doc = _upload_pdf(client, title="A Study", authors="Jane Doe")
        client.post(
            f"/writing-projects/{project['id']}/references",
            json={"document_ids": [doc["document_id"]]},
        )
        bibtex = client.get(f"/writing-projects/{project['id']}/bibliography").json()
        key = bibtex["bibtex"].split("{")[1].split(",")[0]

        listed = client.get(f"/writing-projects/{project['id']}/references").json()
        assert listed["references"][0]["cited"] is False

        client.patch(
            f"/writing-projects/{project['id']}", json={"main_tex_content": f"\\cite{{{key}}}"}
        )
        listed = client.get(f"/writing-projects/{project['id']}/references").json()
        assert listed["references"][0]["cited"] is True

    def test_missing_citation_keys_surfaced(self, harness) -> None:
        client, *_ = harness
        project = _create_project(client)
        client.patch(
            f"/writing-projects/{project['id']}",
            json={"main_tex_content": "\\cite{NotInProjectYet2024}"},
        )
        listed = client.get(f"/writing-projects/{project['id']}/references").json()
        assert listed["missing_citation_keys"] == ["NotInProjectYet2024"]

    def test_add_reference_is_idempotent(self, harness) -> None:
        client, *_ = harness
        project = _create_project(client)
        doc = _upload_pdf(client)
        _add_reference(client, project["id"], doc["document_id"])
        resp = _add_reference(client, project["id"], doc["document_id"])
        assert resp.json()["results"][0]["outcome"] == "already_present"
        listed = client.get(f"/writing-projects/{project['id']}/references").json()
        assert listed["total"] == 1

    def test_add_reference_rejects_another_users_document(self, harness) -> None:
        client, app, _owner, other = harness
        doc = _upload_pdf(client, title="Owner's Doc")
        _as_user(app, other)
        other_project = _create_project(client, title="Attacker Project")
        resp = client.post(
            f"/writing-projects/{other_project['id']}/references",
            json={"document_ids": [doc["document_id"]]},
        )
        assert resp.json()["results"][0]["outcome"] == "document_not_found"

    def test_add_reference_404_for_another_users_project(self, harness) -> None:
        client, app, _owner, other = harness
        project = _create_project(client)
        _as_user(app, other)
        doc = _upload_pdf(client, title="Attacker's Doc")
        resp = client.post(
            f"/writing-projects/{project['id']}/references",
            json={"document_ids": [doc["document_id"]]},
        )
        assert resp.status_code == 404

    def test_remove_reference_keeps_the_document(self, harness) -> None:
        client, *_ = harness
        project = _create_project(client)
        doc = _upload_pdf(client)
        _add_reference(client, project["id"], doc["document_id"])
        resp = client.delete(f"/writing-projects/{project['id']}/references/{doc['document_id']}")
        assert resp.status_code == 204
        listed = client.get(f"/writing-projects/{project['id']}/references").json()
        assert listed["total"] == 0
        document_ids = [d["document_id"] for d in client.get("/documents").json()["documents"]]
        assert doc["document_id"] in document_ids

    def test_remove_reference_404_when_not_present(self, harness) -> None:
        client, *_ = harness
        project = _create_project(client)
        doc = _upload_pdf(client)
        resp = client.delete(f"/writing-projects/{project['id']}/references/{doc['document_id']}")
        assert resp.status_code == 404

    def test_remove_reference_404_for_another_users_project(self, harness) -> None:
        client, app, _owner, other = harness
        project = _create_project(client)
        doc = _upload_pdf(client)
        _add_reference(client, project["id"], doc["document_id"])
        _as_user(app, other)
        resp = client.delete(f"/writing-projects/{project['id']}/references/{doc['document_id']}")
        assert resp.status_code == 404

    def test_deleting_referenced_document_removes_the_reference_but_not_the_project(
        self, harness
    ) -> None:
        client, *_ = harness
        project = _create_project(client)
        doc = _upload_pdf(client)
        _add_reference(client, project["id"], doc["document_id"])
        resp = client.delete(f"/documents/{doc['document_id']}")
        assert resp.status_code == 200
        assert client.get(f"/writing-projects/{project['id']}").status_code == 200
        listed = client.get(f"/writing-projects/{project['id']}/references").json()
        assert listed["total"] == 0


class TestBibliographyAndExport:
    def test_bibliography_reflects_current_references(self, harness) -> None:
        client, *_ = harness
        project = _create_project(client)
        doc = _upload_pdf(client, title="A Study", authors="Jane Doe", publication_year="2020")
        _add_reference(client, project["id"], doc["document_id"])
        resp = client.get(f"/writing-projects/{project['id']}/bibliography")
        assert resp.status_code == 200
        body = resp.json()
        assert body["reference_count"] == 1
        parsed = bibtexparser.loads(body["bibtex"])
        assert len(parsed.entries) == 1
        assert parsed.entries[0]["title"] == "A Study"

    def test_bibliography_empty_for_project_with_no_references(self, harness) -> None:
        client, *_ = harness
        project = _create_project(client)
        resp = client.get(f"/writing-projects/{project['id']}/bibliography")
        assert resp.json()["reference_count"] == 0

    def test_bibliography_404_for_another_users_project(self, harness) -> None:
        client, app, _owner, other = harness
        project = _create_project(client)
        _as_user(app, other)
        resp = client.get(f"/writing-projects/{project['id']}/bibliography")
        assert resp.status_code == 404

    def test_export_zip_contains_main_tex_and_references_bib(self, harness) -> None:
        client, *_ = harness
        project = _create_project(client, title="Thesis")
        doc = _upload_pdf(client, title="A Study", authors="Jane Doe", publication_year="2020")
        _add_reference(client, project["id"], doc["document_id"])
        client.patch(
            f"/writing-projects/{project['id']}", json={"main_tex_content": "\\section{Body}"}
        )

        resp = client.get(f"/writing-projects/{project['id']}/export")
        assert resp.status_code == 200
        assert resp.headers["content-type"] == "application/zip"
        assert "attachment" in resp.headers["content-disposition"]

        archive = zipfile.ZipFile(io.BytesIO(resp.content))
        names = archive.namelist()
        assert "main.tex" in names
        assert "references.bib" in names
        assert archive.read("main.tex").decode("utf-8") == "\\section{Body}"
        parsed = bibtexparser.loads(archive.read("references.bib").decode("utf-8"))
        assert len(parsed.entries) == 1

    def test_export_zip_contains_no_internal_ids_or_user_data(self, harness) -> None:
        client, owner, *_ = harness[0], harness[2]
        project = _create_project(client, title="Thesis")
        resp = client.get(f"/writing-projects/{project['id']}/export")
        archive = zipfile.ZipFile(io.BytesIO(resp.content))
        assert set(archive.namelist()) == {"main.tex", "references.bib"}
        combined = archive.read("main.tex") + archive.read("references.bib")
        assert owner.email.encode() not in combined
        assert str(owner.id).encode() not in combined
        assert project["id"].encode() not in combined

    def test_export_404_for_another_users_project(self, harness) -> None:
        client, app, _owner, other = harness
        project = _create_project(client)
        _as_user(app, other)
        resp = client.get(f"/writing-projects/{project['id']}/export")
        assert resp.status_code == 404

    def test_export_zip_preserves_folder_structure_for_secondary_files(self, harness) -> None:
        """Part 31 — a secondary .tex file inside a folder round-trips
        at its real relative path, never flattened into the archive
        root."""
        client, *_ = harness
        project = _create_project(client, title="Thesis")
        folder_resp = client.post(
            f"/writing-projects/{project['id']}/files/folders", json={"name": "sections"}
        )
        folder_id = folder_resp.json()["file"]["id"]
        client.post(
            f"/writing-projects/{project['id']}/files/text",
            json={"name": "methods.tex", "parent_id": folder_id, "content_text": "Methods body."},
        )
        resp = client.get(f"/writing-projects/{project['id']}/export")
        archive = zipfile.ZipFile(io.BytesIO(resp.content))
        assert "sections/methods.tex" in archive.namelist()
        assert archive.read("sections/methods.tex").decode("utf-8") == "Methods body."


class TestDuplicateArchiveRestore:
    def test_duplicate_copies_metadata_files_and_references(self, harness) -> None:
        client, *_ = harness
        project = _create_project(client, title="Original")
        doc = _upload_pdf(client, title="A Study", authors="Jane Doe", publication_year="2020")
        _add_reference(client, project["id"], doc["document_id"])
        client.post(
            f"/writing-projects/{project['id']}/files/text",
            json={"name": "notes.tex", "content_text": "extra notes"},
        )

        resp = client.post(f"/writing-projects/{project['id']}/duplicate", json={})
        assert resp.status_code == 201, resp.text
        copy = resp.json()
        assert copy["id"] != project["id"]
        assert copy["title"] == "Original (copy)"

        copy_files = client.get(f"/writing-projects/{copy['id']}/files").json()
        assert copy_files["file_count"] == 2  # main.tex + notes.tex
        copy_refs = client.get(f"/writing-projects/{copy['id']}/references").json()
        assert copy_refs["total"] == 1

    def test_duplicate_never_touches_the_source_document(self, harness) -> None:
        client, *_ = harness
        project = _create_project(client, title="Original")
        doc = _upload_pdf(client, title="Shared Doc")
        _add_reference(client, project["id"], doc["document_id"])
        client.post(f"/writing-projects/{project['id']}/duplicate", json={})
        # The original Document itself is untouched — still exactly one
        # copy in the library, never duplicated (Part 29).
        docs = client.get("/documents").json()["documents"]
        matching = [d for d in docs if d["title"] == "Shared Doc"]
        assert len(matching) == 1

    def test_duplicate_custom_title(self, harness) -> None:
        client, *_ = harness
        project = _create_project(client, title="Original")
        resp = client.post(
            f"/writing-projects/{project['id']}/duplicate", json={"title": "My Custom Copy"}
        )
        assert resp.json()["title"] == "My Custom Copy"

    def test_duplicate_404_for_another_users_project(self, harness) -> None:
        client, app, _owner, other = harness
        project = _create_project(client)
        _as_user(app, other)
        resp = client.post(f"/writing-projects/{project['id']}/duplicate", json={})
        assert resp.status_code == 404

    def test_archive_hides_project_from_default_list(self, harness) -> None:
        client, *_ = harness
        project = _create_project(client, title="To Archive")
        resp = client.post(f"/writing-projects/{project['id']}/archive")
        assert resp.status_code == 200
        assert resp.json()["archived_at"] is not None
        active = client.get("/writing-projects").json()["projects"]
        assert all(p["id"] != project["id"] for p in active)
        archived = client.get("/writing-projects?archived=true").json()["projects"]
        assert any(p["id"] == project["id"] for p in archived)

    def test_restore_brings_project_back(self, harness) -> None:
        client, *_ = harness
        project = _create_project(client, title="To Restore")
        client.post(f"/writing-projects/{project['id']}/archive")
        resp = client.post(f"/writing-projects/{project['id']}/restore")
        assert resp.status_code == 200
        assert resp.json()["archived_at"] is None
        active = client.get("/writing-projects").json()["projects"]
        assert any(p["id"] == project["id"] for p in active)

    def test_archive_404_for_another_users_project(self, harness) -> None:
        client, app, _owner, other = harness
        project = _create_project(client)
        _as_user(app, other)
        resp = client.post(f"/writing-projects/{project['id']}/archive")
        assert resp.status_code == 404


class TestDashboardSearchSort:
    def test_search_matches_title(self, harness) -> None:
        client, *_ = harness
        _create_project(client, title="Climate Change Essay")
        _create_project(client, title="Thesis on Robotics")
        resp = client.get("/writing-projects?q=climate")
        titles = [p["title"] for p in resp.json()["projects"]]
        assert titles == ["Climate Change Essay"]

    def test_sort_by_name(self, harness) -> None:
        client, *_ = harness
        _create_project(client, title="Zebra")
        _create_project(client, title="Alpha")
        resp = client.get("/writing-projects?sort=name")
        titles = [p["title"] for p in resp.json()["projects"]]
        assert titles == ["Alpha", "Zebra"]

    def test_default_sort_is_most_recently_updated(self, harness) -> None:
        client, *_ = harness
        first = _create_project(client, title="First")
        _create_project(client, title="Second")
        client.patch(f"/writing-projects/{first['id']}", json={"description": "touched"})
        resp = client.get("/writing-projects")
        titles = [p["title"] for p in resp.json()["projects"]]
        assert titles[0] == "First"


class TestReferenceLimits:
    def test_add_references_requires_at_least_one_id(self, harness) -> None:
        client, *_ = harness
        project = _create_project(client)
        resp = client.post(
            f"/writing-projects/{project['id']}/references", json={"document_ids": []}
        )
        assert resp.status_code == 422


class _FakeCompilerClient:
    """Milestone 5.1 — a controllable stand-in for LatexCompilerClient,
    matching this file's existing "fake collaborator, real route logic"
    convention (see _FakeEmbeddingProvider/_FakeVectorStore above). The
    real compiler service's own subprocess behavior (shell-escape,
    filesystem isolation, timeouts, bibtex pipeline) is validated
    directly against the built Docker image — see the Milestone 5.1
    report's "Compiler Tests" section — this fake only exercises the
    BACKEND route's own orchestration logic (ownership, rate limiting,
    size limits, single-flight-per-project, response mapping)."""

    def __init__(self, outcome=None) -> None:
        self.outcome = outcome
        self.calls: list[dict] = []

    def compile(self, *, job_id: str, main_tex: str, references_bib: str, extra_files=None):
        self.calls.append(
            {
                "job_id": job_id,
                "main_tex": main_tex,
                "references_bib": references_bib,
                "extra_files": extra_files or {},
            }
        )
        return self.outcome


def _success_outcome(pdf_bytes: bytes = b"%PDF-fake-bytes"):
    from app.core.latex_compiler_client import CompileClientOutcome

    return CompileClientOutcome(
        ok=True, status="success", pdf_bytes=pdf_bytes, duration_ms=42.0, page_count=1
    )


class TestCompile:
    def test_compile_404_when_disabled_by_default(self, harness) -> None:
        """Settings.latex_compilation_enabled ships false — a plain
        harness (no override) is exactly a fresh deploy before a human
        operator has deliberately flipped the kill switch."""
        client, *_rest = harness
        project = _create_project(client, title="Thesis")
        resp = client.post(f"/writing-projects/{project['id']}/compile")
        assert resp.status_code == 404

    def test_pdf_download_404_when_disabled_by_default(self, harness) -> None:
        client, *_rest = harness
        project = _create_project(client, title="Thesis")
        resp = client.get(f"/writing-projects/{project['id']}/compile/anything/pdf")
        assert resp.status_code == 404

    @pytest.fixture
    def compile_harness(self, harness):
        from app.core.compile_artifact_cache import CompileArtifactCache
        from app.core.rate_limiter import RateLimiter
        from app.deps import (
            get_compile_artifact_cache,
            get_compile_rate_limiter,
            get_latex_compiler_client,
        )

        client, app, owner, other = harness
        fake_compiler = _FakeCompilerClient(outcome=_success_outcome())
        rate_limiter = RateLimiter(max_requests=100, window_seconds=60)
        artifact_cache = CompileArtifactCache(ttl_seconds=600)
        app.dependency_overrides[get_latex_compiler_client] = lambda: fake_compiler
        app.dependency_overrides[get_compile_rate_limiter] = lambda: rate_limiter
        app.dependency_overrides[get_compile_artifact_cache] = lambda: artifact_cache
        # Compile is off by default (Settings.latex_compilation_enabled) —
        # this harness explicitly opts in, matching a deployment where a
        # human operator has deliberately flipped the kill switch (see
        # test_compile_404_when_disabled_by_default below for the
        # off-by-default case itself).
        app.dependency_overrides[get_settings] = lambda: _build_settings(
            latex_compilation_enabled=True
        )
        return client, app, owner, other, fake_compiler

    def test_successful_compile_returns_compile_id_and_source_hash(self, compile_harness) -> None:
        client, *_rest, fake_compiler = compile_harness
        project = _create_project(client, title="Thesis")
        resp = client.post(f"/writing-projects/{project['id']}/compile")
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["status"] == "success"
        assert body["compile_id"]
        assert body["pdf_size_bytes"] == len(b"%PDF-fake-bytes")
        assert body["source_hash"]
        assert len(fake_compiler.calls) == 1
        # The compiler is called with the project's CURRENT saved
        # content, never a client-supplied body (Part 13/33).
        assert "\\documentclass{article}" in fake_compiler.calls[0]["main_tex"]

    def test_compile_includes_secondary_project_files_as_extra_files(self, compile_harness) -> None:
        """Milestone 5.3 Part 17 — a secondary .tex file + a figure both
        reach the compiler client's extra_files map, at their real
        relative paths, and the root file's own content is NOT
        duplicated into extra_files (it's sent separately as main_tex)."""
        client, *_rest, fake_compiler = compile_harness
        project = _create_project(client, title="Thesis")
        folder_resp = client.post(
            f"/writing-projects/{project['id']}/files/folders", json={"name": "sections"}
        )
        folder_id = folder_resp.json()["file"]["id"]
        client.post(
            f"/writing-projects/{project['id']}/files/text",
            json={
                "name": "introduction.tex",
                "parent_id": folder_id,
                "content_text": "Intro text.",
            },
        )
        png_bytes = bytes.fromhex(
            "89504e470d0a1a0a0000000d494844520000000100000001080600000"
            "01f15c4890000000a49444154789c6300010000050001"
            "0d0a2db40000000049454e44ae426082"
        )
        client.post(
            f"/writing-projects/{project['id']}/files/upload",
            files={"file": ("framework.png", io.BytesIO(png_bytes), "image/png")},
        )

        resp = client.post(f"/writing-projects/{project['id']}/compile")
        assert resp.status_code == 200, resp.text
        assert len(fake_compiler.calls) == 1
        extra_files = fake_compiler.calls[0]["extra_files"]
        assert extra_files["sections/introduction.tex"] == b"Intro text."
        assert extra_files["framework.png"] == png_bytes
        # The root file (main.tex) must never appear a second time inside
        # extra_files — it's already sent as `main_tex`.
        assert "main.tex" not in extra_files

    def test_compile_after_root_reassignment_uses_new_roots_content(
        self, compile_harness
    ) -> None:
        """Regression test — real-browser validation (M5.3 scenario K3)
        found that after reassigning root to a NEW .tex file, the OLD
        root file (still literally named "main.tex" at project root)
        was included in extra_files under the path "main.tex" — the
        exact slot the compiler workdir reserves for the real root's
        content (written first, then silently overwritten by whatever
        extra_files also claims that path). This silently compiled the
        WRONG document with no error surfaced anywhere. Covers both the
        content sent as `main_tex` AND the absence of a colliding
        extra_files entry."""
        client, *_rest, fake_compiler = compile_harness
        project = _create_project(client, title="Thesis")
        new_root_resp = client.post(
            f"/writing-projects/{project['id']}/files/text",
            json={
                "name": "paper.tex",
                "content_text": "\\documentclass{article}\nAlternate root document.",
            },
        )
        new_root_id = new_root_resp.json()["file"]["id"]
        set_root_resp = client.put(
            f"/writing-projects/{project['id']}/root-file", json={"file_id": new_root_id}
        )
        assert set_root_resp.status_code == 200, set_root_resp.text

        resp = client.post(f"/writing-projects/{project['id']}/compile")
        assert resp.status_code == 200, resp.text
        assert len(fake_compiler.calls) == 1
        assert fake_compiler.calls[0]["main_tex"] == (
            "\\documentclass{article}\nAlternate root document."
        )
        assert "main.tex" not in fake_compiler.calls[0]["extra_files"]

    def test_compile_source_hash_changes_when_secondary_file_edited(self, compile_harness) -> None:
        """Part 40 — editing a NON-root file must still change the
        source_hash used for compile-freshness."""
        client, *_rest = compile_harness
        project = _create_project(client, title="Thesis")
        create_resp = client.post(
            f"/writing-projects/{project['id']}/files/text",
            json={"name": "notes.tex", "content_text": "v1"},
        )
        file_id = create_resp.json()["file"]["id"]
        hash_before = client.get(f"/writing-projects/{project['id']}/references").json()[
            "source_hash"
        ]
        client.patch(
            f"/writing-projects/{project['id']}/files/{file_id}", json={"content_text": "v2"}
        )
        hash_after = client.get(f"/writing-projects/{project['id']}/references").json()[
            "source_hash"
        ]
        assert hash_before != hash_after

    def test_compiled_pdf_downloadable_via_compile_id(self, compile_harness) -> None:
        client, *_rest = compile_harness
        project = _create_project(client, title="Thesis")
        compile_resp = client.post(f"/writing-projects/{project['id']}/compile")
        compile_id = compile_resp.json()["compile_id"]

        pdf_resp = client.get(f"/writing-projects/{project['id']}/compile/{compile_id}/pdf")
        assert pdf_resp.status_code == 200
        assert pdf_resp.headers["content-type"] == "application/pdf"
        assert pdf_resp.content == b"%PDF-fake-bytes"

    def test_pdf_download_404_for_wrong_owner(self, compile_harness) -> None:
        client, app, _owner, other, _fake = compile_harness
        project = _create_project(client, title="Thesis")
        compile_resp = client.post(f"/writing-projects/{project['id']}/compile")
        compile_id = compile_resp.json()["compile_id"]

        _as_user(app, other)
        resp = client.get(f"/writing-projects/{project['id']}/compile/{compile_id}/pdf")
        assert resp.status_code == 404

    def test_pdf_download_404_for_guessed_compile_id(self, compile_harness) -> None:
        client, *_rest = compile_harness
        project = _create_project(client, title="Thesis")
        client.post(f"/writing-projects/{project['id']}/compile")
        resp = client.get(f"/writing-projects/{project['id']}/compile/{uuid.uuid4().hex}/pdf")
        assert resp.status_code == 404

    def test_compile_404_for_nonexistent_project(self, compile_harness) -> None:
        client, *_rest = compile_harness
        resp = client.post(f"/writing-projects/{uuid.uuid4()}/compile")
        assert resp.status_code == 404

    def test_compile_404_for_another_users_project(self, compile_harness) -> None:
        client, app, _owner, other, _fake = compile_harness
        project = _create_project(client, title="Thesis")
        _as_user(app, other)
        resp = client.post(f"/writing-projects/{project['id']}/compile")
        assert resp.status_code == 404
        # Never contacted the compiler for a project the caller doesn't own.
        assert _fake.calls == []

    def test_compile_error_status_has_no_compile_id(self, compile_harness) -> None:
        from app.core.latex_compiler_client import CompileClientOutcome
        from app.core.latex_compiler_client import Diagnostic as ClientDiagnostic

        client, _app, *_rest, fake_compiler = compile_harness
        fake_compiler.outcome = CompileClientOutcome(
            ok=True,
            status="error",
            diagnostics=(ClientDiagnostic(severity="error", message="Undefined control sequence"),),
        )
        project = _create_project(client, title="Thesis")
        resp = client.post(f"/writing-projects/{project['id']}/compile")
        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "error"
        assert body["compile_id"] is None
        assert len(body["diagnostics"]) == 1

    def test_compile_queue_full_maps_to_busy(self, compile_harness) -> None:
        from app.core.latex_compiler_client import CompileClientOutcome

        client, _app, *_rest, fake_compiler = compile_harness
        fake_compiler.outcome = CompileClientOutcome(ok=False, failure="queue_full")
        project = _create_project(client, title="Thesis")
        resp = client.post(f"/writing-projects/{project['id']}/compile")
        assert resp.status_code == 200
        assert resp.json()["status"] == "busy"

    def test_compile_client_timeout_maps_to_timeout_status(self, compile_harness) -> None:
        from app.core.latex_compiler_client import CompileClientOutcome

        client, _app, *_rest, fake_compiler = compile_harness
        fake_compiler.outcome = CompileClientOutcome(ok=False, failure="timeout")
        project = _create_project(client, title="Thesis")
        resp = client.post(f"/writing-projects/{project['id']}/compile")
        assert resp.status_code == 200
        assert resp.json()["status"] == "timeout"

    def test_compile_service_unavailable_maps_to_unavailable(self, compile_harness) -> None:
        from app.core.latex_compiler_client import CompileClientOutcome

        client, _app, *_rest, fake_compiler = compile_harness
        fake_compiler.outcome = CompileClientOutcome(ok=False, failure="unavailable")
        project = _create_project(client, title="Thesis")
        resp = client.post(f"/writing-projects/{project['id']}/compile")
        assert resp.status_code == 200
        assert resp.json()["status"] == "unavailable"

    def test_oversized_main_tex_rejected_with_413(self, harness) -> None:
        from app.core.rate_limiter import RateLimiter
        from app.deps import get_compile_rate_limiter, get_latex_compiler_client

        client, app, _owner, _other = harness
        app.dependency_overrides[get_latex_compiler_client] = lambda: _FakeCompilerClient(
            outcome=_success_outcome()
        )
        app.dependency_overrides[get_compile_rate_limiter] = lambda: RateLimiter(
            max_requests=100, window_seconds=60
        )
        app.dependency_overrides[get_settings] = lambda: _build_settings(
            compile_max_main_tex_bytes=1000, latex_compilation_enabled=True
        )
        project = _create_project(client, title="Thesis")
        client.patch(
            f"/writing-projects/{project['id']}", json={"main_tex_content": "x" * 2000}
        )
        resp = client.post(f"/writing-projects/{project['id']}/compile")
        assert resp.status_code == 413

    def test_compile_rate_limit_returns_429(self, harness) -> None:
        from app.core.rate_limiter import RateLimiter
        from app.deps import get_compile_rate_limiter, get_latex_compiler_client

        client, app, _owner, _other = harness
        rate_limiter = RateLimiter(max_requests=1, window_seconds=60)
        app.dependency_overrides[get_latex_compiler_client] = lambda: _FakeCompilerClient(
            outcome=_success_outcome()
        )
        app.dependency_overrides[get_compile_rate_limiter] = lambda: rate_limiter
        app.dependency_overrides[get_settings] = lambda: _build_settings(
            latex_compilation_enabled=True
        )
        project = _create_project(client, title="Thesis")
        first = client.post(f"/writing-projects/{project['id']}/compile")
        assert first.status_code == 200
        second = client.post(f"/writing-projects/{project['id']}/compile")
        assert second.status_code == 429
        assert "Retry-After" in second.headers

    def test_single_flight_per_project_returns_409(self, compile_harness) -> None:
        from app.api.routes_writing import _compiling_projects

        client, *_rest = compile_harness
        project = _create_project(client, title="Thesis")
        _compiling_projects.add(project["id"])
        try:
            resp = client.post(f"/writing-projects/{project['id']}/compile")
            assert resp.status_code == 409
        finally:
            _compiling_projects.discard(project["id"])

    def test_compile_never_calls_llm_or_embedding_or_qdrant(self, compile_harness) -> None:
        """Milestone 5.1 Part 47 — deterministic build infrastructure
        only. The harness's fake embedding/vector-store collaborators
        would raise/return obviously-wrong data if the compile route
        ever touched them; this test's real assertion is structural —
        the route function's own source calls only the compiler client,
        never RagService/LLMProvider/EmbeddingProvider/VectorStore."""
        import inspect

        from app.api.routes_writing import compile_writing_project

        source = inspect.getsource(compile_writing_project)
        for forbidden in ("llm_provider", "embedding_provider", "vector_store", "rag_service"):
            assert forbidden not in source

    def test_references_endpoint_includes_source_hash(self, harness) -> None:
        client, *_rest = harness
        project = _create_project(client, title="Thesis")
        resp = client.get(f"/writing-projects/{project['id']}/references")
        assert resp.status_code == 200
        assert resp.json()["source_hash"]

    def test_source_hash_changes_when_main_tex_changes(self, harness) -> None:
        client, *_rest = harness
        project = _create_project(client, title="Thesis")
        refs_url = f"/writing-projects/{project['id']}/references"
        before = client.get(refs_url).json()["source_hash"]
        client.patch(
            f"/writing-projects/{project['id']}", json={"main_tex_content": "\\section{New}"}
        )
        after = client.get(refs_url).json()["source_hash"]
        assert before != after
