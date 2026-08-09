#!/usr/bin/env python
"""Milestone 9 (Question-to-Claim Transformation & NLI Routing) —
EVALUATION-ONLY harness scoring evaluation/claim_transformer.py against
evaluation/claim_transformation_dataset.py's manually reviewed dataset.

No model, no network call — this is a pure deterministic-function
benchmark, runnable from the ordinary production venv. Never imported by,
or wired into, any production request path.

Usage:
    python scripts/eval_claim_transformer.py
    python scripts/eval_claim_transformer.py --reports-dir evaluation/reports
"""

from __future__ import annotations

import argparse
import json
import time
from dataclasses import dataclass, field
from pathlib import Path

from cli.reporting import utcnow
from evaluation.claim_transformation_dataset import CASES, TransformationCase
from evaluation.claim_transformer import (
    RoutingCategory,
    TransformationResult,
    classify_and_transform,
)


@dataclass
class CaseOutcome:
    case: TransformationCase
    result: TransformationResult
    transform_latency_ms: float

    @property
    def applicability_correct(self) -> bool:
        return self.result.applicable == self.case.gold_applicable

    @property
    def category_correct(self) -> bool:
        return self.result.category == self.case.gold_category

    @property
    def claims_exact_match(self) -> bool | None:
        """None when gold is NOT_NLI_APPLICABLE (no claim comparison applies)."""
        if not self.case.gold_applicable:
            return None
        return self.result.claims == self.case.gold_claims

    @property
    def is_unsafe(self) -> bool:
        """Milestone 9 §15: system says NLI_APPLICABLE but the generated
        claim changes the meaning — i.e. the transformer marked the case
        applicable AND produced a claim that does not exact-match the
        manually-reviewed gold claim (an incorrect claim, not merely a
        different-but-equivalent phrasing, since gold claims were written
        to match the transformer's own deterministic output style)."""
        if not self.result.applicable:
            return False
        if not self.case.gold_applicable:
            # transformer applied where gold says it should not have —
            # counts as unsafe only if it produced a DIFFERENT-meaning
            # claim; since gold has no claims to compare against here,
            # any transformer-applicable result on a gold-inapplicable
            # case is flagged unsafe (over-application is exactly the
            # risk this metric exists to catch).
            return True
        return self.result.claims != self.case.gold_claims

    @property
    def polarity_preserved(self) -> bool | None:
        """None when not applicable to this case (gold not applicable, or
        neither gold nor transformer claim contains an explicit negation
        marker). True/False otherwise — checks 'not'/negation-word
        presence matches between gold and predicted claims."""
        if not self.case.gold_applicable or not self.result.applicable:
            return None
        gold_has_negation = any(
            " not " in c or c.lower().startswith("not ") for c in self.case.gold_claims
        )
        pred_has_negation = any(
            " not " in c or c.lower().startswith("not ") for c in self.result.claims
        )
        if not gold_has_negation and not pred_has_negation:
            return None  # no negation involved in this case either way
        return gold_has_negation == pred_has_negation


def run(cases: list[TransformationCase] | None = None) -> list[CaseOutcome]:
    effective_cases = cases if cases is not None else CASES
    outcomes = []
    for case in effective_cases:
        t0 = time.perf_counter()
        result = classify_and_transform(case.question)
        latency_ms = (time.perf_counter() - t0) * 1000
        outcomes.append(CaseOutcome(case=case, result=result, transform_latency_ms=latency_ms))
    return outcomes


# ---------------------------------------------------------------------------
# Metrics
# ---------------------------------------------------------------------------


def applicability_metrics(outcomes: list[CaseOutcome]) -> dict[str, object]:
    n = len(outcomes)
    correct = sum(1 for o in outcomes if o.applicability_correct)
    tp = sum(1 for o in outcomes if o.case.gold_applicable and o.result.applicable)
    fp = sum(1 for o in outcomes if not o.case.gold_applicable and o.result.applicable)
    fn = sum(1 for o in outcomes if o.case.gold_applicable and not o.result.applicable)
    tn = sum(1 for o in outcomes if not o.case.gold_applicable and not o.result.applicable)
    precision = tp / (tp + fp) if (tp + fp) > 0 else None
    recall = tp / (tp + fn) if (tp + fn) > 0 else None
    return {
        "accuracy": correct / n if n else None,
        "precision_applicable": precision,
        "recall_applicable": recall,
        "true_positive": tp,
        "false_positive": fp,
        "false_negative": fn,
        "true_negative": tn,
    }


def unsafe_transformation_rate(outcomes: list[CaseOutcome]) -> dict[str, object]:
    unsafe = [o for o in outcomes if o.is_unsafe]
    applicable_predictions = [o for o in outcomes if o.result.applicable]
    return {
        "unsafe_count": len(unsafe),
        "unsafe_case_ids": [o.case.case_id for o in unsafe],
        "unsafe_rate_of_applicable_predictions": (
            len(unsafe) / len(applicable_predictions) if applicable_predictions else None
        ),
    }


def polarity_preservation(outcomes: list[CaseOutcome]) -> dict[str, object]:
    relevant = [o for o in outcomes if o.polarity_preserved is not None]
    preserved = [o for o in relevant if o.polarity_preserved]
    return {
        "relevant_case_count": len(relevant),
        "preserved_count": len(preserved),
        "preservation_rate": len(preserved) / len(relevant) if relevant else None,
        "violation_case_ids": [o.case.case_id for o in relevant if not o.polarity_preserved],
    }


def claim_exact_match_rate(outcomes: list[CaseOutcome]) -> dict[str, object]:
    relevant = [o for o in outcomes if o.claims_exact_match is not None]
    matched = [o for o in relevant if o.claims_exact_match]
    return {
        "relevant_case_count": len(relevant),
        "matched_count": len(matched),
        "exact_match_rate": len(matched) / len(relevant) if relevant else None,
    }


def multi_claim_count_accuracy(outcomes: list[CaseOutcome]) -> dict[str, object]:
    relevant = [o for o in outcomes if o.case.gold_category == "MULTI_CLAIM"]
    correct_count = sum(1 for o in relevant if o.result.claim_count == len(o.case.gold_claims))
    return {
        "relevant_case_count": len(relevant),
        "correct_claim_count": correct_count,
        "accuracy": correct_count / len(relevant) if relevant else None,
    }


def coverage_by_group(outcomes: list[CaseOutcome], *, group_fn) -> dict[str, object]:
    groups: dict[str, list[CaseOutcome]] = {}
    for o in outcomes:
        key = group_fn(o.case)
        if key is None:
            continue
        groups.setdefault(key, []).append(o)
    return {
        key: {
            "case_count": len(items),
            "applicable_count": sum(1 for o in items if o.result.applicable),
            "applicable_rate": sum(1 for o in items if o.result.applicable) / len(items)
            if items
            else None,
        }
        for key, items in groups.items()
    }


def category_confusion(outcomes: list[CaseOutcome]) -> dict[str, dict[str, int]]:
    categories: tuple[RoutingCategory, ...] = (
        "BOOLEAN_CLAIM",
        "COMPARATIVE_CLAIM",
        "PRESUPPOSITION_CLAIM",
        "MULTI_CLAIM",
        "NOT_NLI_APPLICABLE",
    )
    matrix = {gold: dict.fromkeys(categories, 0) for gold in categories}
    for o in outcomes:
        matrix[o.case.gold_category][o.result.category] += 1
    return matrix


def latency_stats(outcomes: list[CaseOutcome]) -> dict[str, float]:
    latencies = sorted(o.transform_latency_ms for o in outcomes)
    if not latencies:
        return {"mean_ms": 0.0, "p50_ms": 0.0, "p95_ms": 0.0, "max_ms": 0.0}
    return {
        "mean_ms": sum(latencies) / len(latencies),
        "p50_ms": latencies[len(latencies) // 2],
        "p95_ms": latencies[min(len(latencies) - 1, round(0.95 * (len(latencies) - 1)))],
        "max_ms": latencies[-1],
    }


@dataclass
class TransformerBenchmarkReport:
    generated_at: str
    case_count: int
    applicability: dict[str, object]
    unsafe: dict[str, object]
    polarity: dict[str, object]
    claim_exact_match: dict[str, object]
    multi_claim_accuracy: dict[str, object]
    coverage_overall: dict[str, object]
    coverage_by_question_category: dict[str, object]
    category_confusion_matrix: dict[str, dict[str, int]]
    latency: dict[str, float]
    cases: list[dict[str, object]] = field(default_factory=list)

    def to_dict(self) -> dict[str, object]:
        return {
            "generated_at": self.generated_at,
            "case_count": self.case_count,
            "applicability": self.applicability,
            "unsafe": self.unsafe,
            "polarity": self.polarity,
            "claim_exact_match": self.claim_exact_match,
            "multi_claim_accuracy": self.multi_claim_accuracy,
            "coverage_overall": self.coverage_overall,
            "coverage_by_question_category": self.coverage_by_question_category,
            "category_confusion_matrix": self.category_confusion_matrix,
            "latency": self.latency,
            "cases": self.cases,
        }


def build_report(outcomes: list[CaseOutcome]) -> TransformerBenchmarkReport:
    overall_applicable = sum(1 for o in outcomes if o.result.applicable)
    return TransformerBenchmarkReport(
        generated_at=utcnow().isoformat(),
        case_count=len(outcomes),
        applicability=applicability_metrics(outcomes),
        unsafe=unsafe_transformation_rate(outcomes),
        polarity=polarity_preservation(outcomes),
        claim_exact_match=claim_exact_match_rate(outcomes),
        multi_claim_accuracy=multi_claim_count_accuracy(outcomes),
        coverage_overall={
            "case_count": len(outcomes),
            "applicable_count": overall_applicable,
            "applicable_rate": overall_applicable / len(outcomes) if outcomes else None,
        },
        coverage_by_question_category=coverage_by_group(
            outcomes, group_fn=lambda c: c.question_category
        ),
        category_confusion_matrix=category_confusion(outcomes),
        latency=latency_stats(outcomes),
        cases=[
            {
                "case_id": o.case.case_id,
                "question": o.case.question,
                "gold_applicable": o.case.gold_applicable,
                "predicted_applicable": o.result.applicable,
                "gold_category": o.case.gold_category,
                "predicted_category": o.result.category,
                "gold_claims": list(o.case.gold_claims),
                "predicted_claims": list(o.result.claims),
                "applicability_correct": o.applicability_correct,
                "is_unsafe": o.is_unsafe,
            }
            for o in outcomes
        ],
    )


def write_report(report: TransformerBenchmarkReport, reports_dir: Path) -> Path:
    reports_dir.mkdir(parents=True, exist_ok=True)
    timestamp = utcnow().strftime("%Y%m%dT%H%M%SZ")
    path = reports_dir / f"claim-transformer-eval-{timestamp}.json"
    path.write_text(json.dumps(report.to_dict(), indent=2), encoding="utf-8")
    return path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reports-dir", type=Path, default=Path("evaluation/reports"))
    args = parser.parse_args()

    outcomes = run()
    report = build_report(outcomes)
    path = write_report(report, args.reports_dir)
    print(f"case_count={report.case_count}")
    print(f"applicability_accuracy={report.applicability['accuracy']}")
    print(f"applicable_precision={report.applicability['precision_applicable']}")
    print(f"applicable_recall={report.applicability['recall_applicable']}")
    print(f"unsafe_rate={report.unsafe['unsafe_rate_of_applicable_predictions']}")
    print(f"polarity_preservation_rate={report.polarity['preservation_rate']}")
    print(f"coverage_overall={report.coverage_overall['applicable_rate']}")
    print(f"latency_p50_ms={report.latency['p50_ms']:.4f}")
    print(f"written: {path}")


if __name__ == "__main__":
    main()
