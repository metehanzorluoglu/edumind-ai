"""Per-request stage timing, gated entirely by Settings.performance_profiling
(env var PERFORMANCE_PROFILING, default false — see app/config.py). Added to
instrument the upload and chat pipelines end to end (file save -> parsing ->
chunking -> embedding -> Qdrant upload -> database for uploads; auth ->
conversation lookup -> embedding -> retrieval -> reranking -> prompt
construction -> LLM generation -> streaming for chat) without optimizing
anything yet.

Two ways code reaches the current request's RequestTimer:

- Explicit: the RequestTimer instance passed as a plain argument. This is
  the default choice everywhere it's cheap — route functions
  (app/api/routes_documents.py, app/api/routes_conversations.py) and the
  background-task / SSE-generator continuations that run after a request
  has already returned (run_ingestion_job, event_stream) — a plain object
  reference works identically in either place, since nothing about
  passing it as a normal argument depends on request lifecycle.

- Ambient: get_current_timer(), backed by a contextvar bound for the
  lifetime of FastAPI's dependency-resolution + route-body execution (see
  app/deps.py::get_request_timer). This exists only because Retriever and
  RagService (app/core/retriever.py, app/core/rag_service.py) are
  long-lived @lru_cache singletons (app/deps.py) reached through a
  multi-file Protocol-typed call chain (RagService.prepare ->
  retrieve_and_cite -> execute_scope_plan -> Retriever.retrieve) — thread-
  ing an explicit timer parameter through all of that would mean changing
  several Protocol signatures for a profiling concern alone. The
  contextvar is safe there because that whole chain runs synchronously,
  still inside the bound window, before the route returns.

IMPORTANT — the ambient accessor stops working once a StreamingResponse's
body generator starts running or a BackgroundTasks callable starts
running: both execute after FastAPI's dependency AsyncExitStack has
already closed (and reset the contextvar back to the disabled singleton).
Call sites there (event_stream() in routes_conversations.py,
run_ingestion_job() in document_ingestion_jobs.py) receive the
RequestTimer explicitly instead — see module docstrings there.

When profiling is disabled, RequestTimer.stage()/record() take exactly one
branch (`if not self.enabled: ...`) and return — no time.perf_counter()
call, no list write, no logging call. That is what "zero measurable
overhead when disabled" means here; the one thing NOT free is the single
boolean check itself and, for get_current_timer(), one ContextVar.get()
call, both far below anything measurable against real request latency.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar, Token

logger = logging.getLogger("app.timing")


class RequestTimer:
    """Collects named stage durations (milliseconds) for one request. A
    stage name may be recorded more than once (e.g. "embedding" once per
    retrieval scope tier — see app/core/retriever.py) — as_dict() sums
    same-named entries so the reported table has one row per stage.

    Also collects point-in-time *metrics* — a count or a rate, not a
    duration (e.g. retrieved_chunk_count, estimated_prompt_tokens,
    decode_tokens_per_second — see app/core/llm_provider.py and
    app/api/routes_conversations.py). Kept in a separate dict from the
    duration stages rather than overloading record() for both: a metric is
    a single point value (last write wins), never summed across repeated
    calls the way same-named durations are."""

    __slots__ = ("_metrics", "_stages", "_start", "enabled", "label")

    def __init__(self, *, enabled: bool, label: str = "") -> None:
        self.enabled = enabled
        self.label = label
        self._stages: list[tuple[str, float]] = []
        self._metrics: dict[str, float] = {}
        self._start = time.perf_counter() if enabled else 0.0

    def record(self, name: str, duration_ms: float) -> None:
        """Records a duration already measured by the caller (used where a
        `with stage(...)` block doesn't fit, e.g. the per-token LLM
        generation/streaming split in routes_conversations.py)."""
        if not self.enabled:
            return
        self._stages.append((name, duration_ms))
        logger.info(
            "timing stage=%s duration_ms=%.2f request=%s", name, duration_ms, self.label
        )

    def record_metric(self, name: str, value: float) -> None:
        """Records a named point-in-time metric — a count or rate, not a
        duration (see the class docstring). Last write wins for a given
        name; unlike record(), repeated calls with the same name do not
        accumulate. No-op when disabled, same as every other method here."""
        if not self.enabled:
            return
        self._metrics[name] = value
        logger.info("timing metric=%s value=%s request=%s", name, value, self.label)

    @contextmanager
    def stage(self, name: str) -> Iterator[None]:
        if not self.enabled:
            yield
            return
        t0 = time.perf_counter()
        try:
            yield
        finally:
            self.record(name, (time.perf_counter() - t0) * 1000)

    def total_ms(self) -> float:
        if not self.enabled:
            return 0.0
        return (time.perf_counter() - self._start) * 1000

    def as_dict(self) -> dict[str, float]:
        """Stage name -> summed duration_ms, plus "total_ms", plus every
        recorded metric (see record_metric()). Empty dict when disabled,
        so callers can do `if timings:` without a separate enabled check.
        A metric name must not collide with a stage name — both share this
        one flat namespace in the output."""
        if not self.enabled:
            return {}
        totals: dict[str, float] = {}
        for name, duration_ms in self._stages:
            totals[name] = totals.get(name, 0.0) + duration_ms
        result = {name: round(total, 2) for name, total in totals.items()}
        result["total_ms"] = round(self.total_ms(), 2)
        result.update(self._metrics)
        return result

    def server_timing_header(self) -> str:
        """Formats recorded stages as a standard HTTP `Server-Timing`
        header value (https://www.w3.org/TR/server-timing/), viewable in
        any browser's network devtools. Only includes stages recorded
        *before* this is called — for a streamed response that means
        everything up to (not including) LLM generation/streaming, since
        headers must be sent before the body starts (see
        routes_conversations.py's module docstring)."""
        if not self.enabled:
            return ""
        parts = [f"{name};dur={duration:.2f}" for name, duration in self._stages]
        parts.append(f"total;dur={self.total_ms():.2f}")
        return ", ".join(parts)

    def log_summary(self, *, note: str = "") -> None:
        if not self.enabled:
            return
        logger.info(
            "timing summary request=%s%s stages=%s",
            self.label,
            f" note={note}" if note else "",
            self.as_dict(),
        )


#: Shared, never-mutated instance for "no timer bound" / "profiling off".
#: Safe to hand out to any number of concurrent requests: stage()/record()
#: are no-ops on a disabled RequestTimer, so nothing ever writes to it —
#: there is no shared-mutable-state hazard in reusing one instance instead
#: of constructing a fresh (also-inert) one per request.
DISABLED_TIMER = RequestTimer(enabled=False)
_current_timer: ContextVar[RequestTimer] = ContextVar("_current_timer", default=DISABLED_TIMER)


def bind_timer(timer: RequestTimer) -> Token[RequestTimer]:
    return _current_timer.set(timer)


def unbind_timer(token: Token[RequestTimer]) -> None:
    _current_timer.reset(token)


def get_current_timer() -> RequestTimer:
    """Returns the RequestTimer bound for the current request, or the
    shared disabled singleton if none is bound (either PERFORMANCE_PROFILING
    is off, or this code is running outside the bound window — see the
    module docstring). Never None, so callers never need a null check."""
    return _current_timer.get()
