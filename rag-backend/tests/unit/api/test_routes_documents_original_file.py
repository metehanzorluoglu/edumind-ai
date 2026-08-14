"""Frontend Milestone 3.1 (Original Document Reader & Research Notes
Workspace) — end-to-end coverage at the API level for:

  - original-file persistence during upload (POST /documents through the
    background job) and authenticated delivery (GET /documents/{id}/file)
  - the dual-anchor DocumentHighlight model (optional chunk_id/chunk_index,
    optional visual_anchor, "at least one anchor" validation)
  - the full Notebook surface (create/list/rename/delete notebooks; add
    highlight-derived and manual entries; idempotent re-add; update/remove
    entries) including the mandatory preservation asymmetry: a
    NotebookEntry survives its source Document being deleted, while
    DocumentHighlight rows do not.
  - cross-user access denial (404, never 403) for every new endpoint
  - transaction safety: an embedding failure never leaves a permanent
    original file on disk

Same harness pattern as test_routes_documents_reader.py (real on-disk
SQLite via Base.metadata.create_all, fake embedding provider, fake
in-process Qdrant) — extended with a real DocumentFileStorage rooted at a
temp directory (so this suite never touches the repo's real ./data) and
the notebooks router. Uses pymupdf directly to generate a tiny, genuinely
parseable PDF in-memory — this suite never reads a fixture file from disk.
"""

from __future__ import annotations

import io
import os
import tempfile
import uuid
from collections.abc import Iterator
from pathlib import Path

import pymupdf
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.api.routes_documents import router as documents_router
from app.api.routes_notebooks import router as notebooks_router
from app.config import Settings, get_settings
from app.core.security import get_current_user
from app.db.base import Base
from app.db.models_auth import User
from app.db.models_folders import Folder
from app.db.session import get_db, get_engine, get_session_factory
from app.deps import get_document_file_storage, get_embedding_provider, get_vector_store
from app.services.document_file_storage import DocumentFileStorage
from app.vectorstore.qdrant_client import _point_id
from app.vectorstore.schemas import DocumentChunkContent

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
    fail = False

    def embed_batch(self, texts: list[str]) -> list[list[float]]:
        if self.fail:
            raise RuntimeError("embedding backend unreachable (simulated)")
        return [[0.1, 0.2, 0.3, 0.4] for _ in texts]


class _FakeVectorStore:
    def __init__(self) -> None:
        self.upsert_calls = 0
        self.delete_calls: list[str] = []
        self._chunks: dict[str, dict[str, list[DocumentChunkContent]]] = {}

    def upsert_chunks(self, metadata, chunks, embeddings, *, user_id: str) -> None:
        self.upsert_calls += 1
        by_user = self._chunks.setdefault(metadata.document_id, {})
        stored = by_user.setdefault(user_id, [])
        for chunk in chunks:
            stored.append(
                DocumentChunkContent(
                    chunk_id=_point_id(metadata.document_id, chunk.chunk_index),
                    chunk_index=chunk.chunk_index,
                    page_number=chunk.page_number,
                    text=chunk.text,
                )
            )
        stored.sort(key=lambda c: c.chunk_index)

    def get_document_chunks(self, document_id: str, *, user_id: str) -> list[DocumentChunkContent]:
        return list(self._chunks.get(document_id, {}).get(user_id, []))

    def delete_document(self, document_id: str, *, user_id: str) -> int:
        self.delete_calls.append(document_id)
        removed = self._chunks.get(document_id, {}).pop(user_id, [])
        return len(removed)


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
    vector_store: _FakeVectorStore,
    embedding_provider: _FakeEmbeddingProvider,
    file_storage: DocumentFileStorage,
) -> FastAPI:
    app = FastAPI()
    app.include_router(documents_router)
    app.include_router(notebooks_router)
    factory = sessionmaker(bind=db_engine, autoflush=False, expire_on_commit=False)

    def override_get_db() -> Iterator[object]:
        db = factory()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_settings] = lambda: settings
    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[get_embedding_provider] = lambda: embedding_provider
    app.dependency_overrides[get_vector_store] = lambda: vector_store
    app.dependency_overrides[get_document_file_storage] = lambda: file_storage
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


def _create_folder(db_engine: object, *, user_id: uuid.UUID, name: str) -> Folder:
    factory = sessionmaker(bind=db_engine, autoflush=False, expire_on_commit=False)
    db = factory()
    try:
        folder = Folder(user_id=user_id, parent_id=None, name=name)
        db.add(folder)
        db.commit()
        db.refresh(folder)
        db.expunge(folder)
        return folder
    finally:
        db.close()


@pytest.fixture
def harness(db_engine: object, storage_root: Path):
    vector_store = _FakeVectorStore()
    embedding_provider = _FakeEmbeddingProvider()
    file_storage = DocumentFileStorage(root_dir=str(storage_root))
    app = _make_app(db_engine, _build_settings(), vector_store, embedding_provider, file_storage)
    owner = _create_user(db_engine, email="owner@example.com")
    other = _create_user(db_engine, email="other@example.com")
    _as_user(app, owner)
    client = TestClient(app)
    return client, app, owner, other, vector_store, embedding_provider, file_storage, storage_root


def _upload_pdf(
    client: TestClient,
    *,
    text: str = "Students completed a twelve week program.",
    filename: str = "paper.pdf",
) -> dict:
    resp = client.post(
        "/documents",
        data={"document_type": "report"},
        files={"file": (filename, io.BytesIO(_make_pdf_bytes(text)), "application/pdf")},
    )
    assert resp.status_code == 202, resp.text
    job = client.get(f"/documents/jobs/{resp.json()['job_id']}").json()
    assert job["status"] == "completed", job
    return job["document"]


# --- Original file storage + delivery --------------------------------------


class TestOriginalFileUploadAndDelivery:
    def test_uploaded_pdf_reports_original_file_available(self, harness) -> None:
        client, *_ = harness
        document = _upload_pdf(client)
        assert document["original_file_available"] is True

    def test_get_file_returns_the_real_pdf_bytes_with_correct_content_type(self, harness) -> None:
        client, *_ = harness
        document = _upload_pdf(client)
        resp = client.get(f"/documents/{document['document_id']}/file")
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("application/pdf")
        assert resp.content.startswith(b"%PDF")

    def test_get_file_is_inline_disposition_with_the_real_source_filename(self, harness) -> None:
        client, *_ = harness
        document = _upload_pdf(client, filename="my paper.pdf")
        resp = client.get(f"/documents/{document['document_id']}/file")
        disposition = resp.headers["content-disposition"]
        assert disposition.startswith("inline")
        assert "my paper.pdf" in disposition or "my%20paper.pdf" in disposition

    def test_get_file_denies_cross_user_access_with_a_404_never_a_403(self, harness) -> None:
        client, app, _owner, other, *_ = harness
        document = _upload_pdf(client)
        _as_user(app, other)
        resp = client.get(f"/documents/{document['document_id']}/file")
        assert resp.status_code == 404

    def test_get_file_404s_for_a_guessed_nonexistent_document_id_ownership_safely(
        self, harness
    ) -> None:
        client, *_ = harness
        resp = client.get(f"/documents/{uuid.uuid4()}/file")
        assert resp.status_code == 404

    def test_legacy_document_with_no_original_file_reports_unavailable_and_404s_on_file(
        self, harness
    ) -> None:
        """Simulates a document ingested before this milestone: a real
        `documents` row with storage_key left NULL (never fabricated)."""
        client, _app, owner, _other, _vs, _ep, _fs, _root = harness
        from app.core.time_utils import utcnow
        from app.db.documents_repository import DocumentsRepository
        from app.db.session import get_session_factory
        from app.ingestion.metadata_schema import DocumentMetadata

        session = get_session_factory()()
        try:
            repo = DocumentsRepository(session)
            metadata = DocumentMetadata(
                document_id=str(uuid.uuid4()),
                sha256="0" * 64,
                source_filename="legacy.pdf",
                file_size_bytes=1234,
                title="Legacy Doc",
                authors=[],
                publication_year=None,
                source_venue=None,
                doi=None,
                source_url=None,
                document_type="report",
                journal_quartile=None,
                page_count=1,
                file_format="pdf",
                ingested_at=utcnow(),
            )
            record = repo.create(user_id=owner.id, metadata=metadata, chunk_count=0)
        finally:
            session.close()

        client.get(f"/documents/{record.document_id}")
        # No GET /documents/{id} exists (only list) — verify via the list endpoint instead.
        listed = client.get("/documents").json()["documents"]
        legacy = next(d for d in listed if d["document_id"] == record.document_id)
        assert legacy["original_file_available"] is False

        file_resp = client.get(f"/documents/{record.document_id}/file")
        assert file_resp.status_code == 404

    def test_a_document_whose_storage_key_is_set_but_file_is_physically_gone_reports_unavailable(
        self, harness
    ) -> None:
        """Frontend/Platform Milestone 3.2.1 — the production incident
        this regression-tests: a storage root misconfigured onto
        non-persistent storage (see this milestone's report) can leave
        `storage_key` set on the Document row forever while the actual
        bytes are gone (a container recreate wiped them). `storage_key
        is not None` alone must NOT be trusted for `original_file_
        available` — routes_documents.py's `_original_file_available`
        helper must check real existence via DocumentFileStorage.exists()
        in every response that reports it (content, list), and GET
        .../file must still 404 gracefully, never fabricate/reconstruct
        anything."""
        client, *_rest = harness
        storage_root = harness[7]
        document = _upload_pdf(client)
        assert document["original_file_available"] is True

        # Simulate the exact incident: delete only the physical file,
        # never touch the DB row's storage_key.
        pdf_files = list(storage_root.rglob("*.pdf"))
        assert len(pdf_files) == 1
        pdf_files[0].unlink()

        content = client.get(f"/documents/{document['document_id']}/content").json()
        assert content["original_file_available"] is False

        listed = client.get("/documents").json()["documents"]
        listed_doc = next(d for d in listed if d["document_id"] == document["document_id"])
        assert listed_doc["original_file_available"] is False

        file_resp = client.get(f"/documents/{document['document_id']}/file")
        assert file_resp.status_code == 404

    def test_no_permanent_file_is_left_on_disk_when_embedding_fails(self, harness) -> None:
        client, _app, _owner, _other, _vs, embedding_provider, _fs, storage_root = harness
        embedding_provider.fail = True
        resp = client.post(
            "/documents",
            data={"document_type": "report"},
            files={"file": ("paper.pdf", io.BytesIO(_make_pdf_bytes("text")), "application/pdf")},
        )
        assert resp.status_code == 202
        job = client.get(f"/documents/jobs/{resp.json()['job_id']}").json()
        assert job["status"] == "failed", job
        # No document row, and — critically — no orphaned file anywhere
        # under the storage root (see document_ingestion_jobs.py's
        # transaction-safety handling).
        assert client.get("/documents").json()["total"] == 0
        if storage_root.exists():
            leftover_files = [p for p in storage_root.rglob("*") if p.is_file()]
            assert leftover_files == []

    def test_document_delete_removes_the_original_file_from_disk(self, harness) -> None:
        client, *_rest = harness
        _vs = harness[4]
        storage_root = harness[7]
        document = _upload_pdf(client)
        files_before = list(storage_root.rglob("*.pdf"))
        assert len(files_before) == 1

        del_resp = client.delete(f"/documents/{document['document_id']}")
        assert del_resp.status_code == 200
        files_after = list(storage_root.rglob("*.pdf"))
        assert files_after == []


# --- Frontend/Platform Milestone 3.2.1 Part C: simplified upload ------------


class TestUploadWithoutMetadataQuestionnaire:
    """The normal upload UI no longer collects document_type/journal_
    quartile/title before uploading (see this milestone's report) — POST
    /documents must still succeed with none of them supplied, honestly
    defaulting document_type to "unknown" (never fabricating a specific
    category) and title to server-side auto-extraction/filename fallback
    (already-existing behavior, unrelated to this milestone — see
    app/ingestion/ingest.py)."""

    def test_upload_succeeds_with_no_document_type_journal_quartile_or_title(
        self, harness
    ) -> None:
        client, *_ = harness
        resp = client.post(
            "/documents",
            data={},
            files={
                "file": (
                    "paper.pdf",
                    io.BytesIO(_make_pdf_bytes("Some real content.")),
                    "application/pdf",
                )
            },
        )
        assert resp.status_code == 202, resp.text
        job = client.get(f"/documents/jobs/{resp.json()['job_id']}").json()
        assert job["status"] == "completed", job
        assert job["document"]["document_type"] == "unknown"
        # Title still isn't blank — the pre-existing filename fallback
        # (app/ingestion/ingest.py) took over since none was supplied.
        assert job["document"]["title"]

    def test_upload_still_honors_an_explicitly_supplied_document_type(self, harness) -> None:
        """The field isn't removed server-side — only made optional. A
        caller that DOES supply one (e.g. a future Reference-management
        edit flow) is unaffected."""
        client, *_ = harness
        resp = client.post(
            "/documents",
            data={"document_type": "policy_document"},
            files={
                "file": (
                    "paper.pdf",
                    io.BytesIO(_make_pdf_bytes("Some real content.")),
                    "application/pdf",
                )
            },
        )
        job = client.get(f"/documents/jobs/{resp.json()['job_id']}").json()
        assert job["document"]["document_type"] == "policy_document"


# --- Frontend/Platform Milestone 3.2.1 Part D: library search ---------------


class TestLibrarySearch:
    """GET /documents?q=... — a plain title/filename substring match
    across every folder, never semantic corpus retrieval (see
    DocumentsRepository.search_for_user's docstring)."""

    def test_search_matches_by_partial_title_case_insensitively(self, harness) -> None:
        client, *_ = harness
        _upload_pdf(client, text="Speckle imaging methodology.", filename="speckle.pdf")
        _upload_pdf(client, text="Unrelated content.", filename="other.pdf")

        resp = client.get("/documents", params={"q": "spec"})
        assert resp.status_code == 200
        body = resp.json()
        assert body["total"] == 1
        assert body["documents"][0]["source_filename"] == "speckle.pdf"

    def test_search_with_no_match_returns_empty_not_an_error(self, harness) -> None:
        client, *_ = harness
        _upload_pdf(client)
        resp = client.get("/documents", params={"q": "no such paper anywhere"})
        assert resp.status_code == 200
        assert resp.json() == {"documents": [], "total": 0}

    def test_search_never_matches_another_users_documents(self, harness) -> None:
        client, app, _owner, other, *_ = harness
        _upload_pdf(client, filename="owner-paper.pdf")
        _as_user(app, other)
        resp = client.get("/documents", params={"q": "owner-paper"})
        assert resp.json() == {"documents": [], "total": 0}

    def test_search_result_includes_folder_name_for_a_filed_document(
        self, harness, db_engine: object
    ) -> None:
        client, _app, owner, *_ = harness
        folder = _create_folder(db_engine, user_id=owner.id, name="Literature Review")
        document = _upload_pdf(client, filename="filed-paper.pdf")
        move_resp = client.patch(
            f"/documents/{document['document_id']}", json={"folder_id": str(folder.id)}
        )
        assert move_resp.status_code == 200

        resp = client.get("/documents", params={"q": "filed-paper"})
        body = resp.json()
        assert body["documents"][0]["folder_name"] == "Literature Review"

    def test_blank_q_behaves_exactly_like_the_ordinary_unfiltered_list(self, harness) -> None:
        client, *_ = harness
        _upload_pdf(client)
        with_blank_q = client.get("/documents", params={"q": ""}).json()
        without_q = client.get("/documents").json()
        assert with_blank_q["total"] == without_q["total"] == 1


# --- Dual-anchor highlights --------------------------------------------------


class TestDualAnchorHighlights:
    def _get_real_chunk(self, client: TestClient, document_id: str) -> dict:
        content = client.get(f"/documents/{document_id}/content").json()
        return content["chunks"][0]

    def test_create_highlight_with_only_visual_anchor_saves_with_null_chunk_id(
        self, harness
    ) -> None:
        client, *_ = harness
        document = _upload_pdf(client)
        resp = client.post(
            f"/documents/{document['document_id']}/highlights",
            json={
                "page_number": 1,
                "selected_text": "some passage on the page",
                "visual_anchor": {"rects": [[10.0, 20.0, 100.0, 40.0]]},
            },
        )
        assert resp.status_code == 201, resp.text
        body = resp.json()
        assert body["chunk_id"] is None
        assert body["chunk_index"] is None
        assert body["visual_anchor"] == {"rects": [[10.0, 20.0, 100.0, 40.0]]}

    def test_create_highlight_with_real_chunk_anchor_still_works_unchanged(self, harness) -> None:
        client, *_ = harness
        document = _upload_pdf(client)
        chunk = self._get_real_chunk(client, document["document_id"])
        resp = client.post(
            f"/documents/{document['document_id']}/highlights",
            json={
                "chunk_id": chunk["chunk_id"],
                "chunk_index": chunk["chunk_index"],
                "page_number": chunk["page_number"],
                "selected_text": "Students",
            },
        )
        assert resp.status_code == 201, resp.text
        assert resp.json()["chunk_id"] == chunk["chunk_id"]

    def test_create_highlight_rejects_a_forged_chunk_anchor(self, harness) -> None:
        client, *_ = harness
        document = _upload_pdf(client)
        resp = client.post(
            f"/documents/{document['document_id']}/highlights",
            json={
                "chunk_id": "not-a-real-chunk",
                "chunk_index": 0,
                "page_number": 1,
                "selected_text": "x",
            },
        )
        assert resp.status_code == 422

    def test_create_highlight_with_neither_anchor_is_rejected_by_schema(self, harness) -> None:
        client, *_ = harness
        document = _upload_pdf(client)
        resp = client.post(
            f"/documents/{document['document_id']}/highlights",
            json={"page_number": 1, "selected_text": "x"},
        )
        assert resp.status_code == 422

    def test_page_number_beyond_page_count_is_rejected(self, harness) -> None:
        client, *_ = harness
        document = _upload_pdf(client)
        resp = client.post(
            f"/documents/{document['document_id']}/highlights",
            json={
                "page_number": 999,
                "selected_text": "x",
                "visual_anchor": {"rects": [[0, 0, 1, 1]]},
            },
        )
        assert resp.status_code == 422


# --- Notebooks ---------------------------------------------------------------


class TestNotebooks:
    def test_create_list_rename_delete_notebook(self, harness) -> None:
        client, *_ = harness
        create_resp = client.post("/notebooks", json={"name": "Reading List"})
        assert create_resp.status_code == 201
        notebook_id = create_resp.json()["id"]

        listed = client.get("/notebooks").json()["notebooks"]
        assert any(n["id"] == notebook_id for n in listed)

        rename_resp = client.patch(f"/notebooks/{notebook_id}", json={"name": "Renamed"})
        assert rename_resp.status_code == 200
        assert rename_resp.json()["name"] == "Renamed"

        delete_resp = client.delete(f"/notebooks/{notebook_id}")
        assert delete_resp.status_code == 204
        assert client.get("/notebooks").json()["total"] == 0

    def test_add_highlight_entry_derives_snapshot_fields_server_side(self, harness) -> None:
        client, *_ = harness
        document = _upload_pdf(client)
        highlight = client.post(
            f"/documents/{document['document_id']}/highlights",
            json={
                "page_number": 1,
                "selected_text": "genuine excerpt",
                "visual_anchor": {"rects": [[0, 0, 1, 1]]},
            },
        ).json()
        notebook_id = client.post("/notebooks", json={"name": "NB"}).json()["id"]

        resp = client.post(
            f"/notebooks/{notebook_id}/entries",
            json={
                "entry_type": "highlight",
                "document_id": document["document_id"],
                "highlight_id": highlight["id"],
            },
        )
        assert resp.status_code == 201, resp.text
        entry = resp.json()
        assert entry["excerpt"] == "genuine excerpt"
        assert entry["document_title"] is not None
        assert entry["page_number"] == 1

    def test_add_highlight_entry_is_idempotent_never_a_duplicate(self, harness) -> None:
        client, *_ = harness
        document = _upload_pdf(client)
        highlight = client.post(
            f"/documents/{document['document_id']}/highlights",
            json={
                "page_number": 1,
                "selected_text": "x",
                "visual_anchor": {"rects": [[0, 0, 1, 1]]},
            },
        ).json()
        notebook_id = client.post("/notebooks", json={"name": "NB"}).json()["id"]
        body = {
            "entry_type": "highlight",
            "document_id": document["document_id"],
            "highlight_id": highlight["id"],
        }
        first = client.post(f"/notebooks/{notebook_id}/entries", json=body).json()
        second = client.post(f"/notebooks/{notebook_id}/entries", json=body).json()
        assert first["id"] == second["id"]
        entries = client.get(f"/notebooks/{notebook_id}/entries").json()
        assert entries["total"] == 1

    def test_add_manual_entry_update_note_and_remove(self, harness) -> None:
        client, *_ = harness
        notebook_id = client.post("/notebooks", json={"name": "NB"}).json()["id"]
        add_resp = client.post(
            f"/notebooks/{notebook_id}/entries",
            json={"entry_type": "manual", "note_text": "A standalone thought."},
        )
        assert add_resp.status_code == 201
        assert add_resp.json()["source_available"] is False  # manual entries never have a source
        entry_id = add_resp.json()["id"]

        update_resp = client.patch(
            f"/notebooks/{notebook_id}/entries/{entry_id}", json={"note_text": "Edited."}
        )
        assert update_resp.json()["note_text"] == "Edited."

        remove_resp = client.delete(f"/notebooks/{notebook_id}/entries/{entry_id}")
        assert remove_resp.status_code == 204
        assert client.get(f"/notebooks/{notebook_id}/entries").json()["total"] == 0

    def test_notebook_entry_survives_deletion_of_its_source_highlight(self, harness) -> None:
        """M3.1 Notebook spec §4 (called out as mandatory, a PO decision):
        deleting the Reader highlight a NotebookEntry was created from must
        NOT delete the entry — it is an independently-persisted snapshot,
        not destructively coupled to the highlight it was copied from."""
        client, *_ = harness
        document = _upload_pdf(client)
        highlight = client.post(
            f"/documents/{document['document_id']}/highlights",
            json={
                "page_number": 1,
                "selected_text": "surviving excerpt",
                "visual_anchor": {"rects": [[0, 0, 1, 1]]},
            },
        ).json()
        notebook_id = client.post("/notebooks", json={"name": "NB"}).json()["id"]
        client.post(
            f"/notebooks/{notebook_id}/entries",
            json={
                "entry_type": "highlight",
                "document_id": document["document_id"],
                "highlight_id": highlight["id"],
            },
        )

        del_resp = client.delete(
            f"/documents/{document['document_id']}/highlights/{highlight['id']}"
        )
        assert del_resp.status_code == 204

        # The highlight is gone from the Reader...
        highlights = client.get(f"/documents/{document['document_id']}/highlights").json()
        assert highlights["highlights"] == []

        # ...but the NotebookEntry copied from it is untouched.
        entries = client.get(f"/notebooks/{notebook_id}/entries").json()
        assert entries["total"] == 1
        assert entries["entries"][0]["excerpt"] == "surviving excerpt"

    def test_notebook_entry_survives_source_document_deletion(self, harness) -> None:
        """The mandatory preservation asymmetry (M3.1 Notebook spec §5):
        deleting the document removes its DocumentHighlight rows but NEVER
        the NotebookEntry snapshot copied from one."""
        client, *_ = harness
        document = _upload_pdf(client)
        highlight = client.post(
            f"/documents/{document['document_id']}/highlights",
            json={
                "page_number": 1,
                "selected_text": "surviving excerpt",
                "visual_anchor": {"rects": [[0, 0, 1, 1]]},
            },
        ).json()
        notebook_id = client.post("/notebooks", json={"name": "NB"}).json()["id"]
        add_resp = client.post(
            f"/notebooks/{notebook_id}/entries",
            json={
                "entry_type": "highlight",
                "document_id": document["document_id"],
                "highlight_id": highlight["id"],
            },
        )
        assert add_resp.json()["source_available"] is True

        del_resp = client.delete(f"/documents/{document['document_id']}")
        assert del_resp.status_code == 200

        # The highlight itself is gone (cascade-deleted with the document).
        highlights_resp = client.get(f"/documents/{document['document_id']}/highlights")
        assert highlights_resp.status_code == 404  # document no longer exists

        # But the NotebookEntry — a deliberate, independent snapshot — survives.
        entries = client.get(f"/notebooks/{notebook_id}/entries").json()
        assert entries["total"] == 1
        entry = entries["entries"][0]
        assert entry["excerpt"] == "surviving excerpt"
        # document_id is a snapshot too — kept, never nulled, so "Open
        # source" can still be attempted — but source_available flips to
        # False so the frontend shows "Source unavailable" / disables
        # "Open source" rather than inferring availability from
        # document_id alone (see NotebookEntryResponse.source_available's
        # docstring; this is what a real-browser validation pass found
        # missing — document_id being merely non-null was previously the
        # ONLY signal the frontend had, which never changes on delete).
        assert entry["document_id"] == document["document_id"]
        assert entry["source_available"] is False

    def test_deleting_a_notebook_never_touches_the_source_document_or_highlight(
        self, harness
    ) -> None:
        client, *_ = harness
        document = _upload_pdf(client)
        highlight = client.post(
            f"/documents/{document['document_id']}/highlights",
            json={
                "page_number": 1,
                "selected_text": "x",
                "visual_anchor": {"rects": [[0, 0, 1, 1]]},
            },
        ).json()
        notebook_id = client.post("/notebooks", json={"name": "NB"}).json()["id"]
        client.post(
            f"/notebooks/{notebook_id}/entries",
            json={
                "entry_type": "highlight",
                "document_id": document["document_id"],
                "highlight_id": highlight["id"],
            },
        )

        assert client.delete(f"/notebooks/{notebook_id}").status_code == 204

        # Document and highlight both still exist, untouched.
        assert client.get("/documents").json()["total"] == 1
        assert client.get(f"/documents/{document['document_id']}/highlights").json()["highlights"]

    def test_highlight_notebook_membership_reports_which_notebooks(self, harness) -> None:
        client, *_ = harness
        document = _upload_pdf(client)
        highlight = client.post(
            f"/documents/{document['document_id']}/highlights",
            json={
                "page_number": 1,
                "selected_text": "x",
                "visual_anchor": {"rects": [[0, 0, 1, 1]]},
            },
        ).json()
        notebook_id = client.post("/notebooks", json={"name": "NB"}).json()["id"]

        before = client.get(
            f"/documents/{document['document_id']}/highlights/{highlight['id']}/notebooks"
        ).json()
        assert before["notebooks"] == []

        client.post(
            f"/notebooks/{notebook_id}/entries",
            json={
                "entry_type": "highlight",
                "document_id": document["document_id"],
                "highlight_id": highlight["id"],
            },
        )
        after = client.get(
            f"/documents/{document['document_id']}/highlights/{highlight['id']}/notebooks"
        ).json()
        assert [n["id"] for n in after["notebooks"]] == [notebook_id]

    # --- Cross-user security ---

    def test_cannot_list_or_mutate_another_users_notebook(self, harness) -> None:
        client, app, _owner, other, *_ = harness
        notebook_id = client.post("/notebooks", json={"name": "Private"}).json()["id"]

        _as_user(app, other)
        assert client.get(f"/notebooks/{notebook_id}/entries").status_code == 404
        rename_resp = client.patch(f"/notebooks/{notebook_id}", json={"name": "Hijacked"})
        assert rename_resp.status_code == 404
        assert client.delete(f"/notebooks/{notebook_id}").status_code == 404
        assert (
            client.post(
                f"/notebooks/{notebook_id}/entries",
                json={"entry_type": "manual", "note_text": "hijack"},
            ).status_code
            == 404
        )

    def test_cannot_add_another_users_highlight_to_own_notebook(self, harness) -> None:
        client, app, _owner, other, *_ = harness
        document = _upload_pdf(client)
        highlight = client.post(
            f"/documents/{document['document_id']}/highlights",
            json={
                "page_number": 1,
                "selected_text": "x",
                "visual_anchor": {"rects": [[0, 0, 1, 1]]},
            },
        ).json()

        _as_user(app, other)
        own_notebook_id = client.post("/notebooks", json={"name": "Other's NB"}).json()["id"]
        resp = client.post(
            f"/notebooks/{own_notebook_id}/entries",
            json={
                "entry_type": "highlight",
                "document_id": document["document_id"],
                "highlight_id": highlight["id"],
            },
        )
        assert resp.status_code == 404

    def test_guessed_notebook_id_404s_ownership_safely(self, harness) -> None:
        client, *_ = harness
        assert client.get(f"/notebooks/{uuid.uuid4()}/entries").status_code == 404
