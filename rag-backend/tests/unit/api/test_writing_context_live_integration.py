"""Milestone 6.2 (Context-Aware Ask EduM8) — proves the LIVE model-request
boundary: a real POST /conversations/{id}/messages call carrying
`writing_context`, through the real route handler, into a real (fake-
LLM-captured) prompt. Same harness convention as
test_writing_ai_reuse.py (M5.2's own "Writing reuses the existing
conversations/RAG pipeline" test file) — extended with a fake LLM
provider that CAPTURES the exact system/user prompt sent, and a fake
Retriever that records whether/how many times it was called, so this
file can assert on the actual prompt content and on RAG being skipped/
invoked per M6.1 policy — not just on HTTP status codes.
"""

from __future__ import annotations

import json
import os
import tempfile
import time
import uuid
from collections.abc import Iterator
from datetime import UTC, datetime
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.api.routes_conversations import router as conversations_router
from app.api.routes_writing import router as writing_router
from app.api.routes_writing_files import router as writing_files_router
from app.config import Settings, get_settings
from app.core.rag_service import RagService
from app.core.retrieval_schemas import RetrievedChunk
from app.core.security import get_current_user
from app.db.base import Base
from app.db.documents_repository import DocumentsRepository
from app.db.models_auth import User
from app.db.notebooks_repository import NotebooksRepository
from app.db.session import get_db, get_engine, get_session_factory
from app.db.writing_project_files_repository import WritingProjectFilesRepository
from app.db.writing_projects_repository import WritingProjectsRepository
from app.deps import get_embedding_provider, get_rag_service, get_retriever, get_vector_store
from app.ingestion.metadata_schema import DocumentMetadata
from tests.unit.core.test_reference_mode import (
    SN_ARTICLE_TEX,
    SN_BIBLIOGRAPHY_BIB,
    UNLV_BIBLIOGRAPHY_TEX,
    UNLV_THESIS_TEX,
)

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
    def update_scope_associations(self, *a: object, **k: object) -> int:
        return 1


class _CapturingLLMProvider:
    """Records every (system_prompt, user_prompt) it was ever asked to
    stream, and yields a small fixed reply — never a real model call, so
    these tests stay fast and deterministic (real-model behavior is
    validated separately, see the M6.2 report's "Actual Model Results"
    section)."""

    def __init__(self) -> None:
        self.calls: list[dict[str, str]] = []

    def stream_chat(
        self,
        *,
        system_prompt: str,
        user_prompt: str,
        timer: Any = None,
        options_override: Any = None,
    ):  # type: ignore[no-untyped-def]
        self.calls.append({"system_prompt": system_prompt, "user_prompt": user_prompt})
        yield "This is a test reply."


class _RecordingRetriever:
    def __init__(self, chunks: list[RetrievedChunk] | None = None) -> None:
        self._chunks = chunks or []
        self.call_count = 0

    def retrieve(
        self,
        query: str,
        *,
        user_id: str,
        top_k: int = 8,
        filters: Any = None,
        conversation_id: str | None = None,
        project_id: str | None = None,
    ) -> list[RetrievedChunk]:
        self.call_count += 1
        return list(self._chunks)


def _chunk(**overrides: object) -> RetrievedChunk:
    base: dict[str, object] = {
        "score": 0.9,
        "text": "A real retrieved passage about the topic.",
        "document_id": "doc-1",
        "chunk_id": "chunk-1",
        "document_type": "journal_article",
        "source_filename": "paper.pdf",
        "chunk_index": 0,
        "page_number": 3,
    }
    base.update(overrides)
    return RetrievedChunk(**base)  # type: ignore[arg-type]


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
    settings: Settings,
    llm_provider: _CapturingLLMProvider,
    retriever: _RecordingRetriever,
) -> FastAPI:
    app = FastAPI()
    app.include_router(writing_router)
    app.include_router(writing_files_router)
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
    # get_rag_service() (app/deps.py) builds its retriever/llm_provider by
    # calling get_retriever()/get_llm_provider() directly rather than via
    # FastAPI's own dependency resolution — overriding those two alone
    # would not reach it, so the RagService instance itself is overridden
    # with one built from the fakes.
    app.dependency_overrides[get_rag_service] = lambda: RagService(
        retriever=retriever,
        llm_provider=llm_provider,
        model_name="test-model",
    )
    # post_conversation_message also takes `retriever: RetrieverDep` as
    # its own direct parameter (the vision+corpus path) — overridden too
    # so nothing in this test ever touches a real Qdrant instance.
    app.dependency_overrides[get_retriever] = lambda: retriever
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
def harness(db_engine: object):
    llm_provider = _CapturingLLMProvider()
    retriever = _RecordingRetriever()
    app = _make_app(db_engine, _build_settings(), llm_provider, retriever)
    owner = _create_user(db_engine, email="owner@example.com")
    other = _create_user(db_engine, email="other@example.com")
    _as_user(app, owner)
    client = TestClient(app)
    return client, app, owner, other, llm_provider, retriever


def _create_project(client: TestClient, *, main_tex: str | None = None) -> dict:
    resp = client.post("/writing-projects", json={"title": "My Paper"})
    assert resp.status_code == 201, resp.text
    project = resp.json()
    tree = client.get(f"/writing-projects/{project['id']}/files").json()
    project["root_file_id"] = tree["root_file_id"]
    if main_tex is not None:
        patch = client.patch(
            f"/writing-projects/{project['id']}/files/{project['root_file_id']}",
            json={"content_text": main_tex},
        )
        assert patch.status_code == 200, patch.text
    return project


def _create_conversation(client: TestClient) -> dict:
    resp = client.post("/conversations", json={})
    assert resp.status_code == 201, resp.text
    return resp.json()


def _send_writing_message(
    client: TestClient,
    conversation_id: str,
    *,
    project_id: str,
    query: str,
    selection_start: int | None = None,
    selection_end: int | None = None,
    selected_text: str | None = None,
    active_file_unsaved_content: str | None = None,
    active_file_id: str | None = None,
) -> Any:
    body = {
        "query": query,
        "writing_context": {
            "project_id": project_id,
            "active_file_id": active_file_id,
            "selection_start": selection_start,
            "selection_end": selection_end,
            "selected_text": selected_text,
            "active_file_unsaved_content": active_file_unsaved_content,
        },
    }
    resp = client.post(f"/conversations/{conversation_id}/messages", json=body)
    assert resp.status_code == 200, resp.text
    return resp


def _parse_done_event(resp_text: str) -> dict[str, Any]:
    """Milestone 6.2 Parts 11/12 — pulls the one `data: {"type": "done", ...}`
    SSE line out of a raw event-stream response body. `_sse()`
    (routes_conversations.py) always frames an event as exactly
    `data: <json>\\n\\n`, so this is a plain line split, not a real SSE
    parser — deliberately as small as the actual wire format allows."""
    for line in resp_text.splitlines():
        if not line.startswith("data: "):
            continue
        payload = json.loads(line[len("data: ") :])
        if payload.get("type") == "done":
            return payload
    raise AssertionError(f"No 'done' SSE event found in response:\n{resp_text}")


class TestLocalEditNeverRags:
    def test_grammar_style_request_skips_retrieval_and_includes_selection(self, harness) -> None:
        client, _app, _owner, _other, llm_provider, retriever = harness
        content = (
            "\\documentclass{article}\\begin{document}"
            "Teachers was interested in learning AI."
            "\\end{document}"
        )
        project = _create_project(client, main_tex=content)
        conversation = _create_conversation(client)
        start = content.index("Teachers was interested in learning AI.")
        end = start + len("Teachers was interested in learning AI.")

        _send_writing_message(
            client,
            conversation["id"],
            project_id=project["id"],
            active_file_id=project["root_file_id"],
            query="Fix the grammar.",
            selection_start=start,
            selection_end=end,
            selected_text="Teachers was interested in learning AI.",
        )

        assert retriever.call_count == 0
        assert len(llm_provider.calls) == 1
        combined = llm_provider.calls[0]["system_prompt"] + llm_provider.calls[0]["user_prompt"]
        assert "Teachers was interested in learning AI." in combined
        assert "<writing_context>" in llm_provider.calls[0]["user_prompt"]


class TestWritingContextSummary:
    """Milestone 6.2 Parts 11/12 — the compact, honest context indicator
    the Ask EduM8 panel renders is exactly the ChatDoneEvent.
    writing_context_summary field this SSE stream ends with; these tests
    assert on that raw wire payload directly, independent of any frontend
    rendering."""

    def test_local_edit_turn_reports_selection_included_and_no_notes_or_highlights(
        self, harness
    ) -> None:
        client, _app, _owner, _other, _llm_provider, _retriever = harness
        content = (
            "\\documentclass{article}\\begin{document}Teachers was interested in AI.\\end{document}"
        )
        project = _create_project(client, main_tex=content)
        conversation = _create_conversation(client)
        start = content.index("Teachers was interested in AI.")
        end = start + len("Teachers was interested in AI.")

        resp = _send_writing_message(
            client,
            conversation["id"],
            project_id=project["id"],
            active_file_id=project["root_file_id"],
            query="Fix the grammar.",
            selection_start=start,
            selection_end=end,
            selected_text="Teachers was interested in AI.",
        )

        summary = _parse_done_event(resp.text)["writing_context_summary"]
        assert summary is not None
        assert summary["policy"] == "local_edit"
        assert summary["selection_included"] is True
        assert summary["notes_included"] == 0
        assert summary["highlights_included"] == 0
        assert summary["reference_metadata_included"] == 0

    def test_plain_chat_message_has_no_writing_context_summary(self, harness) -> None:
        client, _app, _owner, _other, _llm_provider, _retriever = harness
        conversation = _create_conversation(client)

        # No `writing_context` field at all — an ordinary Chat message,
        # completely unaffected by this Writing-only field.
        resp = client.post(
            f"/conversations/{conversation['id']}/messages", json={"query": "Hello there."}
        )
        assert resp.status_code == 200, resp.text

        assert _parse_done_event(resp.text)["writing_context_summary"] is None


class TestReferenceQuestionRetrievesEvidence:
    def test_evidence_question_calls_retriever_and_includes_passage(self, harness) -> None:
        client, _app, _owner, _other, llm_provider, retriever = harness
        retriever._chunks = [_chunk(text="A real retrieved passage supporting the claim.")]
        content = "\\documentclass{article}\\begin{document}A claim needing support.\\end{document}"
        project = _create_project(client, main_tex=content)
        conversation = _create_conversation(client)

        _send_writing_message(
            client,
            conversation["id"],
            project_id=project["id"],
            query="Which of my references supports this claim?",
        )

        assert retriever.call_count >= 1
        combined = llm_provider.calls[0]["system_prompt"] + llm_provider.calls[0]["user_prompt"]
        assert "A real retrieved passage supporting the claim." in combined


class TestBibliographyMetadataNeverEvidence:
    def test_imported_bib_without_connected_document_never_becomes_a_source(self, harness) -> None:
        client, _app, _owner, _other, llm_provider, retriever = harness
        retriever._chunks = []  # no connected source documents at all
        content = (
            "\\documentclass{article}\\bibliography{refs}"
            "\\begin{document}\\cite{bib7}\\end{document}"
        )
        project = _create_project(client, main_tex=content)
        files_resp = client.post(
            f"/writing-projects/{project['id']}/files/text",
            json={
                "parent_id": None,
                "name": "refs.bib",
                "content_text": (
                    "@article{bib7, title={A Distant Paper}, author={Someone}, year={2019}}"
                ),
            },
        )
        assert files_resp.status_code == 200, files_resp.text
        conversation = _create_conversation(client)

        _send_writing_message(
            client,
            conversation["id"],
            project_id=project["id"],
            query="What do my references say about bib7?",
        )

        combined = llm_provider.calls[0]["system_prompt"] + llm_provider.calls[0]["user_prompt"]
        assert "REFERENCE METADATA" in combined
        assert "A Distant Paper" in combined
        # Never presented as a numbered, citable source.
        assert '<source id="S1">' not in combined


class TestNoDuplication:
    def test_selected_text_appears_exactly_once_in_the_final_prompt(self, harness) -> None:
        client, _app, _owner, _other, llm_provider, _retriever = harness
        selection_text = "Teacher agency is influenced by contextual conditions."
        content = f"\\documentclass{{article}}\\begin{{document}}{selection_text}\\end{{document}}"
        project = _create_project(client, main_tex=content)
        conversation = _create_conversation(client)
        start = content.index(selection_text)
        end = start + len(selection_text)

        _send_writing_message(
            client,
            conversation["id"],
            project_id=project["id"],
            active_file_id=project["root_file_id"],
            query="Make this clearer.",
            selection_start=start,
            selection_end=end,
            selected_text=selection_text,
        )

        combined = llm_provider.calls[0]["system_prompt"] + llm_provider.calls[0]["user_prompt"]
        assert combined.count(selection_text) == 1


class TestUnsavedBuffer:
    def test_unsaved_buffer_used_over_saved_content(self, harness) -> None:
        client, _app, _owner, _other, llm_provider, _retriever = harness
        saved = "\\documentclass{article}\\begin{document}Old stale sentence.\\end{document}"
        project = _create_project(client, main_tex=saved)
        tree = client.get(f"/writing-projects/{project['id']}/files").json()
        root_id = tree["root_file_id"]
        conversation = _create_conversation(client)

        live_buffer = (
            "\\documentclass{article}\\begin{document}Brand new unsaved sentence.\\end{document}"
        )
        new_start = live_buffer.index("Brand new unsaved sentence.")
        new_end = new_start + len("Brand new unsaved sentence.")

        _send_writing_message(
            client,
            conversation["id"],
            project_id=project["id"],
            query="Improve this.",
            active_file_id=root_id,
            active_file_unsaved_content=live_buffer,
            selection_start=new_start,
            selection_end=new_end,
        )

        combined = llm_provider.calls[0]["system_prompt"] + llm_provider.calls[0]["user_prompt"]
        assert "Brand new unsaved sentence." in combined
        assert "Old stale sentence." not in combined


class TestUnlvFixtureAtLiveBoundary:
    """Milestone 6.2 Part 38 — the REAL UNLV multi-file thesis fixture
    (verbatim from test_reference_mode.py, never rewritten — see that
    module's own constants), through the live conversation boundary. The
    specific real bug class this exists to catch: asking about the
    ACTIVE file must use that file's own text, never the manuscript's
    root file, even though the root (thesis.tex) genuinely `\\include`s
    the active one."""

    def test_active_chapter4_content_is_used_not_the_thesis_root(self, harness) -> None:
        client, _app, _owner, _other, llm_provider, _retriever = harness
        project = _create_project(client, main_tex=UNLV_THESIS_TEX)
        rename = client.post(
            f"/writing-projects/{project['id']}/files/{project['root_file_id']}/rename",
            json={"name": "thesis.tex"},
        )
        assert rename.status_code == 200, rename.text

        chapter4_content = "Chapter 4 body about findings and results."
        chapter4_resp = client.post(
            f"/writing-projects/{project['id']}/files/text",
            json={"parent_id": None, "name": "Chapter4.tex", "content_text": chapter4_content},
        )
        assert chapter4_resp.status_code == 200, chapter4_resp.text
        chapter4_id = chapter4_resp.json()["file"]["id"]
        bib_resp = client.post(
            f"/writing-projects/{project['id']}/files/text",
            json={
                "parent_id": None,
                "name": "Bibliography.tex",
                "content_text": UNLV_BIBLIOGRAPHY_TEX,
            },
        )
        assert bib_resp.status_code == 200, bib_resp.text

        conversation = _create_conversation(client)
        _send_writing_message(
            client,
            conversation["id"],
            project_id=project["id"],
            active_file_id=chapter4_id,
            query="Explain this passage.",
            selection_start=0,
            selection_end=len(chapter4_content),
            selected_text=chapter4_content,
        )

        assert len(llm_provider.calls) == 1
        combined = llm_provider.calls[0]["system_prompt"] + llm_provider.calls[0]["user_prompt"]
        assert "Chapter 4 body about findings and results." in combined
        # thesis.tex's own \include-list body never substitutes for the
        # real active-file text (the exact failure mode this guards).
        assert "\\include{Chapter1}" not in combined


class TestSpringerFixtureAtLiveBoundary:
    """Milestone 6.2 Part 38 — the REAL Springer imported-BibTeX fixture
    (verbatim from test_reference_mode.py), through the live conversation
    boundary: a reference question against real sn-article.tex +
    sn-bibliography.bib content must surface real bibliography metadata
    (never manufactured), correctly labeled as metadata rather than
    published-source evidence."""

    def test_reference_question_surfaces_real_bibliography_metadata(self, harness) -> None:
        client, _app, _owner, _other, llm_provider, retriever = harness
        retriever._chunks = []  # no connected source documents — metadata only
        project = _create_project(client, main_tex=SN_ARTICLE_TEX)
        rename = client.post(
            f"/writing-projects/{project['id']}/files/{project['root_file_id']}/rename",
            json={"name": "sn-article.tex"},
        )
        assert rename.status_code == 200, rename.text
        bib_resp = client.post(
            f"/writing-projects/{project['id']}/files/text",
            json={
                "parent_id": None,
                "name": "sn-bibliography.bib",
                "content_text": SN_BIBLIOGRAPHY_BIB,
            },
        )
        assert bib_resp.status_code == 200, bib_resp.text

        conversation = _create_conversation(client)
        _send_writing_message(
            client,
            conversation["id"],
            project_id=project["id"],
            query="Which of my references supports this?",
        )

        assert len(llm_provider.calls) == 1
        combined = llm_provider.calls[0]["system_prompt"] + llm_provider.calls[0]["user_prompt"]
        assert "REFERENCE METADATA" in combined
        assert "bib1" in combined
        # Metadata, never fabricated evidence: no numbered source block.
        assert '<source id="S1">' not in combined


class TestCrossUserIsolation:
    def test_other_user_cannot_use_owners_writing_project_id(self, harness) -> None:
        client, app, _owner, other, _llm_provider, _retriever = harness
        project = _create_project(client)

        _as_user(app, other)
        other_client = TestClient(app)
        conversation = _create_conversation(other_client)

        resp = other_client.post(
            f"/conversations/{conversation['id']}/messages",
            json={
                "query": "Fix the grammar.",
                "writing_context": {"project_id": project["id"]},
            },
        )
        assert resp.status_code == 404


class TestCrossUserNotesAndHighlightsIsolation:
    """Milestone 6.2 — extends TestCrossUserIsolation's single project-id
    404 check with the specific data-shape isolation M6.1 already
    guarantees at the engine level (NotebooksRepository.
    list_all_entries_for_user is always scoped to the CALLING user's own
    id — see that repository method's own docstring), now proven at the
    LIVE model-request boundary: another user's Notes/Highlights text
    must never enter a DIFFERENT user's model prompt, even when both
    users ask the exact same reference-seeking question."""

    def test_another_users_notes_and_highlights_never_enter_this_users_prompt(
        self, db_engine: object, harness
    ) -> None:
        _client, app, owner, other, llm_provider, _retriever = harness
        factory = sessionmaker(bind=db_engine, autoflush=False, expire_on_commit=False)

        # Owner has a private note — never meant for `other` to see.
        owner_db = factory()
        try:
            owner_notebook = NotebooksRepository(owner_db).create(
                user_id=owner.id, name="Owner's Research"
            )
            NotebooksRepository(owner_db).add_manual_entry(
                user_id=owner.id,
                notebook_id=owner_notebook.id,
                note_text="Owner's confidential note about unpublished findings.",
            )
        finally:
            owner_db.close()

        # `other` has their own, unrelated project and note.
        _as_user(app, other)
        other_client = TestClient(app)
        other_project = _create_project(other_client)
        other_db = factory()
        try:
            other_notebook = NotebooksRepository(other_db).create(
                user_id=other.id, name="Other's Research"
            )
            NotebooksRepository(other_db).add_manual_entry(
                user_id=other.id,
                notebook_id=other_notebook.id,
                note_text="Other user's own note about their own topic.",
            )
        finally:
            other_db.close()
        other_conversation = _create_conversation(other_client)

        _send_writing_message(
            other_client,
            other_conversation["id"],
            project_id=other_project["id"],
            query="What do my references say about this topic?",
        )

        assert len(llm_provider.calls) == 1
        combined = llm_provider.calls[0]["system_prompt"] + llm_provider.calls[0]["user_prompt"]
        assert "Owner's confidential note about unpublished findings." not in combined
        # `other`'s own note legitimately CAN appear — this test isolates
        # cross-user leakage specifically, not whether notes appear at all.
        assert "Other user's own note about their own topic." in combined


# --- Milestone 6.2 Part 24 — M6.1's own large-library acceptance test,
# repeated through the LIVE model-request boundary (not just the engine
# level) ------------------------------------------------------------

_NUM_CHAPTERS = 12
_PARAGRAPHS_PER_CHAPTER = 60
_NUM_BIBLIOGRAPHY_ENTRIES = 200
_NUM_NOTES = 150
_NUM_HIGHLIGHTS = 150
_NUM_CONNECTED_DOCUMENTS = 50
_TARGET_PARAGRAPH = "Teacher agency is influenced by contextual conditions in the classroom."


def _build_large_project(db_session: Session, user_id: uuid.UUID) -> tuple[str, str]:
    """Verbatim-scaled mirror of test_writing_context_performance.py's own
    `_build_large_project` (same constants, same shape) — reused rather
    than re-invented so this live-boundary test proves the SAME acceptance
    scenario the M6.1 engine-level test already covers, just one layer
    further out (a real HTTP POST, not a direct build_writing_context()
    call)."""
    chapters = "\n".join(f"\\include{{Chapter{i}}}" for i in range(1, _NUM_CHAPTERS + 1))
    main_tex = (
        "\\documentclass{book}\n\\bibliographystyle{plain}\n\\bibliography{refs}\n"
        f"\\begin{{document}}\n{chapters}\n\\end{{document}}\n"
    )

    projects_repo = WritingProjectsRepository(db_session)
    record = projects_repo.create(
        user_id=user_id, title="Large Project", description=None, main_tex_content=main_tex
    )
    files_repo = WritingProjectFilesRepository(db_session)
    tree = files_repo.list_tree(user_id, record.id)
    assert tree is not None
    root_id = tree.root_file_id
    files_repo.rename(user_id, record.id, root_id, "main.tex")  # type: ignore[arg-type]
    files_repo.update_text_content(user_id, record.id, root_id, main_tex)  # type: ignore[arg-type]

    chapter7_id: str | None = None
    for i in range(1, _NUM_CHAPTERS + 1):
        section_heading = f"\\section{{Chapter {i} Overview}}\n"
        paragraphs = "\n".join(
            f"\\subsection{{Section {i}.{p}}}\nLorem ipsum dolor sit amet, chapter {i} "
            f"paragraph {p}. " + ("word " * 40)
            for p in range(_PARAGRAPHS_PER_CHAPTER)
        )
        content = section_heading + paragraphs
        if i == 7:
            content += f"\n\\subsection{{Discussion}}\n{_TARGET_PARAGRAPH}\n"
        _outcome, node = files_repo.create_text_file(
            user_id, record.id, parent_id=None, name=f"Chapter{i}.tex", content_text=content
        )
        if i == 7:
            assert node is not None
            chapter7_id = str(node.id)

    bib_entries = "\n".join(
        f"@article{{bib{i}, title={{Paper Number {i}}}, author={{Author {i}}}, year={{2020}}}}"
        for i in range(1, _NUM_BIBLIOGRAPHY_ENTRIES + 1)
    )
    files_repo.create_text_file(
        user_id, record.id, parent_id=None, name="refs.bib", content_text=bib_entries
    )

    documents_repo = DocumentsRepository(db_session)
    document_ids: list[str] = []
    for i in range(_NUM_CONNECTED_DOCUMENTS):
        document_id = str(uuid.uuid4())
        metadata = DocumentMetadata(
            document_id=document_id,
            source_filename=f"paper-{i}.pdf",
            file_format="pdf",
            sha256=uuid.uuid4().hex + uuid.uuid4().hex,
            file_size_bytes=1000,
            page_count=10,
            document_type="journal_article",
            title=f"Connected Paper {i}",
            authors=[f"Author {i}"],
            ingested_at=datetime.now(UTC),
        )
        documents_repo.create(user_id=user_id, metadata=metadata, chunk_count=10)
        document_ids.append(document_id)
        projects_repo.add_reference(user_id, record.id, document_id)

    notebooks_repo = NotebooksRepository(db_session)
    notebook = notebooks_repo.create(user_id=user_id, name="Research")
    for i in range(_NUM_NOTES):
        notebooks_repo.add_manual_entry(
            user_id=user_id,
            notebook_id=notebook.id,
            note_text=f"Note {i} about an unrelated topic {i}.",
        )
    for i in range(_NUM_HIGHLIGHTS):
        notebooks_repo.add_highlight_entry(
            user_id=user_id,
            notebook_id=notebook.id,
            highlight_id=uuid.uuid4(),
            document_id=document_ids[i % len(document_ids)],
            document_title=f"Connected Paper {i % len(document_ids)}",
            page_number=(i % 20) + 1,
            excerpt=f"Highlight excerpt {i} about topic {i}.",
            note_text=None,
            chunk_id=None,
            chunk_index=None,
            visual_anchor_json=None,
        )

    assert chapter7_id is not None
    return str(record.id), chapter7_id


class TestLargeLibraryThroughLiveBoundary:
    def test_local_edit_stays_bounded_before_the_model_is_ever_called(
        self, db_engine: object, harness
    ) -> None:
        client, _app, owner, _other, llm_provider, retriever = harness
        factory = sessionmaker(bind=db_engine, autoflush=False, expire_on_commit=False)
        db_session = factory()
        try:
            project_id, chapter7_id = _build_large_project(db_session, owner.id)
        finally:
            db_session.close()

        files_repo = WritingProjectFilesRepository(factory())
        chapter7 = files_repo.get_content(owner.id, uuid.UUID(project_id), uuid.UUID(chapter7_id))
        assert chapter7 is not None
        assert chapter7.content_text is not None
        start = chapter7.content_text.index(_TARGET_PARAGRAPH)
        end = start + len(_TARGET_PARAGRAPH)

        conversation = _create_conversation(client)
        started = time.perf_counter()
        resp = _send_writing_message(
            client,
            conversation["id"],
            project_id=project_id,
            active_file_id=chapter7_id,
            query="Make this concise.",
            selection_start=start,
            selection_end=end,
            selected_text=_TARGET_PARAGRAPH,
        )
        elapsed_ms = (time.perf_counter() - started) * 1000

        # The critical Part 24 assertion, now at the LIVE HTTP boundary:
        # zero RAG calls, zero notes/highlights/reference-metadata BEFORE
        # the model is ever invoked, and the model prompt itself stays
        # small — none of the 200 bibliography entries / 150 notes / 150
        # highlights / 50 connected-document titles leak into it.
        summary = _parse_done_event(resp.text)["writing_context_summary"]
        assert summary["policy"] == "local_edit"
        assert summary["notes_included"] == 0
        assert summary["highlights_included"] == 0
        assert summary["reference_metadata_included"] == 0
        assert retriever.call_count == 0
        assert len(llm_provider.calls) == 1
        combined = llm_provider.calls[0]["system_prompt"] + llm_provider.calls[0]["user_prompt"]
        assert _TARGET_PARAGRAPH in combined
        assert "Note 0 about an unrelated topic" not in combined
        assert "Paper Number 1" not in combined
        assert "Connected Paper 0" not in combined
        # Generous ceiling (mirrors the engine-level test's own) — this
        # measures the full HTTP round trip, not just context-build time,
        # so it's naturally looser than that test's 2000ms.
        assert elapsed_ms < 5000
