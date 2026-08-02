"""Local (email/password) credential hashing — Argon2id via argon2-cffi,
the OWASP-recommended default for new applications and practical to add to
this stack (a well-maintained C-extension wrapper, no other runtime
dependency). Never used for anything except a user's own chosen password:
opaque high-entropy tokens (refresh tokens, OAuth auth codes) are hashed
with plain SHA-256 elsewhere (see app/core/refresh_tokens.py) since a slow
KDF is pointless — and wasted CPU — for an input that's already
384 bits of randomness rather than a low-entropy human-chosen secret.
"""

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerifyMismatchError

# Library defaults (time_cost=3, memory_cost=65536 KiB / 64 MiB,
# parallelism=4) are already within OWASP's current guidance and fit
# comfortably inside this deployment's per-container memory budget (see
# deploy/oracle/docker-compose.oracle.yml's mem_limit) even under several
# concurrent login/register requests — left untuned rather than guessing at
# "better" parameters without a load-tested reason to.
_hasher = PasswordHasher()

# Practical bounds, not composition rules (deliberately no
# uppercase/digit/symbol requirements — see POST /auth/register's
# docstring): 8 matches NIST SP 800-63B's minimum recommended length; 128
# bounds worst-case Argon2 CPU cost per request against an oversized-input
# abuse attempt, well above any real password-manager-generated passphrase.
MIN_PASSWORD_LENGTH = 8
MAX_PASSWORD_LENGTH = 128


def validate_password_policy(password: str) -> str | None:
    """Returns a safe, user-facing error message if `password` violates the
    policy, or None if it's acceptable. Never logs or echoes the password
    itself back in the message."""
    if not password.strip():
        return "Password cannot be empty."
    if len(password) < MIN_PASSWORD_LENGTH:
        return f"Password must be at least {MIN_PASSWORD_LENGTH} characters."
    if len(password) > MAX_PASSWORD_LENGTH:
        return f"Password must be at most {MAX_PASSWORD_LENGTH} characters."
    return None


def hash_password(password: str) -> str:
    """Argon2id-hashes `password`. The returned string is
    self-describing (algorithm + parameters + salt + hash, argon2-cffi's
    standard encoded format) — nothing else needs to be stored alongside
    it to later verify a login attempt."""
    return _hasher.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    """Constant-time (via argon2-cffi's own C implementation) check of
    `password` against a previously stored `hash_password()` output. Never
    raises for a wrong password or a malformed/foreign hash — both are
    simply "doesn't match", indistinguishable to the caller (see
    POST /auth/login's generic "Invalid email or password" response)."""
    try:
        return _hasher.verify(password_hash, password)
    except (VerifyMismatchError, InvalidHashError):
        return False
