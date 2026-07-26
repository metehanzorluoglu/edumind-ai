from typing import Annotated

from fastapi import Depends, Header, HTTPException, status

from app.core.jwt import InvalidAccessTokenError, decode_access_token
from app.db.models_auth import User
from app.deps import DBSessionDep, SettingsDep

_BEARER_PREFIX = "Bearer "


def get_current_user(
    db: DBSessionDep,
    settings: SettingsDep,
    authorization: Annotated[str | None, Header()] = None,
) -> User:
    """Resolves the caller's access token to a live, active user — the
    single auth gate for every protected route in this app (replaces the
    old shared-static-API-key check; see IMPLEMENTATION_PLAN's auth stage).
    Deliberately returns the same generic 401 for every failure mode
    (missing header, malformed token, expired token, unknown/inactive
    user) — distinguishing them in the response would help an attacker
    fingerprint why a token failed for no legitimate benefit to a real
    caller, who only ever needs to know "log in again"."""
    if authorization is None or not authorization.startswith(_BEARER_PREFIX):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing or malformed Authorization header. Expected: Bearer <access_token>",
        )

    token = authorization.removeprefix(_BEARER_PREFIX).strip()
    try:
        user_id = decode_access_token(token, secret=settings.jwt_secret)
    except InvalidAccessTokenError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired access token"
        ) from exc

    user = db.get(User, user_id)
    if user is None or not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired access token"
        )

    return user


CurrentUserDep = Annotated[User, Depends(get_current_user)]
