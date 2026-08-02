"""Single source of truth for how an email address is normalized and
format-validated across every auth entry point (OAuth identity linking,
local registration, local login) — previously each call site inlined its
own `.strip().lower()`, which is easy to let drift (e.g. one path
normalizing before a uniqueness check and another after).
"""

import re

# Pragmatic RFC 5322-adjacent check, not a full grammar implementation:
# local-part@domain, domain has at least one dot, no whitespace or a second
# '@' anywhere. Good enough to catch real typos ("user@", "user@domain",
# "user domain.com") without the maintenance cost or false-negative risk of
# a "complete" RFC 5322 regex — actual deliverability can only ever be
# confirmed by a real verification email, which this app does not send
# (see app/api/routes_auth.py's register endpoint docstring).
_EMAIL_FORMAT_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

# Matches users.email's column width (String(320)) in app/db/models_auth.py
# — RFC 3696's own practical upper bound for a full email address.
MAX_EMAIL_LENGTH = 320


def normalize_email(email: str) -> str:
    """The one normalization every stored/compared email address must go
    through: trims surrounding whitespace, lowercases. Never call
    `.strip().lower()` directly elsewhere — route new code through this so
    registration, login, and OAuth linking can never disagree on identity."""
    return email.strip().lower()


def is_valid_email_format(email: str) -> bool:
    """Format-only check — does not confirm the address is real or
    reachable (this app has no email-sending capability; see
    POST /auth/register's docstring). Expects an already-normalized email."""
    if not email or len(email) > MAX_EMAIL_LENGTH:
        return False
    return _EMAIL_FORMAT_RE.match(email) is not None
