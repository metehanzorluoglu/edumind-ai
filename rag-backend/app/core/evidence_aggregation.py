"""Milestone 9 (Question-to-Claim Transformation & NLI Routing) §22-27 —
a deterministic, source-transparent aggregation prototype turning a
per-claim, per-source NLI relation matrix into an overall evidence state.
No generative reasoning, no model call — pure deterministic logic, the
same "evaluation-only, no production wiring" status as every other module
in this milestone.

Pipeline this module sits at the end of (conceptual, not integrated):

    claim(s) x source(s) -> NLI relation matrix -> per-claim status
        -> overall evidence state

Two aggregation levels:

1. `aggregate_claim_status()` (§23): for ONE claim, given its relation to
   every source, derive SUPPORTED / CONTRADICTED / UNSUPPORTED /
   CONFLICTED.
2. `aggregate_evidence_state()` (§24/§27): for a full multi-claim question
   (the Claim Router may produce 1+ claims — see
   evaluation/claim_transformer.py), combine every claim's status into one
   overall SUFFICIENT / PARTIAL / INSUFFICIENT / CONTRADICTORY /
   CONFLICTED evidence state.

Deliberately does NOT decide final chat-facing answer behavior (§23's own
instruction) — this only classifies evidence state; what to DO with a
given state (qualify, abstain, correct) is out of scope, same as
Milestones 6/7's own explicit non-decision on that question.

Promoted from evaluation/evidence_aggregation.py to this production-safe
location by Milestone 11 (§25) — the Docker runtime image never ships
`evaluation/` (see app/core/claim_transformer.py's docstring for the same
reasoning), and Milestone 11's shadow infrastructure needs this exact,
already-tested aggregation logic at real request time. The algorithms
below are UNCHANGED by this move (Milestone 11 §25: "Do not alter
algorithms unless required for import/dependency separation").
evaluation/evidence_aggregation.py is now a thin re-export shim.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

NLIRelation = Literal["entailment", "neutral", "contradiction"]
ClaimStatus = Literal["SUPPORTED", "CONTRADICTED", "UNSUPPORTED", "CONFLICTED"]
EvidenceState = Literal["SUFFICIENT", "PARTIAL", "INSUFFICIENT", "CONTRADICTORY", "CONFLICTED"]


@dataclass(frozen=True)
class SourceRelation:
    source_id: str
    relation: NLIRelation


@dataclass(frozen=True)
class ClaimRelationRow:
    """One claim's relation to every scored source — the "relation
    matrix" row (Milestone 9 §22)."""

    claim: str
    source_relations: tuple[SourceRelation, ...]

    def entailing_sources(self) -> tuple[str, ...]:
        return tuple(sr.source_id for sr in self.source_relations if sr.relation == "entailment")

    def contradicting_sources(self) -> tuple[str, ...]:
        return tuple(sr.source_id for sr in self.source_relations if sr.relation == "contradiction")


def aggregate_claim_status(row: ClaimRelationRow) -> ClaimStatus:
    """Milestone 9 §23's deterministic rule, applied exactly as specified:

    - entailment exists AND contradiction absent -> SUPPORTED
    - contradiction exists AND entailment absent  -> CONTRADICTED
    - both exist                                  -> CONFLICTED
    - neither exists (all neutral, or no sources)  -> UNSUPPORTED
    """
    has_entailment = bool(row.entailing_sources())
    has_contradiction = bool(row.contradicting_sources())
    if has_entailment and has_contradiction:
        return "CONFLICTED"
    if has_entailment:
        return "SUPPORTED"
    if has_contradiction:
        return "CONTRADICTED"
    return "UNSUPPORTED"


@dataclass(frozen=True)
class ClaimAggregationResult:
    claim: str
    status: ClaimStatus
    supporting_source_ids: tuple[str, ...]
    contradicting_source_ids: tuple[str, ...]


def aggregate_claims(rows: list[ClaimRelationRow]) -> list[ClaimAggregationResult]:
    return [
        ClaimAggregationResult(
            claim=row.claim,
            status=aggregate_claim_status(row),
            supporting_source_ids=row.entailing_sources(),
            contradicting_source_ids=row.contradicting_sources(),
        )
        for row in rows
    ]


# ---------------------------------------------------------------------------
# Overall evidence-state mapping (Milestone 9 §27)
# ---------------------------------------------------------------------------


def aggregate_evidence_state(claim_results: list[ClaimAggregationResult]) -> EvidenceState:
    """Milestone 9 §24/§25/§26/§27's mapping from per-claim statuses to one
    overall evidence state:

    - Any claim CONTRADICTED (and none CONFLICTED)         -> CONTRADICTORY
      (Milestone 9 §25: a presupposition claim's evidence contradicting it
      is exactly the case this whole pipeline exists to catch.)
    - Any claim CONFLICTED                                  -> CONFLICTED
      (Milestone 9 §26/§27: conflicting sources must never silently
      collapse to SUFFICIENT — CONFLICTED is preserved as its own state,
      checked before CONTRADICTORY so a single conflicted claim among
      otherwise-contradicted claims is never masked.)
    - All claims SUPPORTED                                  -> SUFFICIENT
    - Some claims SUPPORTED, some UNSUPPORTED (none
      CONTRADICTED/CONFLICTED)                               -> PARTIAL
      (Milestone 9 §24's worked example: C1 SUPPORTED + C2 UNSUPPORTED.)
    - All claims UNSUPPORTED                                 -> INSUFFICIENT
    - No claims at all (should not normally occur — the Claim Router
      would have marked the question NOT_NLI_APPLICABLE instead)
                                                               -> INSUFFICIENT
    """
    if not claim_results:
        return "INSUFFICIENT"
    statuses = [c.status for c in claim_results]
    if any(s == "CONFLICTED" for s in statuses):
        return "CONFLICTED"
    if any(s == "CONTRADICTED" for s in statuses):
        return "CONTRADICTORY"
    if all(s == "SUPPORTED" for s in statuses):
        return "SUFFICIENT"
    if all(s == "UNSUPPORTED" for s in statuses):
        return "INSUFFICIENT"
    return "PARTIAL"  # a mix of SUPPORTED and UNSUPPORTED, no CONTRADICTED/CONFLICTED


def should_answer(state: EvidenceState) -> bool:
    """Backward-compatible binary derivation, mirroring
    evaluation/controlled_corpus.py's EvalCase.should_answer pattern
    (Milestone 5.7 §10) — SUFFICIENT is the only state where the
    generator should proceed unqualified; every other state (including
    the new CONFLICTED) should abstain or qualify, never answer plainly."""
    return state == "SUFFICIENT"
