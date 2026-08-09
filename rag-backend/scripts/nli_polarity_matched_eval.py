#!/usr/bin/env python
"""Milestone 9.5 (Polarity-Matched Claim + NLI Validation) — the
authoritative, non-confounded NLI benchmark. Runs cross-encoder/nli-
deberta-v3-small (PyTorch fp32) on evaluation/polarity_matched_dataset.py
TWICE per case (manual polarity-matched claim, then the transformer's own
auto-transformed claim, restricted to the 80/87 cases where the live
transformer actually applies — Milestone 9.5 §6), on a topic-group dev/
holdout split (§18), and reports the clean metric delta (§9).

REQUIRES THE ISOLATED EVALUATION ENVIRONMENT (torch/transformers):

    source evaluation/.nli-eval-env/.venv/bin/activate
    PYTHONPATH=. python scripts/nli_polarity_matched_eval.py

Never imported by, or wired into, any production request path.
"""

from __future__ import annotations

import json
import os
import random
import time
from dataclasses import dataclass
from pathlib import Path

os.environ.setdefault(
    "HF_HOME", str(Path(__file__).resolve().parent.parent / "evaluation" / ".nli-model-cache")
)
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

from evaluation.claim_transformer import classify_and_transform
from evaluation.polarity_matched_dataset import CASES, PolarityMatchedCase
from scripts.nli_feasibility_eval import (
    NLIModel,
    _confusion_matrix,
    _dangerous_errors,
    _per_class_prf,
)

MODEL_ID = "cross-encoder/nli-deberta-v3-small"
SPLIT_SEED = 95
DEV_FRACTION = 0.70


# ---------------------------------------------------------------------------
# Dev/holdout split by topic (§18) — reuses the exact algorithmic shape
# established in Milestones 7/8/9 (deterministic, whole-group assignment).
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class SplitResult:
    dev_ids: list[str]
    holdout_ids: list[str]
    meaningful: bool
    reason: str


def split_dev_holdout(cases: list[PolarityMatchedCase]) -> SplitResult:
    by_group: dict[str, list[PolarityMatchedCase]] = {}
    for case in cases:
        by_group.setdefault(case.topic, []).append(case)
    group_keys = list(by_group.keys())
    if len(group_keys) < 4:
        return SplitResult([], [], False, f"only {len(group_keys)} topic groups — too few")
    rng = random.Random(SPLIT_SEED)
    rng.shuffle(group_keys)
    target = round(len(cases) * DEV_FRACTION)
    dev_groups: list[str] = []
    dev_ids: list[str] = []
    for key in group_keys:
        if len(dev_ids) >= target:
            break
        dev_groups.append(key)
        dev_ids.extend(c.case_id for c in by_group[key])
    holdout_ids = [c.case_id for k in group_keys if k not in dev_groups for c in by_group[k]]
    id_to_label = {c.case_id: c.gold_relation for c in cases}
    dev_labels = {id_to_label[i] for i in dev_ids}
    holdout_labels = {id_to_label[i] for i in holdout_ids}
    labels = {"entailment", "neutral", "contradiction"}
    missing_dev = labels - dev_labels
    missing_holdout = labels - holdout_labels
    meaningful = not missing_dev and not missing_holdout
    reason = (
        f"deterministic GROUP-level 70/30 split by topic, seed={SPLIT_SEED}, "
        f"{len(dev_groups)}/{len(group_keys)} groups in dev"
    )
    if missing_dev:
        reason += f"; WARNING missing from dev: {sorted(missing_dev)}"
    if missing_holdout:
        reason += f"; WARNING missing from holdout: {sorted(missing_holdout)}"
    return SplitResult(dev_ids, holdout_ids, meaningful, reason)


# ---------------------------------------------------------------------------
# Scoring
# ---------------------------------------------------------------------------


@dataclass
class Outcome:
    case_id: str
    gold: str
    predicted: str


def score(
    model: NLIModel, cases: list[PolarityMatchedCase], *, use_auto_claim: bool
) -> list[Outcome]:
    pairs = []
    for case in cases:
        if use_auto_claim:
            result = classify_and_transform(case.question)
            hypothesis = result.claims[0]
        else:
            hypothesis = case.expected_natural_claim
        pairs.append((case.premise_text(), hypothesis))
    predicted_labels, _probs = model.predict_batch(pairs)
    return [
        Outcome(case_id=c.case_id, gold=c.gold_relation, predicted=p)
        for c, p in zip(cases, predicted_labels, strict=True)
    ]


def summarize(outcomes: list[Outcome]) -> dict[str, object]:
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
    }


def _delta(
    auto: dict[str, object], manual: dict[str, object], path: tuple[str, ...]
) -> float | None:
    a, m = auto, manual
    for key in path:
        a = a[key] if a is not None else None  # type: ignore[index]
        m = m[key] if m is not None else None  # type: ignore[index]
    if a is None or m is None:
        return None
    return a - m  # type: ignore[operator]


def main() -> None:
    applicable_cases = [c for c in CASES if c.auto_applicable_expected]
    print(
        f"total dataset: {len(CASES)} cases; "
        f"auto-applicable single-claim subset: {len(applicable_cases)}"
    )

    split = split_dev_holdout(applicable_cases)
    print(f"split: {split.reason}")
    id_to_case = {c.case_id: c for c in applicable_cases}
    dev_cases = [id_to_case[i] for i in split.dev_ids]
    holdout_cases = [id_to_case[i] for i in split.holdout_ids]

    t0 = time.time()
    model = NLIModel.load(MODEL_ID)
    print(f"model loaded in {time.time() - t0:.1f}s")

    results: dict[str, object] = {"model_id": MODEL_ID, "split": split.reason}

    for split_name, cases in (
        ("dev", dev_cases),
        ("holdout", holdout_cases),
        ("all", applicable_cases),
    ):
        if not cases:
            continue
        manual_outcomes = score(model, cases, use_auto_claim=False)
        auto_outcomes = score(model, cases, use_auto_claim=True)
        manual_summary = summarize(manual_outcomes)
        auto_summary = summarize(auto_outcomes)
        agree = sum(
            1
            for m, a in zip(manual_outcomes, auto_outcomes, strict=True)
            if m.predicted == a.predicted
        )
        deltas = {
            "macro_f1_delta": _delta(auto_summary, manual_summary, ("macro_f1",)),
            "accuracy_delta": _delta(auto_summary, manual_summary, ("accuracy",)),
            "contradiction_recall_delta": _delta(
                auto_summary, manual_summary, ("dangerous_errors", "contradiction_recall")
            ),
            "contradiction_to_entailment_delta": _delta(
                auto_summary,
                manual_summary,
                ("dangerous_errors", "contradiction_to_entailment_rate"),
            ),
            "neutral_to_entailment_delta": _delta(
                auto_summary, manual_summary, ("dangerous_errors", "neutral_to_entailment_rate")
            ),
        }
        results[split_name] = {
            "case_count": len(cases),
            "manual_claim_baseline": manual_summary,
            "auto_transformed_claim": auto_summary,
            "prediction_agreement_rate": agree / len(cases),
            "deltas": deltas,
        }
        print(f"\n=== {split_name.upper()} (n={len(cases)}) ===")
        manual_errs = manual_summary["dangerous_errors"]
        print(
            f"MANUAL:  acc={manual_summary['accuracy']:.3f} "
            f"macroF1={manual_summary['macro_f1']:.3f} "
            f"contra_recall={manual_errs['contradiction_recall']} "
            f"contra_to_ent={manual_errs['contradiction_to_entailment_rate']} "
            f"neu_to_ent={manual_errs['neutral_to_entailment_rate']}"
        )
        print(
            f"AUTO:    acc={auto_summary['accuracy']:.3f} macroF1={auto_summary['macro_f1']:.3f} "
            f"contra_recall={auto_summary['dangerous_errors']['contradiction_recall']} "
            f"contra_to_ent={auto_summary['dangerous_errors']['contradiction_to_entailment_rate']} "
            f"neu_to_ent={auto_summary['dangerous_errors']['neutral_to_entailment_rate']}"
        )
        print(f"agreement={agree}/{len(cases)}={agree / len(cases):.3f}  deltas={deltas}")

    reports_dir = Path("evaluation/reports")
    reports_dir.mkdir(parents=True, exist_ok=True)
    timestamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    path = reports_dir / f"nli-polarity-matched-eval-{timestamp}.json"
    path.write_text(json.dumps(results, indent=2), encoding="utf-8")
    print(f"\nwritten: {path}")


if __name__ == "__main__":
    main()
