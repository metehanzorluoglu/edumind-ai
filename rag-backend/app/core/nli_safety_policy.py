"""Milestone 9.6 (NLI Contradiction & Negation Recovery) — deterministic,
pure-Python policy logic for turning raw 3-way NLI class probabilities
into a safety-oriented SUPPORTED / CONTRADICTED / UNKNOWN decision
(Phases E/F/G of the Milestone 9.6 report). No model, no network call —
consumes already-computed probabilities.

Central finding this module encodes (Milestone 9.6 §6/§7): a plain
argmax 3-way classification is not a safe decision rule for this system,
because this system's cost function is asymmetric — a false SUPPORTED
verdict for evidence that actually contradicts a claim is far more
dangerous than a conservative UNKNOWN/abstain outcome. Raising the
SUPPORTED-acceptance threshold on P(entailment) trades decisive coverage
for a large reduction in dangerous errors; §6/Phase E found the two
dangerous errors observed in the clean Milestone 9.5 dataset were made
with HIGH model confidence (>94%), meaning ordinary threshold tuning
cannot recover them without an extreme, coverage-destroying threshold —
this module's `sweep_policy` exists specifically to make that tradeoff
visible and auditable, not to pretend a "sweet spot" threshold solves
the underlying quality problem.

Promoted from evaluation/nli_safety_policy.py to this production-safe
location by Milestone 11 (§25) — `apply_safety_policy`/`ClassProbabilities`
are what turn one raw NLI probability triple into a per-source-pair
SUPPORTED/CONTRADICTED/UNKNOWN decision inside the production shadow
pipeline, and the Docker runtime image never ships `evaluation/` (see
app/core/claim_transformer.py's docstring). The whole module (including
the batch-evaluation-only PolicyReport/evaluate_policy/sweep_policy/
find_zero_dangerous_threshold and the Milestone 9.6 failure-taxonomy
types) was moved as one unit rather than split, per Milestone 11 §25's
"do not alter algorithms unless required for import/dependency
separation" — splitting would have been exactly such an alteration for
no runtime benefit. evaluation/nli_safety_policy.py is now a thin
re-export shim.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

NLILabel = Literal["entailment", "neutral", "contradiction"]
SafetyState = Literal["SUPPORTED", "CONTRADICTED", "UNKNOWN"]


@dataclass(frozen=True)
class ClassProbabilities:
    case_id: str
    gold: NLILabel
    p_entailment: float
    p_neutral: float
    p_contradiction: float


def apply_safety_policy(
    row: ClassProbabilities, *, t_entailment: float, t_contradiction: float
) -> SafetyState:
    """Milestone 9.6 Phase F/G's decision rule: SUPPORTED requires
    P(entailment) to clear its own bar FIRST (checked before
    contradiction — a high-entailment, high-contradiction case, which
    should not normally occur for a well-calibrated model but is checked
    defensively, resolves to SUPPORTED only if entailment confidence
    alone clears the bar); otherwise CONTRADICTED if P(contradiction)
    clears its bar; otherwise UNKNOWN (abstain) — never a forced verdict."""
    if row.p_entailment >= t_entailment:
        return "SUPPORTED"
    if row.p_contradiction >= t_contradiction:
        return "CONTRADICTED"
    return "UNKNOWN"


@dataclass(frozen=True)
class PolicyReport:
    t_entailment: float
    t_contradiction: float
    decisive_coverage: (
        float  # fraction of ENTAILMENT+CONTRADICTION gold cases resolved (not UNKNOWN)
    )
    dangerous_support_count: int
    dangerous_support_rate: (
        float | None
    )  # among SUPPORTED decisions, fraction that are gold != entailment
    dangerous_support_case_ids: tuple[str, ...]
    contradiction_recall: (
        float  # among ALL contradiction-gold rows, fraction correctly flagged CONTRADICTED
    )
    neutral_correctly_unknown_rate: (
        float  # among NEUTRAL-gold rows, fraction that correctly land UNKNOWN
    )


def evaluate_policy(
    rows: list[ClassProbabilities], *, t_entailment: float, t_contradiction: float
) -> PolicyReport:
    decisions = [
        (row, apply_safety_policy(row, t_entailment=t_entailment, t_contradiction=t_contradiction))
        for row in rows
    ]

    ent_contra_gold = [(r, s) for r, s in decisions if r.gold in ("entailment", "contradiction")]
    decisive = [(r, s) for r, s in ent_contra_gold if s != "UNKNOWN"]
    decisive_coverage = len(decisive) / len(ent_contra_gold) if ent_contra_gold else 0.0

    supported = [(r, s) for r, s in decisions if s == "SUPPORTED"]
    dangerous = [r for r, s in supported if r.gold != "entailment"]
    dangerous_rate = len(dangerous) / len(supported) if supported else None

    contradiction_gold = [r for r in rows if r.gold == "contradiction"]
    contradiction_caught = [
        r for r, s in decisions if r.gold == "contradiction" and s == "CONTRADICTED"
    ]
    contradiction_recall = (
        len(contradiction_caught) / len(contradiction_gold) if contradiction_gold else 0.0
    )

    neutral_gold = [(r, s) for r, s in decisions if r.gold == "neutral"]
    neutral_correct = sum(1 for r, s in neutral_gold if s == "UNKNOWN")
    neutral_correctly_unknown_rate = neutral_correct / len(neutral_gold) if neutral_gold else 0.0

    return PolicyReport(
        t_entailment=t_entailment,
        t_contradiction=t_contradiction,
        decisive_coverage=decisive_coverage,
        dangerous_support_count=len(dangerous),
        dangerous_support_rate=dangerous_rate,
        dangerous_support_case_ids=tuple(r.case_id for r in dangerous),
        contradiction_recall=contradiction_recall,
        neutral_correctly_unknown_rate=neutral_correctly_unknown_rate,
    )


def sweep_policy(
    rows: list[ClassProbabilities], thresholds: list[tuple[float, float]]
) -> list[PolicyReport]:
    return [
        evaluate_policy(rows, t_entailment=t_ent, t_contradiction=t_con)
        for t_ent, t_con in thresholds
    ]


def find_zero_dangerous_threshold(
    rows: list[ClassProbabilities], thresholds: list[tuple[float, float]]
) -> PolicyReport | None:
    """Returns the report for the LOWEST-threshold policy (in sweep order)
    achieving dangerous_support_count == 0 — i.e. the most-coverage-
    preserving policy that still eliminates the worst error class. None
    if no tested threshold achieves this."""
    for t_ent, t_con in thresholds:
        report = evaluate_policy(rows, t_entailment=t_ent, t_contradiction=t_con)
        if report.dangerous_support_count == 0:
            return report
    return None


# ---------------------------------------------------------------------------
# Error categorization (Phase A) — a small, fixed taxonomy applied by hand
# to each CONTRADICTION false negative/false positive, recorded as data
# (see evaluation/reports/ for the actual M9.6 failure-analysis artifact),
# not derived automatically. The category set itself is exposed here so
# it's a single, importable, testable source of truth.
# ---------------------------------------------------------------------------

FAILURE_CATEGORIES: tuple[str, ...] = (
    "EXPLICIT_NEGATION",
    "NULL_RESULT",
    "ABSENCE_VS_NEGATION",
    "DIRECTIONAL_REVERSAL",
    "NUMERIC_CONTRADICTION",
    "POPULATION_CONTRADICTION",
    "METHOD_CONTRADICTION",
    "CAUSAL_OVERCLAIM",
    "CORRELATION_VS_CAUSATION",
    "SCOPE_MISMATCH",
    "LEXICAL_SYNONYM",
    "OTHER",
)


@dataclass(frozen=True)
class FailureRecord:
    case_id: str
    question: str
    claim: str
    evidence: str
    gold: NLILabel
    prediction: NLILabel
    p_entailment: float
    p_neutral: float
    p_contradiction: float
    category: str

    def __post_init__(self) -> None:
        if self.category not in FAILURE_CATEGORIES:
            raise ValueError(f"{self.case_id}: unknown failure category {self.category!r}")
