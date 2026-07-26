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
from app.core.auth_service import (
    issue_tokens_for_user,
    revoke_refresh_token,
    rotate_refresh_token,
    upsert_dev_test_user,
    upsert_user_from_identity,
)
from app.core.jwt import create_access_token
from app.core.oauth_providers import (
    OAuthProviderError,
    build_authorize_url,
    fetch_verified_identity,
    get_provider_config,
)
from app.core.security import CurrentUserDep
from app.core.time_utils import ensure_utc, utcnow
from app.db.models_auth import OAuthAccount, OAuthTransaction, User
from app.deps import DBSessionDep, SettingsDep
from app.schemas.auth import (
    DevLoginRequest,
    LogoutRequest,
    ProviderInfo,
    ProvidersResponse,
    RefreshRequest,
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


def _linked_provider(db: Session, user_id: uuid.UUID) -> str | None:
    """The OAuth provider this user first signed in with, or None for a
    dev-login test account — see upsert_dev_test_user, which never creates
    an OAuthAccount row. A user can only ever accumulate more than one
    linked account through a future "link another provider" flow, which
    doesn't exist yet, so `created_at` ordering here is just defensive."""
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
    return ProvidersResponse(providers=providers, dev_login_enabled=_dev_login_available(settings))


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
                config, code=code, code_verifier=transaction.code_verifier or "", client=client
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

    user = upsert_user_from_identity(db, identity)
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
