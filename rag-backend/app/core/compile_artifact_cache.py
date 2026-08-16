"""Milestone 5.1 Part 16/17 — a short-lived, in-memory cache for
successfully-compiled PDF bytes. Deliberately NOT a database table or a
disk file (Part 17: "not permanent storage... clean automatically... no
unbounded compilation-artifact accumulation") — matches this codebase's
existing "no extra infra" posture (app/core/rate_limiter.py's identical
in-process, in-memory, single-instance-state tradeoff, and its own
documented limitation: this resets on process restart, is not shared
across the two uvicorn workers, and is intentionally scoped to "avoid a
base64-PDF-in-JSON round trip to the browser" rather than acting as
real storage.

Each entry remembers which user/project it belongs to so the download
route (`GET /writing-projects/{id}/compile/{compile_id}/pdf`) can
ownership-check it the same way every other Writing Project resource is
ownership-checked — Part 42: a guessed compile_id belonging to another
user's project must 404, indistinguishable from a nonexistent one."""

from __future__ import annotations

import threading
import time
import uuid
from dataclasses import dataclass


@dataclass(frozen=True)
class CompileArtifact:
    user_id: uuid.UUID
    project_id: uuid.UUID
    pdf_bytes: bytes
    stored_at: float


class CompileArtifactCache:
    def __init__(self, *, ttl_seconds: float = 600.0, max_entries: int = 200) -> None:
        self._ttl_seconds = ttl_seconds
        self._max_entries = max_entries
        self._entries: dict[str, CompileArtifact] = {}
        self._lock = threading.Lock()

    def _prune_locked(self, now: float) -> None:
        expired = [k for k, v in self._entries.items() if now - v.stored_at > self._ttl_seconds]
        for k in expired:
            del self._entries[k]
        # Part 17 backstop: if still over capacity after TTL pruning
        # (e.g. a burst of compiles within one TTL window), evict the
        # oldest entries first — never grows unboundedly regardless of
        # request volume.
        if len(self._entries) > self._max_entries:
            by_age = sorted(self._entries.items(), key=lambda kv: kv[1].stored_at)
            for k, _ in by_age[: len(self._entries) - self._max_entries]:
                del self._entries[k]

    def store(self, *, user_id: uuid.UUID, project_id: uuid.UUID, pdf_bytes: bytes) -> str:
        compile_id = uuid.uuid4().hex
        now = time.monotonic()
        with self._lock:
            self._prune_locked(now)
            self._entries[compile_id] = CompileArtifact(
                user_id=user_id, project_id=project_id, pdf_bytes=pdf_bytes, stored_at=now
            )
        return compile_id

    def get(
        self, *, user_id: uuid.UUID, project_id: uuid.UUID, compile_id: str
    ) -> bytes | None:
        """Returns None for a missing, expired, OR ownership-mismatched
        entry — the caller (route) maps every one of those identically
        to 404, never distinguishing "wrong owner" from "doesn't exist"
        (Part 42)."""
        now = time.monotonic()
        with self._lock:
            self._prune_locked(now)
            artifact = self._entries.get(compile_id)
        if artifact is None:
            return None
        if artifact.user_id != user_id or artifact.project_id != project_id:
            return None
        return artifact.pdf_bytes
