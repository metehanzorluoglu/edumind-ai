"""Milestone 6.1 (Writing Context Engine) — Part 14's deterministic
context-escalation policy layer. Classifies a Writing Ask EduM8 request
into one of five policies (Part 2's priority list collapsed into named,
testable buckets) WITHOUT an LLM call (Part 14: "Do not add an LLM call
solely to decide what context to send... defeats the purpose of M6.1").

This is deliberately a small, maintainable keyword/pattern classifier,
not a giant fragile regex list (Part 14's own warning) — a short ordered
list of (pattern, policy) checks, first match wins, with a safe default.
Every policy is independently unit-tested against its own worked example
from the spec (Part 14/29's Scenarios A-F) rather than relying on the
classifier "probably" doing the right thing.

Reused, not reinvented: the M5.5-era "manuscript-selection" transient-
context convention already distinguishes selection-driven requests from
general ones at the UI layer (lib/transientAIContext.ts); this module is
the backend-side, testable counterpart that decides how FAR to escalate
once a request (with or without a selection) actually reaches the context
engine.
"""

from __future__ import annotations

import re

from app.core.writing_context_schemas import ContextPolicyName

# Order matters — first match wins. Reference/evidence-seeking language
# is checked before generic "explain" language so e.g. "what evidence do
# I have for this claim" classifies as reference_question, not
# explanation, even though it also contains an explanatory phrasing.
_REFERENCE_PATTERNS = [
    r"\bevidence\b",
    r"\breferences?\b",
    r"\bsupport(?:s|ed|ing)?\b.*\b(claim|statement|finding)s?\b",
    r"\bcit(?:e|ation|ations|ing)\b",
    r"\bsource(?:s)?\b",
    r"\bbibliograph",
]

_CROSS_SOURCE_PATTERNS = [
    r"\bcompar(?:e|ison|ed|ing)\b",
    r"\bcontradict",
    r"\bconsistent with\b",
    r"\bliterature\b",
    r"\bprevious (?:research|work|studies|findings)\b",
    r"\bagree(?:s)? with\b",
]

_MANUSCRIPT_QUESTION_PATTERNS = [
    r"\bmethodolog",
    r"\bwhat (?:section|chapter|am i)\b",
    r"\bsummariz",
    r"\bsummary\b",
    r"\boverview\b",
    r"\bstructure\b",
    r"\bwhat (?:is|are) my\b",
]

_EXPLANATION_PATTERNS = [
    r"\bwhat does\b.*\bmean\b",
    r"\bexplain\b",
    r"\bwhy\b",
    r"\bclarify\b",
    r"\bunderstand\b",
]

_LOCAL_EDIT_PATTERNS = [
    r"\b(?:make|rewrite|improve|fix|clean up|polish)\b",
    r"\bgrammar\b",
    r"\bclear(?:er)?\b",
    r"\bconcise\b",
    r"\bshorten\b",
    r"\brephrase\b",
    r"\bword(?:ing)?\b",
]


def _matches_any(patterns: list[str], text: str) -> bool:
    return any(re.search(p, text) for p in patterns)


def classify_intent(user_request: str, *, has_selection: bool) -> ContextPolicyName:
    """Deterministic, pure — same input always yields the same policy.
    `has_selection` alone never forces cross_source_synthesis/
    reference_question (an explicit selection is a strong signal for
    LOCAL scope per Part 2 — "The request can be answered primarily
    from the selected sentence" — not a reason to broaden), but DOES
    make local_edit the default fallback instead of manuscript_question,
    since a selection with an unrecognized instruction is far more
    likely to be another local edit than a whole-manuscript question."""
    text = user_request.lower().strip()

    if _matches_any(_REFERENCE_PATTERNS, text):
        return "reference_question"
    if _matches_any(_CROSS_SOURCE_PATTERNS, text):
        return "cross_source_synthesis"
    if _matches_any(_MANUSCRIPT_QUESTION_PATTERNS, text):
        return "manuscript_question"
    if _matches_any(_EXPLANATION_PATTERNS, text):
        return "explanation"
    if _matches_any(_LOCAL_EDIT_PATTERNS, text):
        return "local_edit"

    return "local_edit" if has_selection else "manuscript_question"


# Part 1/2 — which layers each policy pulls in. `True` for a layer means
# "the engine attempts to build it" (still subject to Part 11's budget
# and to the layer genuinely having content — e.g. `evidence=True` on a
# project with no connected source documents still yields zero evidence
# items, never a fabricated one). RAG (`evidence`) is explicitly OFF for
# local_edit/explanation (Part 14: "Do not RAG") and ON only for the two
# policies whose own worked examples in the spec require it.
POLICY_LAYERS: dict[ContextPolicyName, dict[str, bool]] = {
    "local_edit": {
        "selection": True,
        "nearby_text": True,
        "section": False,
        "project_structure": False,
        "notes": False,
        "highlights": False,
        "reference_metadata": False,
        "evidence": False,
    },
    "explanation": {
        "selection": True,
        "nearby_text": True,
        "section": True,
        "project_structure": False,
        "notes": False,
        "highlights": False,
        "reference_metadata": False,
        "evidence": False,
    },
    "manuscript_question": {
        "selection": True,
        "nearby_text": True,
        "section": True,
        "project_structure": True,
        "notes": False,
        "highlights": False,
        "reference_metadata": False,
        "evidence": False,
    },
    "reference_question": {
        "selection": True,
        "nearby_text": True,
        "section": True,
        "project_structure": False,
        "notes": True,
        "highlights": True,
        "reference_metadata": True,
        "evidence": True,
    },
    "cross_source_synthesis": {
        "selection": True,
        "nearby_text": True,
        "section": True,
        "project_structure": True,
        "notes": True,
        "highlights": True,
        "reference_metadata": True,
        "evidence": True,
    },
}
