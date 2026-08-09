"""Milestone 11 (Evidence Service & Shadow Infrastructure Implementation)
§15 promoted this module's implementation to app/core/claim_transformer.py
— the Docker runtime image copies only `app/`, `cli/`, and `alembic/`
(see deploy/rpi5/Dockerfile.rpi5), never `evaluation/`, so the production
request path needs the real code to live under app/core, not here.

This file is now a thin re-export shim so every existing evaluation
script/test (evaluation/claim_transformation_dataset.py,
scripts/eval_claim_transformer.py, scripts/nli_polarity_matched_eval.py,
scripts/nli_with_claim_transform_eval.py,
tests/unit/scripts/test_claim_transformer.py,
tests/unit/scripts/test_polarity_matched_dataset.py) keeps working with an
unmodified `from evaluation.claim_transformer import ...` — no rewrite,
no behavior change, per Milestone 11 §15's "Do NOT rewrite it" and
"Preserve existing evaluation tests where possible" instructions.
"""

from __future__ import annotations

from app.core.claim_transformer import (
    RoutingCategory,
    TransformationResult,
    classify_and_transform,
)

__all__ = ["RoutingCategory", "TransformationResult", "classify_and_transform"]
