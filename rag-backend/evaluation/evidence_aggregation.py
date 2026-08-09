"""Milestone 11 (Evidence Service & Shadow Infrastructure Implementation)
§25 promoted this module's implementation to
app/core/evidence_aggregation.py — the production shadow pipeline needs
this exact, already-tested aggregation logic at real request time, and
the Docker runtime image never ships `evaluation/` (see
app/core/claim_transformer.py's docstring for the same reasoning).

This file is now a thin re-export shim so every existing evaluation
script/test (scripts/nli_source_limit_experiment.py,
tests/unit/scripts/test_claim_transformer.py) keeps working with an
unmodified `from evaluation.evidence_aggregation import ...` — no
algorithm change, per Milestone 11 §25.
"""

from __future__ import annotations

from app.core.evidence_aggregation import (
    ClaimAggregationResult,
    ClaimRelationRow,
    ClaimStatus,
    EvidenceState,
    NLIRelation,
    SourceRelation,
    aggregate_claim_status,
    aggregate_claims,
    aggregate_evidence_state,
    should_answer,
)

__all__ = [
    "ClaimAggregationResult",
    "ClaimRelationRow",
    "ClaimStatus",
    "EvidenceState",
    "NLIRelation",
    "SourceRelation",
    "aggregate_claim_status",
    "aggregate_claims",
    "aggregate_evidence_state",
    "should_answer",
]
