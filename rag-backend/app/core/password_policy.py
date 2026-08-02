"""Centralized password-strength policy — the one place every candidate
password is validated (currently POST /auth/register; any future
password-change/reset route must import this too, never re-implement its
own rules) so requirements can never drift between call sites.

Deliberately separate from app/core/password_hashing.py: that module only
knows how to hash/verify an already-*accepted* password; this module
decides whether a candidate password is accepted at all. Never logs or
echoes the password itself anywhere in this module.
"""

import re
from dataclasses import dataclass

MIN_PASSWORD_LENGTH = 12
# Bounds worst-case Argon2 CPU cost per request against an oversized-input
# abuse attempt (a multi-megabyte "password" would make every hash/verify
# call expensive) — well above any real password-manager-generated
# passphrase. Enforced here, before hashing is ever attempted, and
# defensively again inside password_hashing.hash_password/verify_password.
MAX_PASSWORD_LENGTH = 128

_UPPERCASE_RE = re.compile(r"[A-Z]")
_LOWERCASE_RE = re.compile(r"[a-z]")
_DIGIT_RE = re.compile(r"[0-9]")
_SYMBOL_RE = re.compile(r"[^A-Za-z0-9]")

# Local, curated denylist — never sent to a third-party service (no
# candidate password ever leaves this process to be checked). Small and
# hand-picked rather than a large imported breach corpus: no existing
# dependency in this project bundles one, and maintaining a
# multi-hundred-thousand-entry list is out of proportion to a
# small/self-hosted deployment's actual threat model — this list exists to
# catch the well-known, formulaic passwords (this project's own explicit
# examples plus their common variants), not to be a general-purpose breach
# database. Checked case-insensitively against the *whole* password, never
# a substring match (a substring match would reject too aggressively —
# e.g. any password merely containing "admin" as a word fragment).
_COMMON_PASSWORDS = frozenset(
    {
        "12345678",
        "123456789",
        "1234567890",
        "password",
        "password1",
        "password123",
        "password1234",
        "password123!",
        "passw0rd",
        "passw0rd123",
        "qwerty123",
        "qwertyuiop",
        "letmein",
        "letmein123",
        "admin123",
        "administrator",
        "welcome123",
        "welcome1",
        "iloveyou",
        "iloveyou1",
        "monkey123",
        "dragon123",
        "sunshine1",
        "princess1",
        "football1",
        "baseball1",
        "trustno1",
        "abcdefgh",
        "abcd1234",
        "changeme",
        "changeme1",
        "master123",
        "shadow123",
        "superman1",
        "batman123",
        "michael1",
        "jennifer1",
        "starwars1",
        "freedom123",
        "whatever1",
        "hello1234",
        "hunter12",
        "flower123",
        "summer123",
        "winter123",
        "autumn123",
        "spring123",
    }
)


@dataclass(frozen=True)
class PasswordPolicyError:
    """One structured, frontend-displayable validation failure. `code` is
    a stable machine-readable identifier the frontend's live checklist
    keys off of; `message` is the safe, human-readable English fallback."""

    code: str
    message: str


def _has_only_repeated_or_sequential_chars(password: str) -> bool:
    """True when the password is entirely one repeated character or one
    ascending/descending run of consecutive code points —
    "aaaaaaaaaaaa", "abcdefghijkl", "cba987654321" all satisfy the
    individual composition checks (a run can happen to mix upper/lower/
    digit) but are trivially guessable via a single, well-known vector,
    not because they represent real password entropy."""
    if len(set(password)) <= 1:
        return True
    ascending = all(
        ord(password[i + 1]) - ord(password[i]) == 1 for i in range(len(password) - 1)
    )
    descending = all(
        ord(password[i]) - ord(password[i + 1]) == 1 for i in range(len(password) - 1)
    )
    return ascending or descending


# Email-local-part/name substrings shorter than this are too likely to
# produce false-positive rejections of an otherwise-strong password (e.g.
# a 2-3 character local part like "jo@example.com" appearing incidentally
# inside a long passphrase) — matches this module's other "don't
# over-reject" judgment calls (see the denylist's whole-string-only match).
_MIN_SUBSTRING_LENGTH = 4


def validate_password_policy(
    password: str, *, normalized_email: str = "", display_name: str | None = None
) -> list[PasswordPolicyError]:
    """Returns every violated rule (never just the first) so a frontend
    live-updating checklist can show every unmet requirement at once — an
    empty list means the password is accepted. `normalized_email` should
    already be normalized (see app/core/email_normalization.py)."""
    errors: list[PasswordPolicyError] = []

    if not password.strip():
        errors.append(PasswordPolicyError("empty", "Password cannot be empty."))
        return errors  # every other check is meaningless against ""

    if len(password) < MIN_PASSWORD_LENGTH:
        errors.append(
            PasswordPolicyError(
                "min_length", f"Password must be at least {MIN_PASSWORD_LENGTH} characters."
            )
        )
    if len(password) > MAX_PASSWORD_LENGTH:
        errors.append(
            PasswordPolicyError(
                "max_length", f"Password must be at most {MAX_PASSWORD_LENGTH} characters."
            )
        )
    if not _UPPERCASE_RE.search(password):
        errors.append(
            PasswordPolicyError("uppercase", "Password must contain an uppercase letter.")
        )
    if not _LOWERCASE_RE.search(password):
        errors.append(
            PasswordPolicyError("lowercase", "Password must contain a lowercase letter.")
        )
    if not _DIGIT_RE.search(password):
        errors.append(PasswordPolicyError("digit", "Password must contain a number."))
    if not _SYMBOL_RE.search(password):
        errors.append(PasswordPolicyError("symbol", "Password must contain a special character."))

    if _has_only_repeated_or_sequential_chars(password):
        errors.append(
            PasswordPolicyError(
                "repeated_or_sequential",
                "Password must not be made of repeated or sequential characters.",
            )
        )

    if password.lower() in _COMMON_PASSWORDS:
        errors.append(
            PasswordPolicyError("common_password", "This password is too common. Choose another.")
        )

    normalized_password = password.lower()
    contains_identity = False
    if normalized_email and normalized_email in normalized_password:
        contains_identity = True
    elif normalized_email:
        local_part = normalized_email.split("@", 1)[0]
        if len(local_part) >= _MIN_SUBSTRING_LENGTH and local_part in normalized_password:
            contains_identity = True
    if not contains_identity and display_name:
        name_parts = [
            part.lower() for part in re.split(r"\s+", display_name.strip()) if len(part) >= 3
        ]
        contains_identity = any(part in normalized_password for part in name_parts)
    if contains_identity:
        errors.append(
            PasswordPolicyError(
                "contains_identity", "Password must not contain your email address or name."
            )
        )

    return errors
