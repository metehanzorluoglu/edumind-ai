"""Covers app/core/generation_manager.py — the detached-background-worker
persistence redesign for QA finding BUG-1 (a dropped browser connection,
e.g. net::ERR_QUIC_PROTOCOL_ERROR on a long-lived stream, must never
discard an answer the backend actually finished computing).

Exercises the real worker (a real thread, a real temp-SQLite-backed
ConversationsRepository) rather than mocking threading — the whole point
under test is that persistence survives independently of anything about
the calling context, which a mocked thread would not actually prove.
"""

import os
import tempfile
import threading
import time
import uuid

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core import generation_manager
from app.core.errors import LLMProviderError
from app.core.request_timing import DISABLED_TIMER
from app.db.base import Base
from app.db.conversations_repository import ConversationsRepository
from app.db.models_auth import User
from app.db.models_documents import Document  # noqa: F401 - registers `documents` for the FK below
from app.services.attachment_storage import AttachmentStorage


@pytest.fixture
def repo_and_factory():
    fd, db_path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    engine = create_engine(f"sqlite:///{db_path}", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    attachment_storage = AttachmentStorage(tempfile.mkdtemp())
    db = factory()
    repository = ConversationsRepository(db, attachment_storage)
    user = User(id=uuid.uuid4(), email="test@example.com")
    db.add(user)
    db.commit()
    conversation = repository.create(user_id=user.id)
    user_message = repository.add_user_message(conversation.id, "hello")
    yield repository, factory, attachment_storage, user_message, user
    engine.dispose()
    os.remove(db_path)


def _wait_until_done(message_id: uuid.UUID, timeout: float = 5.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        state = generation_manager.get(message_id)
        if state is None or state.snapshot()[1] != "generating":
            return
        time.sleep(0.02)
    raise TimeoutError(f"generation for {message_id} did not finish within {timeout}s")


def test_successful_generation_persists_content_and_completes(repo_and_factory) -> None:
    repository, factory, attachment_storage, user_message, user = repo_and_factory
    assistant_message = repository.create_pending_assistant_message(
        user_message.conversation_id, parent_message_id=user_message.id
    )

    generation_manager.run_text_generation(
        assistant_message_id=assistant_message.id,
        stream_answer=lambda: iter(["Hello", ", ", "world."]),
        insufficient_evidence=False,
        no_evidence_answer="unused",
        retrieved_sources=[],
        citations=[],
        transparency={},
        attachment_storage=attachment_storage,
        timer=DISABLED_TIMER,
        session_factory=factory,
    )

    persisted = repository.get_message(assistant_message.id)
    assert persisted.content == "Hello, world."
    assert persisted.status == "complete"


def test_llm_error_persists_partial_content_with_error_status(repo_and_factory) -> None:
    repository, factory, attachment_storage, user_message, user = repo_and_factory
    assistant_message = repository.create_pending_assistant_message(
        user_message.conversation_id, parent_message_id=user_message.id
    )

    def _failing_stream():
        yield "Partial"
        raise LLMProviderError("The model is unavailable.")

    generation_manager.run_text_generation(
        assistant_message_id=assistant_message.id,
        stream_answer=_failing_stream,
        insufficient_evidence=False,
        no_evidence_answer="unused",
        retrieved_sources=[],
        citations=[],
        transparency={},
        attachment_storage=attachment_storage,
        timer=DISABLED_TIMER,
        session_factory=factory,
    )

    persisted = repository.get_message(assistant_message.id)
    assert persisted.status == "error"
    assert persisted.content == "Partial"
    assert persisted.error_message == "The model is unavailable."


def test_explicit_cancellation_stops_the_worker_and_preserves_partial_content(
    repo_and_factory,
) -> None:
    """Distinguishes explicit cancellation from a mere dropped connection
    (QA finding BUG-1's own requirement): request_cancel() must actually
    stop the worker, unlike a client just disappearing, which does
    nothing to it by design."""
    repository, factory, attachment_storage, user_message, user = repo_and_factory
    assistant_message = repository.create_pending_assistant_message(
        user_message.conversation_id, parent_message_id=user_message.id
    )
    release = threading.Event()

    def _slow_stream():
        yield "First"
        # Give the test time to call request_cancel() before the next
        # token would be produced.
        release.wait(timeout=5.0)
        yield "Second (should never be reached)"

    thread = threading.Thread(
        target=generation_manager.run_text_generation,
        kwargs={
            "assistant_message_id": assistant_message.id,
            "stream_answer": _slow_stream,
            "insufficient_evidence": False,
            "no_evidence_answer": "unused",
            "retrieved_sources": [],
            "citations": [],
            "transparency": {},
            "attachment_storage": attachment_storage,
            "timer": DISABLED_TIMER,
            "session_factory": factory,
        },
        daemon=True,
    )
    thread.start()

    # Wait for the worker to register itself and yield the first token.
    deadline = time.monotonic() + 5.0
    while time.monotonic() < deadline:
        state = generation_manager.get(assistant_message.id)
        if state is not None and state.snapshot()[0] == "First":
            break
        time.sleep(0.02)
    else:
        pytest.fail("worker never reached the first token")

    assert generation_manager.request_cancel(assistant_message.id) is True
    release.set()
    thread.join(timeout=5.0)

    persisted = repository.get_message(assistant_message.id)
    assert persisted.status == "cancelled"
    assert persisted.content == "First"


def test_retry_after_error_reuses_the_same_row_never_creates_a_second_assistant_message(
    repo_and_factory,
) -> None:
    """The "no duplicate messages" requirement: a retry re-arms the same
    assistant row (see ConversationsRepository.reset_assistant_message_for_retry)
    rather than inserting a second one for the same question."""
    repository, factory, attachment_storage, user_message, user = repo_and_factory
    assistant_message = repository.create_pending_assistant_message(
        user_message.conversation_id, parent_message_id=user_message.id
    )

    def _failing_stream():
        raise LLMProviderError("temporary failure")
        yield  # pragma: no cover - unreachable, makes this a generator

    generation_manager.run_text_generation(
        assistant_message_id=assistant_message.id,
        stream_answer=_failing_stream,
        insufficient_evidence=False,
        no_evidence_answer="unused",
        retrieved_sources=[],
        citations=[],
        transparency={},
        attachment_storage=attachment_storage,
        timer=DISABLED_TIMER,
        session_factory=factory,
    )
    assert repository.get_message(assistant_message.id).status == "error"

    # Simulate a retry: the same lookup _handle_conversation_message uses.
    existing = repository.get_assistant_reply_for_user_message(user_message.id)
    assert existing is not None
    assert existing.id == assistant_message.id  # same row, not a new one

    retried = repository.reset_assistant_message_for_retry(existing.id)
    assert retried.id == assistant_message.id

    generation_manager.run_text_generation(
        assistant_message_id=retried.id,
        stream_answer=lambda: iter(["Success this time."]),
        insufficient_evidence=False,
        no_evidence_answer="unused",
        retrieved_sources=[],
        citations=[],
        transparency={},
        attachment_storage=attachment_storage,
        timer=DISABLED_TIMER,
        session_factory=factory,
    )

    persisted = repository.get_message(assistant_message.id)
    assert persisted.status == "complete"
    assert persisted.content == "Success this time."

    # Still exactly one assistant reply for this user message — the retry
    # updated the existing row in place rather than inserting a second one.
    conversation_messages = repository.get_messages(user.id, user_message.conversation_id) or []
    assistant_replies = [m for m in conversation_messages if m.role == "assistant"]
    assert len(assistant_replies) == 1
    assert assistant_replies[0].id == assistant_message.id


def test_retry_after_complete_finds_the_same_completed_row(repo_and_factory) -> None:
    """A retry that lands after the answer already completed (the
    reconnect/replay case) must find the existing 'complete' row rather
    than triggering a second generation — see
    _handle_conversation_message's mode == "replay" branch."""
    repository, factory, attachment_storage, user_message, user = repo_and_factory
    assistant_message = repository.create_pending_assistant_message(
        user_message.conversation_id, parent_message_id=user_message.id
    )
    generation_manager.run_text_generation(
        assistant_message_id=assistant_message.id,
        stream_answer=lambda: iter(["Already done."]),
        insufficient_evidence=False,
        no_evidence_answer="unused",
        retrieved_sources=[],
        citations=[],
        transparency={},
        attachment_storage=attachment_storage,
        timer=DISABLED_TIMER,
        session_factory=factory,
    )

    existing = repository.get_assistant_reply_for_user_message(user_message.id)
    assert existing is not None
    assert existing.status == "complete"
    persisted = repository.get_message(existing.id)
    assert persisted.content == "Already done."
