#!/usr/bin/env python
"""Milestone 9 (Question-to-Claim Transformation & NLI Routing) §19 —
re-runs the Milestone 8 winning NLI model (cross-encoder/nli-deberta-v3-
small) on a MATCHED subset of evaluation/nli_dataset.py's cases: exactly
the cases evaluation/claim_transformer.py marks NLI_APPLICABLE (single-
claim only, for a clean 1:1 comparison), scored TWICE on identical
premises — once with the dataset's manually authored `hypothesis` field
(the Milestone 8 baseline), once with the transformer's own
auto-generated claim — so any quality difference is attributable to the
transformation step alone, not to a different, non-matched case subset.

REQUIRES THE ISOLATED EVALUATION ENVIRONMENT (torch/transformers), same
as scripts/nli_feasibility_eval.py:

    source evaluation/.nli-eval-env/.venv/bin/activate
    PYTHONPATH=. python scripts/nli_with_claim_transform_eval.py

Never imported by, or wired into, any production request path.
"""

from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass
from pathlib import Path

os.environ.setdefault(
    "HF_HOME", str(Path(__file__).resolve().parent.parent / "evaluation" / ".nli-model-cache")
)
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

from evaluation.claim_transformer import classify_and_transform
from evaluation.nli_dataset import NLI_CASES
from scripts.nli_feasibility_eval import (
    NLIModel,
    _confusion_matrix,
    _dangerous_errors,
    _per_class_prf,
    _safety_collapse,
)

MODEL_ID = "cross-encoder/nli-deberta-v3-small"


@dataclass
class MatchedCase:
    case_id: str
    gold: str
    premise: str
    manual_hypothesis: str
    auto_claim: str


def build_matched_subset() -> list[MatchedCase]:
    matched: list[MatchedCase] = []
    for case in NLI_CASES:
        result = classify_and_transform(case.question)
        if not result.applicable or len(result.claims) != 1:
            continue
        matched.append(
            MatchedCase(
                case_id=case.case_id,
                gold=case.gold_label,
                premise=case.premise_text(),
                manual_hypothesis=case.hypothesis,
                auto_claim=result.claims[0],
            )
        )
    return matched


def score(
    model: NLIModel, cases: list[MatchedCase], *, hypothesis_field: str
) -> list[dict[str, object]]:
    pairs = [(c.premise, getattr(c, hypothesis_field)) for c in cases]
    predicted_labels, _probs = model.predict_batch(pairs)
    return [
        {"case_id": c.case_id, "gold": c.gold, "predicted": pred}
        for c, pred in zip(cases, predicted_labels, strict=True)
    ]


def _summarize(rows: list[dict[str, object]]) -> dict[str, object]:
    from scripts.nli_feasibility_eval import CaseOutcome

    outcomes = [
        CaseOutcome(case_id=r["case_id"], gold=r["gold"], predicted=r["predicted"], probs=[])
        for r in rows
    ]
    correct = sum(1 for o in outcomes if o.predicted == o.gold)
    accuracy = correct / len(outcomes) if outcomes else None
    per_class = _per_class_prf(outcomes)
    f1s = [v["f1"] for v in per_class.values() if v["f1"] is not None]
    macro_f1 = sum(f1s) / len(f1s) if f1s else None
    return {
        "case_count": len(outcomes),
        "accuracy": accuracy,
        "macro_f1": macro_f1,
        "per_class": per_class,
        "confusion_matrix": _confusion_matrix(outcomes),
        "dangerous_errors": _dangerous_errors(outcomes),
        "safety_collapse": _safety_collapse(outcomes),
    }


def main() -> None:
    matched = build_matched_subset()
    print(f"matched subset size: {len(matched)}")
    from collections import Counter

    print(f"gold label distribution: {Counter(c.gold for c in matched)}")

    t0 = time.time()
    model = NLIModel.load(MODEL_ID)
    print(f"model loaded in {time.time() - t0:.1f}s")

    manual_rows = score(model, matched, hypothesis_field="manual_hypothesis")
    auto_rows = score(model, matched, hypothesis_field="auto_claim")

    manual_summary = _summarize(manual_rows)
    auto_summary = _summarize(auto_rows)

    report = {
        "model_id": MODEL_ID,
        "matched_case_count": len(matched),
        "manual_hypothesis_baseline": manual_summary,
        "auto_transformed_claim": auto_summary,
        "per_case_comparison": [
            {
                "case_id": m["case_id"],
                "gold": m["gold"],
                "manual_predicted": m["predicted"],
                "auto_predicted": a["predicted"],
                "predictions_agree": m["predicted"] == a["predicted"],
            }
            for m, a in zip(manual_rows, auto_rows, strict=True)
        ],
    }

    reports_dir = Path("evaluation/reports")
    reports_dir.mkdir(parents=True, exist_ok=True)
    timestamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    path = reports_dir / f"nli-claim-transform-comparison-{timestamp}.json"
    path.write_text(json.dumps(report, indent=2), encoding="utf-8")

    print()
    print("=== MANUAL HYPOTHESIS (Milestone 8 baseline, matched subset) ===")
    print(f"accuracy={manual_summary['accuracy']} macro_f1={manual_summary['macro_f1']}")
    print(f"contradiction_recall={manual_summary['dangerous_errors']['contradiction_recall']}")
    print(
        f"contradiction_to_entailment={manual_summary['dangerous_errors']['contradiction_to_entailment_rate']}"
    )
    print(
        f"neutral_to_entailment={manual_summary['dangerous_errors']['neutral_to_entailment_rate']}"
    )
    print()
    print("=== AUTO-TRANSFORMED CLAIM (Milestone 9) ===")
    print(f"accuracy={auto_summary['accuracy']} macro_f1={auto_summary['macro_f1']}")
    print(f"contradiction_recall={auto_summary['dangerous_errors']['contradiction_recall']}")
    print(
        f"contradiction_to_entailment={auto_summary['dangerous_errors']['contradiction_to_entailment_rate']}"
    )
    print(f"neutral_to_entailment={auto_summary['dangerous_errors']['neutral_to_entailment_rate']}")
    print()
    agree = sum(1 for row in report["per_case_comparison"] if row["predictions_agree"])
    print(f"prediction agreement rate: {agree}/{len(matched)} = {agree / len(matched):.3f}")
    print(f"written: {path}")


if __name__ == "__main__":
    main()
