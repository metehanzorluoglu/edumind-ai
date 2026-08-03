"""Covers the production email/Google authentication work: local
email/password registration and login (POST /auth/register,
POST /auth/login), the DB-backed rate limiter protecting both
(app/core/auth_rate_limiter.py — needed because this deployment runs
multiple uvicorn workers, see deploy/oracle/docker-compose.oracle.yml),
and GET /auth/providers' new `local_auth_enabled` field. Also locks in
regression coverage for the pre-existing OAuth/session machinery this
work reuses (refresh rotation, logout revocation, current-user, and
production's hard-refusal of dev-login) so a future change to shared code
(app/core/auth_service.py, app/api/routes_auth.py) can't silently break
local auth's foundation.

Builds a minimal FastAPI app around just the real auth router, backed by
a fresh on-disk SQLite database per test (Base.metadata.create_all — the
full Alembic migration chain is covered separately by
test_auth_migration_0015.py), with get_settings/get_db overridden via
FastAPI's own dependency_overrides. No network I/O, no real Ollama/Qdrant
dependency.
"""

import os
import re
import tempfile
import time
import uuid
from collections.abc import Iterator
from datetime import timedelta

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.api.routes_auth import router as auth_router
from app.config import Settings, get_settings
from app.core.auth_service import upsert_user_from_identity
from app.core.oauth_providers import VerifiedIdentity
from app.core.time_utils import utcnow
from app.db.base import Base
from app.db.models_auth import OAuthTransaction, User
from app.db.session import get_db
from app.deps import get_email_provider, get_session_factory_dep

_TEST_JWT_SECRET = "test-only-secret-not-a-real-credential-32chars"


def _build_settings(**overrides: object) -> Settings:
    defaults: dict[str, object] = {
        "jwt_secret": _TEST_JWT_SECRET,
        "app_env": "test",
        "auth_local_login_enabled": True,
        "auth_login_rate_limit_max_attempts": 3,
        "auth_login_rate_limit_window_seconds": 60.0,
        "auth_register_rate_limit_max_attempts": 3,
        "auth_register_rate_limit_window_seconds": 60.0,
    }
    defaults.update(overrides)
    return Settings(**defaults)  # type: ignore[arg-type]


@pytest.fixture
def db_engine() -> Iterator[object]:
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    engine = create_engine(f"sqlite:///{path}", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    try:
        yield engine
    finally:
        engine.dispose()
        os.remove(path)


class _CapturingEmailProvider:
    """Test double standing in for EmailProviderDep — captures every
    "sent" email instead of delivering it, so a test can extract the
    verification token from the same link a real recipient would click
    (see _extract_verification_token) rather than reaching into the DB
    for something only the raw email ever carries."""

    def __init__(self) -> None:
        self.sent: list[dict[str, str]] = []

    def send(self, *, to: str, subject: str, html_body: str, text_body: str) -> None:
        self.sent.append(
            {"to": to, "subject": subject, "html_body": html_body, "text_body": text_body}
        )


def _extract_verification_token(email_body: str) -> str:
    match = re.search(r"token=([^&\s\"<]+)", email_body)
    assert match is not None, f"no token= found in email body: {email_body!r}"
    return match.group(1)


def _make_client(db_engine: object, settings: Settings) -> TestClient:
    app = FastAPI()
    app.include_router(auth_router)
    factory = sessionmaker(bind=db_engine, autoflush=False, expire_on_commit=False)

    def override_get_db() -> Iterator[object]:
        db = factory()
        try:
            yield db
        finally:
            db.close()

    email_provider = _CapturingEmailProvider()
    app.dependency_overrides[get_settings] = lambda: settings
    app.dependency_overrides[get_db] = override_get_db
    # The verification-email background task (see routes_auth.py's
    # _send_verification_email_task) opens its own session via this
    # dependency rather than get_db — must point at the same test engine,
    # or it would silently reach for the real, global DATABASE_URL.
    app.dependency_overrides[get_session_factory_dep] = lambda: factory
    app.dependency_overrides[get_email_provider] = lambda: email_provider
    client = TestClient(app)
    client.sent_emails = email_provider.sent  # type: ignore[attr-defined]
    return client


def _register_and_verify(
    client: TestClient,
    *,
    email: str,
    password: str,
    display_name: str | None = None,
) -> None:
    """Registers a local account and immediately redeems its verification
    email's token — the standard setup step for any test that needs a
    ready-to-log-in local account and isn't itself testing the
    registration/verification flow."""
    client.post(
        "/auth/register",
        json={"email": email, "password": password, "display_name": display_name},
    )
    sent_emails: list[dict[str, str]] = client.sent_emails  # type: ignore[attr-defined]
    assert sent_emails, "expected a verification email to have been sent"
    token = _extract_verification_token(sent_emails[-1]["text_body"])
    response = client.get("/auth/verify-email", params={"token": token}, follow_redirects=False)
    assert response.status_code == 302
    assert "status=success" in response.headers["location"]


def _seed_oauth_user(db_engine: object, *, email: str = "oauthonly@example.com") -> uuid.UUID:
    """Seeds a verified Google-linked user with no password — mirrors a
    real pre-existing OAuth user, for testing local-auth interaction with
    OAuth-only accounts."""
    factory = sessionmaker(bind=db_engine, autoflush=False, expire_on_commit=False)
    db = factory()
    try:
        user = upsert_user_from_identity(
            db,
            VerifiedIdentity(
                provider="google",
                provider_account_id="google-sub-123",
                email=email,
                email_verified=True,
                display_name="OAuth User",
                avatar_url=None,
            ),
        )
        db.commit()
        return user.id
    finally:
        db.close()


def _seed_transaction(
    db_engine: object,
    *,
    key: str,
    kind: str = "state",
    provider: str = "google",
    code_verifier: str = "verifier",
    app_redirect_uri: str = "https://edum8.us/auth-callback",
    expires_in_seconds: float = 600.0,
    consumed: bool = False,
) -> None:
    factory = sessionmaker(bind=db_engine, autoflush=False, expire_on_commit=False)
    db = factory()
    try:
        db.add(
            OAuthTransaction(
                kind=kind,
                key=key,
                provider=provider,
                code_verifier=code_verifier,
                app_redirect_uri=app_redirect_uri,
                expires_at=utcnow() + timedelta(seconds=expires_in_seconds),
                consumed_at=utcnow() if consumed else None,
            )
        )
        db.commit()
    finally:
        db.close()


def _extract_auth_code(location: str) -> str:
    return location.split("auth_code=")[1].split("&")[0]


class TestRegister:
    def test_success_with_verification_required_returns_generic_response_and_sends_email(
        self, db_engine: object
    ) -> None:
        client = _make_client(db_engine, _build_settings())
        response = client.post(
            "/auth/register",
            json={"email": "new@example.com", "password": "Str0ng!Passphrase#1"},
        )
        assert response.status_code == 201
        body = response.json()
        assert body["email_verification_required"] is True
        assert body["access_token"] is None
        assert body["refresh_token"] is None
        assert body["user"] is None
        sent_emails: list[dict[str, str]] = client.sent_emails  # type: ignore[attr-defined]
        assert len(sent_emails) == 1
        assert sent_emails[0]["to"] == "new@example.com"
        assert sent_emails[0]["subject"] == "Verify your EduM8 email address"

    def test_success_with_verification_disabled_issues_tokens_immediately(
        self, db_engine: object
    ) -> None:
        client = _make_client(db_engine, _build_settings(auth_email_verification_required=False))
        response = client.post(
            "/auth/register",
            json={"email": "new2@example.com", "password": "Str0ng!Passphrase#1"},
        )
        assert response.status_code == 201
        body = response.json()
        assert body["email_verification_required"] is False
        assert body["access_token"]
        assert body["refresh_token"]
        assert body["token_type"] == "bearer"
        assert body["expires_in"] > 0
        assert body["user"]["email"] == "new2@example.com"
        sent_emails: list[dict[str, str]] = client.sent_emails  # type: ignore[attr-defined]
        assert sent_emails == []

    def test_normalizes_email(self, db_engine: object) -> None:
        client = _make_client(db_engine, _build_settings())
        response = client.post(
            "/auth/register",
            json={"email": "  User@Example.COM ", "password": "Str0ng!Passphrase#1"},
        )
        assert response.status_code == 201
        factory = sessionmaker(bind=db_engine, autoflush=False, expire_on_commit=False)
        db = factory()
        try:
            assert db.query(User).filter(User.email == "user@example.com").count() == 1
        finally:
            db.close()

    def test_duplicate_email_is_conflict(self, db_engine: object) -> None:
        client = _make_client(db_engine, _build_settings())
        client.post(
            "/auth/register", json={"email": "dupe@example.com", "password": "Str0ngFirst!Pass#1"}
        )
        response = client.post(
            "/auth/register", json={"email": "dupe@example.com", "password": "Str0ngSecond!Pass#2"}
        )
        assert response.status_code == 409

    def test_invalid_email_format_is_rejected(self, db_engine: object) -> None:
        client = _make_client(db_engine, _build_settings())
        response = client.post(
            "/auth/register", json={"email": "not-an-email", "password": "Str0ng!Passphrase#1"}
        )
        assert response.status_code == 422

    def test_weak_password_is_rejected(self, db_engine: object) -> None:
        client = _make_client(db_engine, _build_settings())
        response = client.post(
            "/auth/register", json={"email": "weak@example.com", "password": "short"}
        )
        assert response.status_code == 422

    def test_excessively_long_password_is_rejected(self, db_engine: object) -> None:
        client = _make_client(db_engine, _build_settings())
        response = client.post(
            "/auth/register", json={"email": "long@example.com", "password": "x" * 200}
        )
        assert response.status_code == 422

    def test_password_is_hashed_never_stored_plaintext(self, db_engine: object) -> None:
        client = _make_client(db_engine, _build_settings())
        client.post(
            "/auth/register",
            json={"email": "hashed@example.com", "password": "Str0ng!Passphrase#1"},
        )
        factory = sessionmaker(bind=db_engine, autoflush=False, expire_on_commit=False)
        db = factory()
        try:
            user = db.query(User).filter(User.email == "hashed@example.com").one()
            assert user.password_hash is not None
            assert user.password_hash != "Str0ng!Passphrase#1"
            assert "Str0ng!Passphrase#1" not in user.password_hash
            assert user.password_hash.startswith("$argon2id$")
        finally:
            db.close()

    def test_response_never_includes_password_hash(self, db_engine: object) -> None:
        client = _make_client(db_engine, _build_settings())
        response = client.post(
            "/auth/register",
            json={"email": "noleak@example.com", "password": "Str0ng!Passphrase#1"},
        )
        assert "password_hash" not in response.text
        # email_verification_required defaults True — no `user` object is
        # returned by this response at all yet (see RegisterResponse).
        assert response.json()["user"] is None

    def test_links_password_onto_existing_oauth_only_user(self, db_engine: object) -> None:
        user_id = _seed_oauth_user(db_engine, email="linkme@example.com")
        client = _make_client(db_engine, _build_settings())
        response = client.post(
            "/auth/register",
            json={"email": "linkme@example.com", "password": "Str0ng!Passphrase#1"},
        )
        assert response.status_code == 201
        assert response.json()["user"]["id"] == str(user_id)

        factory = sessionmaker(bind=db_engine, autoflush=False, expire_on_commit=False)
        db = factory()
        try:
            assert db.query(User).filter(User.email == "linkme@example.com").count() == 1
        finally:
            db.close()

    def test_disabled_returns_404(self, db_engine: object) -> None:
        client = _make_client(db_engine, _build_settings(auth_local_login_enabled=False))
        response = client.post(
            "/auth/register", json={"email": "x@example.com", "password": "Str0ng!Passphrase#1"}
        )
        assert response.status_code == 404


class TestLogin:
    def test_success(self, db_engine: object) -> None:
        client = _make_client(db_engine, _build_settings())
        _register_and_verify(client, email="login@example.com", password="Str0ng!Passw0rd#1")
        response = client.post(
            "/auth/login", json={"email": "login@example.com", "password": "Str0ng!Passw0rd#1"}
        )
        assert response.status_code == 200
        body = response.json()
        assert body["access_token"]
        assert body["refresh_token"]
        assert body["user"]["email"] == "login@example.com"

    def test_blocked_before_verification(self, db_engine: object) -> None:
        client = _make_client(db_engine, _build_settings())
        client.post(
            "/auth/register",
            json={"email": "unverified@example.com", "password": "Str0ng!Passw0rd#1"},
        )
        response = client.post(
            "/auth/login", json={"email": "unverified@example.com", "password": "Str0ng!Passw0rd#1"}
        )
        assert response.status_code == 403
        assert response.json()["detail"] == "email_verification_required"

    def test_succeeds_after_verification(self, db_engine: object) -> None:
        client = _make_client(db_engine, _build_settings())
        client.post(
            "/auth/register",
            json={"email": "willverify@example.com", "password": "Str0ng!Passw0rd#1"},
        )
        blocked = client.post(
            "/auth/login", json={"email": "willverify@example.com", "password": "Str0ng!Passw0rd#1"}
        )
        assert blocked.status_code == 403

        sent_emails: list[dict[str, str]] = client.sent_emails  # type: ignore[attr-defined]
        token = _extract_verification_token(sent_emails[-1]["text_body"])
        client.get("/auth/verify-email", params={"token": token}, follow_redirects=False)

        allowed = client.post(
            "/auth/login", json={"email": "willverify@example.com", "password": "Str0ng!Passw0rd#1"}
        )
        assert allowed.status_code == 200
        assert allowed.json()["access_token"]

    def test_verification_not_required_when_disabled(self, db_engine: object) -> None:
        client = _make_client(db_engine, _build_settings(auth_email_verification_required=False))
        client.post(
            "/auth/register",
            json={"email": "noverify@example.com", "password": "Str0ng!Passw0rd#1"},
        )
        response = client.post(
            "/auth/login", json={"email": "noverify@example.com", "password": "Str0ng!Passw0rd#1"}
        )
        assert response.status_code == 200

    def test_wrong_password_is_generic_401(self, db_engine: object) -> None:
        client = _make_client(db_engine, _build_settings())
        client.post(
            "/auth/register",
            json={"email": "wrongpw@example.com", "password": "Str0ng!Passw0rd#1"},
        )
        response = client.post(
            "/auth/login", json={"email": "wrongpw@example.com", "password": "totally-wrong"}
        )
        assert response.status_code == 401
        assert response.json()["detail"] == "Invalid email or password"

    def test_unknown_email_is_same_generic_401(self, db_engine: object) -> None:
        client = _make_client(db_engine, _build_settings())
        response = client.post(
            "/auth/login", json={"email": "nobody@example.com", "password": "whatever-password"}
        )
        assert response.status_code == 401
        assert response.json()["detail"] == "Invalid email or password"

    def test_malformed_email_does_not_422_and_is_generic_401(self, db_engine: object) -> None:
        # Login deliberately does not format-validate the email (unlike
        # register) — a malformed address must fail exactly like any other
        # wrong credential, never a distinguishable 422.
        client = _make_client(db_engine, _build_settings())
        response = client.post(
            "/auth/login", json={"email": "not-an-email-at-all", "password": "whatever-password"}
        )
        assert response.status_code == 401
        assert response.json()["detail"] == "Invalid email or password"

    def test_oauth_only_account_gets_same_generic_401(self, db_engine: object) -> None:
        _seed_oauth_user(db_engine, email="oauthonly2@example.com")
        client = _make_client(db_engine, _build_settings())
        response = client.post(
            "/auth/login", json={"email": "oauthonly2@example.com", "password": "whatever-password"}
        )
        assert response.status_code == 401
        assert response.json()["detail"] == "Invalid email or password"

    def test_response_never_includes_password_hash(self, db_engine: object) -> None:
        client = _make_client(db_engine, _build_settings())
        _register_and_verify(client, email="noleak2@example.com", password="Str0ng!Passw0rd#1")
        response = client.post(
            "/auth/login", json={"email": "noleak2@example.com", "password": "Str0ng!Passw0rd#1"}
        )
        assert response.status_code == 200
        assert "password_hash" not in response.text

    def test_disabled_returns_404(self, db_engine: object) -> None:
        client = _make_client(db_engine, _build_settings(auth_local_login_enabled=False))
        response = client.post(
            "/auth/login", json={"email": "x@example.com", "password": "whatever-password"}
        )
        assert response.status_code == 404

    def test_refresh_rotation_works_for_a_local_login_session(self, db_engine: object) -> None:
        client = _make_client(db_engine, _build_settings())
        _register_and_verify(client, email="rotate@example.com", password="Str0ng!Passw0rd#1")
        login = client.post(
            "/auth/login", json={"email": "rotate@example.com", "password": "Str0ng!Passw0rd#1"}
        )
        old_refresh = login.json()["refresh_token"]

        refreshed = client.post("/auth/refresh", json={"refresh_token": old_refresh})
        assert refreshed.status_code == 200
        assert refreshed.json()["refresh_token"] != old_refresh

        reused = client.post("/auth/refresh", json={"refresh_token": old_refresh})
        assert reused.status_code == 401

    def test_logout_revokes_the_session(self, db_engine: object) -> None:
        client = _make_client(db_engine, _build_settings())
        _register_and_verify(client, email="logout@example.com", password="Str0ng!Passw0rd#1")
        login = client.post(
            "/auth/login", json={"email": "logout@example.com", "password": "Str0ng!Passw0rd#1"}
        )
        refresh_token = login.json()["refresh_token"]

        logout = client.post("/auth/logout", json={"refresh_token": refresh_token})
        assert logout.status_code == 204

        refreshed = client.post("/auth/refresh", json={"refresh_token": refresh_token})
        assert refreshed.status_code == 401

    def test_current_user_route_works_after_local_login(self, db_engine: object) -> None:
        client = _make_client(db_engine, _build_settings())
        _register_and_verify(client, email="me@example.com", password="Str0ng!Passw0rd#1")
        login = client.post(
            "/auth/login", json={"email": "me@example.com", "password": "Str0ng!Passw0rd#1"}
        )
        access_token = login.json()["access_token"]

        me = client.get("/auth/me", headers={"Authorization": f"Bearer {access_token}"})
        assert me.status_code == 200
        assert me.json()["email"] == "me@example.com"
        # A purely local account has no linked OAuthAccount row.
        assert me.json()["provider"] is None


class TestAuthRateLimiting:
    def test_login_blocks_after_max_attempts_with_retry_after(self, db_engine: object) -> None:
        settings = _build_settings(
            auth_login_rate_limit_max_attempts=3, auth_login_rate_limit_window_seconds=60.0
        )
        client = _make_client(db_engine, settings)
        client.post(
            "/auth/register",
            json={"email": "limited@example.com", "password": "Str0ng!Passw0rd#1"},
        )

        for _ in range(3):
            response = client.post(
                "/auth/login", json={"email": "limited@example.com", "password": "wrong-password"}
            )
            assert response.status_code == 401

        blocked = client.post(
            "/auth/login", json={"email": "limited@example.com", "password": "wrong-password"}
        )
        assert blocked.status_code == 429
        assert int(blocked.headers["Retry-After"]) >= 1

    def test_register_blocks_after_max_attempts(self, db_engine: object) -> None:
        settings = _build_settings(
            auth_register_rate_limit_max_attempts=2, auth_register_rate_limit_window_seconds=60.0
        )
        client = _make_client(db_engine, settings)
        for i in range(2):
            response = client.post(
                "/auth/register",
                json={"email": f"reg{i}@example.com", "password": "Str0ng!Passw0rd#1"},
            )
            assert response.status_code == 201

        # A third *distinct* email from the same client IP still trips the
        # per-IP bucket, independent of the (now-satisfied) per-email one.
        blocked = client.post(
            "/auth/register",
            json={"email": "reg-third@example.com", "password": "Str0ng!Passw0rd#1"},
        )
        assert blocked.status_code == 429

    def test_rate_limit_resets_after_window_expires(self, db_engine: object) -> None:
        settings = _build_settings(
            auth_login_rate_limit_max_attempts=1, auth_login_rate_limit_window_seconds=1.0
        )
        client = _make_client(db_engine, settings)
        client.post(
            "/auth/register",
            json={"email": "expiring@example.com", "password": "Str0ng!Passw0rd#1"},
        )

        first = client.post(
            "/auth/login", json={"email": "expiring@example.com", "password": "wrong-password"}
        )
        assert first.status_code == 401
        blocked = client.post(
            "/auth/login", json={"email": "expiring@example.com", "password": "wrong-password"}
        )
        assert blocked.status_code == 429

        time.sleep(1.1)
        allowed_again = client.post(
            "/auth/login", json={"email": "expiring@example.com", "password": "wrong-password"}
        )
        assert allowed_again.status_code == 401  # rejected on credentials, not rate limit

    def test_lockout_response_identical_for_real_and_unknown_account(
        self, db_engine: object
    ) -> None:
        settings = _build_settings(
            auth_login_rate_limit_max_attempts=1, auth_login_rate_limit_window_seconds=60.0
        )
        client_a = _make_client(db_engine, settings)
        client_a.post(
            "/auth/register", json={"email": "real@example.com", "password": "Str0ng!Passw0rd#1"}
        )
        # Distinct clients so each gets its own default TestClient IP is
        # the same (testclient), so use distinct emails to isolate buckets
        # instead — the per-email bucket is what's under test here.
        client_a.post(
            "/auth/login", json={"email": "real@example.com", "password": "wrong-password"}
        )
        blocked_real = client_a.post(
            "/auth/login", json={"email": "real@example.com", "password": "wrong-password"}
        )

        client_b = _make_client(db_engine, settings)
        client_b.post(
            "/auth/login", json={"email": "ghost@example.com", "password": "wrong-password"}
        )
        blocked_ghost = client_b.post(
            "/auth/login", json={"email": "ghost@example.com", "password": "wrong-password"}
        )

        assert blocked_real.status_code == blocked_ghost.status_code == 429
        assert blocked_real.json()["detail"] == blocked_ghost.json()["detail"]


class TestProviderDiscovery:
    def test_local_auth_enabled_reported_true_by_default(self, db_engine: object) -> None:
        client = _make_client(db_engine, _build_settings())
        response = client.get("/auth/providers")
        assert response.status_code == 200
        assert response.json()["local_auth_enabled"] is True

    def test_local_auth_enabled_reported_false_when_disabled(self, db_engine: object) -> None:
        client = _make_client(db_engine, _build_settings(auth_local_login_enabled=False))
        response = client.get("/auth/providers")
        assert response.json()["local_auth_enabled"] is False

    def test_google_absent_when_unconfigured(self, db_engine: object) -> None:
        client = _make_client(db_engine, _build_settings())
        response = client.get("/auth/providers")
        providers = [p["provider"] for p in response.json()["providers"]]
        assert "google" not in providers

    def test_google_present_when_fully_configured(self, db_engine: object) -> None:
        settings = _build_settings(
            google_client_id="client-id-123",
            google_client_secret="client-secret-123",
            google_redirect_uri="https://api.edum8.us/auth/google/callback",
        )
        client = _make_client(db_engine, settings)
        response = client.get("/auth/providers")
        providers = {p["provider"]: p for p in response.json()["providers"]}
        assert "google" in providers
        assert providers["google"]["display_name"] == "Google"

    def test_google_absent_when_only_partially_configured(self, db_engine: object) -> None:
        settings = _build_settings(
            google_client_id="client-id-123", google_client_secret="", google_redirect_uri=""
        )
        client = _make_client(db_engine, settings)
        response = client.get("/auth/providers")
        providers = [p["provider"] for p in response.json()["providers"]]
        assert "google" not in providers

    def test_one_unavailable_provider_does_not_disable_local_auth(self, db_engine: object) -> None:
        # Google left unconfigured entirely, local auth still fully usable.
        client = _make_client(db_engine, _build_settings())
        providers_response = client.get("/auth/providers")
        assert providers_response.json()["providers"] == []
        assert providers_response.json()["local_auth_enabled"] is True

        register_response = client.post(
            "/auth/register",
            json={"email": "stillworks@example.com", "password": "Str0ng!Passw0rd#1"},
        )
        assert register_response.status_code == 201


class TestDevLoginProductionRejection:
    def test_dev_login_rejected_in_production_even_if_flag_is_true(self, db_engine: object) -> None:
        settings = _build_settings(app_env="production", auth_dev_login_enabled=True)
        client = _make_client(db_engine, settings)
        response = client.post("/auth/dev-login", json={"email": "dev@example.com"})
        assert response.status_code == 404


def _google_settings(**overrides: object) -> Settings:
    return _build_settings(
        google_client_id="client-id",
        google_client_secret="client-secret",
        google_redirect_uri="https://api.edum8.us/auth/google/callback",
        allowed_auth_redirect_uris="https://edum8.us/auth-callback",
        **overrides,
    )


def _fake_identity(
    *, email: str, email_verified: bool = True, provider_account_id: str = "sub-1"
) -> object:
    def _fetch(*_args: object, **_kwargs: object) -> VerifiedIdentity:
        return VerifiedIdentity(
            provider="google",
            provider_account_id=provider_account_id,
            email=email,
            email_verified=email_verified,
            display_name=None,
            avatar_url=None,
        )

    return _fetch


class TestGoogleOAuthFlow:
    """Regression coverage for the pre-existing (unchanged in logic,
    except the nonce-verification fix — see
    app/core/oauth_providers.py::_google_identity) Google OAuth/PKCE
    flow, which had no test coverage before this task."""

    def test_successful_login_end_to_end(self, db_engine: object, monkeypatch: object) -> None:
        client = _make_client(db_engine, _google_settings())
        _seed_transaction(db_engine, key="state-ok")
        monkeypatch.setattr(  # type: ignore[attr-defined]
            "app.api.routes_auth.fetch_verified_identity",
            _fake_identity(email="googleuser@example.com"),
        )
        callback = client.get(
            "/auth/google/callback",
            params={"code": "auth-code-abc", "state": "state-ok"},
            follow_redirects=False,
        )
        assert callback.status_code == 302
        auth_code = _extract_auth_code(callback.headers["location"])

        exchange = client.post("/auth/session/exchange", json={"auth_code": auth_code})
        assert exchange.status_code == 200
        assert exchange.json()["user"]["email"] == "googleuser@example.com"

    def test_invalid_state_is_rejected(self, db_engine: object) -> None:
        client = _make_client(db_engine, _google_settings())
        response = client.get(
            "/auth/google/callback", params={"code": "x", "state": "never-seeded"}
        )
        assert response.status_code == 400

    def test_expired_transaction_is_rejected(self, db_engine: object) -> None:
        client = _make_client(db_engine, _google_settings())
        _seed_transaction(db_engine, key="state-expired", expires_in_seconds=-10.0)
        response = client.get(
            "/auth/google/callback", params={"code": "x", "state": "state-expired"}
        )
        assert response.status_code == 400

    def test_invalid_nonce_is_rejected(self, db_engine: object, monkeypatch: object) -> None:
        client = _make_client(db_engine, _google_settings())
        _seed_transaction(db_engine, key="state-nonce")

        def _fetch(config: object, *, expected_nonce: str | None = None, **_kwargs: object) -> None:
            from app.core.oauth_providers import OAuthProviderError

            # Simulates what _google_identity itself now does when the
            # id_token's nonce claim doesn't match `expected_nonce` — the
            # real check lives in oauth_providers.py; this test proves the
            # callback route reacts to that failure the same safe way it
            # reacts to any other OAuthProviderError.
            if expected_nonce != "state-nonce":
                raise AssertionError("expected_nonce was not threaded through from `state`")
            raise OAuthProviderError("Google id_token failed nonce verification")

        monkeypatch.setattr("app.api.routes_auth.fetch_verified_identity", _fetch)  # type: ignore[attr-defined]
        response = client.get(
            "/auth/google/callback",
            params={"code": "x", "state": "state-nonce"},
            follow_redirects=False,
        )
        assert response.status_code == 302
        assert "auth_error=provider_error" in response.headers["location"]

    def test_duplicate_callback_reuse_is_rejected(
        self, db_engine: object, monkeypatch: object
    ) -> None:
        client = _make_client(db_engine, _google_settings())
        _seed_transaction(db_engine, key="state-dup")
        monkeypatch.setattr(  # type: ignore[attr-defined]
            "app.api.routes_auth.fetch_verified_identity", _fake_identity(email="dup@example.com")
        )
        first = client.get(
            "/auth/google/callback",
            params={"code": "x", "state": "state-dup"},
            follow_redirects=False,
        )
        assert first.status_code == 302
        second = client.get(
            "/auth/google/callback",
            params={"code": "x", "state": "state-dup"},
            follow_redirects=False,
        )
        assert second.status_code == 400

    def test_reused_exchange_code_is_rejected(self, db_engine: object, monkeypatch: object) -> None:
        client = _make_client(db_engine, _google_settings())
        _seed_transaction(db_engine, key="state-exchange")
        monkeypatch.setattr(  # type: ignore[attr-defined]
            "app.api.routes_auth.fetch_verified_identity",
            _fake_identity(email="exchange@example.com"),
        )
        callback = client.get(
            "/auth/google/callback",
            params={"code": "x", "state": "state-exchange"},
            follow_redirects=False,
        )
        auth_code = _extract_auth_code(callback.headers["location"])

        first_exchange = client.post("/auth/session/exchange", json={"auth_code": auth_code})
        assert first_exchange.status_code == 200
        second_exchange = client.post("/auth/session/exchange", json={"auth_code": auth_code})
        assert second_exchange.status_code == 400

    def test_missing_google_configuration_returns_404(self, db_engine: object) -> None:
        client = _make_client(db_engine, _build_settings())
        response = client.get(
            "/auth/google/authorize", params={"redirect_uri": "https://edum8.us/auth-callback"}
        )
        assert response.status_code == 404

    def test_partially_configured_google_returns_404(self, db_engine: object) -> None:
        client = _make_client(db_engine, _build_settings(google_client_id="only-client-id"))
        response = client.get(
            "/auth/google/authorize", params={"redirect_uri": "https://edum8.us/auth-callback"}
        )
        assert response.status_code == 404

    def test_verified_email_links_to_existing_local_user(
        self, db_engine: object, monkeypatch: object
    ) -> None:
        client = _make_client(db_engine, _google_settings())
        client.post(
            "/auth/register",
            json={"email": "linkgoogle@example.com", "password": "Str0ng!Passw0rd#1"},
        )
        factory = sessionmaker(bind=db_engine, autoflush=False, expire_on_commit=False)
        db = factory()
        try:
            local_user = db.query(User).filter(User.email == "linkgoogle@example.com").one()
            local_user_id = str(local_user.id)
        finally:
            db.close()

        _seed_transaction(db_engine, key="state-link")
        monkeypatch.setattr(  # type: ignore[attr-defined]
            "app.api.routes_auth.fetch_verified_identity",
            _fake_identity(email="linkgoogle@example.com"),
        )
        callback = client.get(
            "/auth/google/callback",
            params={"code": "x", "state": "state-link"},
            follow_redirects=False,
        )
        auth_code = _extract_auth_code(callback.headers["location"])
        exchange = client.post("/auth/session/exchange", json={"auth_code": auth_code})
        assert exchange.json()["user"]["id"] == local_user_id

        factory = sessionmaker(bind=db_engine, autoflush=False, expire_on_commit=False)
        db = factory()
        try:
            assert db.query(User).filter(User.email == "linkgoogle@example.com").count() == 1
        finally:
            db.close()

    def test_unverified_email_conflict_is_a_safe_redirect_not_a_crash(
        self, db_engine: object, monkeypatch: object
    ) -> None:
        client = _make_client(db_engine, _google_settings())
        client.post(
            "/auth/register",
            json={"email": "targetvictim@example.com", "password": "Str0ng!Passw0rd#1"},
        )

        _seed_transaction(db_engine, key="state-unverified")
        monkeypatch.setattr(  # type: ignore[attr-defined]
            "app.api.routes_auth.fetch_verified_identity",
            _fake_identity(email="targetvictim@example.com", email_verified=False),
        )
        callback = client.get(
            "/auth/google/callback",
            params={"code": "x", "state": "state-unverified"},
            follow_redirects=False,
        )
        assert callback.status_code == 302
        assert "auth_error=email_conflict" in callback.headers["location"]

        factory = sessionmaker(bind=db_engine, autoflush=False, expire_on_commit=False)
        db = factory()
        try:
            users = db.query(User).filter(User.email == "targetvictim@example.com").all()
            assert len(users) == 1
            assert users[0].password_hash is not None  # the original local user, untouched
        finally:
            db.close()

    def test_duplicate_normalized_email_never_creates_two_users(
        self, db_engine: object, monkeypatch: object
    ) -> None:
        client = _make_client(db_engine, _google_settings())
        _seed_transaction(db_engine, key="state-first")
        monkeypatch.setattr(  # type: ignore[attr-defined]
            "app.api.routes_auth.fetch_verified_identity",
            _fake_identity(email="samewrit@example.com", provider_account_id="sub-a"),
        )
        first = client.get(
            "/auth/google/callback",
            params={"code": "x", "state": "state-first"},
            follow_redirects=False,
        )
        first_exchange = client.post(
            "/auth/session/exchange",
            json={"auth_code": _extract_auth_code(first.headers["location"])},
        )
        first_user_id = first_exchange.json()["user"]["id"]

        # A second, *different* verified provider identity (different
        # provider_account_id) claiming the same normalized email — this
        # must link to the same existing user, never create a second one
        # (which users.email's UNIQUE constraint would reject anyway).
        _seed_transaction(db_engine, key="state-second")
        monkeypatch.setattr(  # type: ignore[attr-defined]
            "app.api.routes_auth.fetch_verified_identity",
            _fake_identity(email="samewrit@example.com", provider_account_id="sub-b"),
        )
        second = client.get(
            "/auth/google/callback",
            params={"code": "x", "state": "state-second"},
            follow_redirects=False,
        )
        second_exchange = client.post(
            "/auth/session/exchange",
            json={"auth_code": _extract_auth_code(second.headers["location"])},
        )

        assert second_exchange.json()["user"]["id"] == first_user_id

        factory = sessionmaker(bind=db_engine, autoflush=False, expire_on_commit=False)
        db = factory()
        try:
            assert db.query(User).filter(User.email == "samewrit@example.com").count() == 1
        finally:
            db.close()


class TestEmailVerification:
    def test_resend_generic_response_for_unknown_email(self, db_engine: object) -> None:
        client = _make_client(db_engine, _build_settings())
        response = client.post(
            "/auth/resend-verification", json={"email": "nobody-resend@example.com"}
        )
        assert response.status_code == 200
        assert "detail" in response.json()
        sent_emails: list[dict[str, str]] = client.sent_emails  # type: ignore[attr-defined]
        assert sent_emails == []

    def test_resend_sends_a_new_email_for_an_existing_unverified_account(
        self, db_engine: object
    ) -> None:
        settings = _build_settings(email_verification_resend_cooldown_seconds=1)
        client = _make_client(db_engine, settings)
        client.post(
            "/auth/register",
            json={"email": "resendme@example.com", "password": "Str0ng!Passw0rd#1"},
        )
        sent_emails: list[dict[str, str]] = client.sent_emails  # type: ignore[attr-defined]
        assert len(sent_emails) == 1

        time.sleep(1.1)  # past the (minimum-allowed) 1-second resend cooldown
        response = client.post("/auth/resend-verification", json={"email": "resendme@example.com"})
        assert response.status_code == 200
        assert len(sent_emails) == 2

    def test_resend_response_identical_for_unknown_and_already_verified_accounts(
        self, db_engine: object
    ) -> None:
        client = _make_client(db_engine, _build_settings(auth_email_verification_required=False))
        client.post(
            "/auth/register",
            json={"email": "alreadyverified@example.com", "password": "Str0ng!Passw0rd#1"},
        )
        verified_response = client.post(
            "/auth/resend-verification", json={"email": "alreadyverified@example.com"}
        )
        unknown_response = client.post(
            "/auth/resend-verification", json={"email": "totally-unknown@example.com"}
        )
        assert verified_response.status_code == unknown_response.status_code == 200
        assert verified_response.json() == unknown_response.json()
        # Neither actually triggers a send: the account is already
        # verified, the other doesn't exist.
        sent_emails: list[dict[str, str]] = client.sent_emails  # type: ignore[attr-defined]
        assert sent_emails == []

    def test_resend_cooldown_prevents_immediate_repeat_send(self, db_engine: object) -> None:
        settings = _build_settings(email_verification_resend_cooldown_seconds=3600)
        client = _make_client(db_engine, settings)
        client.post(
            "/auth/register",
            json={"email": "cooldown@example.com", "password": "Str0ng!Passw0rd#1"},
        )
        sent_emails: list[dict[str, str]] = client.sent_emails  # type: ignore[attr-defined]
        assert len(sent_emails) == 1

        client.post("/auth/resend-verification", json={"email": "cooldown@example.com"})
        # Cooldown blocks a second send within the same hour — the
        # generic response is still returned either way.
        assert len(sent_emails) == 1

    def test_resend_rate_limit_returns_429(self, db_engine: object) -> None:
        settings = _build_settings(
            auth_resend_verification_rate_limit_max_attempts=2,
            auth_resend_verification_rate_limit_window_seconds=60.0,
        )
        client = _make_client(db_engine, settings)
        for _ in range(2):
            response = client.post(
                "/auth/resend-verification", json={"email": "ratelimited@example.com"}
            )
            assert response.status_code == 200
        blocked = client.post(
            "/auth/resend-verification", json={"email": "ratelimited@example.com"}
        )
        assert blocked.status_code == 429

    def test_verify_invalid_token_redirects_with_invalid_status(self, db_engine: object) -> None:
        settings = _build_settings(frontend_url="https://edum8.us")
        client = _make_client(db_engine, settings)
        response = client.get(
            "/auth/verify-email", params={"token": "not-a-real-token"}, follow_redirects=False
        )
        assert response.status_code == 302
        assert "status=invalid" in response.headers["location"]
        assert response.headers["location"].startswith("https://edum8.us/verify-email")

    def test_verify_expired_token_redirects_with_expired_status(self, db_engine: object) -> None:
        settings = _build_settings(email_verification_token_ttl_minutes=1)
        client = _make_client(db_engine, settings)
        client.post(
            "/auth/register",
            json={"email": "expiredtoken@example.com", "password": "Str0ng!Passw0rd#1"},
        )
        sent_emails: list[dict[str, str]] = client.sent_emails  # type: ignore[attr-defined]
        token = _extract_verification_token(sent_emails[-1]["text_body"])

        factory = sessionmaker(bind=db_engine, autoflush=False, expire_on_commit=False)
        db = factory()
        try:
            from datetime import timedelta as _timedelta

            from app.core.time_utils import utcnow as _utcnow
            from app.db.models_auth import EmailVerificationToken

            row = db.query(EmailVerificationToken).one()
            row.expires_at = _utcnow() - _timedelta(minutes=1)
            db.commit()
        finally:
            db.close()

        response = client.get("/auth/verify-email", params={"token": token}, follow_redirects=False)
        assert "status=expired" in response.headers["location"]

    def test_verify_already_used_token_cannot_be_replayed(self, db_engine: object) -> None:
        client = _make_client(db_engine, _build_settings())
        client.post(
            "/auth/register",
            json={"email": "replay@example.com", "password": "Str0ng!Passw0rd#1"},
        )
        sent_emails: list[dict[str, str]] = client.sent_emails  # type: ignore[attr-defined]
        token = _extract_verification_token(sent_emails[-1]["text_body"])

        first = client.get("/auth/verify-email", params={"token": token}, follow_redirects=False)
        assert "status=success" in first.headers["location"]

        second = client.get("/auth/verify-email", params={"token": token}, follow_redirects=False)
        assert "status=already_used" in second.headers["location"]

    def test_verify_rate_limit_returns_429(self, db_engine: object) -> None:
        settings = _build_settings(
            auth_verify_rate_limit_max_attempts=2, auth_verify_rate_limit_window_seconds=60.0
        )
        client = _make_client(db_engine, settings)
        for _ in range(2):
            response = client.get(
                "/auth/verify-email", params={"token": "bogus"}, follow_redirects=False
            )
            assert response.status_code == 302
        blocked = client.get("/auth/verify-email", params={"token": "bogus"})
        assert blocked.status_code == 429

    def test_resending_issues_a_new_token_and_revokes_the_old_one(self, db_engine: object) -> None:
        settings = _build_settings(email_verification_resend_cooldown_seconds=1)
        client = _make_client(db_engine, settings)
        client.post(
            "/auth/register",
            json={"email": "revoked@example.com", "password": "Str0ng!Passw0rd#1"},
        )
        sent_emails: list[dict[str, str]] = client.sent_emails  # type: ignore[attr-defined]
        old_token = _extract_verification_token(sent_emails[-1]["text_body"])

        time.sleep(1.1)  # past the (minimum-allowed) 1-second resend cooldown
        client.post("/auth/resend-verification", json={"email": "revoked@example.com"})
        new_token = _extract_verification_token(sent_emails[-1]["text_body"])
        assert new_token != old_token

        old_result = client.get(
            "/auth/verify-email", params={"token": old_token}, follow_redirects=False
        )
        assert "status=already_used" in old_result.headers["location"]

        new_result = client.get(
            "/auth/verify-email", params={"token": new_token}, follow_redirects=False
        )
        assert "status=success" in new_result.headers["location"]


class TestOAuthAccountLinkingMarksEmailVerified:
    def test_linking_a_verified_google_identity_marks_a_previously_unverified_local_user_verified(
        self, db_engine: object, monkeypatch: object
    ) -> None:
        client = _make_client(db_engine, _google_settings())
        client.post(
            "/auth/register",
            json={"email": "linkverify@example.com", "password": "Str0ng!Passw0rd#1"},
        )

        factory = sessionmaker(bind=db_engine, autoflush=False, expire_on_commit=False)
        db = factory()
        try:
            user_before = db.query(User).filter(User.email == "linkverify@example.com").one()
            assert user_before.email_verified is False
            assert user_before.email_verified_at is None
        finally:
            db.close()

        _seed_transaction(db_engine, key="state-linkverify")
        monkeypatch.setattr(  # type: ignore[attr-defined]
            "app.api.routes_auth.fetch_verified_identity",
            _fake_identity(email="linkverify@example.com", provider_account_id="sub-linkverify"),
        )
        callback = client.get(
            "/auth/google/callback",
            params={"code": "x", "state": "state-linkverify"},
            follow_redirects=False,
        )
        client.post(
            "/auth/session/exchange",
            json={"auth_code": _extract_auth_code(callback.headers["location"])},
        )

        db = factory()
        try:
            user_after = db.query(User).filter(User.email == "linkverify@example.com").one()
            assert user_after.email_verified is True
            assert user_after.email_verified_at is not None
        finally:
            db.close()

        # Now able to log in locally too, without ever clicking the
        # original verification email.
        login = client.post(
            "/auth/login",
            json={"email": "linkverify@example.com", "password": "Str0ng!Passw0rd#1"},
        )
        assert login.status_code == 200
