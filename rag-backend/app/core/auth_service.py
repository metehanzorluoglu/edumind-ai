"""Core session/user persistence shared by every auth entry point (real
OAuth callback, dev-login, refresh). HTTP concerns — redirects, cookies,
request parsing, talking to a provider — stay in app/api/routes_auth.py and
app/core/oauth_providers.py; this module only touches the DB, and never
raises an HTTPException itself (callers translate its results/exceptions
into responses).
"""

from dataclasses import dataclass
from datetime import timedelta

from sqlalchemy import select, update
from sqlalchemy.orm import Session as DBSession

from app.config import Settings
from app.core.email_normalization import normalize_email
from app.core.jwt import create_access_token
from app.core.oauth_providers import VerifiedIdentity
from app.core.password_hashing import hash_password, verify_password
from app.core.refresh_tokens import generate_refresh_token, hash_refresh_token
from app.core.time_utils import ensure_utc, utcnow
from app.db.models_auth import OAuthAccount, User
from app.db.models_auth import Session as SessionModel


@dataclass(frozen=True)
class IssuedTokens:
    access_token: str
    refresh_token: str
    expires_in_seconds: int
    user: User


def issue_tokens_for_user(
    db: DBSession,
    settings: Settings,
    user: User,
    *,
    user_agent: str | None = None,
    ip_address: str | None = None,
) -> IssuedTokens:
    """Creates a new session (refresh token) and mints an access token for
    an already-resolved, trusted user — the one place every login path
    (OAuth callback, dev-login, and indirectly /auth/refresh via
    rotate_refresh_token below) converges."""
    raw_refresh = generate_refresh_token()
    session = SessionModel(
        user_id=user.id,
        refresh_token_hash=hash_refresh_token(raw_refresh),
        expires_at=utcnow() + timedelta(days=settings.refresh_token_ttl_days),
        user_agent=user_agent,
        ip_address=ip_address,
    )
    db.add(session)
    user.last_login_at = utcnow()
    db.commit()

    access_token = create_access_token(
        user.id, secret=settings.jwt_secret, ttl_minutes=settings.jwt_access_ttl_minutes
    )
    return IssuedTokens(
        access_token=access_token,
        refresh_token=raw_refresh,
        expires_in_seconds=settings.jwt_access_ttl_minutes * 60,
        user=user,
    )


class UnverifiedEmailConflictError(Exception):
    """Raised by upsert_user_from_identity when an *unverified* provider
    email matches an address a different, already-existing user already
    owns. Refusing this outright is the entire point of never trusting an
    unverified email (see the function's own docstring) — without this
    explicit check, falling through to `User(email=normalized_email, ...)`
    would hit `users.email`'s UNIQUE constraint (app/db/models_auth.py)
    and raise an unhandled IntegrityError (an opaque 500) instead of a
    clean, safe rejection the callback can redirect on (see
    app/api/routes_auth.py's `auth_error=email_conflict`)."""


def upsert_user_from_identity(db: DBSession, identity: VerifiedIdentity) -> User:
    """Resolves a verified provider identity to a `users` row.

    An existing (provider, provider_account_id) match always wins outright
    — that's a returning user on a provider they've used before. Otherwise,
    if the provider marks the email verified, this links to (or creates) a
    user by that email; an *unverified* email is never used to merge into
    an existing account, since that would let anyone claim an existing
    account just by typing its address into an unrelated provider's profile
    field — see UnverifiedEmailConflictError for what happens instead when
    that unverified email collides with someone else's. Requires
    `identity.email is not None` — callers must handle the "provider
    returned no email" case before ever reaching here (see
    app/api/routes_auth.py's callback handler).
    """
    if identity.email is None:
        raise ValueError("upsert_user_from_identity requires a non-None identity.email")

    existing_account = db.execute(
        select(OAuthAccount).where(
            OAuthAccount.provider == identity.provider,
            OAuthAccount.provider_account_id == identity.provider_account_id,
        )
    ).scalar_one_or_none()
    if existing_account is not None:
        user = db.get(User, existing_account.user_id)
        assert user is not None  # FK guarantees a matching row exists
        _refresh_profile_fields(user, identity)
        _mark_verified_from_provider(user, identity)
        db.flush()
        return user

    normalized_email = normalize_email(identity.email)
    user = None
    if identity.email_verified:
        user = db.execute(select(User).where(User.email == normalized_email)).scalar_one_or_none()
    elif (
        db.execute(select(User.id).where(User.email == normalized_email)).scalar_one_or_none()
        is not None
    ):
        raise UnverifiedEmailConflictError(normalized_email)

    if user is None:
        user = User(
            email=normalized_email,
            email_verified=identity.email_verified,
            email_verified_at=utcnow() if identity.email_verified else None,
            display_name=identity.display_name,
            avatar_url=identity.avatar_url,
        )
        db.add(user)
        db.flush()
    else:
        # Reached only via the verified-email lookup above (an unverified
        # identity never reaches this branch — see UnverifiedEmailConflictError)
        # — an existing user (OAuth-only or a previously-unverified local
        # account) linked here by a *provider-confirmed* email is exactly
        # Phase 7's "safe account-linking" case: the provider is vouching
        # for this address, so it's safe to also mark the account verified
        # if it wasn't already (e.g. a local account that never clicked its
        # own verification email can still reach full access this way).
        _refresh_profile_fields(user, identity)
        _mark_verified_from_provider(user, identity)

    db.add(
        OAuthAccount(
            user_id=user.id,
            provider=identity.provider,
            provider_account_id=identity.provider_account_id,
            provider_email=identity.email,
        )
    )
    db.flush()
    return user


def _refresh_profile_fields(user: User, identity: VerifiedIdentity) -> None:
    if identity.display_name and not user.display_name:
        user.display_name = identity.display_name
    if identity.avatar_url:
        user.avatar_url = identity.avatar_url


def _mark_verified_from_provider(user: User, identity: VerifiedIdentity) -> None:
    """Marks `user` verified when this provider identity confirms it and
    the user wasn't already verified — never touches `email_verified_at`
    once it's already set, so a returning user's original verification
    moment is preserved rather than churned on every login. A provider
    that does NOT assert email_verified never un-verifies or otherwise
    changes an already-verified user here (this function only ever moves
    False -> True, never the reverse)."""
    if identity.email_verified and not user.email_verified:
        user.email_verified = True
        user.email_verified_at = utcnow()


def upsert_dev_test_user(db: DBSession, *, email: str, display_name: str | None) -> User:
    """Dev-login's user resolution — deliberately simpler than
    upsert_user_from_identity: a dev login is inherently self-asserted
    (there's no external provider confirming anything), so it always trusts
    the caller-supplied email outright rather than running the
    verified-vs-unverified merge logic real OAuth identities go through.
    Only ever called from a code path already gated by
    settings.auth_dev_login_enabled + a non-production app_env (see
    app/api/routes_auth.py).
    """
    normalized_email = normalize_email(email)
    existing_account = db.execute(
        select(OAuthAccount).where(
            OAuthAccount.provider == "dev", OAuthAccount.provider_account_id == normalized_email
        )
    ).scalar_one_or_none()
    if existing_account is not None:
        user = db.get(User, existing_account.user_id)
        assert user is not None
        return user

    user = db.execute(select(User).where(User.email == normalized_email)).scalar_one_or_none()
    if user is None:
        user = User(
            email=normalized_email,
            email_verified=True,
            display_name=display_name or normalized_email,
            is_dev_test_user=True,
        )
        db.add(user)
        db.flush()

    db.add(
        OAuthAccount(
            user_id=user.id,
            provider="dev",
            provider_account_id=normalized_email,
            provider_email=normalized_email,
        )
    )
    db.flush()
    return user


@dataclass(frozen=True)
class RefreshResult:
    tokens: IssuedTokens | None
    theft_detected: bool


def rotate_refresh_token(
    db: DBSession,
    settings: Settings,
    raw_refresh_token: str,
    *,
    user_agent: str | None = None,
    ip_address: str | None = None,
) -> RefreshResult:
    """Redeems one refresh token for a new (access token, refresh token)
    pair, revoking the redeemed one in the same transaction (rotate-on-use).
    Presenting a token that's already been revoked is treated as reuse —
    presumptive theft — and revokes every other active session for that
    user too, forcing a full re-login everywhere.
    """
    token_hash = hash_refresh_token(raw_refresh_token)
    session = db.execute(
        select(SessionModel).where(SessionModel.refresh_token_hash == token_hash)
    ).scalar_one_or_none()
    if session is None:
        return RefreshResult(tokens=None, theft_detected=False)

    now = utcnow()
    if session.revoked_at is not None:
        db.execute(
            update(SessionModel)
            .where(SessionModel.user_id == session.user_id, SessionModel.revoked_at.is_(None))
            .values(revoked_at=now)
        )
        db.commit()
        return RefreshResult(tokens=None, theft_detected=True)

    if ensure_utc(session.expires_at) < now:
        return RefreshResult(tokens=None, theft_detected=False)

    user = db.get(User, session.user_id)
    if user is None or not user.is_active:
        return RefreshResult(tokens=None, theft_detected=False)

    raw_new_refresh = generate_refresh_token()
    new_session = SessionModel(
        user_id=user.id,
        refresh_token_hash=hash_refresh_token(raw_new_refresh),
        expires_at=now + timedelta(days=settings.refresh_token_ttl_days),
        user_agent=user_agent,
        ip_address=ip_address,
    )
    db.add(new_session)
    db.flush()

    session.revoked_at = now
    session.last_used_at = now
    session.replaced_by_session_id = new_session.id
    db.commit()

    access_token = create_access_token(
        user.id, secret=settings.jwt_secret, ttl_minutes=settings.jwt_access_ttl_minutes
    )
    return RefreshResult(
        tokens=IssuedTokens(
            access_token=access_token,
            refresh_token=raw_new_refresh,
            expires_in_seconds=settings.jwt_access_ttl_minutes * 60,
            user=user,
        ),
        theft_detected=False,
    )


def revoke_refresh_token(db: DBSession, raw_refresh_token: str) -> bool:
    """Logout: revokes the session matching this refresh token, if any.
    Returns True if a live session was found and revoked. Never raises for
    an unknown/already-revoked token — logging out is idempotent."""
    token_hash = hash_refresh_token(raw_refresh_token)
    session = db.execute(
        select(SessionModel).where(SessionModel.refresh_token_hash == token_hash)
    ).scalar_one_or_none()
    if session is None or session.revoked_at is not None:
        return False
    session.revoked_at = utcnow()
    db.commit()
    return True


class EmailAlreadyRegisteredError(Exception):
    """Raised by register_local_user when the normalized email already
    belongs to a user who already has a password credential — a genuine
    duplicate-registration attempt. Never raised for an existing
    *OAuth-only* user with the same email; that case links the new
    password onto the existing account instead (see the function's own
    docstring)."""


def register_local_user(
    db: DBSession, *, normalized_email: str, password: str, display_name: str | None
) -> User:
    """Creates a new local (password) account, or attaches a password
    credential to an existing OAuth-only user with the same normalized
    email — never creates a second `users` row for an email that already
    exists (mirrors upsert_user_from_identity's "one user per normalized
    email" invariant). Raises EmailAlreadyRegisteredError if the existing
    user already has a password set, so the caller
    (POST /auth/register) can return a safe, generic 409 without ever
    revealing which provider the existing account actually uses.

    `normalized_email` must already be normalized (see
    app/core/email_normalization.py) — this function does not normalize it
    itself, matching every other function in this module.
    """
    existing = db.execute(
        select(User).where(User.email == normalized_email)
    ).scalar_one_or_none()
    if existing is not None:
        if existing.password_hash is not None:
            raise EmailAlreadyRegisteredError(normalized_email)
        existing.password_hash = hash_password(password)
        if display_name and not existing.display_name:
            existing.display_name = display_name
        db.commit()
        return existing

    user = User(
        email=normalized_email,
        # A self-registered local account has had its email confirmed by
        # no one — never marked verified at creation. Mirrors
        # upsert_user_from_identity's own rule that only a provider's own
        # verified assertion may set this; local registration has no
        # third party to trust, and this app sends no verification email
        # (see deploy/oracle/README.md's "Email verification status").
        email_verified=False,
        password_hash=hash_password(password),
        display_name=display_name,
    )
    db.add(user)
    db.commit()
    return user


# A fixed, non-secret Argon2 hash of an arbitrary constant string —
# verified against on every login attempt that can't reach a real
# verify_password() call (no such user, or an OAuth-only user with no
# password_hash at all), purely to keep authenticate_local_user's execution
# time roughly constant regardless of *why* the attempt failed. Without
# this, "unknown email" would return almost immediately (one indexed SELECT
# miss) while "known email, wrong password" would take however long a real
# Argon2 verify takes — an account-enumeration timing side channel.
# Computed once at import time (hashing takes real, deliberate CPU time —
# doing it per-request would be wasted work for a value that never
# changes) rather than a hand-encoded literal, since that would need
# argon2-cffi's exact parameter/salt encoding maintained by hand for no
# benefit.
_DUMMY_PASSWORD_HASH = hash_password("dummy-password-for-timing-parity-only")


def authenticate_local_user(db: DBSession, *, normalized_email: str, password: str) -> User | None:
    """Returns the matching, active local user if `password` verifies
    against their stored Argon2id hash, else None — covers "no such
    user", "user exists but is OAuth-only (no password set)", "user is
    inactive", and "wrong password" all identically, so the caller
    (POST /auth/login) can return one generic "Invalid email or password"
    for every case without revealing which one actually happened.
    `normalized_email` must already be normalized.
    """
    user = db.execute(
        select(User).where(User.email == normalized_email)
    ).scalar_one_or_none()
    if user is None or user.password_hash is None or not user.is_active:
        verify_password(password, _DUMMY_PASSWORD_HASH)
        return None
    if not verify_password(password, user.password_hash):
        return None
    return user
