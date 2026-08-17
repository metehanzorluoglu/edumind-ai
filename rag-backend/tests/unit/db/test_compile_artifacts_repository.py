"""Milestone 5.5 Part 22 — CompileArtifactsRepository: ownership (Part
42) and TTL sweep (Part 17 — "no unbounded accumulation"), the exact
same coverage shape as test_writing_import_sessions_repository.py for
its structurally-identical sibling."""

from __future__ import annotations

import os
import tempfile
import uuid
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.db.base import Base
from app.db.compile_artifacts_repository import CompileArtifactsRepository
from app.db.documents_repository import DocumentsRepository  # noqa: F401 — registers mappers
from app.db.models_auth import User
from app.db.models_writing import WritingProject


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
    project = WritingProject(
        id=uuid.uuid4(),
        user_id=user_id,
        title="Thesis",
        main_tex_content="\\documentclass{article}",
    )
    db_session.add(project)
    db_session.commit()
    return project.id


class TestCreateAndGet:
    def test_create_returns_record_with_the_given_compile_id(self, db_session: Session) -> None:
        user_id = _make_user(db_session)
        project_id = _make_project(db_session, user_id)
        repo = CompileArtifactsRepository(db_session)
        compile_id = uuid.uuid4()
        record = repo.create(
            compile_id=compile_id,
            user_id=user_id,
            project_id=project_id,
            storage_key=f"{user_id}/{compile_id}.pdf",
            ttl_seconds=600,
        )
        assert record.id == compile_id
        assert record.user_id == user_id
        assert record.project_id == project_id
        assert record.storage_key == f"{user_id}/{compile_id}.pdf"

    def test_get_returns_the_created_artifact(self, db_session: Session) -> None:
        user_id = _make_user(db_session)
        project_id = _make_project(db_session, user_id)
        repo = CompileArtifactsRepository(db_session)
        compile_id = uuid.uuid4()
        repo.create(
            compile_id=compile_id,
            user_id=user_id,
            project_id=project_id,
            storage_key="k",
            ttl_seconds=600,
        )
        fetched = repo.get(user_id=user_id, project_id=project_id, compile_id=compile_id)
        assert fetched is not None
        assert fetched.storage_key == "k"

    def test_get_returns_none_for_unknown_compile_id(self, db_session: Session) -> None:
        user_id = _make_user(db_session)
        project_id = _make_project(db_session, user_id)
        repo = CompileArtifactsRepository(db_session)
        assert repo.get(user_id=user_id, project_id=project_id, compile_id=uuid.uuid4()) is None


class TestOwnership:
    """Part 42 — a guessed/wrong-owner compile_id 404s identically to a
    nonexistent one; User B cannot fetch User A's compiled PDF."""

    def test_get_returns_none_for_a_different_user(self, db_session: Session) -> None:
        owner_id = _make_user(db_session)
        other_id = _make_user(db_session)
        project_id = _make_project(db_session, owner_id)
        repo = CompileArtifactsRepository(db_session)
        compile_id = uuid.uuid4()
        repo.create(
            compile_id=compile_id,
            user_id=owner_id,
            project_id=project_id,
            storage_key="k",
            ttl_seconds=600,
        )
        assert repo.get(user_id=other_id, project_id=project_id, compile_id=compile_id) is None

    def test_get_returns_none_for_a_mismatched_project_id(self, db_session: Session) -> None:
        """Even the RIGHT user, but the WRONG project — a compile_id
        minted for project A must never resolve under project B, even
        for its own owner."""
        user_id = _make_user(db_session)
        project_a = _make_project(db_session, user_id)
        project_b = _make_project(db_session, user_id)
        repo = CompileArtifactsRepository(db_session)
        compile_id = uuid.uuid4()
        repo.create(
            compile_id=compile_id,
            user_id=user_id,
            project_id=project_a,
            storage_key="k",
            ttl_seconds=600,
        )
        assert repo.get(user_id=user_id, project_id=project_b, compile_id=compile_id) is None
        assert repo.get(user_id=user_id, project_id=project_a, compile_id=compile_id) is not None


class TestExpiryAndSweep:
    def test_get_returns_none_for_an_expired_artifact(self, db_session: Session) -> None:
        user_id = _make_user(db_session)
        project_id = _make_project(db_session, user_id)
        repo = CompileArtifactsRepository(db_session)
        compile_id = uuid.uuid4()
        repo.create(
            compile_id=compile_id,
            user_id=user_id,
            project_id=project_id,
            storage_key="k",
            ttl_seconds=600,
        )
        # Force expiry directly on the underlying row (ttl_seconds only
        # controls creation-time TTL, not a way to backdate for a test).
        from app.db.models_writing import CompileArtifact

        row = db_session.get(CompileArtifact, compile_id)
        row.expires_at = datetime.now(UTC) - timedelta(minutes=1)
        db_session.commit()

        assert repo.get(user_id=user_id, project_id=project_id, compile_id=compile_id) is None

    def test_sweep_expired_deletes_only_expired_artifacts_across_all_users(
        self, db_session: Session
    ) -> None:
        user_a = _make_user(db_session)
        user_b = _make_user(db_session)
        project_a = _make_project(db_session, user_a)
        project_b = _make_project(db_session, user_b)
        repo = CompileArtifactsRepository(db_session)

        expired_id = uuid.uuid4()
        fresh_id = uuid.uuid4()
        repo.create(
            compile_id=expired_id,
            user_id=user_a,
            project_id=project_a,
            storage_key="old-key",
            ttl_seconds=600,
        )
        repo.create(
            compile_id=fresh_id,
            user_id=user_b,
            project_id=project_b,
            storage_key="new-key",
            ttl_seconds=600,
        )
        from app.db.models_writing import CompileArtifact

        row = db_session.get(CompileArtifact, expired_id)
        row.expires_at = datetime.now(UTC) - timedelta(minutes=1)
        db_session.commit()

        swept_keys = repo.sweep_expired()
        assert swept_keys == ["old-key"]
        assert repo.get(user_id=user_a, project_id=project_a, compile_id=expired_id) is None
        assert repo.get(user_id=user_b, project_id=project_b, compile_id=fresh_id) is not None

    def test_sweep_expired_is_a_no_op_when_nothing_expired(self, db_session: Session) -> None:
        repo = CompileArtifactsRepository(db_session)
        assert repo.sweep_expired() == []
