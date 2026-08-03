"""Covers app/api/routes_conversations.py::_stream_vision_reply's SSE
progress events, profiling metrics, and error classification — the
vision-path counterpart to test_routes_conversations_progress_events.py
(the text path), added by the same investigation that found the vision
path emitted *no* progress events at all before this and had *no*
profiling instrumentation (see app/config.py's vision_request_timeout_seconds
docstring for the measured root cause this task fixed).

Drives _stream_vision_reply directly against a real (temp SQLite)
database and a real ConversationsRepository — see
test_routes_conversations_progress_events.py's module docstring for why a
fake repository can no longer stand in for persistence now that the
actual write happens on the background worker's own, independent session
(app/core/generation_manager.py) rather than inline in this generator.
"""

import json
import os
import tempfile
import uuid
from collections.abc import AsyncIterator
from datetime import UTC, datetime

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.api.routes_conversations import ParsedMessageRequest, _stream_vision_reply
from app.config import Settings
from app.core.errors import VisionErrorCategory, VisionServiceError
from app.core.model_routing import ModelRoute
from app.core.request_timing import RequestTimer
from app.core.retrieval_schemas import RetrievedChunk
from app.db.base import Base
from app.db.conversation_scope_repository import ConversationScopeRecord
from app.db.conversations_repository import ConversationsRepository
from app.db.models_auth import User
from app.services.attachment_storage import AttachmentStorage

_JWT_SECRET = "a" * 32

EXPECTED_PRE_TOKEN_STAGES = ["connected", "processing_context", "loading_model", "generating"]
EXPECTED_PRE_TOKEN_STAGES_WITH_RETRIEVAL = [
    "connected",
    "retrieving",
    "processing_context",
    "loading_model",
    "generating",
]


class _FakeRetriever:
    def __init__(self, chunks: list[RetrievedChunk] | None = None) -> None:
        self._chunks = chunks or []

    def retrieve(
        self, query, *, user_id, top_k=8, filters=None, conversation_id=None, project_id=None
    ):
        return list(self._chunks)


class _FakeVisionService:
    def __init__(
        self, tokens: list[str] | None = None, error: VisionServiceError | None = None
    ) -> None:
        self._tokens = tokens or []
        self._error = error
        self.calls: list[dict[str, object]] = []

    async def stream_chat(
        self, *, prompt, images, system_prompt=None, timer=None
    ) -> AsyncIterator[str]:
        self.calls.append(
            {"prompt": prompt, "images": images, "system_prompt": system_prompt, "timer": timer}
        )
        if self._error is not None:
            raise self._error
        for token in self._tokens:
            yield token


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


def _make_repository() -> tuple[ConversationsRepository, "sessionmaker"]:
    fd, db_path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    engine = create_engine(f"sqlite:///{db_path}", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    attachment_storage = AttachmentStorage(tempfile.mkdtemp())
    repository = ConversationsRepository(factory(), attachment_storage)
    return repository, factory, attachment_storage


async def _call_stream_vision_reply(
    *,
    tokens: list[str] | None = None,
    error: VisionServiceError | None = None,
    use_retrieval: bool = False,
    enabled_timer: bool = True,
    settings: Settings | None = None,
) -> tuple[list[dict], ConversationsRepository, _FakeVisionService, uuid.UUID]:
    repository, factory, attachment_storage = _make_repository()
    user = User(id=uuid.uuid4(), email="test@example.com")
    repository._db.add(user)
    repository._db.commit()
    conversation = repository.create(user_id=user.id)
    conversation_id = conversation.id
    user_message = repository.add_user_message(conversation_id, "What is in this image?")
    assistant_message = repository.create_pending_assistant_message(
        conversation_id, parent_message_id=user_message.id
    )

    parsed = ParsedMessageRequest(
        query="What is in this image?", top_k=8, filters=None, client_message_id=None
    )
    vision_service = _FakeVisionService(tokens=tokens, error=error)
    scope_settings = _make_scope_settings(conversation_id)
    timer = RequestTimer(enabled=enabled_timer, label="test")
    route = ModelRoute(model="qwen2.5vl:7b", use_retrieval=use_retrieval, is_vision=True)

    response = _stream_vision_reply(
        conversation_id,
        parsed,
        route,
        [b"fake-image-bytes"],
        user,
        repository,
        vision_service,
        _FakeRetriever(),
        settings or Settings(jwt_secret=_JWT_SECRET),
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
    )
    events = await _drain_events(response)
    return events, repository, vision_service, assistant_message.id


async def test_progress_events_precede_first_token_in_exact_order() -> None:
    events, _, _, _ = await _call_stream_vision_reply(tokens=["Hello", " world"])

    progress_stages = [e["stage"] for e in events if e["type"] == "progress"]
    assert progress_stages == EXPECTED_PRE_TOKEN_STAGES

    first_token_index = next(i for i, e in enumerate(events) if e["type"] == "token")
    last_progress_index = max(i for i, e in enumerate(events) if e["type"] == "progress")
    assert last_progress_index < first_token_index


async def test_retrieving_stage_only_appears_when_use_retrieval_is_true() -> None:
    events, _, _, _ = await _call_stream_vision_reply(tokens=["ok"], use_retrieval=True)
    progress_stages = [e["stage"] for e in events if e["type"] == "progress"]
    assert progress_stages == EXPECTED_PRE_TOKEN_STAGES_WITH_RETRIEVAL


async def test_no_progress_events_are_sent_once_tokens_start() -> None:
    events, _, _, _ = await _call_stream_vision_reply(tokens=["A", "B", "C"])
    first_token_index = next(i for i, e in enumerate(events) if e["type"] == "token")
    assert all(e["type"] != "progress" for e in events[first_token_index:])


async def test_stream_ends_with_exactly_one_done_event_and_persists_the_answer() -> None:
    events, repository, _, message_id = await _call_stream_vision_reply(tokens=["hi", " there"])
    done_events = [e for e in events if e["type"] == "done"]
    assert len(done_events) == 1
    assert events[-1]["type"] == "done"
    persisted = repository.get_message(message_id)
    assert persisted is not None
    assert persisted.content == "hi there"
    assert persisted.status == "complete"


async def test_profiling_metrics_are_recorded_when_enabled() -> None:
    events, _, _, _ = await _call_stream_vision_reply(tokens=["ok"], enabled_timer=True)
    done = next(e for e in events if e["type"] == "done")
    timings = done["debug_timings"]
    assert timings is not None
    assert "estimated_prompt_tokens" in timings
    assert "vision_total_ms" in timings


async def test_debug_timings_absent_when_profiling_disabled() -> None:
    events, _, _, _ = await _call_stream_vision_reply(tokens=["ok"], enabled_timer=False)
    done = next(e for e in events if e["type"] == "done")
    assert done["debug_timings"] is None
    # Progress events are a UI concern independent of profiling — still
    # sent even with PERFORMANCE_PROFILING off.
    progress_stages = [e["stage"] for e in events if e["type"] == "progress"]
    assert progress_stages == EXPECTED_PRE_TOKEN_STAGES


async def test_vision_service_error_becomes_a_categorized_error_event() -> None:
    error = VisionServiceError(
        "The model did not respond in time.",
        category=VisionErrorCategory.MODEL_LOAD_OR_PROMPT_EVAL_TIMEOUT,
    )
    events, repository, _, message_id = await _call_stream_vision_reply(error=error)

    error_events = [e for e in events if e["type"] == "error"]
    assert len(error_events) == 1
    assert error_events[0]["message"] == "The model did not respond in time."
    assert error_events[0]["error_category"] == "model_load_or_prompt_eval_timeout"
    # No "done" event.
    assert not any(e["type"] == "done" for e in events)
    # The row is persisted with status='error' (QA finding BUG-1's
    # recovery redesign: an attempt is always durable, even a failed one —
    # see generation_manager.py) rather than never having existed.
    persisted = repository.get_message(message_id)
    assert persisted is not None
    assert persisted.status == "error"


async def test_oversized_vision_prompt_is_rejected_before_calling_ollama() -> None:
    settings = Settings(jwt_secret=_JWT_SECRET, vision_max_prompt_chars=100)
    repository, factory, attachment_storage = _make_repository()
    user = User(id=uuid.uuid4(), email="test@example.com")
    repository._db.add(user)
    repository._db.commit()
    conversation = repository.create(user_id=user.id)
    conversation_id = conversation.id
    user_message = repository.add_user_message(conversation_id, "x" * 500)
    assistant_message = repository.create_pending_assistant_message(
        conversation_id, parent_message_id=user_message.id
    )
    parsed = ParsedMessageRequest(
        query="x" * 500,  # the vision-only system prompt alone already exceeds 100 chars
        top_k=8,
        filters=None,
        client_message_id=None,
    )
    vision_service = _FakeVisionService(tokens=["should never be reached"])
    scope_settings = _make_scope_settings(conversation_id)
    timer = RequestTimer(enabled=False, label="test")
    route = ModelRoute(model="qwen2.5vl:7b", use_retrieval=False, is_vision=True)

    with pytest.raises(HTTPException) as exc_info:
        _stream_vision_reply(
            conversation_id,
            parsed,
            route,
            [b"fake-image-bytes"],
            user,
            repository,
            vision_service,
            _FakeRetriever(),
            settings,
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
        )
    assert exc_info.value.status_code == 400
    assert "prompt" in exc_info.value.detail.lower()
    assert vision_service.calls == []
