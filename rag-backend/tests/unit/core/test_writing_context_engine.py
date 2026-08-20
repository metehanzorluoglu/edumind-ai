"""Milestone 6.1 (Writing Context Engine) — integration-level tests
against a real (temp-file SQLite) database and real repositories, same
convention as tests/unit/db/test_writing_project_files_repository.py.
Only the Retriever (Qdrant/embeddings) is faked (RetrieverLike protocol),
matching app/core/scoped_retrieval.py's own established precedent for
testing retrieval-consuming code without a real vector store.

Covers required letters: A, B, C, L, M, N, O, P, Q, R, S, T, X, Y, Z (D-K
and U-W are covered by their own dedicated pure-function test files —
test_latex_structure.py, test_writing_manuscript_graph.py,
test_writing_context_budget.py, test_writing_context_policy.py)."""

from __future__ import annotations

import os
import tempfile
import uuid
from collections.abc import Iterator
from datetime import UTC, datetime

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.core.retrieval_schemas import RetrievedChunk
from app.core.writing_context_engine import (
    WritingContextAuthorizationError,
    build_writing_context,
)
from app.core.writing_context_schemas import WritingContextRequest
from app.db.base import Base
from app.db.documents_repository import DocumentsRepository
from app.db.models_auth import User
from app.db.notebooks_repository import NotebooksRepository
from app.db.writing_project_files_repository import WritingProjectFilesRepository
from app.db.writing_projects_repository import WritingProjectsRepository
from app.ingestion.metadata_schema import DocumentMetadata


@pytest.fixture
def db_session() -> Iterator[Session]:
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    engine = create_engine(f"sqlite:///{path}", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    session = factory()
    try:
        yield session
    finally:
        session.close()
        engine.dispose()
        os.remove(path)


def _make_user(db_session: Session, *, email: str | None = None) -> uuid.UUID:
    user = User(id=uuid.uuid4(), email=email or f"{uuid.uuid4()}@example.com")
    db_session.add(user)
    db_session.commit()
    return user.id


def _make_document(db_session: Session, user_id: uuid.UUID, *, title: str = "A Study") -> str:
    repository = DocumentsRepository(db_session)
    document_id = str(uuid.uuid4())
    metadata = DocumentMetadata(
        document_id=document_id,
        source_filename="paper.pdf",
        file_format="pdf",
        sha256=uuid.uuid4().hex + uuid.uuid4().hex,
        file_size_bytes=1000,
        page_count=3,
        document_type="journal_article",
        title=title,
        authors=["Jane Doe"],
        ingested_at=datetime.now(UTC),
    )
    repository.create(user_id=user_id, metadata=metadata, chunk_count=3)
    return document_id


def _make_project(
    db_session: Session,
    user_id: uuid.UUID,
    *,
    main_tex: str = "\\documentclass{article}\n\\begin{document}\n\\end{document}\n",
) -> uuid.UUID:
    repo = WritingProjectsRepository(db_session)
    record = repo.create(
        user_id=user_id, title="Paper", description=None, main_tex_content=main_tex
    )
    return record.id


class _FakeRetriever:
    def __init__(self, chunks: list[RetrievedChunk]) -> None:
        self._chunks = chunks
        self.calls: list[str] = []

    def retrieve(
        self, query: str, *, user_id: str, top_k: int = 8, filters: object | None = None
    ) -> list[RetrievedChunk]:
        self.calls.append(query)
        return self._chunks[:top_k]


def _chunk(**overrides: object) -> RetrievedChunk:
    base = dict(
        score=0.9,
        text="Retrieved passage text about the topic.",
        document_id="doc-1",
        chunk_id="chunk-1",
        document_type="journal_article",
        source_filename="paper.pdf",
        chunk_index=0,
        page_number=3,
    )
    base.update(overrides)
    return RetrievedChunk(**base)  # type: ignore[arg-type]


def _request(**overrides: object) -> WritingContextRequest:
    base: dict[str, object] = {"project_id": "", "user_request": ""}
    base.update(overrides)
    return WritingContextRequest(**base)  # type: ignore[arg-type]


class TestSelectionScenarios:
    """Letters A (selected sentence), B (selected paragraph), C (cursor
    with no selection)."""

    def test_letter_A_selected_sentence_stays_small(self, db_session: Session) -> None:
        content = "\\documentclass{article}\n\\begin{document}\nTeachers was interested in learning AI.\n\\end{document}\n"
        user_id = _make_user(db_session)
        project_id = _make_project(db_session, user_id, main_tex=content)
        files_repo = WritingProjectFilesRepository(db_session)
        tree = files_repo.list_tree(user_id, project_id)
        assert tree is not None
        root_id = str(tree.root_file_id)

        start = content.index("Teachers was interested in learning AI.")
        end = start + len("Teachers was interested in learning AI.")
        request = _request(
            project_id=str(project_id),
            active_file_id=root_id,
            selection_start=start,
            selection_end=end,
            selected_text="Teachers was interested in learning AI.",
            user_request="Improve the grammar.",
        )
        packet = build_writing_context(
            request,
            user_id=user_id,
            files_repo=files_repo,
            notebooks_repo=NotebooksRepository(db_session),
            retriever=_FakeRetriever([]),
        )
        assert packet.policy == "local_edit"
        assert packet.selection is not None
        assert packet.selection.selected_text == "Teachers was interested in learning AI."
        # NOT the entire thesis/bibliography/notes/highlights (Scenario A).
        assert packet.notes == []
        assert packet.highlights == []
        assert packet.evidence == []
        assert packet.diagnostics.estimated_total_tokens < 200

    def test_letter_B_selected_paragraph(self, db_session: Session) -> None:
        paragraph = "This is a full paragraph about teacher agency and the contextual conditions that shape it in real classrooms."
        content = (
            f"\\documentclass{{article}}\n\\begin{{document}}\n{paragraph}\n\\end{{document}}\n"
        )
        user_id = _make_user(db_session)
        project_id = _make_project(db_session, user_id, main_tex=content)
        files_repo = WritingProjectFilesRepository(db_session)
        root_id = str(files_repo.list_tree(user_id, project_id).root_file_id)  # type: ignore[union-attr]

        start = content.index(paragraph)
        end = start + len(paragraph)
        request = _request(
            project_id=str(project_id),
            active_file_id=root_id,
            selection_start=start,
            selection_end=end,
            selected_text=paragraph,
            user_request="Make this clearer.",
        )
        packet = build_writing_context(
            request,
            user_id=user_id,
            files_repo=files_repo,
            notebooks_repo=NotebooksRepository(db_session),
            retriever=_FakeRetriever([]),
        )
        assert packet.selection is not None
        assert packet.selection.selected_text == paragraph

    def test_letter_C_cursor_with_no_selection(self, db_session: Session) -> None:
        content = (
            "\\documentclass{article}\n\\begin{document}\nSome sentence here.\n\\end{document}\n"
        )
        user_id = _make_user(db_session)
        project_id = _make_project(db_session, user_id, main_tex=content)
        files_repo = WritingProjectFilesRepository(db_session)
        root_id = str(files_repo.list_tree(user_id, project_id).root_file_id)  # type: ignore[union-attr]

        cursor = content.index("Some sentence")
        request = _request(
            project_id=str(project_id),
            active_file_id=root_id,
            cursor_position=cursor,
            user_request="Continue this sentence.",
        )
        packet = build_writing_context(
            request,
            user_id=user_id,
            files_repo=files_repo,
            notebooks_repo=NotebooksRepository(db_session),
            retriever=_FakeRetriever([]),
        )
        assert packet.selection is not None
        assert packet.selection.selected_text == ""  # no real selection
        assert packet.selection.selection_start == packet.selection.selection_end == cursor


class TestNotesAndHighlights:
    """Letters L (notes retrieval), M (highlights retrieval)."""

    def test_letter_L_relevant_note_retrieved_not_all(self, db_session: Session) -> None:
        user_id = _make_user(db_session)
        project_id = _make_project(db_session, user_id)
        notebooks_repo = NotebooksRepository(db_session)
        notebook = notebooks_repo.create(user_id=user_id, name="Research")
        notebooks_repo.add_manual_entry(
            user_id=user_id,
            notebook_id=notebook.id,
            note_text="Teacher agency depends on contextual conditions in the classroom.",
        )
        notebooks_repo.add_manual_entry(
            user_id=user_id,
            notebook_id=notebook.id,
            note_text="Completely unrelated note about lab equipment calibration.",
        )

        files_repo = WritingProjectFilesRepository(db_session)
        request = _request(
            project_id=str(project_id),
            user_request="Do I have evidence supporting teacher agency and contextual conditions?",
        )
        packet = build_writing_context(
            request,
            user_id=user_id,
            files_repo=files_repo,
            notebooks_repo=notebooks_repo,
            retriever=_FakeRetriever([]),
        )
        assert len(packet.notes) == 1
        assert "Teacher agency" in packet.notes[0].text
        assert packet.notes[0].kind == "user_note"
        assert packet.notes[0].note_id is not None

    def test_letter_M_highlight_retrieved_with_provenance(self, db_session: Session) -> None:
        user_id = _make_user(db_session)
        document_id = _make_document(db_session, user_id, title="Contextual Conditions Paper")
        project_id = _make_project(db_session, user_id)
        notebooks_repo = NotebooksRepository(db_session)
        notebook = notebooks_repo.create(user_id=user_id, name="Research")
        notebooks_repo.add_highlight_entry(
            user_id=user_id,
            notebook_id=notebook.id,
            highlight_id=uuid.uuid4(),
            document_id=document_id,
            document_title="Contextual Conditions Paper",
            page_number=12,
            excerpt="Contextual conditions strongly shape teacher agency in practice.",
            note_text=None,
            chunk_id=None,
            chunk_index=None,
            visual_anchor_json=None,
        )
        files_repo = WritingProjectFilesRepository(db_session)
        request = _request(
            project_id=str(project_id),
            user_request="What evidence do I have about contextual conditions and teacher agency?",
        )
        packet = build_writing_context(
            request,
            user_id=user_id,
            files_repo=files_repo,
            notebooks_repo=notebooks_repo,
            retriever=_FakeRetriever([]),
        )
        assert len(packet.highlights) == 1
        item = packet.highlights[0]
        assert item.kind == "user_highlight"
        assert item.document_id == document_id
        assert item.page_number == 12
        assert item.highlight_id is not None


class TestReferenceModes:
    """Letters N (reference metadata), O (imported bibliography), P
    (EduM8 bibliography), Q (bibliography .tex source), R (inline
    thebibliography)."""

    def test_letter_O_imported_bibtex_bibliography_source(self, db_session: Session) -> None:
        main_tex = (
            "\\documentclass{article}\\bibliographystyle{plain}"
            "\\bibliography{sn-bibliography}\\begin{document}\\cite{bib1}\\end{document}"
        )
        user_id = _make_user(db_session)
        project_id = _make_project(db_session, user_id, main_tex=main_tex)
        files_repo = WritingProjectFilesRepository(db_session)
        files_repo.create_text_file(
            user_id,
            project_id,
            parent_id=None,
            name="sn-bibliography.bib",
            content_text="@article{bib1, title={A Paper}, author={Doe, J.}, year={2020}}",
        )
        request = _request(
            project_id=str(project_id), user_request="Which of my references supports this?"
        )
        packet = build_writing_context(
            request,
            user_id=user_id,
            files_repo=files_repo,
            notebooks_repo=NotebooksRepository(db_session),
            retriever=_FakeRetriever([]),
        )
        assert packet.references is not None
        assert packet.references.mode == "imported_bib"
        assert packet.references.bibliography_source == "sn-bibliography.bib"
        # NOT references.bib (spec's own Scenario D).
        assert packet.references.bibliography_source != "references.bib"
        assert any(item.reference_key == "bib1" for item in packet.reference_metadata)
        assert all(item.kind == "reference_metadata" for item in packet.reference_metadata)

    def test_letter_P_edum8_reference_library_bibliography(self, db_session: Session) -> None:
        main_tex = "\\documentclass{article}\\begin{document}\\cite{smith2020}\\end{document}"
        user_id = _make_user(db_session)
        document_id = _make_document(db_session, user_id, title="Smith Paper")
        project_id = _make_project(db_session, user_id, main_tex=main_tex)
        projects_repo = WritingProjectsRepository(db_session)
        outcome = projects_repo.add_reference(user_id, project_id, document_id)
        assert outcome == "added"

        files_repo = WritingProjectFilesRepository(db_session)
        request = _request(project_id=str(project_id), user_request="What references do I have?")
        packet = build_writing_context(
            request,
            user_id=user_id,
            files_repo=files_repo,
            notebooks_repo=NotebooksRepository(db_session),
            retriever=_FakeRetriever([]),
            edum8_reference_count=1,
        )
        assert packet.references is not None
        assert packet.references.mode == "edum8_library"
        assert packet.references.edum8_available is True

    def test_letter_Q_bibliography_tex_source(self, db_session: Session) -> None:
        """detect_reference_mode's TEMPLATE_TEX_BIBLIOGRAPHY mode: the
        root \\input{}'s a .tex file that itself contains a real
        \\begin{thebibliography} block (a bare \\bibitem with no
        thebibliography wrapper is NOT enough — see that module's own
        priority-order docstring, step 2)."""
        main_tex = "\\documentclass{article}\\input{references}\\begin{document}\\end{document}"
        user_id = _make_user(db_session)
        project_id = _make_project(db_session, user_id, main_tex=main_tex)
        files_repo = WritingProjectFilesRepository(db_session)
        files_repo.create_text_file(
            user_id,
            project_id,
            parent_id=None,
            name="references.tex",
            content_text="\\begin{thebibliography}{9}\\bibitem{bib1} Doe, J. (2020). A Paper.\\end{thebibliography}",
        )
        request = _request(project_id=str(project_id), user_request="Show references.")
        packet = build_writing_context(
            request,
            user_id=user_id,
            files_repo=files_repo,
            notebooks_repo=NotebooksRepository(db_session),
            retriever=_FakeRetriever([]),
        )
        assert packet.references is not None
        assert packet.references.mode == "template_tex"
        assert packet.references.bibliography_source == "references.tex"
        assert packet.references.mode != "edum8_library"

    def test_letter_R_inline_thebibliography(self, db_session: Session) -> None:
        main_tex = (
            "\\documentclass{article}\\begin{document}\\cite{bib1}"
            "\\begin{thebibliography}{9}\\bibitem{bib1} Doe, J. A Paper.\\end{thebibliography}"
            "\\end{document}"
        )
        user_id = _make_user(db_session)
        project_id = _make_project(db_session, user_id, main_tex=main_tex)
        files_repo = WritingProjectFilesRepository(db_session)
        request = _request(project_id=str(project_id), user_request="Show references.")
        packet = build_writing_context(
            request,
            user_id=user_id,
            files_repo=files_repo,
            notebooks_repo=NotebooksRepository(db_session),
            retriever=_FakeRetriever([]),
        )
        assert packet.references is not None
        assert packet.references.mode == "inline_template"


class TestEvidenceProvenance:
    """Letters S (evidence with source document), T (bibliography
    metadata without source document — Part 9's core distinction: a
    BibTeX entry existing does NOT mean EduM8 possesses the paper)."""

    def test_letter_S_evidence_with_source_document(self, db_session: Session) -> None:
        user_id = _make_user(db_session)
        document_id = _make_document(db_session, user_id, title="Connected Source")
        project_id = _make_project(db_session, user_id)
        outcome = WritingProjectsRepository(db_session).add_reference(
            user_id, project_id, document_id
        )
        assert outcome == "added"
        files_repo = WritingProjectFilesRepository(db_session)
        chunk = _chunk(
            document_id=document_id, text="A real retrieved passage from the connected paper."
        )
        request = _request(
            project_id=str(project_id), user_request="Do my findings contradict previous research?"
        )
        packet = build_writing_context(
            request,
            user_id=user_id,
            files_repo=files_repo,
            notebooks_repo=NotebooksRepository(db_session),
            retriever=_FakeRetriever([chunk]),
            edum8_reference_count=1,
        )
        assert len(packet.evidence) == 1
        item = packet.evidence[0]
        assert item.kind == "source_passage"
        assert item.document_id == document_id
        assert item.chunk_id == "chunk-1"
        assert item.page_number == 3

    def test_letter_T_bibliography_metadata_without_source_document(
        self, db_session: Session
    ) -> None:
        """bib7 exists in an imported .bib — EduM8 knows the metadata but
        does NOT possess the paper (Part 9's worked example). Reference
        metadata must never be labeled source_passage."""
        main_tex = "\\documentclass{article}\\bibliography{refs}\\begin{document}\\cite{bib7}\\end{document}"
        user_id = _make_user(db_session)
        project_id = _make_project(db_session, user_id, main_tex=main_tex)
        files_repo = WritingProjectFilesRepository(db_session)
        files_repo.create_text_file(
            user_id,
            project_id,
            parent_id=None,
            name="refs.bib",
            content_text="@article{bib7, title={A Distant Paper}, author={Someone}, year={2019}}",
        )
        request = _request(
            project_id=str(project_id), user_request="What do my references say about bib7?"
        )
        packet = build_writing_context(
            request,
            user_id=user_id,
            files_repo=files_repo,
            notebooks_repo=NotebooksRepository(db_session),
            retriever=_FakeRetriever([]),  # no connected source documents at all
        )
        assert any(item.reference_key == "bib7" for item in packet.reference_metadata)
        assert all(item.kind == "reference_metadata" for item in packet.reference_metadata)
        # Never fabricated as evidence/source_passage.
        assert packet.evidence == []
        assert all(item.kind != "source_passage" for item in packet.reference_metadata)


class TestUserIsolationAndStaleContent:
    """Letters X (user isolation / authorization), Y (stale/changed
    editor content behavior)."""

    def test_letter_X_cannot_access_another_users_project(self, db_session: Session) -> None:
        owner_id = _make_user(db_session, email="owner@example.com")
        attacker_id = _make_user(db_session, email="attacker@example.com")
        project_id = _make_project(db_session, owner_id)
        files_repo = WritingProjectFilesRepository(db_session)
        request = _request(project_id=str(project_id), user_request="Anything")
        with pytest.raises(WritingContextAuthorizationError):
            build_writing_context(
                request,
                user_id=attacker_id,
                files_repo=files_repo,
                notebooks_repo=NotebooksRepository(db_session),
                retriever=_FakeRetriever([]),
            )

    def test_letter_X_notes_are_never_another_users(self, db_session: Session) -> None:
        user_a = _make_user(db_session, email="a@example.com")
        user_b = _make_user(db_session, email="b@example.com")
        notebooks_repo = NotebooksRepository(db_session)
        notebook_a = notebooks_repo.create(user_id=user_a, name="A's notebook")
        notebooks_repo.add_manual_entry(
            user_id=user_a,
            notebook_id=notebook_a.id,
            note_text="User A's private research note about teacher agency.",
        )

        project_b = _make_project(db_session, user_b)
        files_repo = WritingProjectFilesRepository(db_session)
        request = _request(
            project_id=str(project_b), user_request="Tell me about teacher agency notes."
        )
        packet = build_writing_context(
            request,
            user_id=user_b,
            files_repo=files_repo,
            notebooks_repo=notebooks_repo,
            retriever=_FakeRetriever([]),
        )
        assert packet.notes == []  # user B must never see user A's note

    def test_letter_Y_unsaved_buffer_used_over_stale_saved_content(
        self, db_session: Session
    ) -> None:
        saved = "\\documentclass{article}\\begin{document}Old stale sentence.\\end{document}"
        user_id = _make_user(db_session)
        project_id = _make_project(db_session, user_id, main_tex=saved)
        files_repo = WritingProjectFilesRepository(db_session)
        root_id = str(files_repo.list_tree(user_id, project_id).root_file_id)  # type: ignore[union-attr]

        live_buffer = (
            "\\documentclass{article}\\begin{document}Brand new unsaved sentence.\\end{document}"
        )
        new_start = live_buffer.index("Brand new unsaved sentence.")
        new_end = new_start + len("Brand new unsaved sentence.")
        request = _request(
            project_id=str(project_id),
            active_file_id=root_id,
            active_file_unsaved_content=live_buffer,
            selection_start=new_start,
            selection_end=new_end,
            user_request="Improve this.",
        )
        packet = build_writing_context(
            request,
            user_id=user_id,
            files_repo=files_repo,
            notebooks_repo=NotebooksRepository(db_session),
            retriever=_FakeRetriever([]),
        )
        assert packet.selection is not None
        assert packet.selection.content_freshness == "unsaved_client_buffer"
        assert packet.selection.selected_text == "Brand new unsaved sentence."
        assert "stale" not in packet.selection.selected_text.lower()

    def test_letter_Y_client_selected_text_mismatch_detected_not_trusted(
        self, db_session: Session
    ) -> None:
        content = "\\documentclass{article}\\begin{document}Real content here.\\end{document}"
        user_id = _make_user(db_session)
        project_id = _make_project(db_session, user_id, main_tex=content)
        files_repo = WritingProjectFilesRepository(db_session)
        root_id = str(files_repo.list_tree(user_id, project_id).root_file_id)  # type: ignore[union-attr]

        start = content.index("Real content here.")
        end = start + len("Real content here.")
        request = _request(
            project_id=str(project_id),
            active_file_id=root_id,
            selection_start=start,
            selection_end=end,
            selected_text="Something the client wrongly claims was selected",  # deliberately wrong
            user_request="Improve this.",
        )
        packet = build_writing_context(
            request,
            user_id=user_id,
            files_repo=files_repo,
            notebooks_repo=NotebooksRepository(db_session),
            retriever=_FakeRetriever([]),
        )
        assert packet.selection is not None
        # Server-reconstructed text wins, never the client's claim.
        assert packet.selection.selected_text == "Real content here."
        assert packet.selection.selected_text_matches_client is False


class TestNoUnnecessaryLLMInvocation:
    """Letter Z — selecting text or moving the cursor MUST NOT call the
    LLM (Part 17). This module never imports an LLM client at all; this
    test asserts the packet's own diagnostics say so explicitly, and
    that only the (fake, non-LLM) retriever is ever touched."""

    def test_letter_Z_zero_llm_calls_and_retriever_only_called_when_policy_requires(
        self, db_session: Session
    ) -> None:
        content = "\\documentclass{article}\\begin{document}A sentence.\\end{document}"
        user_id = _make_user(db_session)
        project_id = _make_project(db_session, user_id, main_tex=content)
        files_repo = WritingProjectFilesRepository(db_session)
        root_id = str(files_repo.list_tree(user_id, project_id).root_file_id)  # type: ignore[union-attr]
        retriever = _FakeRetriever([])

        # A pure cursor-move / local-edit request must not touch the retriever.
        request = _request(
            project_id=str(project_id),
            active_file_id=root_id,
            cursor_position=5,
            user_request="Fix grammar.",
        )
        packet = build_writing_context(
            request,
            user_id=user_id,
            files_repo=files_repo,
            notebooks_repo=NotebooksRepository(db_session),
            retriever=retriever,
        )
        assert packet.diagnostics.llm_calls_made == 0
        assert retriever.calls == []


class TestEvidenceRetrievalGrowsLibraryScope:
    def test_evidence_only_attempted_for_policies_that_need_it(self, db_session: Session) -> None:
        user_id = _make_user(db_session)
        project_id = _make_project(db_session, user_id)
        files_repo = WritingProjectFilesRepository(db_session)
        retriever = _FakeRetriever([_chunk()])
        request = _request(
            project_id=str(project_id), user_request="Do my findings contradict previous research?"
        )
        packet = build_writing_context(
            request,
            user_id=user_id,
            files_repo=files_repo,
            notebooks_repo=NotebooksRepository(db_session),
            retriever=retriever,
        )
        assert packet.policy == "cross_source_synthesis"
        assert len(retriever.calls) == 1
        assert len(packet.evidence) == 1
