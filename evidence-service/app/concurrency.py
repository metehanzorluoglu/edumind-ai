"""Milestone 11 (Evidence Service & Shadow Infrastructure Implementation)
§8/§14 — bounded concurrency and backpressure for model inference.

Design (Milestone 10 §32/§33): exactly `concurrency` (1, by default —
Milestone 10's approved value for this 4-core host) inference calls run
at a time; up to `queue_depth` (8) additional requests wait for a slot;
anything beyond that capacity is rejected immediately with a distinct
error rather than queued unboundedly (Milestone 11 §8: "Do not create
unlimited task queues... queue full: return explicit overload response").

HONEST TIMEOUT SEMANTICS (Milestone 11 §14's "report exact semantics"
instruction — do not paper over this):

Model inference (`NLIModel.predict_batch`) is synchronous, CPU-bound torch
code with no safe mid-computation cancellation point. It runs in a worker
thread (`asyncio.to_thread`, wired up by the caller — see app/main.py) so
the event loop itself stays responsive (health checks, admission/
rejection of other requests) while inference runs. When a request's
timeout expires WHILE INFERENCE IS ALREADY RUNNING (not just queued), this
class stops the caller from *waiting* for it (an InferenceTimeoutError is
raised back to the HTTP layer promptly), but it does NOT kill the
underlying OS thread — torch has no safe mid-computation cancellation
point. That inference keeps running in the background, still holding its
concurrency slot, until it finishes naturally; a small internal cleanup
task (not the caller) awaits it and releases the slot only once it
genuinely completes. A request that timed out while merely QUEUED (its
inference never started) has no such orphan — its slot was never held at
all, and this class does not increment/decrement it in that case.

In practice this rarely matters: Milestone 10's own source-limit
experiment measured worst-case batch-of-3 inference at ~873ms p50, well
under the ~2.3s internal timeout in app/config.py, and this service's own
request limits (max_sources_per_claim=3) keep every real batch that size
or smaller — so a timeout firing mid-inference, rather than mid-queue, is
the uncommon case, not the common one.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import TypeVar

T = TypeVar("T")


class QueueFullError(Exception):
    """The bounded waiting queue was already at capacity — Milestone 11
    §8's "queue full: return explicit overload response" case. Maps to
    HTTP 503 in app/main.py."""


class InferenceTimeoutError(Exception):
    """The request waited longer than `request_timeout_seconds` for
    either a queue slot or the inference call itself to complete — see
    this module's docstring for the exact, honest semantics. Maps to HTTP
    504 in app/main.py (distinct from 503/QueueFullError: this is "we
    started/were about to start, but ran out of time," not "we never
    admitted you at all")."""


@dataclass
class QueueStats:
    waiting: int
    capacity: int


class BoundedInferenceExecutor:
    """One instance per process (see app/main.py's app.state), guarding
    every call into NLIModel.predict_batch. `concurrency` inference calls
    run at once; up to `queue_depth` more wait; anything beyond that is
    rejected immediately (QueueFullError) rather than queued."""

    def __init__(self, *, concurrency: int, queue_depth: int) -> None:
        self._semaphore = asyncio.Semaphore(concurrency)
        self._queue_depth = queue_depth
        self._waiting = 0
        self._admission_lock = asyncio.Lock()

    async def stats(self) -> QueueStats:
        async with self._admission_lock:
            return QueueStats(waiting=self._waiting, capacity=self._queue_depth)

    async def run(
        self, fn: Callable[[], Awaitable[T]], *, timeout_seconds: float
    ) -> tuple[T, float]:
        """Runs `fn` (already wrapping the blocking model call in
        `asyncio.to_thread` — see app/main.py) under the bounded
        concurrency/queue limits. Returns (result, queue_wait_ms) so the
        caller can report queue time separately from inference time.
        Raises QueueFullError immediately if no concurrency slot is free
        AND the queue is already at capacity (never waits in that case —
        Milestone 11 §8: "No infinite waits"; note a request that arrives
        while a slot is immediately free is admitted right away
        regardless of `queue_depth`, even queue_depth=0 — the queue only
        bounds requests that must actually WAIT for a busy slot), or
        InferenceTimeoutError if waiting for a slot, or the inference
        call itself, exceeds `timeout_seconds` (see the module docstring
        for exactly what does and doesn't get interrupted in the latter
        case).

        Minor known limitation, not a safety issue: admission when a slot
        is immediately free is checked via `Semaphore.locked()` then
        `Semaphore.acquire()` as two steps (atomic only with respect to
        other admission decisions, serialized by `_admission_lock`) — in
        a rare race where a slot frees at the same instant a NEW request
        arrives, that new request can be admitted ahead of an
        already-queued waiter that's still being woken up by asyncio's
        own FIFO wait queue. This never lets more than `concurrency`
        inferences run at once (the bound this class exists to enforce),
        it can only occasionally reorder who goes next among already-
        eligible requests — acceptable for an internal, concurrency=1-by-
        default diagnostics service; not worth a hand-rolled fair
        ticketing scheme here."""
        start = time.perf_counter()
        async with self._admission_lock:
            if not self._semaphore.locked():
                await self._semaphore.acquire()  # a permit is free; returns immediately
                immediate = True
            elif self._waiting < self._queue_depth:
                self._waiting += 1
                immediate = False
            else:
                raise QueueFullError(
                    f"queue full: {self._waiting} already waiting (capacity {self._queue_depth})"
                )

        queue_wait_ms = 0.0
        if not immediate:
            try:
                async with asyncio.timeout(timeout_seconds):
                    await self._semaphore.acquire()
            except TimeoutError as exc:
                async with self._admission_lock:
                    self._waiting -= 1
                raise InferenceTimeoutError(
                    f"timed out after {timeout_seconds}s waiting for an inference slot"
                ) from exc
            async with self._admission_lock:
                self._waiting -= 1
            queue_wait_ms = (time.perf_counter() - start) * 1000

        remaining_seconds = timeout_seconds - (time.perf_counter() - start)

        # Semaphore is now held. `task` runs independently of whether the
        # caller keeps waiting for it (see module docstring) — a separate
        # `_release_when_done` coroutine, not the caller, is responsible
        # for releasing the semaphore once `task` genuinely finishes,
        # whether or not the caller below times out first.
        task: asyncio.Task[T] = asyncio.ensure_future(fn())

        async def _release_when_done() -> None:
            try:
                await task
            except BaseException:
                pass
            finally:
                self._semaphore.release()

        asyncio.ensure_future(_release_when_done())

        if remaining_seconds <= 0:
            raise InferenceTimeoutError(
                f"timed out after {timeout_seconds}s (no time remaining after queue wait); "
                "inference continues running in the background — see module docstring"
            )
        try:
            result = await asyncio.wait_for(asyncio.shield(task), timeout=remaining_seconds)
        except TimeoutError as exc:
            raise InferenceTimeoutError(
                f"timed out after {timeout_seconds}s waiting for inference to complete; "
                "inference continues running in the background and will release its "
                "concurrency slot when it finishes — see module docstring"
            ) from exc
        return result, queue_wait_ms
