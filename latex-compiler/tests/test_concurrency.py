"""Milestone 5.1 Part 50 — pure asyncio tests for BoundedJobExecutor.
No subprocess, no pdflatex needed — runs anywhere Python does."""

import asyncio

import pytest

from app.concurrency import BoundedJobExecutor, JobTimeoutError, QueueFullError


async def test_single_job_runs_and_returns_result():
    executor = BoundedJobExecutor(concurrency=1, queue_depth=2)

    async def job():
        return "done"

    result = await executor.run(job, timeout_seconds=5)
    assert result == "done"


async def test_admits_up_to_concurrency_then_queues():
    executor = BoundedJobExecutor(concurrency=2, queue_depth=2)
    started = []
    release = asyncio.Event()

    async def slow_job(name):
        started.append(name)
        await release.wait()
        return name

    tasks = [
        asyncio.create_task(executor.run(lambda n=n: slow_job(n), timeout_seconds=5))
        for n in ("a", "b")
    ]
    await asyncio.sleep(0.05)
    assert set(started) == {"a", "b"}  # both admitted immediately (concurrency=2)
    release.set()
    results = await asyncio.gather(*tasks)
    assert set(results) == {"a", "b"}


async def test_rejects_when_queue_full():
    executor = BoundedJobExecutor(concurrency=1, queue_depth=1)
    release = asyncio.Event()

    async def slow_job():
        await release.wait()
        return "ok"

    # 1 running + 1 queued = capacity 2; a 3rd concurrent caller must be
    # rejected immediately, never left waiting unboundedly (Part 11).
    t1 = asyncio.create_task(executor.run(slow_job, timeout_seconds=5))
    await asyncio.sleep(0.02)
    t2 = asyncio.create_task(executor.run(slow_job, timeout_seconds=5))
    await asyncio.sleep(0.02)

    with pytest.raises(QueueFullError):
        await executor.run(slow_job, timeout_seconds=5)

    release.set()
    await asyncio.gather(t1, t2)


async def test_job_timeout_raises_and_releases_slot():
    executor = BoundedJobExecutor(concurrency=1, queue_depth=1)

    async def hangs_forever():
        await asyncio.sleep(100)

    with pytest.raises(JobTimeoutError):
        await executor.run(hangs_forever, timeout_seconds=0.05)

    # The slot must be released even after a timeout -- a second job
    # should be admitted immediately, not blocked forever behind the
    # first one's semaphore permit.
    async def quick():
        return "ok"

    result = await asyncio.wait_for(executor.run(quick, timeout_seconds=5), timeout=1)
    assert result == "ok"


async def test_job_exception_still_releases_slot():
    executor = BoundedJobExecutor(concurrency=1, queue_depth=1)

    async def raises():
        raise ValueError("boom")

    with pytest.raises(ValueError):
        await executor.run(raises, timeout_seconds=5)

    async def quick():
        return "ok"

    result = await asyncio.wait_for(executor.run(quick, timeout_seconds=5), timeout=1)
    assert result == "ok"
