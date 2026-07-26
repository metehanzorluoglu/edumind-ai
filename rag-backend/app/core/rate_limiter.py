"""A minimal in-memory rate limiter (milestone V4) — protects
POST /conversations/{id}/messages (the only endpoint that calls an LLM,
text or vision) from being flooded by one caller, whether accidentally
(a buggy retry loop) or deliberately.

Deliberately in-process, in-memory, single-instance state — no Redis or
other shared cache, matching this project's existing "no extra infra"
posture everywhere else (embedded Qdrant, SQLite, a host Ollama process).
This means limits reset on every process restart and are not shared
across multiple backend processes/workers; see the module's own
docstring in app/config.py for where this tradeoff is made explicit. That
is an accepted limitation for a single-user/small-team local-first app,
not an oversight — see this project's README "Known limitations".
"""

import threading
import time
from collections import defaultdict, deque


class RateLimiter:
    """Sliding-window limiter: at most `max_requests` calls to `allow()`
    for a given `key` may return True within any trailing
    `window_seconds` window. Thread-safe (FastAPI's sync routes run in a
    threadpool, so multiple requests can call this concurrently)."""

    def __init__(self, *, max_requests: int, window_seconds: float) -> None:
        self._max_requests = max_requests
        self._window_seconds = window_seconds
        self._hits: dict[str, deque[float]] = defaultdict(deque)
        self._lock = threading.Lock()

    def _prune(self, hits: deque[float], now: float) -> None:
        while hits and now - hits[0] > self._window_seconds:
            hits.popleft()

    def allow(self, key: str) -> bool:
        now = time.monotonic()
        with self._lock:
            hits = self._hits[key]
            self._prune(hits, now)
            if len(hits) >= self._max_requests:
                return False
            hits.append(now)
            return True

    def seconds_until_next_slot(self, key: str) -> float:
        """How long until `allow(key)` would next return True, for a
        caller that was just rejected — 0.0 if it would already succeed
        (e.g. a key never seen, or its oldest hit has already aged out)."""
        now = time.monotonic()
        with self._lock:
            hits = self._hits[key]
            self._prune(hits, now)
            if len(hits) < self._max_requests:
                return 0.0
            return max(0.0, self._window_seconds - (now - hits[0]))
