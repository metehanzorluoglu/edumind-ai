"""Milestone 5.5 Part 24 — cli/qa_accounts.py: this is the ONLY code
path that ever writes users.is_qa_account, so its mark/unmark/list
behavior (idempotency, unknown-email handling, exact-match-only) is
covered directly rather than only smoke-tested manually."""

from __future__ import annotations

import os
import tempfile
import uuid
from collections.abc import Iterator

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.db.base import Base
from app.db.documents_repository import DocumentsRepository  # noqa: F401 — registers mappers
from app.db.models_auth import User
from cli.qa_accounts import cmd_list, cmd_mark, cmd_unmark


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


def _make_user(db_session: Session, *, email: str) -> User:
    user = User(id=uuid.uuid4(), email=email)
    db_session.add(user)
    db_session.commit()
    return user


class _Args:
    def __init__(self, email: str | None = None) -> None:
        self.email = email


class TestMarkAndUnmark:
    def test_mark_sets_the_flag(self, db_session: Session, monkeypatch, capsys) -> None:
        user = _make_user(db_session, email="qa.tester@example.com")
        monkeypatch.setattr(
            "cli.qa_accounts.get_session_factory", lambda: (lambda: db_session)
        )

        exit_code = cmd_mark(_Args(email="qa.tester@example.com"))

        assert exit_code == 0
        # The CLI's own `with db: ...` closes the session on exit,
        # expiring/detaching the earlier `user` object — re-fetch fresh
        # rather than refresh()ing a now-detached instance.
        assert db_session.get(User, user.id).is_qa_account is True
        assert "Marked" in capsys.readouterr().out

    def test_mark_is_idempotent(self, db_session: Session, monkeypatch, capsys) -> None:
        user = _make_user(db_session, email="qa.tester@example.com")
        user.is_qa_account = True
        db_session.commit()
        monkeypatch.setattr(
            "cli.qa_accounts.get_session_factory", lambda: (lambda: db_session)
        )

        exit_code = cmd_mark(_Args(email="qa.tester@example.com"))

        assert exit_code == 0
        assert "already marked" in capsys.readouterr().out

    def test_mark_unknown_email_fails_with_exit_code_1(
        self, db_session: Session, monkeypatch, capsys
    ) -> None:
        monkeypatch.setattr(
            "cli.qa_accounts.get_session_factory", lambda: (lambda: db_session)
        )

        exit_code = cmd_mark(_Args(email="nobody@example.com"))

        assert exit_code == 1
        assert "No user found" in capsys.readouterr().err

    def test_unmark_clears_the_flag(self, db_session: Session, monkeypatch, capsys) -> None:
        user = _make_user(db_session, email="qa.tester@example.com")
        user.is_qa_account = True
        db_session.commit()
        monkeypatch.setattr(
            "cli.qa_accounts.get_session_factory", lambda: (lambda: db_session)
        )

        exit_code = cmd_unmark(_Args(email="qa.tester@example.com"))

        assert exit_code == 0
        assert db_session.get(User, user.id).is_qa_account is False

    def test_unmark_when_not_marked_is_a_no_op(
        self, db_session: Session, monkeypatch, capsys
    ) -> None:
        _make_user(db_session, email="qa.tester@example.com")
        monkeypatch.setattr(
            "cli.qa_accounts.get_session_factory", lambda: (lambda: db_session)
        )

        exit_code = cmd_unmark(_Args(email="qa.tester@example.com"))

        assert exit_code == 0
        assert "not marked" in capsys.readouterr().out


class TestList:
    def test_list_shows_only_qa_marked_accounts(
        self, db_session: Session, monkeypatch, capsys
    ) -> None:
        _make_user(db_session, email="real.user@example.com")
        qa_user = _make_user(db_session, email="qa.tester@example.com")
        qa_user.is_qa_account = True
        db_session.commit()
        monkeypatch.setattr(
            "cli.qa_accounts.get_session_factory", lambda: (lambda: db_session)
        )

        exit_code = cmd_list(_Args())

        assert exit_code == 0
        out = capsys.readouterr().out
        assert "qa.tester@example.com" in out
        assert "real.user@example.com" not in out

    def test_list_when_none_marked(self, db_session: Session, monkeypatch, capsys) -> None:
        _make_user(db_session, email="real.user@example.com")
        monkeypatch.setattr(
            "cli.qa_accounts.get_session_factory", lambda: (lambda: db_session)
        )

        exit_code = cmd_list(_Args())

        assert exit_code == 0
        assert "No accounts" in capsys.readouterr().out
