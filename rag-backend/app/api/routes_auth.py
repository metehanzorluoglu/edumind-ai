import base64
import hashlib
import json
import logging
import secrets
import uuid
from datetime import timedelta
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

import httpx
from fastapi import APIRouter, HTTPException, Request, Response, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import Settings
from app.core.auth_rate_limiter import enforce_auth_rate_limit
from app.core.auth_service import (
    EmailAlreadyRegisteredError,
    UnverifiedEmailConflictError,
    authenticate_local_user,
    issue_tokens_for_user,
    register_local_user,
    revoke_refresh_token,
    rotate_refresh_token,
    upsert_dev_test_user,
    upsert_user_from_identity,
)
from app.core.email_provider import EmailDeliveryError, EmailProvider
from app.core.email_templates import build_verification_email
from app.core.jwt import create_access_token
from app.core.oauth_providers import (
    OAuthProviderError,
    build_authorize_url,
    fetch_verified_identity,
    get_provider_config,
)
from app.core.security import CurrentUserDep
from app.core.time_utils import ensure_utc, utcnow
from app.core.verification_service import (
    issue_verification_token,
    redeem_verification_token,
    seconds_since_last_token_issued,
)
from app.db.models_auth import OAuthAccount, OAuthTransaction, User
from app.deps import DBSessionDep, EmailProviderDep, SettingsDep
from app.schemas.auth import (
    DevLoginRequest,
    GenericMessageResponse,
    LoginRequest,
    LogoutRequest,
    ProviderInfo,
    ProvidersResponse,
    RefreshRequest,
    RegisterRequest,
    RegisterResponse,
    ResendVerificationRequest,
    SessionExchangeRequest,
    TokenResponse,
    UserResponse,
)

router = APIRouter(prefix="/auth", tags=["auth"])
logger = logging.getLogger(__name__)

_REFRESH_COOKIE_NAME = "eac_refresh_token"
_STATE_TTL_MINUTES = 10
_AUTH_CODE_TTL_SECONDS = 60
_PROVIDER_NAMES = ("google", "facebook", "linkedin")


def _dev_login_available(settings: Settings) -> bool:
    return settings.auth_dev_login_enabled and settings.app_env != "production"


def _enforce_rate_limit(
    db: Session,
    *,
    route: str,
    request: Request,
    email: str | None,
    max_attempts: int,
    window_seconds: float,
) -> None:
    """Shared by post_register/post_login/get_verify_email/
    post_resend_verification — see app/core/auth_rate_limiter.py for why
    this is DB-backed rather than the in-memory app/core/rate_limiter.py
    (this deployment runs multiple uvicorn workers). `email=None` (used
    by get_verify_email, which has no account until the token is looked
    up) checks only the per-IP bucket. Raises the same 429 shape
    app/api/routes_conversations.py already uses for the chat rate limiter
    (a `Retry-After` header, seconds rounded up to at least 1) — never
    reveals whether the IP or the email bucket was the one that tripped."""
    result = enforce_auth_rate_limit(
        db,
        route=route,
        ip_address=request.client.host if request.client else None,
        email=email,
        max_attempts=max_attempts,
        window_seconds=window_seconds,
    )
    if not result.allowed:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many attempts. Please try again later.",
            headers={"Retry-After": str(max(1, round(result.retry_after_seconds)))},
        )


_GENERIC_RESEND_RESPONSE = (
    "If an account exists for this email and still needs verification, "
    "a new verification email has been sent."
)


def _send_verification_email(
    db: Session, settings: Settings, email_provider: EmailProvider, user: User
) -> None:
    """Issues a fresh token and emails it — shared by post_register and
    post_resend_verification. A delivery failure is logged and swallowed,
    never raised into the route: the account still exists and remains
    resendable (see POST /auth/resend-verification), which is the
    "no partially-created unusable accounts without a recoverable resend
    flow" requirement — a transient SMTP outage must never look like a
    500 to someone who just registered.
    """
    issued = issue_verification_token(
        db, user_id=user.id, ttl_minutes=settings.email_verification_token_ttl_minutes
    )
    verification_url = (
        f"{settings.backend_public_url.rstrip('/')}/auth/verify-email?token={issued.raw_token}"
    )
    content = build_verification_email(
        verification_url=verification_url,
        ttl_minutes=settings.email_verification_token_ttl_minutes,
    )
    try:
        email_provider.send(
            to=user.email,
            subject=content.subject,
            html_body=content.html_body,
            text_body=content.text_body,
        )
    except EmailDeliveryError as exc:
        logger.error("Verification email to user_id=%s could not be sent: %s", user.id, exc)


def _linked_provider(db: Session, user_id: uuid.UUID) -> str | None:
    """The OAuth provider this user first signed in with, or None for a
    dev-login test account — see upsert_dev_test_user, which never creates
    an OAuthAccount row. Also None for a purely local (password-only)
    account with no linked OAuthAccount row at all — see
    register_local_user; the frontend's Settings screen already renders
    None as a plain email address rather than "Signed in with ...", which
    is exactly the right fallback here too. A user can only ever
    accumulate more than one linked account through a future "link another
    provider" flow, which doesn't exist yet, so `created_at` ordering here
    is just defensive."""
    account = db.execute(
        select(OAuthAccount)
        .where(OAuthAccount.user_id == user_id)
        .order_by(OAuthAccount.created_at.asc())
        .limit(1)
    ).scalar_one_or_none()
    return account.provider if account is not None else None


def _user_response(user: User, db: Session) -> UserResponse:
    return UserResponse(
        id=str(user.id),
        email=user.email,
        display_name=user.display_name,
        avatar_url=user.avatar_url,
        is_dev_test_user=user.is_dev_test_user,
        provider=_linked_provider(db, user.id),
    )


def _append_query(url: str, **params: str) -> str:
    parsed = urlparse(url)
    query = dict(parse_qsl(parsed.query))
    query.update(params)
    return urlunparse(parsed._replace(query=urlencode(query)))


def _generate_pkce_pair() -> tuple[str, str]:
    code_verifier = secrets.token_urlsafe(64)
    digest = hashlib.sha256(code_verifier.encode("ascii")).digest()
    code_challenge = base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")
    return code_verifier, code_challenge


def _cookie_secure_flag(request: Request, settings: Settings) -> bool:
    # Production always demands Secure, regardless of the scheme this
    # particular request appears to have arrived over — a misconfigured
    # proxy must never cause an insecure cookie (worst case here is the
    # cookie silently not being stored by the browser, never a leaked one).
    # Outside production (local/LAN dev), Secure is set only when the
    # request itself is actually HTTPS, so plain-HTTP localhost/LAN dev
    # still gets a working cookie (see docs/oauth-setup.md). This also
    # covers LAN access from another machine (e.g. http://192.168.0.99:8000)
    # — the cookie's Domain is left unset (defaults to the exact request
    # host), and SameSite=Lax only restricts cross-*site* requests, not
    # cross-port-same-host ones, so a browser on another LAN machine talking
    # to this same host:port over plain HTTP still sends/receives the cookie
    # normally; only real cross-site or HTTPS-required cases change.
    if settings.app_env == "production":
        return True
    return request.url.scheme == "https"


def _set_refresh_cookie(
    response: Response, raw_refresh_token: str, settings: Settings, *, request: Request
) -> None:
    response.set_cookie(
        key=_REFRESH_COOKIE_NAME,
        value=raw_refresh_token,
        max_age=settings.refresh_token_ttl_days * 86400,
        httponly=True,
        secure=_cookie_secure_flag(request, settings),
        samesite="lax",
        path="/auth",
    )


def _clear_refresh_cookie(response: Response) -> None:
    response.delete_cookie(key=_REFRESH_COOKIE_NAME, path="/auth")


@router.get("/providers", response_model=ProvidersResponse)
def get_providers(settings: SettingsDep) -> ProvidersResponse:
    providers = [
        ProviderInfo(provider=config.name, display_name=config.display_name)
        for name in _PROVIDER_NAMES
        if (config := get_provider_config(name, settings)) is not None
    ]
    return ProvidersResponse(
        providers=providers,
        dev_login_enabled=_dev_login_available(settings),
        local_auth_enabled=settings.auth_local_login_enabled,
    )


@router.post("/register", response_model=RegisterResponse, status_code=status.HTTP_201_CREATED)
def post_register(
    body: RegisterRequest,
    request: Request,
    response: Response,
    settings: SettingsDep,
    db: DBSessionDep,
    email_provider: EmailProviderDep,
) -> RegisterResponse:
    """Creates a local (email/password) account. When
    `settings.auth_email_verification_required` is True (the default —
    see app/config.py), the account is created unverified, a
    verification email is sent, and NO tokens are issued yet — the
    caller only gets a generic success message and must confirm the
    emailed link (GET /auth/verify-email) before POST /auth/login will
    let them in (see that route). When verification is disabled by the
    operator, this behaves exactly like every other login path and signs
    the caller in immediately, same as before this feature existed.

    An existing OAuth-only user with the same normalized email gets this
    password attached to their existing account instead of a second user
    being created — see register_local_user's docstring.
    """
    if not settings.auth_local_login_enabled:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")

    _enforce_rate_limit(
        db,
        route="register",
        request=request,
        email=body.email,
        max_attempts=settings.auth_register_rate_limit_max_attempts,
        window_seconds=settings.auth_register_rate_limit_window_seconds,
    )

    try:
        user = register_local_user(
            db,
            normalized_email=body.email,
            password=body.password,
            display_name=body.display_name,
        )
    except EmailAlreadyRegisteredError as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="An account with this email already exists.",
        ) from exc

    if settings.auth_email_verification_required and not user.email_verified:
        _send_verification_email(db, settings, email_provider, user)
        return RegisterResponse(
            email_verification_required=True,
            message=(
                "Account created. Check your email for a link to verify your address "
                "before signing in."
            ),
        )

    if not user.email_verified:
        # Verification is disabled by the operator (auth_email_verification_
        # required=False) — mark this account verified immediately rather
        # than leaving it permanently unverified. Otherwise, re-enabling
        # verification later would silently lock out every account created
        # while it was off, exactly the "unexpected lockout of existing
        # legitimate accounts" this feature must avoid.
        user.email_verified = True
        user.email_verified_at = utcnow()
        db.commit()

    tokens = issue_tokens_for_user(
        db,
        settings,
        user,
        user_agent=request.headers.get("user-agent"),
        ip_address=request.client.host if request.client else None,
    )
    _set_refresh_cookie(response, tokens.refresh_token, settings, request=request)
    return RegisterResponse(
        email_verification_required=False,
        message="Account created.",
        access_token=tokens.access_token,
        refresh_token=tokens.refresh_token,
        expires_in=tokens.expires_in_seconds,
        user=_user_response(user, db),
    )


@router.post("/login", response_model=TokenResponse)
def post_login(
    body: LoginRequest,
    request: Request,
    response: Response,
    settings: SettingsDep,
    db: DBSessionDep,
) -> TokenResponse:
    """Local email/password sign-in — reuses the exact same session/token
    architecture as every OAuth login path (see issue_tokens_for_user).
    Always returns the same generic 401 for an unknown email, an
    OAuth-only account (no password set), an inactive account, and a
    genuinely wrong password — never reveals which one actually happened
    (see authenticate_local_user).
    """
    if not settings.auth_local_login_enabled:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")

    _enforce_rate_limit(
        db,
        route="login",
        request=request,
        email=body.email,
        max_attempts=settings.auth_login_rate_limit_max_attempts,
        window_seconds=settings.auth_login_rate_limit_window_seconds,
    )

    user = authenticate_local_user(db, normalized_email=body.email, password=body.password)
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid email or password"
        )

    if settings.auth_email_verification_required and not user.email_verified:
        # A distinct status (403, not 401) and a short, stable,
        # machine-readable `detail` string — never a full sentence — so
        # the frontend can reliably distinguish "credentials were correct
        # but this account isn't verified yet" from "wrong credentials"
        # without any special response body shape. Same convention this
        # codebase already uses for the OAuth callback's `auth_error`
        # redirect codes (e.g. "email_required", "email_conflict"). No
        # tokens are issued past this point.
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="email_verification_required"
        )

    tokens = issue_tokens_for_user(
        db,
        settings,
        user,
        user_agent=request.headers.get("user-agent"),
        ip_address=request.client.host if request.client else None,
    )
    _set_refresh_cookie(response, tokens.refresh_token, settings, request=request)
    return TokenResponse(
        access_token=tokens.access_token,
        refresh_token=tokens.refresh_token,
        expires_in=tokens.expires_in_seconds,
        user=_user_response(user, db),
    )


@router.get("/verify-email")
def get_verify_email(
    token: str, request: Request, settings: SettingsDep, db: DBSessionDep
) -> Response:
    """The link a verification email sends the user to (see
    _send_verification_email) — redeems the single-use token server-side,
    then redirects the browser to the frontend's /verify-email page with
    a `status` query param (`success` | `invalid` | `expired` |
    `already_used`) it renders a safe outcome page from. This route
    itself never returns tokens and never redirects with anything
    sensitive in the query string — `status` is the only value appended;
    the (now-consumed, one-time) verification token is not echoed back.

    Rate-limited by IP only (no account is known until the token is
    looked up) — protects against brute-forcing token values.
    """
    _enforce_rate_limit(
        db,
        route="verify-email",
        request=request,
        email=None,
        max_attempts=settings.auth_verify_rate_limit_max_attempts,
        window_seconds=settings.auth_verify_rate_limit_window_seconds,
    )

    result = redeem_verification_token(db, raw_token=token)
    status_param = "success" if result.ok else (result.reason or "invalid")
    frontend_verify_url = f"{settings.frontend_url.rstrip('/')}/verify-email"
    return Response(
        status_code=status.HTTP_302_FOUND,
        headers={"Location": _append_query(frontend_verify_url, status=status_param)},
    )


@router.post("/resend-verification", response_model=GenericMessageResponse)
def post_resend_verification(
    body: ResendVerificationRequest,
    request: Request,
    settings: SettingsDep,
    db: DBSessionDep,
    email_provider: EmailProviderDep,
) -> GenericMessageResponse:
    """Always returns the exact same response regardless of whether the
    address is registered, already verified, or OAuth-only — see
    _GENERIC_RESEND_RESPONSE. A new email is only actually sent when the
    account exists, is local (has a password), is still unverified, and
    the per-account resend cooldown (settings.
    email_verification_resend_cooldown_seconds) has elapsed since the
    last one — independent of, and in addition to, the request-volume
    rate limit enforced first below.
    """
    _enforce_rate_limit(
        db,
        route="resend-verification",
        request=request,
        email=body.email,
        max_attempts=settings.auth_resend_verification_rate_limit_max_attempts,
        window_seconds=settings.auth_resend_verification_rate_limit_window_seconds,
    )

    user = db.execute(select(User).where(User.email == body.email)).scalar_one_or_none()
    if user is not None and user.password_hash is not None and not user.email_verified:
        elapsed = seconds_since_last_token_issued(db, user_id=user.id)
        if elapsed is None or elapsed >= settings.email_verification_resend_cooldown_seconds:
            _send_verification_email(db, settings, email_provider, user)

    return GenericMessageResponse(detail=_GENERIC_RESEND_RESPONSE)


@router.get("/{provider}/authorize")
def get_authorize(
    provider: str, redirect_uri: str, settings: SettingsDep, db: DBSessionDep
) -> Response:
    config = get_provider_config(provider, settings)
    if config is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Unknown or unconfigured provider '{provider}'",
        )
    if redirect_uri not in settings.allowed_auth_redirect_uris_list:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="redirect_uri is not on the allowed list",
        )

    code_verifier, code_challenge = _generate_pkce_pair()
    state = secrets.token_urlsafe(32)
    db.add(
        OAuthTransaction(
            kind="state",
            key=state,
            provider=provider,
            code_verifier=code_verifier,
            app_redirect_uri=redirect_uri,
            expires_at=utcnow() + timedelta(minutes=_STATE_TTL_MINUTES),
        )
    )
    db.commit()

    authorize_url = build_authorize_url(config, state=state, code_challenge=code_challenge)
    return Response(status_code=status.HTTP_302_FOUND, headers={"Location": authorize_url})


@router.get("/{provider}/callback")
def get_callback(
    provider: str, code: str, state: str, settings: SettingsDep, db: DBSessionDep
) -> Response:
    config = get_provider_config(provider, settings)
    if config is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Unknown or unconfigured provider '{provider}'",
        )

    transaction = db.execute(
        select(OAuthTransaction).where(
            OAuthTransaction.kind == "state", OAuthTransaction.key == state
        )
    ).scalar_one_or_none()
    if (
        transaction is None
        or transaction.consumed_at is not None
        or transaction.provider != provider
        or ensure_utc(transaction.expires_at) < utcnow()
    ):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid or expired OAuth state"
        )

    transaction.consumed_at = utcnow()
    db.commit()

    app_redirect_uri = transaction.app_redirect_uri
    if app_redirect_uri is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid OAuth state")

    try:
        with httpx.Client() as client:
            identity = fetch_verified_identity(
                config,
                code=code,
                code_verifier=transaction.code_verifier or "",
                client=client,
                # `state` doubles as the nonce this transaction's authorize
                # call sent to the provider (see build_authorize_url) — the
                # only value this callback has to compare an id_token's own
                # nonce claim against.
                expected_nonce=state,
            )
    except OAuthProviderError as exc:
        # Never logs `code` or any provider secret — OAuthProviderError's
        # own messages are static/generic by construction (see
        # app/core/oauth_providers.py) and never interpolate either.
        logger.warning("OAuth callback failed for provider=%s: %s", provider, exc)
        return Response(
            status_code=status.HTTP_302_FOUND,
            headers={"Location": _append_query(app_redirect_uri, auth_error="provider_error")},
        )

    if identity.email is None:
        return Response(
            status_code=status.HTTP_302_FOUND,
            headers={"Location": _append_query(app_redirect_uri, auth_error="email_required")},
        )

    try:
        user = upsert_user_from_identity(db, identity)
    except UnverifiedEmailConflictError:
        # Never a raw 500 (see UnverifiedEmailConflictError's docstring) —
        # a safe redirect the frontend can turn into "sign in with your
        # existing method for this email instead" copy (see
        # AuthProvider.tsx's describeAuthError). Never logs the email
        # itself: which specific address collided is not privileged
        # information this log line needs to carry.
        logger.warning("OAuth callback for provider=%s: unverified email conflict", provider)
        return Response(
            status_code=status.HTTP_302_FOUND,
            headers={"Location": _append_query(app_redirect_uri, auth_error="email_conflict")},
        )
    tokens = issue_tokens_for_user(db, settings, user)

    auth_code = secrets.token_urlsafe(32)
    db.add(
        OAuthTransaction(
            kind="auth_code",
            key=auth_code,
            provider=provider,
            payload_json=json.dumps(
                {"refresh_token": tokens.refresh_token, "user_id": str(user.id)}
            ),
            expires_at=utcnow() + timedelta(seconds=_AUTH_CODE_TTL_SECONDS),
        )
    )
    db.commit()

    return Response(
        status_code=status.HTTP_302_FOUND,
        headers={"Location": _append_query(app_redirect_uri, auth_code=auth_code)},
    )


@router.post("/session/exchange", response_model=TokenResponse)
def post_session_exchange(
    body: SessionExchangeRequest,
    request: Request,
    response: Response,
    settings: SettingsDep,
    db: DBSessionDep,
) -> TokenResponse:
    """Redeems the single-use `auth_code` from GET /{provider}/callback's
    redirect for real tokens. Tokens are never put in a URL — this is the
    only place they're ever handed to the client, in a JSON response body.
    """
    transaction = db.execute(
        select(OAuthTransaction).where(
            OAuthTransaction.kind == "auth_code", OAuthTransaction.key == body.auth_code
        )
    ).scalar_one_or_none()
    if (
        transaction is None
        or transaction.consumed_at is not None
        or ensure_utc(transaction.expires_at) < utcnow()
    ):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid or expired auth_code"
        )

    transaction.consumed_at = utcnow()
    db.commit()

    payload = json.loads(transaction.payload_json or "{}")
    refresh_token = payload.get("refresh_token")
    user_id_str = payload.get("user_id")
    if not isinstance(refresh_token, str) or not isinstance(user_id_str, str):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid auth_code")

    user = db.get(User, uuid.UUID(user_id_str))
    if user is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid auth_code")

    access_token = create_access_token(
        user.id, secret=settings.jwt_secret, ttl_minutes=settings.jwt_access_ttl_minutes
    )
    _set_refresh_cookie(response, refresh_token, settings, request=request)
    return TokenResponse(
        access_token=access_token,
        refresh_token=refresh_token,
        expires_in=settings.jwt_access_ttl_minutes * 60,
        user=_user_response(user, db),
    )


@router.post("/refresh", response_model=TokenResponse)
def post_refresh(
    body: RefreshRequest,
    request: Request,
    response: Response,
    settings: SettingsDep,
    db: DBSessionDep,
) -> TokenResponse:
    raw_token = body.refresh_token or request.cookies.get(_REFRESH_COOKIE_NAME)
    if not raw_token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="No refresh token provided"
        )

    result = rotate_refresh_token(
        db,
        settings,
        raw_token,
        user_agent=request.headers.get("user-agent"),
        ip_address=request.client.host if request.client else None,
    )
    if result.theft_detected:
        _clear_refresh_cookie(response)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Refresh token reuse detected; all sessions have been revoked",
        )
    if result.tokens is None:
        _clear_refresh_cookie(response)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired refresh token"
        )

    _set_refresh_cookie(response, result.tokens.refresh_token, settings, request=request)
    return TokenResponse(
        access_token=result.tokens.access_token,
        refresh_token=result.tokens.refresh_token,
        expires_in=result.tokens.expires_in_seconds,
        user=_user_response(result.tokens.user, db),
    )


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
def post_logout(
    body: LogoutRequest, request: Request, response: Response, db: DBSessionDep
) -> None:
    raw_token = body.refresh_token or request.cookies.get(_REFRESH_COOKIE_NAME)
    if raw_token:
        revoke_refresh_token(db, raw_token)
    _clear_refresh_cookie(response)


@router.get("/me", response_model=UserResponse)
def get_me(user: CurrentUserDep, db: DBSessionDep) -> UserResponse:
    return _user_response(user, db)


@router.post("/dev-login", response_model=TokenResponse)
def post_dev_login(
    body: DevLoginRequest,
    request: Request,
    response: Response,
    settings: SettingsDep,
    db: DBSessionDep,
) -> TokenResponse:
    """Signs in as any {email} with no real OAuth provider — development
    and test convenience only. Refuses with 404 (not 403: this endpoint
    should look like it doesn't exist, not like it exists-but-is-forbidden)
    whenever disabled, and is *always* disabled when app_env=="production"
    regardless of AUTH_DEV_LOGIN_ENABLED (see _dev_login_available)."""
    if not _dev_login_available(settings):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")

    user = upsert_dev_test_user(db, email=body.email, display_name=body.display_name)
    tokens = issue_tokens_for_user(db, settings, user)
    _set_refresh_cookie(response, tokens.refresh_token, settings, request=request)
    return TokenResponse(
        access_token=tokens.access_token,
        refresh_token=tokens.refresh_token,
        expires_in=tokens.expires_in_seconds,
        user=_user_response(user, db),
    )
