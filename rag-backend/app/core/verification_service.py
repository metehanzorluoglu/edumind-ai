"""Email-verification token lifecycle — generation, hashing, single-use
redemption, and the resend-cooldown lookup. Kept separate from
app/api/routes_auth.py (HTTP concerns: redirects, rate limiting) and
app/core/email_provider.py/email_templates.py (delivery mechanics and
copy): this module only touches the DB and decides *whether* a token is
valid to redeem or when one was last issued.
"""

import hashlib
import secrets
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta

from sqlalchemy import select, update
from sqlalchemy.orm import Session as DBSession

from app.core.time_utils import ensure_utc, utcnow
from app.db.models_auth import EmailVerificationToken, User

# 32 random bytes (~43 url-safe chars) — high-entropy enough that hashing
# with a plain, fast digest (not a slow password KDF) is appropriate,
# exactly the same reasoning app/core/refresh_tokens.py already documents
# for refresh tokens: this is never a low-entropy, human-chosen secret.
_TOKEN_BYTES = 32


def _hash_token(raw_token: str) -> str:
    return hashlib.sha256(raw_token.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class IssuedVerificationToken:
    raw_token: str
    expires_at: datetime


def issue_verification_token(
    db: DBSession, *, user_id: uuid.UUID, ttl_minutes: int
) -> IssuedVerificationToken:
    """Revokes every still-active (not consumed, not already revoked)
    token for this user, then issues and stores a new one — only the
    token's hash is ever persisted (see EmailVerificationToken's own
    docstring). Used by both registration and POST /auth/resend-verification,
    so a user can never have more than one genuinely redeemable link at a
    time; clicking an older email's link after requesting a newer one
    correctly reports "already used" rather than silently working.
    """
    now = utcnow()
    db.execute(
        update(EmailVerificationToken)
        .where(
            EmailVerificationToken.user_id == user_id,
            EmailVerificationToken.consumed_at.is_(None),
            EmailVerificationToken.revoked_at.is_(None),
        )
        .values(revoked_at=now)
    )
    raw_token = secrets.token_urlsafe(_TOKEN_BYTES)
    expires_at = now + timedelta(minutes=ttl_minutes)
    db.add(
        EmailVerificationToken(
            user_id=user_id, token_hash=_hash_token(raw_token), expires_at=expires_at
        )
    )
    db.commit()
    return IssuedVerificationToken(raw_token=raw_token, expires_at=expires_at)


@dataclass(frozen=True)
class VerificationResult:
    ok: bool
    # "invalid" | "expired" | "already_used" — only meaningful when ok is
    # False; a stable machine-readable code (see GET /auth/verify-email's
    # `status` redirect query param), never a free-text message.
    reason: str | None = None


def redeem_verification_token(db: DBSession, *, raw_token: str) -> VerificationResult:
    """Single-use: a token that redeems successfully is immediately
    marked consumed, so replaying the same link a second time reports
    "already_used", never re-verifies (harmlessly idempotent) or errors
    unpredictably."""
    token_hash = _hash_token(raw_token)
    token = db.execute(
        select(EmailVerificationToken).where(EmailVerificationToken.token_hash == token_hash)
    ).scalar_one_or_none()
    if token is None:
        return VerificationResult(ok=False, reason="invalid")
    if token.consumed_at is not None or token.revoked_at is not None:
        return VerificationResult(ok=False, reason="already_used")
    if ensure_utc(token.expires_at) < utcnow():
        return VerificationResult(ok=False, reason="expired")

    now = utcnow()
    token.consumed_at = now
    user = db.get(User, token.user_id)
    assert user is not None  # FK guarantees a matching row exists
    user.email_verified = True
    user.email_verified_at = now
    db.commit()
    return VerificationResult(ok=True)


def seconds_since_last_token_issued(db: DBSession, *, user_id: uuid.UUID) -> float | None:
    """How long ago the most recent verification token (consumed, revoked,
    or still active — any of them) was issued for this user, or None if
    none ever was. Backs POST /auth/resend-verification's cooldown, kept
    independent of the request-count rate limiter (app/core/
    auth_rate_limiter.py): the cooldown bounds *pace* per account, the
    rate limiter bounds *volume* per IP/account — different protections,
    both applied.
    """
    last = db.execute(
        select(EmailVerificationToken.created_at)
        .where(EmailVerificationToken.user_id == user_id)
        .order_by(EmailVerificationToken.created_at.desc())
        .limit(1)
    ).scalar_one_or_none()
    if last is None:
        return None
    return (utcnow() - ensure_utc(last)).total_seconds()
