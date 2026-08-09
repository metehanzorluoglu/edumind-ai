"""Milestone 11 §8/§14/§33 — tests for app/concurrency.py's
BoundedInferenceExecutor. Pure asyncio, no torch."""

from __future__ import annotations

import asyncio

import pytest

from app.concurrency import BoundedInferenceExecutor, InferenceTimeoutError, QueueFullError


class TestBasicExecution:
    async def test_single_call_runs_and_returns_result(self) -> None:
        executor = BoundedInferenceExecutor(concurrency=1, queue_depth=8)

        async def _fn() -> str:
            return "ok"

        result, queue_wait_ms = await executor.run(_fn, timeout_seconds=1.0)
        assert result == "ok"
        assert queue_wait_ms >= 0

    async def test_stats_reports_zero_waiting_when_idle(self) -> None:
        executor = BoundedInferenceExecutor(concurrency=1, queue_depth=8)
        stats = await executor.stats()
        assert stats.waiting == 0
        assert stats.capacity == 8


class TestConcurrencyLimit:
    async def test_second_call_waits_for_the_first_to_finish(self) -> None:
        executor = BoundedInferenceExecutor(concurrency=1, queue_depth=8)
        order: list[str] = []

        async def _slow() -> None:
            order.append("slow-start")
            await asyncio.sleep(0.05)
            order.append("slow-end")

        async def _fast() -> None:
            order.append("fast")

        first = asyncio.ensure_future(executor.run(_slow, timeout_seconds=2.0))
        await asyncio.sleep(0.01)  # let `first` actually acquire the slot
        second = asyncio.ensure_future(executor.run(_fast, timeout_seconds=2.0))
        await asyncio.gather(first, second)

        # "fast" must not start until "slow" has released its slot.
        assert order == ["slow-start", "slow-end", "fast"]


class TestQueueFull:
    async def test_raises_queue_full_immediately_when_capacity_exceeded(self) -> None:
        executor = BoundedInferenceExecutor(concurrency=1, queue_depth=1)

        async def _slow() -> None:
            await asyncio.sleep(0.2)

        # Fill the one concurrency slot.
        holder = asyncio.ensure_future(executor.run(_slow, timeout_seconds=2.0))
        await asyncio.sleep(0.01)
        # Fill the one queue slot.
        waiter = asyncio.ensure_future(executor.run(_slow, timeout_seconds=2.0))
        await asyncio.sleep(0.01)

        # A third request must be rejected immediately (queue at capacity).
        with pytest.raises(QueueFullError):
            await executor.run(_slow, timeout_seconds=2.0)

        await asyncio.gather(holder, waiter)

    async def test_queue_full_does_not_wait(self) -> None:
        import time

        executor = BoundedInferenceExecutor(concurrency=1, queue_depth=0)

        async def _slow() -> None:
            await asyncio.sleep(0.3)

        holder = asyncio.ensure_future(executor.run(_slow, timeout_seconds=2.0))
        await asyncio.sleep(0.01)

        start = time.perf_counter()
        with pytest.raises(QueueFullError):
            await executor.run(_slow, timeout_seconds=2.0)
        elapsed = time.perf_counter() - start
        assert elapsed < 0.1  # rejected immediately, not after waiting

        await holder


class TestTimeout:
    async def test_timeout_while_waiting_for_a_slot(self) -> None:
        executor = BoundedInferenceExecutor(concurrency=1, queue_depth=8)

        async def _slow() -> None:
            await asyncio.sleep(0.3)

        holder = asyncio.ensure_future(executor.run(_slow, timeout_seconds=2.0))
        await asyncio.sleep(0.01)

        with pytest.raises(InferenceTimeoutError):
            await executor.run(_slow, timeout_seconds=0.05)

        await holder

    async def test_timeout_while_inference_itself_is_running(self) -> None:
        executor = BoundedInferenceExecutor(concurrency=1, queue_depth=8)

        async def _slow() -> str:
            await asyncio.sleep(0.5)
            return "done"

        with pytest.raises(InferenceTimeoutError):
            await executor.run(_slow, timeout_seconds=0.05)

    async def test_slot_is_released_after_orphaned_inference_completes(self) -> None:
        # The documented "honest semantics" (see app/concurrency.py's
        # module docstring): a timed-out-but-still-running inference
        # keeps holding its slot until it finishes, THEN releases it —
        # verified here by timing out call 1 (0.15s inference vs 0.05s
        # timeout) and confirming call 2 cannot start until call 1's
        # orphaned inference has actually finished.
        executor = BoundedInferenceExecutor(concurrency=1, queue_depth=8)
        order: list[str] = []

        async def _orphan() -> None:
            order.append("orphan-start")
            await asyncio.sleep(0.15)
            order.append("orphan-end")

        async def _next() -> None:
            order.append("next")

        with pytest.raises(InferenceTimeoutError):
            await executor.run(_orphan, timeout_seconds=0.05)

        # At this point the orphaned inference is still running in the
        # background. A new call must still wait for it.
        await executor.run(_next, timeout_seconds=2.0)
        assert order == ["orphan-start", "orphan-end", "next"]
