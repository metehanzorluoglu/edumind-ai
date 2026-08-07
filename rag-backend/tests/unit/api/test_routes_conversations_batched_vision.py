"""Covers app/api/routes_conversations.py::_stream_vision_reply's
`batched_pdf` branch — the SSE-level counterpart to
test_routes_conversations_vision_progress_events.py (the plain single-call
vision path). Confirms the batched pipeline's ChatProgressEvent.detail
lines arrive before any ChatTokenEvent, that the final token stream is the
reduce step's own output (not the individual batch summaries), and that
the persisted answer/status match.

Same "drive _stream_vision_reply directly against a real (temp SQLite)
database and a real ConversationsRepository" approach as that sibling
module — see its docstring for why a fake repository can't stand in once
persistence happens on the background worker's own session.
"""

import json
import os
import tempfile
import uuid
from collections.abc import AsyncIterator
from datetime import UTC, datetime

import pymupdf
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.api.routes_conversations import (
    BatchedPdfRequest,
    ParsedMessageRequest,
    _stream_vision_reply,
)
from app.config import Settings
from app.core.model_routing import ModelRoute
from app.core.request_timing import RequestTimer
from app.core.retrieval_schemas import RetrievedChunk
from app.db.base import Base
from app.db.conversation_scope_repository import ConversationScopeRecord
from app.db.conversations_repository import ConversationsRepository
from app.db.models_auth import User
from app.services.attachment_storage import AttachmentStorage
from app.services.pdf_batch_planner import plan_pdf_batches

_JWT_SECRET = "a" * 32


def _text_pdf(page_count: int) -> bytes:
    doc = pymupdf.open()
    for i in range(page_count):
        page = doc.new_page(width=400, height=600)
        page.insert_text((50, 72), f"Page {i + 1}. " + ("Real body text. " * 10), fontsize=11)
    data = doc.tobytes()
    doc.close()
    return data


class _FakeRetriever:
    def retrieve(self, query, *, user_id, top_k=8, filters=None, conversation_id=None, project_id=None):
        return []


class _FakeVisionService:
    """Never actually invoked by these tests (every batch below is
    text-mode) — present only because _stream_vision_reply requires one."""

    async def stream_chat(self, *, prompt, images, system_prompt=None, timer=None) -> AsyncIterator[str]:
        raise AssertionError("vision model should never be called for an all-text-mode plan")
        yield  # pragma: no cover - unreachable, makes this a generator


class _FakeTextProvider:
    def __init__(self, outcomes: list[list[str]]) -> None:
        self._outcomes = list(outcomes)
        self.calls: list[dict[str, object]] = []

    def stream_chat(self, *, system_prompt, user_prompt, timer=None):
        self.calls.append({"system_prompt": system_prompt, "user_prompt": user_prompt})
        return iter(self._outcomes.pop(0))


def _make_scope_settings(conversation_id: uuid.UUID) -> ConversationScopeRecord:
    return ConversationScopeRecord(
        conversation_id=conversation_id,
        chat_enabled=True,
        project_enabled=True,
        general_enabled=True,
        include_other_project_summaries=False,
        updated_at=datetime.now(UTC),
    )


async def _drain_events(response) -> list[dict]:
    chunks = []
    async for chunk in response.body_iterator:
        chunks.append(chunk if isinstance(chunk, str) else chunk.decode("utf-8"))
    raw = "".join(chunks)
    events = []
    for block in raw.split("\n\n"):
        block = block.strip()
        if not block:
            continue
        assert block.startswith("data: "), f"unexpected non-SSE-data line: {block!r}"
        events.append(json.loads(block[len("data: ") :]))
    return events


def _make_repository():
    fd, db_path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    engine = create_engine(f"sqlite:///{db_path}", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    attachment_storage = AttachmentStorage(tempfile.mkdtemp())
    repository = ConversationsRepository(factory(), attachment_storage)
    return repository, factory, attachment_storage


async def _call_batched(*, batch_summaries: list[list[str]], reduce_answer: list[str]):
    repository, factory, attachment_storage = _make_repository()
    user = User(id=uuid.uuid4(), email="test@example.com")
    repository._db.add(user)
    repository._db.commit()
    conversation = repository.create(user_id=user.id)
    conversation_id = conversation.id
    user_message = repository.add_user_message(conversation_id, "Summarize this document")
    assistant_message = repository.create_pending_assistant_message(
        conversation_id, parent_message_id=user_message.id
    )

    pdf_data = _text_pdf(6)
    plan = plan_pdf_batches(pdf_data, batch_size=3, max_pages=100)
    assert plan.needs_batching is True
    assert len(plan.batches) == 2

    parsed = ParsedMessageRequest(
        query="Summarize this document", top_k=8, filters=None, client_message_id=None
    )
    vision_service = _FakeVisionService()
    text_provider = _FakeTextProvider(outcomes=[*batch_summaries, reduce_answer])
    scope_settings = _make_scope_settings(conversation_id)
    timer = RequestTimer(enabled=True, label="test")
    route = ModelRoute(model="qwen2.5vl:7b", use_retrieval=False, is_vision=True)

    response = _stream_vision_reply(
        conversation_id,
        parsed,
        route,
        [],
        user,
        repository,
        vision_service,
        _FakeRetriever(),
        Settings(jwt_secret=_JWT_SECRET),
        [],
        None,
        scope_settings,
        [],
        [],
        timer,
        assistant_message=assistant_message,
        attach_only=False,
        attachment_storage=attachment_storage,
        session_factory=lambda: factory(),
        batched_pdf=BatchedPdfRequest(pdf_data=pdf_data, plan=plan),
        llm_provider=text_provider,
    )
    events = await _drain_events(response)
    return events, repository, text_provider, assistant_message.id


async def test_progress_details_precede_the_final_answers_tokens() -> None:
    events, _, _, _ = await _call_batched(
        batch_summaries=[["batch one summary"], ["batch two summary"]],
        reduce_answer=["The document ", "discusses X."],
    )

    first_token_index = next(i for i, e in enumerate(events) if e["type"] == "token")
    progress_before = [
        e for i, e in enumerate(events) if e["type"] == "progress" and i < first_token_index
    ]
    # connected/processing_context/loading_model/generating (no
    # "retrieving": use_retrieval=False here) are always sent synchronously
    # by event_stream() itself, independent of the batched worker's own
    # pace — these four are never affected by the race below.
    assert len(progress_before) >= 4
    details = [e.get("detail") for e in progress_before if e.get("detail")]
    # At least one real progress `detail` line survives — poll_batched_vision
    # (interval_seconds=0.08) can coalesce several fast worker updates into
    # fewer observed ones when the fake models resolve near-instantly (the
    # same "purely advisory, next poll just sees the latest" behavior
    # ChatProgressEvent.detail's docstring documents; a real Ollama call is
    # never this fast), so this deliberately doesn't assert on every
    # specific line surviving — only that the channel carries real ones.
    assert len(details) >= 1
    assert all(isinstance(d, str) and d for d in details)

    # No progress after the first token, same invariant as the plain
    # single-call vision path.
    assert all(e["type"] != "progress" for e in events[first_token_index:])


async def test_the_streamed_answer_is_the_reduce_steps_output_only() -> None:
    events, repository, text_provider, message_id = await _call_batched(
        batch_summaries=[["batch one summary — never shown to the user"], ["batch two summary"]],
        reduce_answer=["The document ", "discusses X."],
    )

    tokens = "".join(e["content"] for e in events if e["type"] == "token")
    assert tokens == "The document discusses X."
    assert "batch one summary" not in tokens
    assert "batch two summary" not in tokens

    persisted = repository.get_message(message_id)
    assert persisted.content == "The document discusses X."
    assert persisted.status == "complete"

    # Exactly 3 text-provider calls: 2 batches + 1 reduce.
    assert len(text_provider.calls) == 3


async def test_stream_ends_with_exactly_one_done_event() -> None:
    events, _, _, _ = await _call_batched(
        batch_summaries=[["a"], ["b"]], reduce_answer=["done"]
    )
    done_events = [e for e in events if e["type"] == "done"]
    assert len(done_events) == 1
    assert events[-1]["type"] == "done"
