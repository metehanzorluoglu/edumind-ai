"""Milestone 5.4 (LaTeX Templates & Project Import) Part 15 — RELEASE
CRITICAL coverage for create_project_from_manifest(): the entire
project (row + every file/folder row + every binary asset's bytes on
disk) is created, or NOTHING is. Same "real repository against a temp
on-disk SQLite DB" convention as test_writing_project_files_repository.py."""

from __future__ import annotations

import os
import tempfile
import uuid
from collections.abc import Iterator

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker

from app.db.base import Base
from app.db.documents_repository import DocumentsRepository  # noqa: F401 — registers mappers
from app.db.models_auth import User
from app.db.models_writing import WritingProject, WritingProjectFile
from app.core.writing_project_creation import ManifestFile, ProjectCreationError, create_project_from_manifest
from app.services.writing_project_file_storage import WritingProjectFileStorage


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


@pytest.fixture
def files_storage(tmp_path) -> WritingProjectFileStorage:
    return WritingProjectFileStorage(root_dir=str(tmp_path / "writing-files"))


def _make_user(db_session: Session) -> uuid.UUID:
    user = User(id=uuid.uuid4(), email=f"{uuid.uuid4()}@example.com")
    db_session.add(user)
    db_session.commit()
    return user.id


class TestSuccessfulCreation:
    def test_single_text_file_project(self, db_session: Session, files_storage: WritingProjectFileStorage) -> None:
        user_id = _make_user(db_session)
        project = create_project_from_manifest(
            db_session,
            files_storage,
            user_id=user_id,
            title="Blank Article",
            description=None,
            files=[ManifestFile(path="main.tex", kind="text", content_text="\\documentclass{article}")],
            root_path="main.tex",
        )
        assert project.root_file_id is not None
        assert project.main_tex_content == "\\documentclass{article}"

        rows = db_session.execute(
            select(WritingProjectFile).where(WritingProjectFile.writing_project_id == project.id)
        ).scalars().all()
        assert len(rows) == 1
        assert rows[0].name == "main.tex"
        assert rows[0].id == project.root_file_id

    def test_multi_file_project_creates_folder_rows_and_correct_tree(
        self, db_session: Session, files_storage: WritingProjectFileStorage
    ) -> None:
        user_id = _make_user(db_session)
        project = create_project_from_manifest(
            db_session,
            files_storage,
            user_id=user_id,
            title="Academic Article",
            description="An imported paper",
            files=[
                ManifestFile(path="main.tex", kind="text", content_text="\\documentclass{article}"),
                ManifestFile(path="sections/intro.tex", kind="text", content_text="Intro."),
                ManifestFile(path="sections/deep/nested.tex", kind="text", content_text="Deep."),
            ],
            root_path="main.tex",
        )
        rows = db_session.execute(
            select(WritingProjectFile).where(WritingProjectFile.writing_project_id == project.id)
        ).scalars().all()
        by_name = {r.name: r for r in rows}
        # main.tex + sections(folder) + intro.tex + deep(folder) + nested.tex
        assert len(rows) == 5
        assert by_name["sections"].kind == "folder"
        assert by_name["deep"].kind == "folder"
        assert by_name["deep"].parent_id == by_name["sections"].id
        assert by_name["nested.tex"].parent_id == by_name["deep"].id
        assert by_name["intro.tex"].parent_id == by_name["sections"].id
        assert by_name["main.tex"].parent_id is None

    def test_binary_file_written_to_storage_and_readable(
        self, db_session: Session, files_storage: WritingProjectFileStorage
    ) -> None:
        user_id = _make_user(db_session)
        png_bytes = b"\x89PNG\r\n\x1a\n" + b"0" * 50
        project = create_project_from_manifest(
            db_session,
            files_storage,
            user_id=user_id,
            title="With Figure",
            description=None,
            files=[
                ManifestFile(path="main.tex", kind="text", content_text="\\documentclass{article}"),
                ManifestFile(
                    path="figures/plot.png", kind="binary", raw_bytes=png_bytes, mime_type="image/png"
                ),
            ],
            root_path="main.tex",
        )
        rows = db_session.execute(
            select(WritingProjectFile).where(WritingProjectFile.writing_project_id == project.id)
        ).scalars().all()
        binary_row = next(r for r in rows if r.kind == "binary")
        assert binary_row.storage_key is not None
        assert files_storage.read(binary_row.storage_key) == png_bytes

    def test_no_root_path_leaves_project_without_root(
        self, db_session: Session, files_storage: WritingProjectFileStorage
    ) -> None:
        # Part 12 — "allow import but require explicit root selection
        # before compile" — a project can legitimately be created with
        # root_file_id still None.
        user_id = _make_user(db_session)
        project = create_project_from_manifest(
            db_session,
            files_storage,
            user_id=user_id,
            title="No Root Yet",
            description=None,
            files=[ManifestFile(path="notes.tex", kind="text", content_text="just notes")],
            root_path=None,
        )
        assert project.root_file_id is None
        assert project.main_tex_content == ""


class TestFailureIsFullyAtomic:
    def test_binary_write_failure_mid_creation_leaves_no_db_rows_and_no_disk_bytes(
        self, db_session: Session, files_storage: WritingProjectFileStorage, tmp_path
    ) -> None:
        user_id = _make_user(db_session)
        with pytest.raises(ProjectCreationError):
            create_project_from_manifest(
                db_session,
                files_storage,
                user_id=user_id,
                title="Will Fail",
                description=None,
                files=[
                    ManifestFile(path="main.tex", kind="text", content_text="\\documentclass{article}"),
                    ManifestFile(
                        path="figures/good.png", kind="binary", raw_bytes=b"realbytes", mime_type="image/png"
                    ),
                    # Missing raw_bytes on a binary entry — deliberately
                    # invalid input, triggers ProjectCreationError after
                    # the FIRST binary file has already been written to
                    # disk, exercising the rollback's disk-cleanup path.
                    ManifestFile(path="figures/bad.png", kind="binary", raw_bytes=None, mime_type="image/png"),
                ],
                root_path="main.tex",
            )

        # No project/file rows should have survived the rollback.
        assert db_session.execute(select(WritingProject)).scalars().all() == []
        assert db_session.execute(select(WritingProjectFile)).scalars().all() == []

        # No bytes should remain on disk anywhere under this user's
        # storage subtree — walk the whole storage root looking for any
        # leftover file.
        leftover_files = []
        for root, _dirs, filenames in os.walk(files_storage._root):  # noqa: SLF001 — test-only introspection
            leftover_files.extend(filenames)
        assert leftover_files == []

    def test_unknown_file_kind_rejected_and_fully_rolled_back(
        self, db_session: Session, files_storage: WritingProjectFileStorage
    ) -> None:
        user_id = _make_user(db_session)
        with pytest.raises(ProjectCreationError):
            create_project_from_manifest(
                db_session,
                files_storage,
                user_id=user_id,
                title="Bad Kind",
                description=None,
                files=[ManifestFile(path="weird.xyz", kind="something-else", content_text="x")],
                root_path=None,
            )
        assert db_session.execute(select(WritingProject)).scalars().all() == []
