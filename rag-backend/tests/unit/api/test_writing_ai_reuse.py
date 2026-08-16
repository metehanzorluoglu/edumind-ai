"""Milestone 5.2 (Research-Aware Writing Assistant) Part 17/18/19 —
explicit coverage for the Writing workspace's "Ask EduM8" REUSING the
existing conversations/RAG pipeline, framed exactly as the Writing
workflow uses it (a Writing Project's own reference documents driving a
conversation's document scope + zoom_in_mode), rather than duplicating
the already-thorough GENERIC boundary tests in
test_routes_conversations_document_scope.py / test_routes_conversations_
zoom_in.py / test_routes_writing.py.

Two halves, matching this codebase's existing split for this exact area
(see test_routes_conversations_zoom_in.py's own module doc):
  - HTTP/persistence: real FastAPI app (documents + writing_projects +
    conversations routers), real on-disk SQLite, real PDF uploads —
    proves the Writing-side sequencing (upload -> reference -> PUT
    conversation documents -> PATCH zoom_in_mode) actually works, and
    that cross-user boundaries hold for a genuine Writing Project
    reference document specifically (Part 17: "a Writing Project's own
    references can't be attached to another user's conversation scope",
    "must never ... inspect another user's Writing Project").
  - RagService-level: no route exists in this codebase that unit-tests
    message-sending through the SSE endpoint (see
    test_zoom_in_retrieval.py's own module doc — leakage/citation
    correctness is tested one layer down, against RagService directly).
    Proves Writing-reference-scoped zoom-in never leaks a non-referenced
    document into evidence (Part 4A/18), and that a manuscript-selection-
    shaped query has no structural path to ever write to a vector store
    (Part 15/19 — "no Qdrant writes from manuscript selection").
"""

from __future__ import annotations

import inspect
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

from app.api.routes_conversations import router as conversations_router
from app.api.routes_documents import router as documents_router
from app.api.routes_writing import router as writing_router
from app.config import Settings, get_settings
from app.core.rag_service import RagService
from app.core.retrieval_schemas import RetrievedChunk
from app.core.security import get_current_user
from app.db.base import Base
from app.db.models_auth import User
from app.db.session import get_db, get_engine, get_session_factory
from app.deps import get_document_file_storage, get_embedding_provider, get_vector_store
from app.services.document_file_storage import DocumentFileStorage

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

    def update_scope_associations(
        self, document_id: str, *, user_id: str, conversation_ids: list[str], project_ids: list[str]
    ) -> int:
        return 1


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


def _make_app(db_engine: object, settings: Settings, file_storage: DocumentFileStorage) -> FastAPI:
    app = FastAPI()
    app.include_router(documents_router)
    app.include_router(writing_router)
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


@pytest.fixture
def harness(db_engine: object, storage_root: Path):
    file_storage = DocumentFileStorage(root_dir=str(storage_root))
    app = _make_app(db_engine, _build_settings(), file_storage)
    owner = _create_user(db_engine, email="owner@example.com")
    other = _create_user(db_engine, email="other@example.com")
    _as_user(app, owner)
    client = TestClient(app)
    return client, app, owner, other


def _upload_pdf(client: TestClient, *, text: str = "Body text.") -> dict:
    resp = client.post(
        "/documents",
        data={"document_type": "journal_article"},
        files={
            "file": (f"{uuid.uuid4()}.pdf", io.BytesIO(_make_pdf_bytes(text)), "application/pdf")
        },
    )
    assert resp.status_code == 202, resp.text
    job = client.get(f"/documents/jobs/{resp.json()['job_id']}").json()
    assert job["status"] == "completed", job
    return job["document"]


def _create_project(client: TestClient, *, title: str = "My Paper") -> dict:
    resp = client.post("/writing-projects", json={"title": title})
    assert resp.status_code == 201, resp.text
    return resp.json()


def _create_conversation(client: TestClient) -> dict:
    resp = client.post("/conversations", json={})
    assert resp.status_code == 201, resp.text
    return resp.json()


class TestWritingReferenceIntoConversationScope:
    """Part 4A/8 — proves useWritingAsk.ts's own exact sequencing (upload
    -> add reference -> PUT conversation documents -> PATCH zoom_in_mode)
    against the real backend, for a genuine Writing Project reference
    document."""

    def test_owner_can_scope_their_own_conversation_to_their_writing_reference(
        self, harness
    ) -> None:
        client, _app, _owner, _other = harness
        document = _upload_pdf(client)
        project = _create_project(client)
        add_resp = client.post(
            f"/writing-projects/{project['id']}/references",
            json={"document_ids": [document["document_id"]]},
        )
        assert add_resp.status_code == 200, add_resp.text

        conversation = _create_conversation(client)
        put_resp = client.put(
            f"/conversations/{conversation['id']}/documents",
            json={"document_ids": [document["document_id"]]},
        )
        assert put_resp.status_code == 200, put_resp.text
        assert put_resp.json()["total"] == 1

        patch_resp = client.patch(
            f"/conversations/{conversation['id']}/scope", json={"zoom_in_mode": True}
        )
        assert patch_resp.status_code == 200, patch_resp.text
        assert patch_resp.json()["zoom_in_mode"] is True

    def test_other_user_cannot_attach_owners_writing_reference_to_their_own_conversation(
        self, harness
    ) -> None:
        """Part 17's exact scenario: a Writing Project's own reference
        document, owned by `owner`, must never be attachable to a
        conversation `other` owns — even though `other`'s conversation
        genuinely exists and the document_id is genuine (not guessed)."""
        client, app, _owner, other = harness
        document = _upload_pdf(client)
        project = _create_project(client)
        assert (
            client.post(
                f"/writing-projects/{project['id']}/references",
                json={"document_ids": [document["document_id"]]},
            ).status_code
            == 200
        )

        _as_user(app, other)
        other_client = TestClient(app)
        other_conversation = _create_conversation(other_client)

        resp = other_client.put(
            f"/conversations/{other_conversation['id']}/documents",
            json={"document_ids": [document["document_id"]]},
        )
        assert resp.status_code == 404

        listing = other_client.get(f"/conversations/{other_conversation['id']}/documents").json()
        assert listing["total"] == 0

    def test_other_user_cannot_inspect_owners_writing_project_references(self, harness) -> None:
        """Part 17: "must never ... inspect another user's Writing
        Project" — the reference list specifically, since that is what
        Ask EduM8's default "Project references" scope reads."""
        client, app, _owner, other = harness
        document = _upload_pdf(client)
        project = _create_project(client)
        client.post(
            f"/writing-projects/{project['id']}/references",
            json={"document_ids": [document["document_id"]]},
        )

        _as_user(app, other)
        other_client = TestClient(app)
        resp = other_client.get(f"/writing-projects/{project['id']}/references")
        assert resp.status_code == 404


def _chunk(chunk_id: str, document_id: str, text: str = "text") -> RetrievedChunk:
    return RetrievedChunk(
        score=0.9,
        text=text,
        document_id=document_id,
        chunk_id=chunk_id,
        document_type="report",
        source_filename=f"{document_id}.pdf",
        chunk_index=0,
        page_number=1,
    )


class _WritingReferenceScopedRetriever:
    """Mirrors test_zoom_in_retrieval.py's _RecordingScopedRetriever
    exactly, renamed/recommented for the Writing framing: `doc-reference`
    is the Writing Project's OWN reference document (in the conversation's
    chat scope); `doc-not-referenced` is a document that exists in the
    user's library but was never added as a reference — the project/
    general tiers would happily return it if either ever executed, which
    is exactly the leak Project References scope (Part 4A) must prevent."""

    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []

    def retrieve(
        self, query, *, user_id, top_k=8, filters=None, conversation_id=None, project_id=None
    ):
        self.calls.append({"conversation_id": conversation_id, "project_id": project_id})
        if conversation_id == "conv-writing-ask":
            return [_chunk("ref-chunk", "doc-reference", text="evidence from the reference")]
        return [_chunk("leak-chunk", "doc-not-referenced", text="evidence NOT in this project")]


class _RecordingLLMProvider:
    def __init__(self) -> None:
        self.call_count = 0

    def stream_chat(self, *, system_prompt, user_prompt, timer=None, options_override=None):
        self.call_count += 1
        yield "answer"


class TestWritingReferenceScopeRetrievalIsolation:
    def test_project_references_scope_never_leaks_a_non_referenced_document(self) -> None:
        retriever = _WritingReferenceScopedRetriever()
        rag_service = RagService(
            retriever=retriever, llm_provider=_RecordingLLMProvider(), model_name="m"
        )

        prepared = rag_service.prepare(
            "What evidence supports this claim?",
            user_id="user-1",
            conversation_id="conv-writing-ask",
            include_chat=True,
            include_project=False,
            include_general=False,
            strict_mode=True,
        )

        # Exactly the chat tier ran — project/general (where the
        # non-referenced document would leak from) never executed at all.
        assert len(retriever.calls) == 1

        document_ids = {s.document_id for s in prepared.retrieved_sources}
        assert document_ids == {"doc-reference"}
        assert "doc-not-referenced" not in document_ids

        cited_document_ids = {c.document_id for c in prepared.citations}
        assert cited_document_ids <= {"doc-reference"}
        # Part 18 (3): document_id matches the REAL reference — never a
        # fabricated/placeholder id.
        for citation in prepared.citations:
            assert citation.document_id == "doc-reference"


class TestManuscriptSelectionNeverWritesToVectorStore:
    """Part 15/19 — "no Qdrant writes from manuscript selection." A
    manuscript selection only ever reaches the backend as ordinary
    conversation query text (see buildTransientContextPrefix's "Regarding
    this passage from my manuscript:" prefix) — it is never routed
    through any ingestion/embedding endpoint. This is proven two ways:
    structurally (RagService has no vector-store-shaped collaborator at
    all — see its __init__ signature) and at runtime (answering such a
    query invokes only the two collaborators RagService can possibly
    call)."""

    def test_rag_service_has_no_vector_store_dependency(self) -> None:
        params = set(inspect.signature(RagService.__init__).parameters)
        # Every real collaborator RagService can ever call anything on —
        # if a vector-store/embedding-write dependency existed, its
        # parameter name would appear here.
        assert params == {
            "self",
            "retriever",
            "llm_provider",
            "model_name",
            "max_chunks_per_document",
            "max_total_context_chars",
            "dedup_similarity_threshold",
            "chat_scope_top_k",
            "project_scope_top_k",
            "prompt_variant",
            "source_order",
        }

    def test_answering_a_manuscript_selection_shaped_query_touches_only_retriever_and_llm(
        self,
    ) -> None:
        retriever = _WritingReferenceScopedRetriever()
        llm = _RecordingLLMProvider()
        rag_service = RagService(retriever=retriever, llm_provider=llm, model_name="m")

        manuscript_query = (
            'Regarding this passage from my manuscript:\n\n'
            '"Teachers\' motivational beliefs influenced how they enacted agency."\n\n'
            "What evidence supports this claim?"
        )

        result = rag_service.run(
            manuscript_query,
            user_id="user-1",
            conversation_id="conv-writing-ask",
            include_chat=True,
            include_project=False,
            include_general=False,
            strict_mode=True,
        )

        assert result.answer == "answer"
        # The only two collaborators RagService can invoke anything on —
        # both fakes recorded exactly what they were asked to do, and
        # neither is (or wraps) a vector store/document-ingestion path.
        assert len(retriever.calls) == 1
        assert llm.call_count == 1
