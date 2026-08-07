"""Covers app/core/generation_manager.py's batched-vision worker
(run_batched_vision_generation / poll_batched_vision) — the counterpart to
test_generation_manager.py's plain-text/vision coverage, added for the
"remove the artificial PDF page limit" batched-PDF pipeline. Exercises a
real worker thread and a real temp-SQLite-backed ConversationsRepository,
same convention as test_generation_manager.py, since the point under test
(progress/content persistence across a real thread boundary) would not be
proven by mocking threading.
"""

import asyncio
import os
import tempfile
import threading
import time
import uuid

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core import generation_manager
from app.core.errors import VisionErrorCategory, VisionServiceError
from app.core.generation_events import GenProgress, GenToken
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


async def _updates(items):
    for item in items:
        yield item


def test_progress_updates_never_appear_in_the_persisted_content(repo_and_factory) -> None:
    repository, factory, attachment_storage, user_message, user = repo_and_factory
    assistant_message = repository.create_pending_assistant_message(
        user_message.conversation_id, parent_message_id=user_message.id
    )

    generation_manager.run_batched_vision_generation(
        assistant_message_id=assistant_message.id,
        stream_updates=lambda: _updates(
            [
                GenProgress(detail="Analyzing pages 1-4 of 8 (1/2)…"),
                GenProgress(detail="✓ pages 1-4 processed (1/2)"),
                GenProgress(detail="Combining findings…"),
                GenToken(text="Final "),
                GenToken(text="answer."),
            ]
        ),
        retrieved_sources=[],
        citations=[],
        transparency={},
        attachment_storage=attachment_storage,
        timer=DISABLED_TIMER,
        session_factory=factory,
    )

    persisted = repository.get_message(assistant_message.id)
    assert persisted.content == "Final answer."
    assert persisted.status == "complete"


def test_a_vision_service_error_persists_partial_content_with_error_status(
    repo_and_factory,
) -> None:
    repository, factory, attachment_storage, user_message, user = repo_and_factory
    assistant_message = repository.create_pending_assistant_message(
        user_message.conversation_id, parent_message_id=user_message.id
    )

    async def _failing_updates():
        yield GenProgress(detail="Analyzing pages 1-4 of 8 (1/2)…")
        yield GenToken(text="Partial")
        raise VisionServiceError(
            "The model failed on every part.", category=VisionErrorCategory.OTHER
        )

    generation_manager.run_batched_vision_generation(
        assistant_message_id=assistant_message.id,
        stream_updates=_failing_updates,
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
    assert persisted.error_message == "The model failed on every part."


def test_poll_batched_vision_yields_progress_then_tokens_in_order(repo_and_factory) -> None:
    """A live GenerationState's progress_seq lets a poller notice each new
    progress line exactly once, interleaved correctly with token deltas —
    the SSE layer (routes_conversations.py) depends on this ordering to
    map straight onto ChatProgressEvent/ChatTokenEvent.

    Manually steps the poll generator one item at a time, mutating state
    *between* steps — polling only ever observes whatever the state looks
    like at the moment it's checked, so writing all the state mutations
    up front (before polling at all) would only ever be "caught up to"
    the final state, not each intermediate one; interleaving here is what
    actually exercises poll_batched_vision's per-iteration read."""
    repository, factory, attachment_storage, user_message, user = repo_and_factory
    assistant_message = repository.create_pending_assistant_message(
        user_message.conversation_id, parent_message_id=user_message.id
    )
    state = generation_manager.register(assistant_message.id)
    poller = generation_manager.poll_batched_vision(assistant_message.id, interval_seconds=0)

    with state.lock:
        state.progress = "Analyzing pages 1-4 of 8 (1/2)…"
        state.progress_seq = 1
    first = next(poller)
    assert isinstance(first, GenProgress)
    assert first.detail == "Analyzing pages 1-4 of 8 (1/2)…"

    with state.lock:
        state.content = "Hello"
    second = next(poller)
    assert isinstance(second, GenToken)
    assert second.text == "Hello"

    with state.lock:
        state.progress = "Combining findings…"
        state.progress_seq = 2
    third = next(poller)
    assert isinstance(third, GenProgress)
    assert third.detail == "Combining findings…"

    with state.lock:
        state.content = "Hello world"
        state.status = "complete"
    remaining = list(poller)  # drains the final token delta, then stops (status left 'generating')
    assert len(remaining) == 1
    assert isinstance(remaining[0], GenToken)
    assert remaining[0].text == " world"


def test_poll_batched_vision_yields_nothing_once_no_live_state_exists(repo_and_factory) -> None:
    _repository, _factory, _attachment_storage, _user_message, _user = repo_and_factory
    missing_id = uuid.uuid4()
    assert list(generation_manager.poll_batched_vision(missing_id, interval_seconds=0)) == []


def test_explicit_cancellation_stops_the_batched_worker(repo_and_factory) -> None:
    repository, factory, attachment_storage, user_message, user = repo_and_factory
    assistant_message = repository.create_pending_assistant_message(
        user_message.conversation_id, parent_message_id=user_message.id
    )
    release = threading.Event()

    async def _slow_updates():
        yield GenProgress(detail="Analyzing pages 1-4 of 8 (1/2)…")
        yield GenToken(text="First")
        # Give the test time to call request_cancel() before the next
        # update would be produced.
        deadline = time.monotonic() + 5.0
        while not release.is_set() and time.monotonic() < deadline:
            await asyncio.sleep(0.01)
        yield GenToken(text="Second (should never be reached)")

    thread = threading.Thread(
        target=generation_manager.run_batched_vision_generation,
        kwargs={
            "assistant_message_id": assistant_message.id,
            "stream_updates": _slow_updates,
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
