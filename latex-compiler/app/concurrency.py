"""Milestone 5.1 Part 11 — bounded concurrency and backpressure for
compile jobs. Mirrors evidence-service/app/concurrency.py's admission
design (exactly `concurrency` jobs run at once; up to `queue_depth` more
wait; anything beyond that is rejected immediately rather than queued
unboundedly), but is SIMPLER than that module in one important way:
unlike torch inference, a compile job is a real OS subprocess this
service fully controls, so a timeout can actually terminate it (see
app/compiler.py's process-group SIGKILL) rather than merely stop
*waiting* for it. There is no orphaned-background-job complexity here —
when `run()` times out or is cancelled, the wrapped job coroutine's own
`finally` block (in app/compiler.py) kills the real process group before
this method returns control."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from typing import TypeVar

T = TypeVar("T")


class QueueFullError(Exception):
    """No free concurrency slot and the bounded waiting queue is already
    at capacity. Maps to HTTP 503 in app/main.py."""


class JobTimeoutError(Exception):
    """The job did not finish within its timeout budget. By the time this
    is raised, the underlying process group has already been killed —
    see app/compiler.py's `run_compile_job`."""


class BoundedJobExecutor:
    def __init__(self, *, concurrency: int, queue_depth: int) -> None:
        self._semaphore = asyncio.Semaphore(concurrency)
        self._queue_depth = queue_depth
        self._waiting = 0
        self._admission_lock = asyncio.Lock()

    async def run(self, fn: Callable[[], Awaitable[T]], *, timeout_seconds: float) -> T:
        async with self._admission_lock:
            if not self._semaphore.locked():
                await self._semaphore.acquire()
                immediate = True
            elif self._waiting < self._queue_depth:
                self._waiting += 1
                immediate = False
            else:
                raise QueueFullError(
                    f"queue full: {self._waiting} already waiting (capacity {self._queue_depth})"
                )

        if not immediate:
            try:
                async with asyncio.timeout(timeout_seconds):
                    await self._semaphore.acquire()
            except TimeoutError as exc:
                async with self._admission_lock:
                    self._waiting -= 1
                raise QueueFullError("timed out waiting for a compile slot") from exc
            async with self._admission_lock:
                self._waiting -= 1

        try:
            # `fn` (app/compiler.py's run_compile_job) is responsible for
            # killing its own process group in a `finally` block when
            # cancelled — asyncio.wait_for's cancellation on timeout
            # propagates into it exactly like any other task cancellation.
            return await asyncio.wait_for(fn(), timeout=timeout_seconds)
        except TimeoutError as exc:
            raise JobTimeoutError(f"job exceeded {timeout_seconds}s") from exc
        finally:
            self._semaphore.release()
