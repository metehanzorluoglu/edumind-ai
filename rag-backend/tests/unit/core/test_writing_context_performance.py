"""Milestone 6.1 (Writing Context Engine) Part 24 — the critical
acceptance test: a large research library must NOT make a small local
edit request send proportionally large context. Builds a realistic large
project (many .tex files, a long manuscript, many bibliography entries,
many notes/highlights, several connected source documents each with
retrievable chunks) and asserts context size and build latency stay
bounded regardless of library size."""

from __future__ import annotations

import os
import tempfile
import time
import uuid
from collections.abc import Iterator
from datetime import UTC, datetime

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.core.retrieval_schemas import RetrievedChunk
from app.core.writing_context_engine import build_writing_context
from app.core.writing_context_schemas import WritingContextRequest
from app.db.base import Base
from app.db.documents_repository import DocumentsRepository
from app.db.models_auth import User
from app.db.notebooks_repository import NotebooksRepository
from app.db.writing_project_files_repository import WritingProjectFilesRepository
from app.db.writing_projects_repository import WritingProjectsRepository
from app.ingestion.metadata_schema import DocumentMetadata

_NUM_CHAPTERS = 12
_PARAGRAPHS_PER_CHAPTER = 60
_NUM_BIBLIOGRAPHY_ENTRIES = 200
_NUM_NOTES = 150
_NUM_HIGHLIGHTS = 150
_NUM_CONNECTED_DOCUMENTS = 50


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


class _LargeCorpusRetriever:
    """Simulates a real Retriever backed by a 200-page-equivalent
    library: always "finds" plenty of chunks, since the assertion this
    test cares about is that the ENGINE bounds what it keeps, not that
    retrieval itself returns little."""

    def __init__(self) -> None:
        self.call_count = 0

    def retrieve(
        self, query: str, *, user_id: str, top_k: int = 8, filters: object | None = None
    ) -> list[RetrievedChunk]:
        self.call_count += 1
        return [
            RetrievedChunk(
                score=0.9 - (i * 0.01),
                text=("Retrieved passage " + str(i) + " " + ("word " * 150)),
                document_id=f"doc-{i}",
                chunk_id=f"chunk-{i}",
                document_type="journal_article",
                source_filename=f"paper-{i}.pdf",
                chunk_index=0,
                page_number=1,
            )
            for i in range(top_k)
        ]


def _make_user(db_session: Session) -> uuid.UUID:
    user = User(id=uuid.uuid4(), email=f"{uuid.uuid4()}@example.com")
    db_session.add(user)
    db_session.commit()
    return user.id


def _build_large_project(db_session: Session, user_id: uuid.UUID) -> tuple[uuid.UUID, str]:
    chapters = "\n".join(f"\\include{{Chapter{i}}}" for i in range(1, _NUM_CHAPTERS + 1))
    main_tex = f"\\documentclass{{book}}\n\\bibliographystyle{{plain}}\n\\bibliography{{refs}}\n\\begin{{document}}\n{chapters}\n\\end{{document}}\n"

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

    target_paragraph = "Teacher agency is influenced by contextual conditions in the classroom."
    target_chapter_path = "Chapter7.tex"
    for i in range(1, _NUM_CHAPTERS + 1):
        section_heading = f"\\section{{Chapter {i} Overview}}\n"
        paragraphs = "\n".join(
            f"\\subsection{{Section {i}.{p}}}\nLorem ipsum dolor sit amet, consectetur adipiscing elit, chapter {i} paragraph {p}. "
            + ("word " * 40)
            for p in range(_PARAGRAPHS_PER_CHAPTER)
        )
        content = section_heading + paragraphs
        if i == 7:
            content += f"\n\\subsection{{Discussion}}\n{target_paragraph}\n"
        files_repo.create_text_file(
            user_id, record.id, parent_id=None, name=f"Chapter{i}.tex", content_text=content
        )

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

    return record.id, target_chapter_path


class TestLargeProjectPerformance:
    def test_local_edit_context_stays_small_regardless_of_library_size(
        self, db_session: Session
    ) -> None:
        user_id = _make_user(db_session)
        project_id, _target_path = _build_large_project(db_session, user_id)
        files_repo = WritingProjectFilesRepository(db_session)
        tree = files_repo.list_tree(user_id, project_id)
        assert tree is not None
        chapter7_id = next(str(n.id) for n in tree.nodes if n.path == "Chapter7.tex")
        chapter7_content = files_repo.get_content(user_id, project_id, uuid.UUID(chapter7_id))  # type: ignore[union-attr]
        assert chapter7_content is not None
        selection_text = "Teacher agency is influenced by contextual conditions in the classroom."
        start = chapter7_content.content_text.index(selection_text)  # type: ignore[union-attr]
        end = start + len(selection_text)

        retriever = _LargeCorpusRetriever()
        request = WritingContextRequest(
            project_id=str(project_id),
            active_file_id=chapter7_id,
            selection_start=start,
            selection_end=end,
            selected_text=selection_text,
            user_request="Make this concise.",
        )
        started = time.perf_counter()
        packet = build_writing_context(
            request,
            user_id=user_id,
            files_repo=files_repo,
            notebooks_repo=NotebooksRepository(db_session),
            retriever=retriever,
        )
        elapsed_ms = (time.perf_counter() - started) * 1000

        # The critical assertion (Part 24): a 200-entry bibliography /
        # 150 notes / 150 highlights / 50 connected documents / 12-
        # chapter manuscript must NOT show up in a local-edit packet.
        assert packet.policy == "local_edit"
        assert packet.notes == []
        assert packet.highlights == []
        assert packet.evidence == []
        assert packet.reference_metadata == []
        assert retriever.call_count == 0  # never even attempted (Part 14: "Do not RAG")
        assert packet.diagnostics.estimated_total_tokens < 300
        assert elapsed_ms < 2000  # generous ceiling; real build is much faster (see report)
        self.local_edit_elapsed_ms = elapsed_ms  # noqa: B010 - stashed for the report's own measurement script

    def test_cross_source_synthesis_stays_bounded_despite_large_library(
        self, db_session: Session
    ) -> None:
        """The worst-case policy (every layer on) must still respect the
        hard budget caps — large library size increases what's
        AVAILABLE, never what's SENT."""
        user_id = _make_user(db_session)
        project_id, _target_path = _build_large_project(db_session, user_id)
        files_repo = WritingProjectFilesRepository(db_session)

        retriever = _LargeCorpusRetriever()
        request = WritingContextRequest(
            project_id=str(project_id),
            user_request="Do my findings contradict previous research in the literature?",
        )
        packet = build_writing_context(
            request,
            user_id=user_id,
            files_repo=files_repo,
            notebooks_repo=NotebooksRepository(db_session),
            retriever=retriever,
        )
        assert packet.policy == "cross_source_synthesis"
        # Bounded by the hard per-category item caps, never "all 200
        # bibliography entries" / "all 150 notes".
        assert len(packet.reference_metadata) <= 5
        assert len(packet.evidence) <= 5
        assert len(packet.notes) <= 5
        assert len(packet.highlights) <= 5
        assert packet.diagnostics.estimated_total_tokens <= packet.budget.total_token_budget

    def test_project_structure_never_concatenates_all_chapters(self, db_session: Session) -> None:
        user_id = _make_user(db_session)
        project_id, _target_path = _build_large_project(db_session, user_id)
        files_repo = WritingProjectFilesRepository(db_session)
        tree = files_repo.list_tree(user_id, project_id)
        assert tree is not None
        chapter7_id = next(str(n.id) for n in tree.nodes if n.path == "Chapter7.tex")

        request = WritingContextRequest(
            project_id=str(project_id),
            active_file_id=chapter7_id,
            user_request="What am I writing about?",
        )
        packet = build_writing_context(
            request,
            user_id=user_id,
            files_repo=files_repo,
            notebooks_repo=NotebooksRepository(db_session),
            retriever=_LargeCorpusRetriever(),
        )
        assert packet.project_structure is not None
        # Only Chapter7's own direct ancestor (main.tex) — never all 12
        # sibling chapters concatenated in.
        assert packet.project_structure.ancestor_paths == ["main.tex"]
        assert packet.project_structure.tex_file_count == _NUM_CHAPTERS + 1
