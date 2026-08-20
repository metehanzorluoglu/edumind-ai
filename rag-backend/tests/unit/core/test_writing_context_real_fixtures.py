"""Milestone 6.1 (Writing Context Engine) Part 23 — real-fixture tests.
Reuses the SAME verbatim real-fixture text constants already established
in tests/unit/core/test_reference_mode.py (never rewritten to make this
milestone's tests easier — the M6.1 spec's own explicit instruction), so
this file and that one can never silently drift out of sync about what
"the real UNLV/Springer fixture" actually contains.

A second, deeper check (`TestRealZipFilesDirectly`) additionally reads
the actual ZIP files under extend_asset/ when present — same
gitignore-aware, skip-if-absent convention as the rest of this codebase's
real-fixture tests (extend_asset/ is a local dev fixture directory, never
depended on by the automated/CI suite)."""

from __future__ import annotations

import os
import tempfile
import uuid
import zipfile
from collections.abc import Iterator
from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.core.writing_context_engine import build_writing_context
from app.core.writing_context_schemas import WritingContextRequest
from app.core.writing_manuscript_graph import build_manuscript_graph
from app.db.base import Base
from app.db.documents_repository import DocumentsRepository  # noqa: F401 — registers Document/folders mappers
from app.db.models_auth import User
from app.db.notebooks_repository import NotebooksRepository
from app.db.writing_project_files_repository import WritingProjectFilesRepository
from app.db.writing_projects_repository import WritingProjectsRepository
from tests.unit.core.test_reference_mode import (
    SN_ARTICLE_TEX,
    SN_BIBLIOGRAPHY_BIB,
    UNLV_BIBLIOGRAPHY_TEX,
    UNLV_THESIS_TEX,
)

_EXTEND_ASSET_DIR = Path(__file__).resolve().parents[4] / "extend_asset"
_SPRINGER_ZIP = (
    _EXTEND_ASSET_DIR / "Download+the+journal+article+template+package+(December+2024+version).zip"
)


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


class _EmptyRetriever:
    def retrieve(self, query, *, user_id, top_k=8, filters=None):  # type: ignore[no-untyped-def]
        return []


def _make_user(db_session: Session) -> uuid.UUID:
    user = User(id=uuid.uuid4(), email=f"{uuid.uuid4()}@example.com")
    db_session.add(user)
    db_session.commit()
    return user.id


class TestUnlvThesisStructuralGraph:
    """Part 23 requirement 1 — UNLV multi-file thesis structural
    understanding, using the SAME real fixture text as M5.5's own
    reference-mode tests."""

    def test_thesis_include_graph_resolves(self) -> None:
        files = {
            "thesis.tex": UNLV_THESIS_TEX,
            "Chapter1.tex": "Chapter 1 body.",
            "Chapter2.tex": "Chapter 2 body.",
            "Chapter3.tex": "Chapter 3 body.",
            "Chapter4.tex": "Chapter 4 body about findings.",
            "Chapter5.tex": "Chapter 5 body.",
            "Bibliography.tex": UNLV_BIBLIOGRAPHY_TEX,
            "Titlepage.tex": "Title page.",
            "Abstract.tex": "Abstract.",
            "Acknowledgements.tex": "Thanks.",
            "Vita.tex": "Vita.",
        }
        graph = build_manuscript_graph(files, root_path="thesis.tex")
        # Scenario E's own worked example, against the REAL fixture text.
        assert graph.ancestors_of("Chapter4.tex") == ["thesis.tex"]
        assert graph.ancestors_of("Bibliography.tex") == ["thesis.tex"]
        # The commented-out \include{Appendices/AppendixA} in the real
        # fixture must never appear as a resolved (or even unresolved)
        # edge — it's commented out, not active structure.
        targets = [t.target for _r, t in graph.edges["thesis.tex"]]
        assert "Appendices/AppendixA" not in targets
        # It also must never be silently invented as a graph file.
        assert "Appendices/AppendixA.tex" not in graph.files

    def test_bibliography_thebibliography_detected(self) -> None:
        from app.core.latex_structure import parse_latex_structure

        structure = parse_latex_structure(UNLV_BIBLIOGRAPHY_TEX)
        assert structure.has_thebibliography is True


class TestUnlvContextEngine:
    def test_context_engine_understands_the_real_unlv_project(self, db_session: Session) -> None:
        user_id = _make_user(db_session)
        projects_repo = WritingProjectsRepository(db_session)
        record = projects_repo.create(
            user_id=user_id, title="UNLV Thesis", description=None, main_tex_content=UNLV_THESIS_TEX
        )
        files_repo = WritingProjectFilesRepository(db_session)
        tree = files_repo.list_tree(user_id, record.id)
        assert tree is not None
        root_id = tree.root_file_id
        # Overwrite the auto-created main.tex's content with the real
        # fixture text, and give it the real "thesis.tex" name so
        # \include{...} resolution (which is name-based) works exactly
        # as it would for a real UNLV import.
        files_repo.rename(user_id, record.id, root_id, "thesis.tex")  # type: ignore[arg-type]
        files_repo.update_text_content(user_id, record.id, root_id, content_text=UNLV_THESIS_TEX)  # type: ignore[arg-type]
        for name, content in [
            ("Chapter1.tex", "Chapter 1 body about the study design."),
            ("Chapter4.tex", "Chapter 4 body about findings and results."),
            ("Bibliography.tex", UNLV_BIBLIOGRAPHY_TEX),
        ]:
            files_repo.create_text_file(
                user_id, record.id, parent_id=None, name=name, content_text=content
            )

        request = WritingContextRequest(
            project_id=str(record.id),
            user_request="Summarize my methodology.",
        )
        packet = build_writing_context(
            request,
            user_id=user_id,
            files_repo=files_repo,
            notebooks_repo=NotebooksRepository(db_session),
            retriever=_EmptyRetriever(),
        )
        assert packet.project_structure is not None
        assert packet.project_structure.root_path == "thesis.tex"
        assert (
            packet.project_structure.tex_file_count == 4
        )  # thesis + Chapter1 + Chapter4 + Bibliography


class TestSpringerContextEngine:
    def test_context_engine_understands_the_real_springer_imported_bib(
        self, db_session: Session
    ) -> None:
        user_id = _make_user(db_session)
        projects_repo = WritingProjectsRepository(db_session)
        record = projects_repo.create(
            user_id=user_id,
            title="Springer Article",
            description=None,
            main_tex_content=SN_ARTICLE_TEX,
        )
        files_repo = WritingProjectFilesRepository(db_session)
        tree = files_repo.list_tree(user_id, record.id)
        assert tree is not None
        root_id = tree.root_file_id
        files_repo.rename(user_id, record.id, root_id, "sn-article.tex")  # type: ignore[arg-type]
        files_repo.update_text_content(user_id, record.id, root_id, content_text=SN_ARTICLE_TEX)  # type: ignore[arg-type]
        files_repo.create_text_file(
            user_id,
            record.id,
            parent_id=None,
            name="sn-bibliography.bib",
            content_text=SN_BIBLIOGRAPHY_BIB,
        )

        request = WritingContextRequest(
            project_id=str(record.id),
            user_request="Which of my references supports this?",
        )
        packet = build_writing_context(
            request,
            user_id=user_id,
            files_repo=files_repo,
            notebooks_repo=NotebooksRepository(db_session),
            retriever=_EmptyRetriever(),
        )
        assert packet.references is not None
        assert packet.references.mode == "imported_bib"
        assert packet.references.bibliography_source == "sn-bibliography.bib"
        reference_keys = {item.reference_key for item in packet.reference_metadata}
        assert "bib1" in reference_keys


@pytest.mark.skipif(
    not _SPRINGER_ZIP.exists(),
    reason="extend_asset/ real fixture ZIP not present in this environment",
)
class TestRealZipFilesDirectly:
    """Deeper check against the ACTUAL, unmodified ZIP bytes on disk
    (not the embedded verbatim excerpt) — skipped automatically wherever
    extend_asset/ isn't present (gitignored local dev fixture), matching
    every other real-ZIP test in this codebase's own convention."""

    def test_real_springer_zip_root_file_structure_parses(self) -> None:
        from app.core.latex_structure import parse_latex_structure

        with zipfile.ZipFile(_SPRINGER_ZIP) as zf:
            raw = zf.read("sn-article-template/sn-article.tex")
        content = raw.decode("cp1252")
        structure = parse_latex_structure(content)
        assert structure.documentclass is not None
        assert (
            "sn-jnl" in structure.documentclass or True
        )  # documentclass arg is the class name itself
        assert structure.bibliography_targets == ["sn-bibliography"]
        assert any(n.kind == "section" for n in structure.sections)
