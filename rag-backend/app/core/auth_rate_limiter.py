"""Cross-process (multi-uvicorn-worker) rate limiting for the local auth
endpoints (POST /auth/login, POST /auth/register, and any future
POST /auth/password/* route) — the existing app/core/rate_limiter.py is
explicitly documented as single-process in-memory only, which would
silently under-count (a request rejected by worker A is invisible to
worker B) across this deployment's `--workers 2`
(deploy/oracle/docker-compose.oracle.yml). SQLite already backs every
other piece of persistent state this app has (see app/config.py's
database_url); reusing it here avoids adding a new infra dependency
(Redis, memcached) for a single-user/small-team app, the same "no extra
infra" posture app/core/rate_limiter.py's own docstring accepts
explicitly for the chat limiter.

Design:
- Sliding window, counted via a row-per-attempt table (AuthRateLimitHit).
- Bucketed by a SHA-256 hash of (route, identifier) — never the raw email
  or IP address, so this table alone can never be used to enumerate real
  user emails or addresses even with direct DB access.
- Checked per-IP and per-normalized-email independently; either bucket
  being full is enough to reject — this stops both a single attacker
  hammering one account from many IPs, and a single IP spraying many
  accounts (credential stuffing), while returning one identical generic
  429 response either way (never reveals which bucket tripped: that would
  let a caller distinguish "this specific account is being throttled"
  from "your IP is", weak account-enumeration signal on its own but
  needless to expose).
- Each check is one short transaction (delete-expired -> count -> maybe
  insert -> commit), all against indexed columns — no long-held SQLite
  write lock. Bounded table growth is lazy: a bucket's own stale rows are
  deleted the next time that same bucket is touched, which suffices here
  since the realistic set of distinct (route, email-or-IP) pairs for a
  single-user/small-team deployment never grows large; a bucket that goes
  permanently dormant leaves at most `max_attempts` rows behind forever,
  not an unbounded amount.
"""

import hashlib
from dataclasses import dataclass
from datetime import timedelta

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session as DBSession

from app.core.time_utils import ensure_utc, utcnow
from app.db.models_auth import AuthRateLimitHit


def _bucket_key(*parts: str) -> str:
    return hashlib.sha256("|".join(parts).encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class RateLimitResult:
    allowed: bool
    retry_after_seconds: float


def _check_and_record(
    db: DBSession, *, bucket_key: str, max_attempts: int, window_seconds: float
) -> RateLimitResult:
    now = utcnow()
    window_start = now - timedelta(seconds=window_seconds)

    db.execute(
        delete(AuthRateLimitHit).where(
            AuthRateLimitHit.bucket_key == bucket_key,
            AuthRateLimitHit.created_at < window_start,
        )
    )

    count = db.execute(
        select(func.count())
        .select_from(AuthRateLimitHit)
        .where(
            AuthRateLimitHit.bucket_key == bucket_key,
            AuthRateLimitHit.created_at >= window_start,
        )
    ).scalar_one()

    if count >= max_attempts:
        oldest = db.execute(
            select(func.min(AuthRateLimitHit.created_at)).where(
                AuthRateLimitHit.bucket_key == bucket_key,
                AuthRateLimitHit.created_at >= window_start,
            )
        ).scalar_one()
        db.commit()
        retry_after = window_seconds
        if oldest is not None:
            retry_after = max(0.0, window_seconds - (now - ensure_utc(oldest)).total_seconds())
        return RateLimitResult(allowed=False, retry_after_seconds=retry_after)

    db.add(AuthRateLimitHit(bucket_key=bucket_key, created_at=now))
    db.commit()
    return RateLimitResult(allowed=True, retry_after_seconds=0.0)


def enforce_auth_rate_limit(
    db: DBSession,
    *,
    route: str,
    ip_address: str | None,
    email: str | None,
    max_attempts: int,
    window_seconds: float,
) -> RateLimitResult:
    """The one entry point routes_auth.py's login/register handlers call.
    Checks the per-IP bucket first (cheaper to exhaust deliberately, so
    check it first to short-circuit before touching the per-email
    bucket), then the per-normalized-email bucket — `email` should already
    be normalized (see app/core/email_normalization.py) by the caller.
    Either missing `ip_address` or missing `email` simply skips that
    bucket rather than erroring: a request with no discoverable client IP
    (e.g. in a test harness) still gets the email-keyed protection, and
    vice versa.
    """
    if ip_address:
        ip_result = _check_and_record(
            db,
            bucket_key=_bucket_key(route, "ip", ip_address),
            max_attempts=max_attempts,
            window_seconds=window_seconds,
        )
        if not ip_result.allowed:
            return ip_result

    if email:
        email_result = _check_and_record(
            db,
            bucket_key=_bucket_key(route, "email", email),
            max_attempts=max_attempts,
            window_seconds=window_seconds,
        )
        if not email_result.allowed:
            return email_result

    return RateLimitResult(allowed=True, retry_after_seconds=0.0)
