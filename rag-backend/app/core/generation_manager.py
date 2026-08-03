"""Runs LLM generation for one assistant message in a real background OS
thread, detached from the HTTP/SSE request that triggered it (QA finding
BUG-1: a browser-side connection failure — observed as
`net::ERR_QUIC_PROTOCOL_ERROR` on a long-lived streaming connection through
Cloudflare — must never discard an answer the backend actually finished
computing).

Design, deliberately simple over deliberately clever:

- A worker function does the real work (consume the LLM's token stream,
  persist the final message to the database) inside `threading.Thread`,
  not `asyncio.create_task`/`BackgroundTasks` — a raw thread's lifetime is
  tied to nothing about the request/response cycle at all, so it survives
  the SSE generator being torn down (client disconnect), the request
  coroutine being garbage-collected, or Starlette's own disconnect
  handling, none of which can reach into or cancel a plain thread they
  don't hold a reference to.
- The worker writes to a `GenerationState` (in-memory, one per assistant
  message, in `_states` below) under a plain `threading.Lock` on every
  token, and persists the authoritative final row to the database — via
  its *own* SQLAlchemy session (`get_session_factory()()`), never the
  request-scoped one, since the request that spawned this worker may
  already be long gone by the time it finishes.
- Any SSE connection — the original one, or a later reconnect (refresh,
  reopen, a retry that finds a 'generating' row already in flight) —
  reads the same `GenerationState` by polling `content`/`status` under the
  lock. Polling (not a callback/queue) is deliberate: it makes "a new SSE
  connection attaches to an in-progress generation" and "a new SSE
  connection catches up to one that already finished" the exact same code
  path, and it needs no cross-thread async primitives at all.
- Explicit cancellation (`request_cancel`) sets a `threading.Event` the
  worker checks between tokens — a real stop, distinct from a client
  merely disappearing (which does nothing to the worker at all, by
  design: that's the whole point of this module).
- `_states` only ever holds entries for generations started by *this*
  process. A process restart loses every in-flight entry — any row still
  'generating' in the database at that point is orphaned, not
  live, and is swept to 'interrupted' once at startup (see
  ConversationsRepository.sweep_stale_generating_messages, called from
  app/main.py) rather than left to spin forever.
"""

from __future__ import annotations

import asyncio
import logging
import threading
import time
import uuid
from collections.abc import AsyncIterator, Callable, Iterator
from dataclasses import dataclass, field

from sqlalchemy.orm import Session

from app.core.citation import Citation
from app.core.citation_validation import validate_citations
from app.core.errors import LLMProviderError, VisionServiceError
from app.core.request_timing import RequestTimer
from app.core.retrieval_schemas import RetrievedChunk
from app.db.conversations_repository import ConversationsRepository
from app.services.attachment_storage import AttachmentStorage

logger = logging.getLogger("app.generation")

GenerationStatus = str  # "generating" | "complete" | "error" | "cancelled"


class GenerationCancelled(Exception):
    """Raised inside a worker thread when `request_cancel` was called for
    its message — caught only by that worker, never propagated further."""


@dataclass
class GenerationState:
    lock: threading.Lock = field(default_factory=threading.Lock)
    content: str = ""
    status: GenerationStatus = "generating"
    error_message: str | None = None
    # Vision-only (see run_vision_generation) — not persisted to the
    # database (no schema column for it), so only readable from this live,
    # in-memory state: available to the SSE connection that was live when
    # the error happened, not to a later reconnect/replay. Never consumed
    # by any frontend code today (checked before this tradeoff was made);
    # kept only so a same-connection error event stays as specific as it
    # was before this module existed.
    error_category: str | None = None
    sources: list[RetrievedChunk] = field(default_factory=list)
    citations: list[Citation] = field(default_factory=list)
    citation_warnings: list[str] = field(default_factory=list)
    insufficient_evidence: bool = False
    transparency: dict[str, object] = field(default_factory=dict)
    cancel_event: threading.Event = field(default_factory=threading.Event)

    def snapshot(self) -> tuple[str, GenerationStatus]:
        with self.lock:
            return self.content, self.status


_registry_lock = threading.Lock()
_states: dict[uuid.UUID, GenerationState] = {}


def register(message_id: uuid.UUID) -> GenerationState:
    state = GenerationState()
    with _registry_lock:
        _states[message_id] = state
    return state


def get(message_id: uuid.UUID) -> GenerationState | None:
    with _registry_lock:
        return _states.get(message_id)


def discard(message_id: uuid.UUID) -> None:
    with _registry_lock:
        _states.pop(message_id, None)


def request_cancel(message_id: uuid.UUID) -> bool:
    """Best-effort: True if a live worker was found and signalled, False if
    nothing is running for this message (already finished, or this process
    didn't start it — e.g. a multi-worker deployment; see the module's
    "Remaining risks" note in the final report)."""
    state = get(message_id)
    if state is None:
        return False
    state.cancel_event.set()
    return True


def run_text_generation(
    *,
    assistant_message_id: uuid.UUID,
    stream_answer: Callable[[], Iterator[str]],
    insufficient_evidence: bool,
    no_evidence_answer: str,
    retrieved_sources: list[RetrievedChunk],
    citations: list[Citation],
    transparency: dict[str, object],
    attachment_storage: AttachmentStorage,
    timer: RequestTimer,
    session_factory: Callable[[], Session],
) -> None:
    """Runs on its own thread (see module docstring). `stream_answer` is a
    zero-arg callable rather than an already-started iterator so the
    (blocking) Ollama HTTP call itself only begins once this thread is
    actually running, not on the request thread that constructed it.
    `session_factory` (see app/deps.py's SessionFactoryDep) is injected
    rather than imported/called directly so a test can point this worker
    at an isolated test database the same way it already can for every
    ordinary request-scoped repository."""
    # In every branch below, the database write happens *before* `state.status`
    # is flipped away from "generating" — a poller (see poll_until_done) treats
    # that flip as its signal to stop and read the row back, so writing the
    # row first is what guarantees that read always sees the final data
    # rather than racing the commit across the two independent sessions.
    state = register(assistant_message_id)
    session = session_factory()
    repository = ConversationsRepository(session, attachment_storage)
    try:
        if insufficient_evidence:
            with state.lock:
                state.content = no_evidence_answer
                state.sources = retrieved_sources
                state.insufficient_evidence = True
                state.transparency = transparency
            repository.update_assistant_message(
                assistant_message_id,
                content=no_evidence_answer,
                status="complete",
                citations=[],
                citation_warnings=[],
                insufficient_evidence=True,
                sources=retrieved_sources,
                transparency=transparency,
            )
            with state.lock:
                state.status = "complete"
            return

        answer_parts: list[str] = []
        flushed_len = 0
        try:
            for token in stream_answer():
                if state.cancel_event.is_set():
                    raise GenerationCancelled
                answer_parts.append(token)
                with state.lock:
                    state.content += token
                    current_len = len(state.content)
                # Periodic partial-content flush to the database — a
                # refresh/reopen *during* generation then shows real
                # in-progress text instead of a blank row until
                # completion, at the (deliberately small) cost of one
                # extra UPDATE roughly every 200 characters. Status stays
                # 'generating'; only the final flush below changes it.
                if current_len - flushed_len >= 200:
                    repository.update_assistant_message(
                        assistant_message_id, content="".join(answer_parts), status="generating"
                    )
                    flushed_len = current_len
        except GenerationCancelled:
            answer = "".join(answer_parts)
            with state.lock:
                state.content = answer
            repository.update_assistant_message(
                assistant_message_id, content=answer, status="cancelled"
            )
            with state.lock:
                state.status = "cancelled"
            return
        except LLMProviderError as exc:
            answer = "".join(answer_parts)
            message = str(exc)
            with state.lock:
                state.content = answer
                state.error_message = message
            repository.update_assistant_message(
                assistant_message_id, content=answer, status="error", error_message=message
            )
            with state.lock:
                state.status = "error"
            timer.log_summary(note="llm_error")
            return

        answer = "".join(answer_parts)
        validation = validate_citations(answer, citations)
        with state.lock:
            state.content = answer
            state.citations = citations
            state.citation_warnings = validation.warnings
            state.sources = retrieved_sources
            state.transparency = transparency
        repository.update_assistant_message(
            assistant_message_id,
            content=answer,
            status="complete",
            citations=citations,
            citation_warnings=validation.warnings,
            insufficient_evidence=False,
            sources=retrieved_sources,
            transparency=transparency,
        )
        with state.lock:
            state.status = "complete"
        timer.log_summary()
    except Exception:
        # Never let a worker thread die silently — an uncaught exception
        # here would otherwise leave the message stuck in 'generating'
        # forever with nothing to explain why (until the startup sweep on
        # a future restart). A generic message only: never surface a raw
        # exception string to end users.
        logger.exception(
            "Unhandled error in text generation worker for message %s", assistant_message_id
        )
        with state.lock:
            content = state.content
            state.error_message = "Generation failed unexpectedly."
        repository.update_assistant_message(
            assistant_message_id,
            content=content,
            status="error",
            error_message="Generation failed unexpectedly.",
        )
        with state.lock:
            state.status = "error"
    finally:
        session.close()


def start_text_generation(**kwargs: object) -> threading.Thread:
    thread = threading.Thread(
        target=run_text_generation, kwargs=kwargs, name="text-generation", daemon=True
    )
    thread.start()
    return thread


def run_vision_generation(
    *,
    assistant_message_id: uuid.UUID,
    stream_chat: Callable[[], AsyncIterator[str]],
    retrieved_sources: list[RetrievedChunk],
    citations: list[Citation],
    transparency: dict[str, object],
    attachment_storage: AttachmentStorage,
    timer: RequestTimer,
    session_factory: Callable[[], Session],
) -> None:
    """The vision counterpart to run_text_generation — same detached-thread
    contract (including `session_factory` injection — see that function's
    docstring), but drives VisionService.stream_chat's *async* generator
    via a private event loop (asyncio.run) inside this thread, since
    nothing about this thread has (or needs) a running loop of its own
    otherwise. `stream_chat` is a zero-arg callable returning a fresh
    async iterator so the underlying Ollama AsyncClient call is
    constructed on and bound to *this* thread's event loop, never the
    request's."""
    state = register(assistant_message_id)
    session = session_factory()
    repository = ConversationsRepository(session, attachment_storage)

    async def _consume() -> tuple[str, str | None, str | None, str | None]:
        """Returns (answer_so_far, status_override, error_message, error_category)."""
        answer_parts: list[str] = []
        flushed_len = 0
        try:
            async for token in stream_chat():
                if state.cancel_event.is_set():
                    return "".join(answer_parts), "cancelled", None, None
                answer_parts.append(token)
                with state.lock:
                    state.content += token
                    current_len = len(state.content)
                # Same periodic partial-content flush as the text worker —
                # see run_text_generation's own comment.
                if current_len - flushed_len >= 200:
                    repository.update_assistant_message(
                        assistant_message_id, content="".join(answer_parts), status="generating"
                    )
                    flushed_len = current_len
        except VisionServiceError as exc:
            return "".join(answer_parts), "error", str(exc), str(exc.category)
        return "".join(answer_parts), None, None, None

    try:
        answer, status_override, error_message, error_category = asyncio.run(_consume())
        if status_override == "cancelled":
            with state.lock:
                state.content = answer
            repository.update_assistant_message(
                assistant_message_id, content=answer, status="cancelled"
            )
            with state.lock:
                state.status = "cancelled"
            return
        if status_override == "error":
            with state.lock:
                state.content = answer
                state.error_message = error_message
                state.error_category = error_category
            repository.update_assistant_message(
                assistant_message_id, content=answer, status="error", error_message=error_message
            )
            with state.lock:
                state.status = "error"
            timer.log_summary(note="vision_error")
            return

        validation = validate_citations(answer, citations)
        with state.lock:
            state.content = answer
            state.citations = citations
            state.citation_warnings = validation.warnings
            state.sources = retrieved_sources
            state.transparency = transparency
        repository.update_assistant_message(
            assistant_message_id,
            content=answer,
            status="complete",
            citations=citations,
            citation_warnings=validation.warnings,
            insufficient_evidence=False,
            sources=retrieved_sources,
            transparency=transparency,
        )
        with state.lock:
            state.status = "complete"
        timer.log_summary()
    except Exception:
        logger.exception(
            "Unhandled error in vision generation worker for message %s", assistant_message_id
        )
        with state.lock:
            content = state.content
            state.error_message = "Generation failed unexpectedly."
        repository.update_assistant_message(
            assistant_message_id,
            content=content,
            status="error",
            error_message="Generation failed unexpectedly.",
        )
        with state.lock:
            state.status = "error"
    finally:
        session.close()


def start_vision_generation(**kwargs: object) -> threading.Thread:
    thread = threading.Thread(
        target=run_vision_generation, kwargs=kwargs, name="vision-generation", daemon=True
    )
    thread.start()
    return thread


def poll_until_done(message_id: uuid.UUID, *, interval_seconds: float = 0.08) -> Iterator[str]:
    """Yields newly-appended content deltas for `message_id`'s live
    GenerationState until it leaves 'generating' — used by the SSE
    endpoint (see app/api/routes_conversations.py) so "stream a live
    generation" and "catch up to one that's already partially done" are
    the same loop. Yields nothing further (but does not raise) once no
    live state is found — the caller is expected to read the authoritative
    final row from the database in that case (the worker had already
    finished and been discarded, or this process never started it)."""
    last_len = 0
    while True:
        state = get(message_id)
        if state is None:
            return
        content, status = state.snapshot()
        if len(content) > last_len:
            yield content[last_len:]
            last_len = len(content)
        if status != "generating":
            return
        time.sleep(interval_seconds)
