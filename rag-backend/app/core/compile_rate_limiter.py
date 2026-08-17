"""Cross-process (multi-uvicorn-worker) rate limiting for
POST /writing-projects/{id}/compile — replaces the in-process
RateLimiter (app/core/rate_limiter.py) previously used here, which that
module's own docstring already documents as single-process-only and
therefore invisible across this deployment's `--workers 2`
(deploy/oracle/docker-compose.oracle.yml): a burst of requests split
across both workers could each see an empty local window and pass, when
the SHARED count should have rejected them.

Mirrors app/core/auth_rate_limiter.py's design exactly (SQLite-backed
sliding window, counted via a row-per-attempt table, bucket key is a
hash rather than the raw identifier) — reusing that proven pattern
rather than inventing a second one, via a dedicated
CompileRateLimitHit table so this stays independent of the
security-sensitive auth module. Simpler than the auth limiter in one
respect: compile requests are already authenticated (a real user_id),
so there is only ever one bucket per request, not a per-IP/per-email
pair.
"""

from __future__ import annotations

import hashlib
import uuid
from dataclasses import dataclass
from datetime import timedelta

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session as DBSession

from app.core.time_utils import ensure_utc, utcnow
from app.db.models_writing import CompileRateLimitHit


def _bucket_key(user_id: uuid.UUID) -> str:
    return hashlib.sha256(f"compile|user|{user_id}".encode()).hexdigest()


@dataclass(frozen=True)
class CompileRateLimitResult:
    allowed: bool
    retry_after_seconds: float


def enforce_compile_rate_limit(
    db: DBSession,
    *,
    user_id: uuid.UUID,
    max_requests: int,
    window_seconds: float,
) -> CompileRateLimitResult:
    """One short transaction (delete-expired -> count -> maybe insert ->
    commit) against indexed columns — no long-held SQLite write lock,
    same reasoning as auth_rate_limiter._check_and_record. Bounded table
    growth is lazy: a bucket's own stale rows are deleted the next time
    that same bucket is touched."""
    bucket_key = _bucket_key(user_id)
    now = utcnow()
    window_start = now - timedelta(seconds=window_seconds)

    db.execute(
        delete(CompileRateLimitHit).where(
            CompileRateLimitHit.bucket_key == bucket_key,
            CompileRateLimitHit.created_at < window_start,
        )
    )

    count = db.execute(
        select(func.count())
        .select_from(CompileRateLimitHit)
        .where(
            CompileRateLimitHit.bucket_key == bucket_key,
            CompileRateLimitHit.created_at >= window_start,
        )
    ).scalar_one()

    if count >= max_requests:
        oldest = db.execute(
            select(func.min(CompileRateLimitHit.created_at)).where(
                CompileRateLimitHit.bucket_key == bucket_key,
                CompileRateLimitHit.created_at >= window_start,
            )
        ).scalar_one()
        db.commit()
        retry_after = window_seconds
        if oldest is not None:
            retry_after = max(0.0, window_seconds - (now - ensure_utc(oldest)).total_seconds())
        return CompileRateLimitResult(allowed=False, retry_after_seconds=retry_after)

    db.add(CompileRateLimitHit(bucket_key=bucket_key, created_at=now))
    db.commit()
    return CompileRateLimitResult(allowed=True, retry_after_seconds=0.0)
