"""Detects whether a chat query is asking the assistant to *design*
instructional material (a lesson, a unit, a classroom activity, a
curriculum) rather than to *answer a research question* about the corpus —
the two call for genuinely different response shapes (see
app/core/prompt_builder.py's _INSTRUCTIONAL_DESIGN_ADDENDUM).

Deliberately general — a verb-plus-noun pattern match, not a lookup of any
specific exact prompt. Matches "design/create/develop/build/plan a lesson/
unit/curriculum/activity/course" in any order, plus a few fixed common
phrasings ("lesson plan", "lesson flow", "learning sequence") that name the
artifact directly without needing a separate verb. Intentionally
conservative about false positives: a genuine research question that merely
mentions "lesson" in passing (e.g. "What does the literature say about
lesson study in Japan?") must not trigger this — the verb+noun pattern
requires an actual design/creation verb adjacent to the instructional-
material noun, which "what does the literature say about X" never has.
"""

import re

_DESIGN_VERBS = r"design|create|develop|build|plan|write|draft|construct|outline"
_INSTRUCTIONAL_NOUNS = (
    r"lesson(?:\s+plan|\s+flow|\s+sequence)?"
    r"|unit\s+plan"
    r"|curricul(?:um|a)"
    r"|classroom\s+activit(?:y|ies)"
    r"|learning\s+(?:sequence|activity|activities|experience)"
    r"|teaching\s+sequence"
    r"|instructional\s+(?:sequence|unit|design|material)"
    r"|course\s+(?:outline|plan)"
    r"|student\s+project"
)

# e.g. "design a lesson", "developing a curriculum", "help me build a unit plan"
_VERB_NOUN_PATTERN = re.compile(
    rf"\b(?:{_DESIGN_VERBS})\w*\b[^.?!]{{0,40}}?\b(?:{_INSTRUCTIONAL_NOUNS})\b", re.IGNORECASE
)

# Phrasings that name the artifact directly and are themselves unambiguous
# requests for one, without needing a separate design verb immediately
# before them (e.g. "I need a lesson plan on...", "a learning sequence
# where students...").
_DIRECT_PHRASES = re.compile(
    r"\blesson\s+(?:plan|flow)\b|\blearning\s+sequence\b|\bunit\s+plan\b", re.IGNORECASE
)


def is_instructional_design_request(query: str) -> bool:
    """True if `query` is asking the assistant to design/create
    instructional material, rather than to answer a question about the
    research corpus. See the module docstring for the matching rules."""
    if not query or not query.strip():
        return False
    return bool(_VERB_NOUN_PATTERN.search(query) or _DIRECT_PHRASES.search(query))
