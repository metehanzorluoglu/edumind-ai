"""Milestone 5.4 (LaTeX Templates & Project Import) Part 9/31/32 —
WritingImportSessionsRepository: ownership (Part 31) and TTL sweep
(Part 32 — "no unbounded accumulation")."""

from __future__ import annotations

import os
import tempfile
import uuid
from collections.abc import Iterator
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.core.writing_project_import import ImportInspection
from app.db.base import Base
from app.db.documents_repository import DocumentsRepository  # noqa: F401 — registers mappers
from app.db.models_auth import User
from app.db.writing_import_sessions_repository import WritingImportSessionsRepository


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


def _inspection() -> ImportInspection:
    return ImportInspection(
        suggested_title="Imported Project",
        files=[],
        root_candidates=[],
        preselected_root=None,
    )


class TestCreateAndGet:
    def test_create_returns_record_with_the_given_session_id(self, db_session: Session) -> None:
        user_id = _make_user(db_session)
        repo = WritingImportSessionsRepository(db_session)
        session_id = uuid.uuid4()
        record = repo.create(
            session_id=session_id,
            user_id=user_id,
            original_filename="paper.zip",
            storage_key=f"{user_id}/{session_id}.zip",
            inspection=_inspection(),
            ttl_minutes=30,
        )
        assert record.id == session_id
        assert record.user_id == user_id
        assert record.storage_key == f"{user_id}/{session_id}.zip"

    def test_get_returns_the_created_session(self, db_session: Session) -> None:
        user_id = _make_user(db_session)
        repo = WritingImportSessionsRepository(db_session)
        session_id = uuid.uuid4()
        repo.create(
            session_id=session_id,
            user_id=user_id,
            original_filename="paper.zip",
            storage_key="k",
            inspection=_inspection(),
            ttl_minutes=30,
        )
        fetched = repo.get(user_id, session_id)
        assert fetched is not None
        assert fetched.original_filename == "paper.zip"
        assert fetched.inspection.suggested_title == "Imported Project"

    def test_get_returns_none_for_unknown_session(self, db_session: Session) -> None:
        user_id = _make_user(db_session)
        repo = WritingImportSessionsRepository(db_session)
        assert repo.get(user_id, uuid.uuid4()) is None


class TestOwnership:
    """Part 31 — User B cannot inspect/confirm/cancel User A's session."""

    def test_get_returns_none_for_a_different_user(self, db_session: Session) -> None:
        owner_id = _make_user(db_session)
        other_id = _make_user(db_session)
        repo = WritingImportSessionsRepository(db_session)
        session_id = uuid.uuid4()
        repo.create(
            session_id=session_id,
            user_id=owner_id,
            original_filename="paper.zip",
            storage_key="k",
            inspection=_inspection(),
            ttl_minutes=30,
        )
        assert repo.get(other_id, session_id) is None

    def test_delete_by_a_different_user_does_nothing_and_returns_none(self, db_session: Session) -> None:
        owner_id = _make_user(db_session)
        other_id = _make_user(db_session)
        repo = WritingImportSessionsRepository(db_session)
        session_id = uuid.uuid4()
        repo.create(
            session_id=session_id,
            user_id=owner_id,
            original_filename="paper.zip",
            storage_key="k",
            inspection=_inspection(),
            ttl_minutes=30,
        )
        assert repo.delete(other_id, session_id) is None
        # Still fetchable by the real owner — the wrong-user delete was
        # a true no-op, not a partial mutation.
        assert repo.get(owner_id, session_id) is not None


class TestDelete:
    def test_delete_by_owner_returns_storage_key_and_removes_row(self, db_session: Session) -> None:
        user_id = _make_user(db_session)
        repo = WritingImportSessionsRepository(db_session)
        session_id = uuid.uuid4()
        repo.create(
            session_id=session_id,
            user_id=user_id,
            original_filename="paper.zip",
            storage_key="the-storage-key",
            inspection=_inspection(),
            ttl_minutes=30,
        )
        deleted_key = repo.delete(user_id, session_id)
        assert deleted_key == "the-storage-key"
        assert repo.get(user_id, session_id) is None

    def test_delete_of_already_deleted_session_returns_none(self, db_session: Session) -> None:
        user_id = _make_user(db_session)
        repo = WritingImportSessionsRepository(db_session)
        assert repo.delete(user_id, uuid.uuid4()) is None


class TestExpiryAndSweep:
    def test_get_returns_none_for_an_expired_session(self, db_session: Session) -> None:
        user_id = _make_user(db_session)
        repo = WritingImportSessionsRepository(db_session)
        session_id = uuid.uuid4()
        repo.create(
            session_id=session_id,
            user_id=user_id,
            original_filename="paper.zip",
            storage_key="k",
            inspection=_inspection(),
            ttl_minutes=30,
        )
        # Force expiry directly on the underlying row (ttl_minutes only
        # controls creation-time TTL, not a way to backdate for a test).
        from app.db.models_writing import WritingImportSession

        row = db_session.get(WritingImportSession, session_id)
        row.expires_at = datetime.now(timezone.utc) - timedelta(minutes=1)
        db_session.commit()

        assert repo.get(user_id, session_id) is None

    def test_sweep_expired_deletes_only_expired_sessions_across_all_users(self, db_session: Session) -> None:
        user_a = _make_user(db_session)
        user_b = _make_user(db_session)
        repo = WritingImportSessionsRepository(db_session)

        expired_id = uuid.uuid4()
        fresh_id = uuid.uuid4()
        repo.create(
            session_id=expired_id,
            user_id=user_a,
            original_filename="old.zip",
            storage_key="old-key",
            inspection=_inspection(),
            ttl_minutes=30,
        )
        repo.create(
            session_id=fresh_id,
            user_id=user_b,
            original_filename="new.zip",
            storage_key="new-key",
            inspection=_inspection(),
            ttl_minutes=30,
        )
        from app.db.models_writing import WritingImportSession

        row = db_session.get(WritingImportSession, expired_id)
        row.expires_at = datetime.now(timezone.utc) - timedelta(minutes=1)
        db_session.commit()

        swept_keys = repo.sweep_expired()
        assert swept_keys == ["old-key"]
        assert repo.get(user_a, expired_id) is None
        assert repo.get(user_b, fresh_id) is not None

    def test_sweep_expired_is_a_no_op_when_nothing_expired(self, db_session: Session) -> None:
        repo = WritingImportSessionsRepository(db_session)
        assert repo.sweep_expired() == []
