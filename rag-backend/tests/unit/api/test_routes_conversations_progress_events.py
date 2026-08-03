"""Covers app/api/routes_conversations.py::_stream_text_reply's SSE
progress events (ChatProgressEvent, see app/schemas/chat.py) — added to
replace an indefinite "Connecting..." UI state with real, ordered status
updates on a slow (CPU-only Ollama) backend: a cold model load alone was
measured at ~44s, and prompt evaluation past 2,560 tokens at 155s+, with
nothing sent to the client in the meantime before this existed.

Drives _stream_text_reply directly with a real (temp SQLite) database and
a real ConversationsRepository, and consumes the real StreamingResponse it
returns (not a hand-simulated event list) — so this exercises the actual
code path the frontend receives bytes from, *and* the actual background
worker (see app/core/generation_manager.py) that now does the real
persistence, run on its own thread exactly as it is in production. Only
the retriever and LLM provider are fakes; everything database-shaped is
real, since the stream-disconnect-recovery redesign (QA finding BUG-1)
means the streaming generator and the actual persistence are no longer
the same code path — a fake repository can no longer stand in for the one
the background thread's own independent session actually writes through.
"""

import asyncio
import json
import os
import tempfile
import uuid
from datetime import UTC, datetime

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.api.routes_conversations import ParsedMessageRequest, _stream_text_reply
from app.config import Settings
from app.core.rag_service import RagService
from app.core.request_timing import RequestTimer
from app.core.retrieval_schemas import RetrievedChunk
from app.db.base import Base
from app.db.conversation_scope_repository import ConversationScopeRecord
from app.db.conversations_repository import ConversationsRepository
from app.db.models_auth import User
from app.services.attachment_storage import AttachmentStorage

EXPECTED_PRE_TOKEN_STAGES = [
    "connected",
    "retrieving",
    "processing_context",
    "loading_model",
    "generating",
]


class _FakeRetriever:
    """Satisfies the RetrieverLike/ScopedRetrieverLike Protocol — returns
    the same canned chunks regardless of scope tier, so real retrieval
    (embedding, Qdrant, MMR) never runs in these tests; only
    _stream_text_reply's own event/metric emission is under test."""

    def __init__(self, chunks: list[RetrievedChunk]) -> None:
        self._chunks = chunks

    def retrieve(
        self, query, *, user_id, top_k=8, filters=None, conversation_id=None, project_id=None
    ):
        return list(self._chunks)


class _FakeLLMProvider:
    def __init__(self, tokens: list[str]) -> None:
        self._tokens = tokens

    def stream_chat(self, *, system_prompt, user_prompt, timer=None, options_override=None):
        yield from self._tokens


def _make_chunk(text: str = "Some retrieved evidence.") -> RetrievedChunk:
    return RetrievedChunk(
        score=0.9,
        text=text,
        document_id="doc-1",
        chunk_id="chunk-1",
        document_type="report",
        source_filename="doc.pdf",
        chunk_index=0,
        page_number=1,
    )


def _make_scope_settings(conversation_id: uuid.UUID) -> ConversationScopeRecord:
    return ConversationScopeRecord(
        conversation_id=conversation_id,
        chat_enabled=True,
        project_enabled=True,
        general_enabled=True,
        include_other_project_summaries=False,
        updated_at=datetime.now(UTC),
    )


def _drain_events(response) -> list[dict]:
    """Runs the real StreamingResponse body to completion (Starlette wraps
    a sync generator in an async iterator via iterate_in_threadpool — see
    StreamingResponse.__init__) and parses every SSE `data:` line back
    into its JSON payload, in emission order. The background worker (see
    generation_manager.poll_until_done) is polled with a short sleep
    inside the generator itself, so simply draining the body already
    waits for it to finish — no separate synchronization needed."""

    async def _collect() -> list[str]:
        chunks = []
        async for chunk in response.body_iterator:
            chunks.append(chunk if isinstance(chunk, str) else chunk.decode("utf-8"))
        return chunks

    raw = "".join(asyncio.run(_collect()))
    events = []
    for block in raw.split("\n\n"):
        block = block.strip()
        if not block:
            continue
        assert block.startswith("data: "), f"unexpected non-SSE-data line: {block!r}"
        events.append(json.loads(block[len("data: ") :]))
    return events


def _call_stream_text_reply(
    *, tokens: list[str], chunks: list[RetrievedChunk], enabled_timer: bool = False
) -> tuple[list[dict], ConversationsRepository]:
    fd, db_path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    engine = create_engine(f"sqlite:///{db_path}", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)

    def session_factory():
        return factory()

    tmp_attachments = tempfile.mkdtemp()
    attachment_storage = AttachmentStorage(tmp_attachments)

    db = factory()
    repository = ConversationsRepository(db, attachment_storage)
    user = User(id=uuid.uuid4(), email="test@example.com")
    db.add(user)
    db.commit()
    conversation = repository.create(user_id=user.id)
    conversation_id = conversation.id
    user_message = repository.add_user_message(conversation_id, "What does the document say?")
    assistant_message = repository.create_pending_assistant_message(
        conversation_id, parent_message_id=user_message.id
    )

    parsed = ParsedMessageRequest(
        query="What does the document say?", top_k=8, filters=None, client_message_id=None
    )
    rag_service = RagService(
        retriever=_FakeRetriever(chunks),
        llm_provider=_FakeLLMProvider(tokens),
        model_name="qwen3:8b",
    )
    scope_settings = _make_scope_settings(conversation_id)
    timer = RequestTimer(enabled=enabled_timer, label="test")

    response = _stream_text_reply(
        conversation_id,
        parsed,
        user,
        repository,
        rag_service,
        [],
        None,
        scope_settings,
        [],
        [],
        timer,
        settings=Settings(jwt_secret="test-only-secret-not-a-real-credential-32chars"),
        assistant_message=assistant_message,
        attach_only=False,
        attachment_storage=attachment_storage,
        session_factory=session_factory,
    )
    return _drain_events(response), repository


def test_progress_events_precede_first_token_in_exact_order() -> None:
    events, _ = _call_stream_text_reply(tokens=["Hello", " world"], chunks=[_make_chunk()])

    progress_stages = [e["stage"] for e in events if e["type"] == "progress"]
    assert progress_stages == EXPECTED_PRE_TOKEN_STAGES

    first_token_index = next(i for i, e in enumerate(events) if e["type"] == "token")
    last_progress_index = max(i for i, e in enumerate(events) if e["type"] == "progress")
    assert last_progress_index < first_token_index, (
        "every progress event must arrive before the first token event"
    )


def test_no_progress_events_are_sent_once_tokens_start() -> None:
    events, _ = _call_stream_text_reply(tokens=["A", "B", "C"], chunks=[_make_chunk()])
    first_token_index = next(i for i, e in enumerate(events) if e["type"] == "token")
    assert all(e["type"] != "progress" for e in events[first_token_index:])


def test_progress_events_still_precede_the_insufficient_evidence_response() -> None:
    """Empty retrieval -> insufficient_evidence=True, an early-return
    branch with no LLM call — connected/retrieving/processing_context
    still apply (retrieval genuinely happened and found nothing);
    loading_model/generating must NOT appear, since no model is ever
    called on this path."""
    events, _ = _call_stream_text_reply(tokens=[], chunks=[])

    progress_stages = [e["stage"] for e in events if e["type"] == "progress"]
    assert progress_stages == ["connected", "retrieving", "processing_context"]
    assert events[-1]["type"] == "done"
    assert events[-1]["insufficient_evidence"] is True


def test_stream_ends_with_exactly_one_done_event() -> None:
    events, _ = _call_stream_text_reply(tokens=["hi"], chunks=[_make_chunk()])
    done_events = [e for e in events if e["type"] == "done"]
    assert len(done_events) == 1
    assert events[-1]["type"] == "done"


def test_progress_events_are_still_sent_when_profiling_is_disabled() -> None:
    """Progress events are a UI concern, independent of
    PERFORMANCE_PROFILING — must not silently disappear when profiling is
    off (the default production state)."""
    events, _ = _call_stream_text_reply(
        tokens=["hi"], chunks=[_make_chunk()], enabled_timer=False
    )
    progress_stages = [e["stage"] for e in events if e["type"] == "progress"]
    assert progress_stages == EXPECTED_PRE_TOKEN_STAGES

    done = next(e for e in events if e["type"] == "done")
    assert done["debug_timings"] is None


def test_profiling_metrics_recorded_when_enabled() -> None:
    events, _ = _call_stream_text_reply(
        tokens=["hi"], chunks=[_make_chunk(text="x" * 100)], enabled_timer=True
    )
    done = next(e for e in events if e["type"] == "done")
    timings = done["debug_timings"]
    assert timings is not None
    assert timings["retrieved_chunk_count"] == 1
    assert timings["context_characters"] == 100
    assert "estimated_prompt_tokens" in timings
    assert timings["estimated_prompt_tokens"] > 0
