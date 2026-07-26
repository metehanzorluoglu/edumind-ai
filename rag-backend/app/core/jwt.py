import uuid
from datetime import timedelta

import jwt

from app.core.time_utils import utcnow

_ALGORITHM = "HS256"


class InvalidAccessTokenError(Exception):
    """Raised for any access token that fails to verify — expired, bad
    signature, or malformed. Deliberately does not distinguish which (mirrors
    the previous verify_api_key's single generic 401): a more specific error
    would let a caller fingerprint *why* their token failed, which isn't
    useful information to hand back.
    """


def create_access_token(user_id: uuid.UUID, *, secret: str, ttl_minutes: int) -> str:
    now = utcnow()
    payload = {
        "sub": str(user_id),
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(minutes=ttl_minutes)).timestamp()),
    }
    return jwt.encode(payload, secret, algorithm=_ALGORITHM)


def decode_access_token(token: str, *, secret: str) -> uuid.UUID:
    """Returns the user id encoded in a valid, unexpired access token.
    Raises InvalidAccessTokenError for anything else (expired, bad
    signature, malformed, or missing/invalid `sub` claim)."""
    try:
        payload = jwt.decode(token, secret, algorithms=[_ALGORITHM])
    except jwt.PyJWTError as exc:
        raise InvalidAccessTokenError(str(exc)) from exc

    sub = payload.get("sub")
    if not isinstance(sub, str):
        raise InvalidAccessTokenError("Access token is missing a 'sub' claim")
    try:
        return uuid.UUID(sub)
    except ValueError as exc:
        raise InvalidAccessTokenError("Access token 'sub' claim is not a valid user id") from exc
