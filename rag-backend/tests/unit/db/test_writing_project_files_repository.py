"""Milestone 5.3 — WritingProjectFilesRepository. Same "real repository
against a temp on-disk SQLite DB" convention as
test_writing_projects_repository.py."""

from __future__ import annotations

import os
import tempfile
import uuid
from collections.abc import Iterator

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.db.base import Base
from app.db.documents_repository import DocumentsRepository  # noqa: F401 — registers Document/folders mappers
from app.db.models_auth import User
from app.db.writing_project_files_repository import WritingProjectFilesRepository
from app.db.writing_projects_repository import WritingProjectsRepository


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


def _make_user(db_session: Session) -> uuid.UUID:
    user = User(id=uuid.uuid4(), email=f"{uuid.uuid4()}@example.com")
    db_session.add(user)
    db_session.commit()
    return user.id


def _make_project(db_session: Session, user_id: uuid.UUID) -> uuid.UUID:
    repo = WritingProjectsRepository(db_session)
    record = repo.create(
        user_id=user_id, title="Paper", description=None, main_tex_content="\\documentclass{article}"
    )
    return record.id


class TestListTreeAndPaths:
    def test_new_project_has_one_root_text_file(self, db_session: Session) -> None:
        user_id = _make_user(db_session)
        project_id = _make_project(db_session, user_id)
        repo = WritingProjectFilesRepository(db_session)
        tree = repo.list_tree(user_id, project_id)
        assert tree is not None
        assert tree.file_count == 1
        assert tree.nodes[0].name == "main.tex"
        assert tree.nodes[0].path == "main.tex"
        assert tree.root_file_id == tree.nodes[0].id

    def test_nested_path_computed_correctly(self, db_session: Session) -> None:
        user_id = _make_user(db_session)
        project_id = _make_project(db_session, user_id)
        repo = WritingProjectFilesRepository(db_session)
        outcome, folder = repo.create_folder(user_id, project_id, parent_id=None, name="sections")
        assert outcome == "ok"
        outcome2, sub = repo.create_folder(user_id, project_id, parent_id=folder.id, name="drafts")
        assert outcome2 == "ok"
        outcome3, f = repo.create_text_file(
            user_id, project_id, parent_id=sub.id, name="v1.tex", content_text="draft"
        )
        assert outcome3 == "ok"
        assert f.path == "sections/drafts/v1.tex"

    def test_list_tree_returns_none_for_other_users_project(self, db_session: Session) -> None:
        owner_id = _make_user(db_session)
        other_id = _make_user(db_session)
        project_id = _make_project(db_session, owner_id)
        repo = WritingProjectFilesRepository(db_session)
        assert repo.list_tree(other_id, project_id) is None


class TestCreateValidation:
    def test_duplicate_name_rejected(self, db_session: Session) -> None:
        user_id = _make_user(db_session)
        project_id = _make_project(db_session, user_id)
        repo = WritingProjectFilesRepository(db_session)
        repo.create_folder(user_id, project_id, parent_id=None, name="sections")
        outcome, node = repo.create_folder(user_id, project_id, parent_id=None, name="sections")
        assert outcome == "duplicate_name"
        assert node is None

    def test_same_name_allowed_in_different_folders(self, db_session: Session) -> None:
        user_id = _make_user(db_session)
        project_id = _make_project(db_session, user_id)
        repo = WritingProjectFilesRepository(db_session)
        _, folder_a = repo.create_folder(user_id, project_id, parent_id=None, name="a")
        _, folder_b = repo.create_folder(user_id, project_id, parent_id=None, name="b")
        outcome1, _ = repo.create_text_file(
            user_id, project_id, parent_id=folder_a.id, name="notes.tex", content_text=""
        )
        outcome2, _ = repo.create_text_file(
            user_id, project_id, parent_id=folder_b.id, name="notes.tex", content_text=""
        )
        assert outcome1 == "ok"
        assert outcome2 == "ok"

    def test_parent_not_found(self, db_session: Session) -> None:
        user_id = _make_user(db_session)
        project_id = _make_project(db_session, user_id)
        repo = WritingProjectFilesRepository(db_session)
        outcome, _ = repo.create_folder(user_id, project_id, parent_id=uuid.uuid4(), name="x")
        assert outcome == "parent_not_found"

    def test_parent_must_be_a_folder(self, db_session: Session) -> None:
        user_id = _make_user(db_session)
        project_id = _make_project(db_session, user_id)
        repo = WritingProjectFilesRepository(db_session)
        _, text_file = repo.create_text_file(
            user_id, project_id, parent_id=None, name="a.tex", content_text=""
        )
        outcome, _ = repo.create_folder(user_id, project_id, parent_id=text_file.id, name="sub")
        assert outcome == "parent_not_a_folder"

    def test_file_limit_enforced(self, db_session: Session, monkeypatch: pytest.MonkeyPatch) -> None:
        import app.db.writing_project_files_repository as mod

        monkeypatch.setattr(mod, "MAX_FILES_PER_PROJECT", 2)
        user_id = _make_user(db_session)
        project_id = _make_project(db_session, user_id)  # already has 1 file (main.tex)
        repo = WritingProjectFilesRepository(db_session)
        outcome1, _ = repo.create_text_file(
            user_id, project_id, parent_id=None, name="a.tex", content_text=""
        )
        assert outcome1 == "ok"
        outcome2, _ = repo.create_text_file(
            user_id, project_id, parent_id=None, name="b.tex", content_text=""
        )
        assert outcome2 == "file_limit_reached"


class TestMoveAndCycles:
    def test_move_into_self_rejected(self, db_session: Session) -> None:
        user_id = _make_user(db_session)
        project_id = _make_project(db_session, user_id)
        repo = WritingProjectFilesRepository(db_session)
        _, folder = repo.create_folder(user_id, project_id, parent_id=None, name="a")
        outcome = repo.move(user_id, project_id, folder.id, new_parent_id=folder.id)
        assert outcome == "cannot_move_into_self_or_descendant"

    def test_move_into_descendant_rejected(self, db_session: Session) -> None:
        user_id = _make_user(db_session)
        project_id = _make_project(db_session, user_id)
        repo = WritingProjectFilesRepository(db_session)
        _, parent = repo.create_folder(user_id, project_id, parent_id=None, name="parent")
        _, child = repo.create_folder(user_id, project_id, parent_id=parent.id, name="child")
        _, grandchild = repo.create_folder(user_id, project_id, parent_id=child.id, name="gc")
        outcome = repo.move(user_id, project_id, parent.id, new_parent_id=grandchild.id)
        assert outcome == "cannot_move_into_self_or_descendant"

    def test_move_to_root(self, db_session: Session) -> None:
        user_id = _make_user(db_session)
        project_id = _make_project(db_session, user_id)
        repo = WritingProjectFilesRepository(db_session)
        _, folder = repo.create_folder(user_id, project_id, parent_id=None, name="a")
        _, f = repo.create_text_file(
            user_id, project_id, parent_id=folder.id, name="x.tex", content_text=""
        )
        outcome = repo.move(user_id, project_id, f.id, new_parent_id=None)
        assert outcome == "ok"
        node = repo.get_node(user_id, project_id, f.id)
        assert node is not None
        assert node.path == "x.tex"


class TestDeleteAndRoot:
    def test_delete_root_file_blocked(self, db_session: Session) -> None:
        user_id = _make_user(db_session)
        project_id = _make_project(db_session, user_id)
        repo = WritingProjectFilesRepository(db_session)
        tree = repo.list_tree(user_id, project_id)
        assert tree is not None
        root_id = tree.root_file_id
        assert root_id is not None
        outcome, keys = repo.delete(user_id, project_id, root_id)
        assert outcome == "cannot_delete_root_file"
        assert keys == []

    def test_delete_folder_recursively_removes_descendants(self, db_session: Session) -> None:
        user_id = _make_user(db_session)
        project_id = _make_project(db_session, user_id)
        repo = WritingProjectFilesRepository(db_session)
        _, folder = repo.create_folder(user_id, project_id, parent_id=None, name="a")
        _, f1 = repo.create_text_file(
            user_id, project_id, parent_id=folder.id, name="x.tex", content_text=""
        )
        _, sub = repo.create_folder(user_id, project_id, parent_id=folder.id, name="b")
        _, f2 = repo.create_text_file(
            user_id, project_id, parent_id=sub.id, name="y.tex", content_text=""
        )
        outcome, _ = repo.delete(user_id, project_id, folder.id)
        assert outcome == "ok"
        assert repo.get_node(user_id, project_id, f1.id) is None
        assert repo.get_node(user_id, project_id, f2.id) is None
        assert repo.get_node(user_id, project_id, sub.id) is None

    def test_set_root_requires_tex_extension(self, db_session: Session) -> None:
        user_id = _make_user(db_session)
        project_id = _make_project(db_session, user_id)
        repo = WritingProjectFilesRepository(db_session)
        _, cls_file = repo.create_text_file(
            user_id, project_id, parent_id=None, name="journal.cls", content_text=""
        )
        outcome = repo.set_root(user_id, project_id, cls_file.id)
        assert outcome == "not_a_tex_file"

    def test_set_root_to_new_tex_file(self, db_session: Session) -> None:
        user_id = _make_user(db_session)
        project_id = _make_project(db_session, user_id)
        repo = WritingProjectFilesRepository(db_session)
        _, new_root = repo.create_text_file(
            user_id, project_id, parent_id=None, name="paper.tex", content_text="\\documentclass{article}"
        )
        outcome = repo.set_root(user_id, project_id, new_root.id)
        assert outcome == "ok"
        tree = repo.list_tree(user_id, project_id)
        assert tree is not None
        assert tree.root_file_id == new_root.id

    def test_set_root_syncs_project_main_tex_content_to_new_root(
        self, db_session: Session
    ) -> None:
        """Regression test — real-browser validation (M5.3 scenario K3)
        found that reassigning root left `main_tex_content` pointing at
        the OLD root's text: compile reads that legacy column directly
        (never re-resolves through root_file_id), so a compile
        immediately after set_root() was silently compiling the file
        that USED to be root, not the newly chosen one. set_root() must
        write-through into main_tex_content exactly like
        update_text_content() already does when editing the current
        root's content."""
        user_id = _make_user(db_session)
        project_id = _make_project(db_session, user_id)
        files_repo = WritingProjectFilesRepository(db_session)
        projects_repo = WritingProjectsRepository(db_session)
        _, new_root = files_repo.create_text_file(
            user_id,
            project_id,
            parent_id=None,
            name="paper.tex",
            content_text="\\documentclass{article}\nAlternate root document.",
        )
        outcome = files_repo.set_root(user_id, project_id, new_root.id)
        assert outcome == "ok"
        project = projects_repo.get(user_id, project_id)
        assert project is not None
        assert project.main_tex_content == "\\documentclass{article}\nAlternate root document."


class TestWriteThroughSync:
    def test_updating_root_file_content_syncs_project_main_tex_content(
        self, db_session: Session
    ) -> None:
        user_id = _make_user(db_session)
        project_id = _make_project(db_session, user_id)
        files_repo = WritingProjectFilesRepository(db_session)
        projects_repo = WritingProjectsRepository(db_session)
        tree = files_repo.list_tree(user_id, project_id)
        assert tree is not None
        root_id = tree.root_file_id
        assert root_id is not None
        outcome = files_repo.update_text_content(user_id, project_id, root_id, "new content")
        assert outcome == "ok"
        project = projects_repo.get(user_id, project_id)
        assert project is not None
        assert project.main_tex_content == "new content"

    def test_updating_non_root_file_never_touches_main_tex_content(
        self, db_session: Session
    ) -> None:
        user_id = _make_user(db_session)
        project_id = _make_project(db_session, user_id)
        files_repo = WritingProjectFilesRepository(db_session)
        projects_repo = WritingProjectsRepository(db_session)
        _, f = files_repo.create_text_file(
            user_id, project_id, parent_id=None, name="notes.tex", content_text=""
        )
        files_repo.update_text_content(user_id, project_id, f.id, "unrelated content")
        project = projects_repo.get(user_id, project_id)
        assert project is not None
        assert "unrelated content" not in project.main_tex_content


class TestDuplicateProject:
    def test_duplicates_full_tree_and_content(self, db_session: Session) -> None:
        user_id = _make_user(db_session)
        source_id = _make_project(db_session, user_id)
        files_repo = WritingProjectFilesRepository(db_session)
        projects_repo = WritingProjectsRepository(db_session)
        _, folder = files_repo.create_folder(user_id, source_id, parent_id=None, name="sections")
        _, f = files_repo.create_text_file(
            user_id, source_id, parent_id=folder.id, name="intro.tex", content_text="Hello."
        )
        dest_record = projects_repo.duplicate_metadata(user_id, source_id, new_title="Paper (copy)")
        assert dest_record is not None
        id_map, binary_copies = files_repo.duplicate_all_for_project(source_id, dest_record.id)
        assert binary_copies == []
        assert f.id in id_map
        dest_tree = files_repo.list_tree(user_id, dest_record.id)
        assert dest_tree is not None
        assert dest_tree.file_count == 3  # main.tex + sections/ + intro.tex
        dest_content = files_repo.get_content(user_id, dest_record.id, id_map[f.id])
        assert dest_content is not None
        assert dest_content.content_text == "Hello."

    def test_duplicate_is_independent_of_source(self, db_session: Session) -> None:
        user_id = _make_user(db_session)
        source_id = _make_project(db_session, user_id)
        files_repo = WritingProjectFilesRepository(db_session)
        projects_repo = WritingProjectsRepository(db_session)
        dest_record = projects_repo.duplicate_metadata(user_id, source_id, new_title="Copy")
        assert dest_record is not None
        id_map, _ = files_repo.duplicate_all_for_project(source_id, dest_record.id)
        source_tree = files_repo.list_tree(user_id, source_id)
        assert source_tree is not None
        root_id = source_tree.root_file_id
        assert root_id is not None
        files_repo.update_text_content(user_id, source_id, root_id, "edited only in source")
        dest_content = files_repo.get_content(user_id, dest_record.id, id_map[root_id])
        assert dest_content is not None
        assert dest_content.content_text != "edited only in source"


class TestArchiveRestore:
    def test_archive_hides_from_default_list(self, db_session: Session) -> None:
        user_id = _make_user(db_session)
        project_id = _make_project(db_session, user_id)
        projects_repo = WritingProjectsRepository(db_session)
        projects_repo.archive(user_id, project_id)
        active = projects_repo.list_for_user(user_id, include_archived=False)
        assert all(p.id != project_id for p in active)
        everything = projects_repo.list_for_user(user_id, include_archived=True)
        assert any(p.id == project_id for p in everything)

    def test_restore_brings_it_back(self, db_session: Session) -> None:
        user_id = _make_user(db_session)
        project_id = _make_project(db_session, user_id)
        projects_repo = WritingProjectsRepository(db_session)
        projects_repo.archive(user_id, project_id)
        projects_repo.restore(user_id, project_id)
        active = projects_repo.list_for_user(user_id, include_archived=False)
        assert any(p.id == project_id for p in active)
