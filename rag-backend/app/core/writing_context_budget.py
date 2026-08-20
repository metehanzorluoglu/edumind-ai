"""Milestone 6.1 (Writing Context Engine) — Part 11's hard requirement: an
explicit context budget the application controls, never left to "however
big the model's context window happens to be."

Token ESTIMATION reuses this codebase's existing, already-documented
convention (chars/4 — see app/core/rag_service.py's `_record_prompt_metadata`
and its own comment pointing at `estimated_prompt_tokens` in
app/api/routes_conversations.py): an approximation, explicitly labeled as
one everywhere it's surfaced, never presented as an exact tokenizer count
(Part 12: "Do not pretend an estimate is exact"). No tokenizer library
(tiktoken or otherwise) is a dependency of this backend today — introducing
one for a single new feature's estimate, when this codebase already has an
established, documented estimate convention, would be exactly the kind of
"parallel architecture" Part 0 warns against.

Deduplication (Part 13) reuses app/core/context_preparation.py's existing
near-duplicate text collapsing (`_deduplicate_near_identical`, itself using
the same difflib.SequenceMatcher approach import structures around) rather
than a second implementation — Writing context adds its own thin wrapper
because the objects being deduplicated here (EvidenceItem) aren't
RetrievedChunk, but the underlying normalize+compare logic is identical in
spirit and kept at the same similarity threshold for consistency.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from difflib import SequenceMatcher

from app.core.writing_context_schemas import ContextBudgetReport, EvidenceItem

_CHARS_PER_TOKEN_ESTIMATE = 4
_DEDUP_SIMILARITY_THRESHOLD = 0.92


def estimate_tokens(text: str) -> int:
    """The same chars/4 heuristic already used elsewhere in this backend
    (see module docstring) — kept as its own named function here so
    every Writing-context call site reads `estimate_tokens(...)` rather
    than a bare magic-number division scattered across the engine."""
    return round(len(text) / _CHARS_PER_TOKEN_ESTIMATE)


# Part 11 — category-level budgets. Chosen against this backend's actual
# deployed model stack (qwen3:8b via Ollama, see deploy/oracle/.env.oracle
# and app/core/llm_provider.py) rather than copied from the spec's own
# illustrative numbers (which it explicitly says not to blindly reuse).
# qwen3:8b's practical context window on this host is large enough that
# these are NOT "as much as physically fits" limits — they are
# deliberately small, product-level ceilings: Part 1's "the system should
# normally start with L0-L2" means most real requests (a local edit on a
# selected sentence) should use a tiny fraction of this budget, and the
# budget's job is to bound the WORST case (a cross-source-synthesis
# request touching every layer), not to size every request up to it.
# selection/nearby_text/current_section are kept generous relative to
# notes/highlights/reference_metadata/evidence (which are each capped
# to a handful of retrieved items, not "however long they happen to
# be") because manuscript context is the thing the user is actually
# looking at and should essentially never be truncated in normal use,
# while retrieved evidence is exactly the category Part 13 warns against
# blowing up unboundedly.
DEFAULT_CATEGORY_BUDGETS: dict[str, int] = {
    "selection": 800,
    "nearby_text": 600,
    "current_section": 1500,
    "project_structure": 200,
    "notes": 600,
    "highlights": 600,
    "reference_metadata": 500,
    "evidence": 2000,
}

DEFAULT_TOTAL_BUDGET = 6000


@dataclass
class _CategoryAccumulator:
    limit: int
    included: list[EvidenceItem] = field(default_factory=list)
    included_tokens: int = 0
    omitted_tokens: int = 0


def _normalize(text: str) -> str:
    return " ".join(text.split()).lower()


def deduplicate_evidence(items: list[EvidenceItem]) -> list[EvidenceItem]:
    """Drops an item whose text is empty or near-identical (Part 13's
    similarity threshold, matching context_preparation.py's) to an
    EARLIER item already kept — so when the same sentence legitimately
    appears as both `selection` and inside `current_section`, only the
    first (more specific) occurrence survives. Order-preserving: callers
    pass items in priority order (selection before section, etc.) so
    "earlier wins" is equivalent to "higher-priority layer wins"."""
    kept: list[EvidenceItem] = []
    kept_normalized: list[str] = []
    for item in items:
        text = item.text.strip()
        if not text:
            continue
        normalized = _normalize(text)
        is_duplicate = any(
            SequenceMatcher(None, normalized, existing).ratio() >= _DEDUP_SIMILARITY_THRESHOLD
            for existing in kept_normalized
        )
        if is_duplicate:
            continue
        kept.append(item)
        kept_normalized.append(normalized)
    return kept


class ContextBudgetEnforcer:
    """Accumulates EvidenceItems per category under a fixed set of
    per-category limits plus one overall total limit, in the exact
    priority order the caller feeds items (Part 2's context priority).
    Deterministic: given the same inputs and limits, always keeps/drops
    the same items — no randomness, no wall-clock dependence."""

    def __init__(
        self,
        *,
        category_limits: dict[str, int] | None = None,
        total_budget: int = DEFAULT_TOTAL_BUDGET,
    ) -> None:
        self._limits = dict(category_limits or DEFAULT_CATEGORY_BUDGETS)
        self._total_budget = total_budget
        self._categories: dict[str, _CategoryAccumulator] = {
            name: _CategoryAccumulator(limit=limit) for name, limit in self._limits.items()
        }
        self._total_included_tokens = 0

    def add(self, category: str, items: list[EvidenceItem]) -> list[EvidenceItem]:
        """Adds `items` (already deduplicated by the caller) to
        `category`, in order, until either the category's own limit or
        the overall total budget is reached. Returns exactly the items
        that were actually kept, in order — the caller uses this
        (rather than re-reading the accumulator) to know what survived."""
        acc = self._categories.setdefault(
            category, _CategoryAccumulator(limit=self._limits.get(category, 0))
        )
        kept: list[EvidenceItem] = []
        for item in items:
            tokens = item.estimated_tokens
            if acc.included_tokens + tokens > acc.limit:
                acc.omitted_tokens += tokens
                continue
            if self._total_included_tokens + tokens > self._total_budget:
                acc.omitted_tokens += tokens
                continue
            acc.included.append(item)
            acc.included_tokens += tokens
            self._total_included_tokens += tokens
            kept.append(item)
        return kept

    def report(self) -> ContextBudgetReport:
        return ContextBudgetReport(
            category_limits=dict(self._limits),
            category_tokens_included={
                name: acc.included_tokens for name, acc in self._categories.items()
            },
            category_tokens_omitted={
                name: acc.omitted_tokens for name, acc in self._categories.items()
            },
            total_token_budget=self._total_budget,
            total_tokens_included=self._total_included_tokens,
        )
