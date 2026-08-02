"""Local (email/password) credential hashing — Argon2id via argon2-cffi,
the OWASP-recommended default for new applications and practical to add to
this stack (a well-maintained C-extension wrapper, no other runtime
dependency). Never used for anything except a user's own chosen password:
opaque high-entropy tokens (refresh tokens, OAuth auth codes) are hashed
with plain SHA-256 elsewhere (see app/core/refresh_tokens.py) since a slow
KDF is pointless — and wasted CPU — for an input that's already
384 bits of randomness rather than a low-entropy human-chosen secret.

Whether a candidate password is *acceptable* (length, composition,
denylist, ...) is app/core/password_policy.py's job, not this module's —
this module only knows how to hash/verify a password already accepted by
that policy. It still enforces password_policy.MAX_PASSWORD_LENGTH itself,
defensively, so a caller that skipped policy validation can never make
Argon2 hash/verify an unbounded-length input.
"""

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerifyMismatchError

from app.core.password_policy import MAX_PASSWORD_LENGTH

# Library defaults (time_cost=3, memory_cost=65536 KiB / 64 MiB,
# parallelism=4) are already within OWASP's current guidance and fit
# comfortably inside this deployment's per-container memory budget (see
# deploy/oracle/docker-compose.oracle.yml's mem_limit) even under several
# concurrent login/register requests — left untuned rather than guessing at
# "better" parameters without a load-tested reason to.
_hasher = PasswordHasher()


class PasswordTooLongError(ValueError):
    """Raised by hash_password/verify_password for a password exceeding
    password_policy.MAX_PASSWORD_LENGTH — a defensive, never-expected-in-
    practice guard (every real caller already runs password_policy's
    validate_password_policy() first, which rejects this earlier with a
    friendlier message), never truncates."""


def hash_password(password: str) -> str:
    """Argon2id-hashes `password`. The returned string is
    self-describing (algorithm + parameters + salt + hash, argon2-cffi's
    standard encoded format) — nothing else needs to be stored alongside
    it to later verify a login attempt."""
    if len(password) > MAX_PASSWORD_LENGTH:
        raise PasswordTooLongError(f"Password exceeds {MAX_PASSWORD_LENGTH} characters")
    return _hasher.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    """Constant-time (via argon2-cffi's own C implementation) check of
    `password` against a previously stored `hash_password()` output. Never
    raises for a wrong password or a malformed/foreign hash — both are
    simply "doesn't match", indistinguishable to the caller (see
    POST /auth/login's generic "Invalid email or password" response). An
    over-length password is also simply "doesn't match" here (unlike
    hash_password, which raises) — login must never surface an internal
    length-bound detail to a caller who is, by definition, already wrong
    about the password regardless of its length."""
    if len(password) > MAX_PASSWORD_LENGTH:
        return False
    try:
        return _hasher.verify(password_hash, password)
    except (VerifyMismatchError, InvalidHashError):
        return False
