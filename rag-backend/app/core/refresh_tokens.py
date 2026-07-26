import hashlib
import secrets

# 48 random bytes (~64 url-safe chars) — high-entropy enough that hashing
# with a plain, fast digest (not a slow password KDF) is appropriate: this
# is never a low-entropy, human-chosen secret the way a password is.
_TOKEN_BYTES = 48


def generate_refresh_token() -> str:
    return secrets.token_urlsafe(_TOKEN_BYTES)


def hash_refresh_token(raw_token: str) -> str:
    return hashlib.sha256(raw_token.encode("utf-8")).hexdigest()
