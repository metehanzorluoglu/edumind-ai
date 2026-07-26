import re

_MAX_WORDS = 8
_MAX_CHARS = 60
_ELLIPSIS = "…"

# Strips ASCII/C1 control characters (including newlines/tabs) but keeps
# ordinary printable text — a title is rendered as plain text by the
# frontend (never raw HTML), so this is a defense-in-depth data hygiene
# measure, not an XSS control.
_CONTROL_CHARS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


def sanitize_title(raw: str) -> str:
    """Collapses whitespace and strips control characters from a
    user-supplied conversation title (see PATCH /conversations/{id})."""
    without_control_chars = _CONTROL_CHARS.sub("", raw)
    return re.sub(r"\s+", " ", without_control_chars).strip()


def generate_title(first_message: str) -> str:
    """Deterministic conversation title from a user's first message — no LLM
    call. Collapses whitespace, takes the first _MAX_WORDS words, and caps
    the result at _MAX_CHARS characters at a word boundary, appending an
    ellipsis if either limit truncated the source text."""
    collapsed = sanitize_title(first_message)
    if not collapsed:
        return "New conversation"

    words = collapsed.split(" ")
    truncated_by_words = len(words) > _MAX_WORDS
    candidate = " ".join(words[:_MAX_WORDS])

    if len(candidate) <= _MAX_CHARS:
        return candidate + _ELLIPSIS if truncated_by_words else candidate

    # Cut at the last word boundary at or before _MAX_CHARS so the title
    # never ends mid-word.
    cut = candidate[:_MAX_CHARS]
    last_space = cut.rfind(" ")
    if last_space > 0:
        cut = cut[:last_space]
    return cut + _ELLIPSIS
