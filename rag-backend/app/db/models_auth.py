import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, UniqueConstraint, Uuid, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class User(Base):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    email: Mapped[str] = mapped_column(String(320), unique=True, nullable=False, index=True)
    # True only when the identity provider itself asserts the address is
    # verified (e.g. Google's `email_verified` claim) — never inferred, since
    # this flag is what account-linking-by-email safety decisions key off.
    email_verified: Mapped[bool] = mapped_column(default=False, nullable=False)
    display_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    avatar_url: Mapped[str | None] = mapped_column(String(2048), nullable=True)
    is_active: Mapped[bool] = mapped_column(default=True, nullable=False)
    # Marks accounts created via POST /auth/dev-login — never set by any real
    # OAuth provider path. Lets an admin/report distinguish real users from
    # local test accounts without inferring it from the linked provider.
    is_dev_test_user: Mapped[bool] = mapped_column(default=False, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class OAuthAccount(Base):
    """One row per (provider, provider account) a user has signed in with.
    Deliberately does not store the provider's own access/refresh tokens —
    this app never calls back into Google/Facebook/LinkedIn APIs after login,
    so persisting those would be a needless secret-retention liability.
    Modeled as its own table (not columns on `users`) so a user can link a
    second provider later without a schema change, even though the current
    login flow only ever creates one row at signup time.
    """

    __tablename__ = "oauth_accounts"
    __table_args__ = (
        UniqueConstraint(
            "provider", "provider_account_id", name="uq_oauth_accounts_provider_account"
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    provider: Mapped[str] = mapped_column(String(20), nullable=False)
    provider_account_id: Mapped[str] = mapped_column(String(255), nullable=False)
    provider_email: Mapped[str | None] = mapped_column(String(320), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class Session(Base):
    """A refresh-token session. The raw refresh token is never stored —
    only `refresh_token_hash` (SHA-256 of the raw value) — so a database
    read alone can never yield a usable credential. Refresh is rotate-on-use:
    `/auth/refresh` revokes this row and creates a new one, chained via
    `replaced_by_session_id`; presenting an already-revoked token is treated
    as token theft and revokes the whole chain for that user.
    """

    __tablename__ = "sessions"

    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    refresh_token_hash: Mapped[str] = mapped_column(
        String(128), unique=True, nullable=False, index=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    expires_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, index=True
    )
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # Informational only (shown to the user as "active sessions" material in
    # a future settings UI) — never used in any authorization decision, since
    # both are trivially spoofable request headers.
    user_agent: Mapped[str | None] = mapped_column(String(512), nullable=True)
    ip_address: Mapped[str | None] = mapped_column(String(45), nullable=True)
    replaced_by_session_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("sessions.id"), nullable=True
    )


class OAuthTransaction(Base):
    """Short-lived, single-use, server-side state for one OAuth round trip.
    Two `kind`s share this table rather than getting separate ones, since
    they're structurally identical (an opaque key -> a small payload, with a
    TTL and single-use consumption) and are never queried across each other:

    - kind="state": created by GET /auth/{provider}/authorize, `key` is the
      `state` value handed to the provider, `code_verifier`/`app_redirect_uri`
      hold what /callback needs to complete the exchange. A DB row (not a
      cookie) is required here because the authorize call and the callback
      can legitimately arrive in different HTTP contexts on native (the
      system browser's session, not the app's own cookie jar).
    - kind="auth_code": created by GET /auth/{provider}/callback once our own
      tokens have been minted, `key` is the single-use `auth_code` handed to
      the app in the final redirect, `payload_json` carries what
      POST /auth/session/exchange needs to hand back to the client — the
      raw (pre-hash) refresh token and the user id. This is the only place
      the raw refresh token is ever held anywhere outside the client itself,
      and only for up to 60 seconds, deleted immediately on redemption.
    """

    __tablename__ = "oauth_transactions"

    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    kind: Mapped[str] = mapped_column(String(20), nullable=False)
    key: Mapped[str] = mapped_column(String(128), unique=True, nullable=False, index=True)
    provider: Mapped[str | None] = mapped_column(String(20), nullable=True)
    code_verifier: Mapped[str | None] = mapped_column(String(255), nullable=True)
    app_redirect_uri: Mapped[str | None] = mapped_column(String(2048), nullable=True)
    payload_json: Mapped[str | None] = mapped_column(String(4096), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    expires_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, index=True
    )
    consumed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
