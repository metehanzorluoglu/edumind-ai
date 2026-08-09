"""Milestone 11 (Evidence Service & Shadow Infrastructure Implementation)
§25 promoted this module's implementation to app/core/nli_safety_policy.py
— the production shadow pipeline's `apply_safety_policy` decision needs to
live where the Docker runtime image actually ships it (see
app/core/claim_transformer.py's docstring for why `evaluation/` itself is
never copied into the image).

This file is now a thin re-export shim so every existing evaluation
script/test (evaluation/nli_failure_analysis_m96.py,
tests/unit/scripts/test_nli_safety_policy.py) keeps working with an
unmodified `from evaluation.nli_safety_policy import ...` — no algorithm
change, per Milestone 11 §25.
"""

from __future__ import annotations

from app.core.nli_safety_policy import (
    FAILURE_CATEGORIES,
    ClassProbabilities,
    FailureRecord,
    NLILabel,
    PolicyReport,
    SafetyState,
    apply_safety_policy,
    evaluate_policy,
    find_zero_dangerous_threshold,
    sweep_policy,
)

__all__ = [
    "FAILURE_CATEGORIES",
    "ClassProbabilities",
    "FailureRecord",
    "NLILabel",
    "PolicyReport",
    "SafetyState",
    "apply_safety_policy",
    "evaluate_policy",
    "find_zero_dangerous_threshold",
    "sweep_policy",
]
