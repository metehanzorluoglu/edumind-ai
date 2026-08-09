#!/usr/bin/env python
"""Milestone 8 (Dedicated NLI / Evidence Entailment Feasibility) —
EVALUATION-ONLY harness for benchmarking small, purpose-built NLI/
entailment models against evaluation/nli_dataset.py's hand-authored
premise/hypothesis corpus.

THIS SCRIPT REQUIRES THE ISOLATED EVALUATION ENVIRONMENT, NOT THE
PRODUCTION rag-backend .venv:

    source evaluation/.nli-eval-env/.venv/bin/activate
    PYTHONPATH=. python scripts/nli_feasibility_eval.py --model <hf-model-id>

torch/transformers/onnxruntime are installed ONLY in
evaluation/.nli-eval-env/.venv (gitignored, never part of the production
image or pyproject.toml dependencies) — see the Milestone 8 report §1 for
why. This script imports evaluation/nli_dataset.py and
evaluation/realistic_corpus.py directly (pure-Python + pydantic, both
present in the isolated venv too) but never imports anything from
app.core/app.api — it has no path into the production request flow and
is never invoked by any production code.

Usage:
    python scripts/nli_feasibility_eval.py --model cross-encoder/nli-deberta-v3-xsmall
    python scripts/nli_feasibility_eval.py --model cross-encoder/nli-deberta-v3-xsmall \
        --hypothesis-source question   # raw interrogative text instead of authored claim
    python scripts/nli_feasibility_eval.py --model cross-encoder/nli-deberta-v3-xsmall \
        --split holdout
"""

from __future__ import annotations

import argparse
import json
import os
import resource
import statistics
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

os.environ.setdefault(
    "HF_HOME", str(Path(__file__).resolve().parent.parent / "evaluation" / ".nli-model-cache")
)
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

# torch/transformers are deliberately NOT imported at module level: this
# keeps every pure-logic piece below (the dev/holdout split, label
# normalization, all metric computations) importable — and unit-testable —
# from the PRODUCTION rag-backend venv, which does not and should not have
# torch installed (see the module docstring). Only NLIModel.load/
# predict_batch actually need torch, and import it lazily inside those
# methods, the only place this script ever touches a model.
from evaluation.nli_dataset import (
    CONFLICTING_SOURCE_CASES,
    NLI_CASES,
    NLICase,
    NLILabel,
)

LABELS: tuple[NLILabel, ...] = ("entailment", "neutral", "contradiction")

# ---------------------------------------------------------------------------
# Dev/holdout topic-group split (Milestone 8 §27) — identical algorithmic
# shape to Milestone 7's split_dev_holdout (deterministic, whole-group
# assignment, every class checked present in both halves), reimplemented
# here since it operates on NLICase directly, not the verifier's
# (EvalCase, Sufficiency) pairs, and this script must run standalone in an
# environment that does not import scripts/optimize_evidence_verifier.py
# (which needs `ollama`, not installed in the isolated NLI venv).
# ---------------------------------------------------------------------------

import random  # noqa: E402

SPLIT_SEED = 84
DEV_FRACTION = 0.70


@dataclass(frozen=True)
class SplitResult:
    dev_ids: list[str]
    holdout_ids: list[str]
    meaningful: bool
    reason: str


def split_dev_holdout(cases: list[NLICase]) -> SplitResult:
    by_group: dict[str, list[NLICase]] = {}
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

    id_to_label = {c.case_id: c.gold_label for c in cases}
    dev_labels = {id_to_label[i] for i in dev_ids}
    holdout_labels = {id_to_label[i] for i in holdout_ids}
    missing_dev = set(LABELS) - dev_labels
    missing_holdout = set(LABELS) - holdout_labels
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
# Model wrapper — label-index mapping read from each model's OWN config
# (Milestone 8 §6/§14 caveat: candidates use DIFFERENT id2label orderings
# — cross-encoder/nli-deberta-v3-* uses {0: contradiction, 1: entailment,
# 2: neutral}, MoritzLaurer's uses {0: entailment, 1: neutral,
# 2: contradiction} — hardcoding either order would silently corrupt the
# other model's results, so this is read from config.id2label every time,
# never assumed.
# ---------------------------------------------------------------------------


@dataclass
class NLIModel:
    model_id: str
    tokenizer: object
    model: object
    label_from_index: dict[int, NLILabel]

    @classmethod
    def load(cls, model_id: str) -> NLIModel:
        from transformers import AutoModelForSequenceClassification, AutoTokenizer

        tokenizer = AutoTokenizer.from_pretrained(model_id)
        model = AutoModelForSequenceClassification.from_pretrained(model_id)
        # Milestone 8 §1/§17 finding: PyTorch's CPU backend lacks efficient
        # native float16 kernels — a model whose weights are stored/loaded
        # in fp16 (e.g. MoritzLaurer/DeBERTa-v3-base-mnli-fever-anli, which
        # ships torch_dtype=float16) falls back to slow scalar emulation on
        # CPU, measured at ~43.7s for a single pair vs ~0.25s after this
        # cast — a ~175x difference for numerically near-identical logits.
        # Always cast to fp32 for CPU inference; a no-op (and harmless) for
        # any candidate already stored in fp32.
        model = model.float()
        model.eval()
        label_from_index = {
            idx: _normalize_label(label) for idx, label in model.config.id2label.items()
        }
        return cls(
            model_id=model_id, tokenizer=tokenizer, model=model, label_from_index=label_from_index
        )

    def predict_batch(
        self, pairs: list[tuple[str, str]]
    ) -> tuple[list[NLILabel], list[list[float]]]:
        """pairs: list of (premise, hypothesis). Returns (predicted_labels, softmax_probs)."""
        import torch

        with torch.no_grad():
            premises = [p for p, _h in pairs]
            hypotheses = [h for _p, h in pairs]
            encoded = self.tokenizer(
                premises, hypotheses, return_tensors="pt", truncation=True, padding=True
            )
            logits = self.model(**encoded).logits
            probs = torch.softmax(logits, dim=-1)
            predicted_indices = torch.argmax(probs, dim=-1).tolist()
        predicted_labels = [self.label_from_index[i] for i in predicted_indices]
        return predicted_labels, probs.tolist()


def _normalize_label(raw: str) -> NLILabel:
    lowered = raw.lower()
    if lowered not in ("entailment", "neutral", "contradiction"):
        raise ValueError(f"unrecognized NLI label from model config: {raw!r}")
    return lowered  # type: ignore[return-value]


# ---------------------------------------------------------------------------
# Latency / memory measurement
# ---------------------------------------------------------------------------


def _rss_mb() -> float:
    """Resident set size of THIS process in MB (Linux: ru_maxrss is KB)."""
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024


def measure_latency(nli_model: NLIModel, sample_pairs: list[tuple[str, str]]) -> dict[str, object]:
    """cold load is measured separately by the caller (time to import+load);
    this measures warm single-pair, batch-4, batch-8 timing on already-loaded
    weights."""
    single = sample_pairs[0]

    # warm single-pair, repeated for a stable estimate
    single_latencies: list[float] = []
    for _ in range(8):
        t0 = time.perf_counter()
        nli_model.predict_batch([single])
        single_latencies.append((time.perf_counter() - t0) * 1000)

    batch4_pairs = (sample_pairs * 4)[:4]
    batch4_latencies: list[float] = []
    for _ in range(5):
        t0 = time.perf_counter()
        nli_model.predict_batch(batch4_pairs)
        batch4_latencies.append((time.perf_counter() - t0) * 1000)

    batch8_pairs = (sample_pairs * 8)[:8]
    batch8_latencies: list[float] = []
    for _ in range(5):
        t0 = time.perf_counter()
        nli_model.predict_batch(batch8_pairs)
        batch8_latencies.append((time.perf_counter() - t0) * 1000)

    def _stats(values: list[float]) -> dict[str, float]:
        ordered = sorted(values)
        return {
            "mean_ms": statistics.mean(values),
            "p50_ms": ordered[len(ordered) // 2],
            "min_ms": min(values),
            "max_ms": max(values),
        }

    return {
        "warm_single_pair": _stats(single_latencies),
        "batch4": _stats(batch4_latencies),
        "batch4_per_pair_ms": _stats(batch4_latencies)["mean_ms"] / 4,
        "batch8": _stats(batch8_latencies),
        "batch8_per_pair_ms": _stats(batch8_latencies)["mean_ms"] / 8,
    }


# ---------------------------------------------------------------------------
# Metrics — same shapes as Milestones 6/7's verifier benchmarks, adapted
# to the 3-class ENTAILMENT/NEUTRAL/CONTRADICTION ontology.
# ---------------------------------------------------------------------------


@dataclass
class CaseOutcome:
    case_id: str
    gold: NLILabel
    predicted: NLILabel
    probs: list[float]


def _per_class_prf(outcomes: list[CaseOutcome]) -> dict[str, dict[str, float | None]]:
    result: dict[str, dict[str, float | None]] = {}
    for label in LABELS:
        tp = sum(1 for o in outcomes if o.gold == label and o.predicted == label)
        fp = sum(1 for o in outcomes if o.gold != label and o.predicted == label)
        fn = sum(1 for o in outcomes if o.gold == label and o.predicted != label)
        precision = tp / (tp + fp) if (tp + fp) > 0 else None
        recall = tp / (tp + fn) if (tp + fn) > 0 else None
        f1 = (
            2 * precision * recall / (precision + recall)
            if precision is not None and recall is not None and (precision + recall) > 0
            else None
        )
        result[label] = {"precision": precision, "recall": recall, "f1": f1, "support": tp + fn}
    return result


def _confusion_matrix(outcomes: list[CaseOutcome]) -> dict[str, dict[str, int]]:
    matrix = {gold: dict.fromkeys(LABELS, 0) for gold in LABELS}
    for o in outcomes:
        matrix[o.gold][o.predicted] += 1
    return matrix


def _dangerous_errors(outcomes: list[CaseOutcome]) -> dict[str, object]:
    contra_support = sum(1 for o in outcomes if o.gold == "contradiction")
    contra_correct = sum(
        1 for o in outcomes if o.gold == "contradiction" and o.predicted == "contradiction"
    )
    contra_to_ent = [
        o.case_id for o in outcomes if o.gold == "contradiction" and o.predicted == "entailment"
    ]
    neutral_to_ent = [
        o.case_id for o in outcomes if o.gold == "neutral" and o.predicted == "entailment"
    ]
    neutral_support = sum(1 for o in outcomes if o.gold == "neutral")
    return {
        "contradiction_recall": contra_correct / contra_support if contra_support else None,
        "contradiction_to_entailment_rate": len(contra_to_ent) / contra_support
        if contra_support
        else None,
        "contradiction_to_entailment_case_ids": contra_to_ent,
        "neutral_to_entailment_rate": len(neutral_to_ent) / neutral_support
        if neutral_support
        else None,
        "neutral_to_entailment_case_ids": neutral_to_ent,
    }


def _safety_collapse(outcomes: list[CaseOutcome]) -> dict[str, object]:
    """ENTAILMENT -> evidence supports; NEUTRAL -> insufficient;
    CONTRADICTION -> evidence contradicts. Dangerous errors are anything
    NEUTRAL/CONTRADICTION gold mispredicted as ENTAILMENT (a false
    'evidence supports this claim')."""
    dangerous = [o for o in outcomes if o.gold != "entailment" and o.predicted == "entailment"]
    not_entailment_gold = [o for o in outcomes if o.gold != "entailment"]
    return {
        "dangerous_support_error_count": len(dangerous),
        "dangerous_support_error_case_ids": [o.case_id for o in dangerous],
        "dangerous_support_error_rate": len(dangerous) / len(not_entailment_gold)
        if not_entailment_gold
        else None,
    }


@dataclass
class CandidateReport:
    model_id: str
    hypothesis_source: str
    split_used: str
    case_count: int
    accuracy: float | None
    macro_f1: float | None
    per_class: dict[str, dict[str, float | None]]
    confusion_matrix: dict[str, dict[str, int]]
    dangerous_errors: dict[str, object]
    safety_collapse: dict[str, object]
    latency: dict[str, object]
    memory_rss_mb: float
    param_count: int
    cases: list[dict[str, object]] = field(default_factory=list)

    def to_dict(self) -> dict[str, object]:
        return {
            "model_id": self.model_id,
            "hypothesis_source": self.hypothesis_source,
            "split_used": self.split_used,
            "case_count": self.case_count,
            "accuracy": self.accuracy,
            "macro_f1": self.macro_f1,
            "per_class": self.per_class,
            "confusion_matrix": self.confusion_matrix,
            "dangerous_errors": self.dangerous_errors,
            "safety_collapse": self.safety_collapse,
            "latency": self.latency,
            "memory_rss_mb": self.memory_rss_mb,
            "param_count": self.param_count,
            "cases": self.cases,
        }


def build_report(
    model_id: str,
    hypothesis_source: str,
    split_used: str,
    outcomes: list[CaseOutcome],
    latency: dict[str, object],
    memory_rss_mb: float,
    param_count: int,
) -> CandidateReport:
    correct = sum(1 for o in outcomes if o.predicted == o.gold)
    accuracy = correct / len(outcomes) if outcomes else None
    per_class = _per_class_prf(outcomes)
    f1s = [v["f1"] for v in per_class.values() if v["f1"] is not None]
    macro_f1 = sum(f1s) / len(f1s) if f1s else None
    return CandidateReport(
        model_id=model_id,
        hypothesis_source=hypothesis_source,
        split_used=split_used,
        case_count=len(outcomes),
        accuracy=accuracy,
        macro_f1=macro_f1,
        per_class=per_class,
        confusion_matrix=_confusion_matrix(outcomes),
        dangerous_errors=_dangerous_errors(outcomes),
        safety_collapse=_safety_collapse(outcomes),
        latency=latency,
        memory_rss_mb=memory_rss_mb,
        param_count=param_count,
        cases=[
            {
                "case_id": o.case_id,
                "gold": o.gold,
                "predicted": o.predicted,
                "probs": [round(p, 4) for p in o.probs],
            }
            for o in outcomes
        ],
    )


def run_candidate(
    model_id: str,
    cases: list[NLICase],
    *,
    hypothesis_source: Literal["hypothesis", "question"],
    split_used: str,
) -> CandidateReport:
    t0 = time.perf_counter()
    nli_model = NLIModel.load(model_id)
    cold_load_ms = (time.perf_counter() - t0) * 1000
    param_count = sum(p.numel() for p in nli_model.model.parameters())

    pairs = [
        (
            case.premise_text(),
            case.hypothesis if hypothesis_source == "hypothesis" else case.question,
        )
        for case in cases
    ]
    predicted_labels, probs = nli_model.predict_batch(pairs)
    outcomes = [
        CaseOutcome(case_id=case.case_id, gold=case.gold_label, predicted=pred, probs=prob)
        for case, pred, prob in zip(cases, predicted_labels, probs, strict=True)
    ]

    latency = measure_latency(nli_model, pairs[:8] if len(pairs) >= 8 else pairs)
    latency["cold_load_ms"] = cold_load_ms
    memory_rss_mb = _rss_mb()

    return build_report(
        model_id, hypothesis_source, split_used, outcomes, latency, memory_rss_mb, param_count
    )


def run_conflicting_source_check(model_id: str) -> dict[str, object]:
    """Milestone 8 §21: source-level aggregation on genuinely conflicting
    evidence — each conflicting-source case's two premises are scored
    independently against the same hypothesis, and both predictions are
    reported (not collapsed) so the future aggregation-layer question this
    milestone is scoping — 'can supporting and contradicting evidence be
    detected as coexisting?' — has a direct empirical answer."""
    nli_model = NLIModel.load(model_id)
    results = []
    for case in CONFLICTING_SOURCE_CASES:
        pairs = [(case.source_a_text(), case.hypothesis), (case.source_b_text(), case.hypothesis)]
        predicted_labels, _probs = nli_model.predict_batch(pairs)
        a_correct = predicted_labels[0] == case.source_a_gold_label
        b_correct = predicted_labels[1] == case.source_b_gold_label
        results.append(
            {
                "case_id": case.case_id,
                "source_a_gold": case.source_a_gold_label,
                "source_a_predicted": predicted_labels[0],
                "source_a_correct": a_correct,
                "source_b_gold": case.source_b_gold_label,
                "source_b_predicted": predicted_labels[1],
                "source_b_correct": b_correct,
                "both_correct": a_correct and b_correct,
                "disagreement_detected": predicted_labels[0] != predicted_labels[1],
            }
        )
    both_correct_count = sum(1 for r in results if r["both_correct"])
    disagreement_detected_count = sum(1 for r in results if r["disagreement_detected"])
    return {
        "case_count": len(results),
        "both_sources_correctly_labeled_count": both_correct_count,
        "both_sources_correctly_labeled_rate": both_correct_count / len(results)
        if results
        else None,
        "disagreement_detected_count": disagreement_detected_count,
        "disagreement_detected_rate": disagreement_detected_count / len(results)
        if results
        else None,
        "cases": results,
    }


def write_report(report: CandidateReport, reports_dir: Path) -> Path:
    reports_dir.mkdir(parents=True, exist_ok=True)
    timestamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    safe_model = report.model_id.replace("/", "__")
    filename = (
        f"nli-feasibility-{safe_model}-{report.hypothesis_source}-{report.split_used}-{timestamp}.json"
    )
    path = reports_dir / filename
    path.write_text(json.dumps(report.to_dict(), indent=2), encoding="utf-8")
    return path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", required=True)
    parser.add_argument(
        "--hypothesis-source", choices=["hypothesis", "question"], default="hypothesis"
    )
    parser.add_argument("--split", choices=["dev", "holdout", "all"], default="dev")
    parser.add_argument("--reports-dir", type=Path, default=Path("evaluation/reports"))
    parser.add_argument(
        "--conflicting-sources",
        action="store_true",
        help="Run the §21 conflicting-source check instead",
    )
    args = parser.parse_args()

    if args.conflicting_sources:
        result = run_conflicting_source_check(args.model)
        print(json.dumps(result, indent=2))
        return

    split = split_dev_holdout(NLI_CASES)
    print(f"split: {split.reason}")
    id_to_case = {c.case_id: c for c in NLI_CASES}
    if args.split == "dev":
        selected_ids = split.dev_ids
    elif args.split == "holdout":
        selected_ids = split.holdout_ids
    else:
        selected_ids = split.dev_ids + split.holdout_ids
    cases = [id_to_case[i] for i in selected_ids]

    report = run_candidate(
        args.model, cases, hypothesis_source=args.hypothesis_source, split_used=args.split
    )
    path = write_report(report, args.reports_dir)
    print(
        f"model={report.model_id} hypothesis_source={report.hypothesis_source} "
        f"split={report.split_used}"
    )
    print(f"accuracy={report.accuracy} macro_f1={report.macro_f1}")
    print(f"contradiction_recall={report.dangerous_errors['contradiction_recall']}")
    print(
        f"contradiction_to_entailment_rate={report.dangerous_errors['contradiction_to_entailment_rate']}"
    )
    print(f"neutral_to_entailment_rate={report.dangerous_errors['neutral_to_entailment_rate']}")
    print(f"latency warm_single_pair p50={report.latency['warm_single_pair']['p50_ms']:.1f}ms")
    print(f"latency batch8 per-pair={report.latency['batch8_per_pair_ms']:.1f}ms")
    print(f"memory_rss_mb={report.memory_rss_mb:.0f} param_count={report.param_count}")
    print(f"written: {path}")


if __name__ == "__main__":
    main()
