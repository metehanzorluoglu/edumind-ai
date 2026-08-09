#!/usr/bin/env python
"""Milestone 10 (Production Evidence Architecture Design) §44/§5/§6 — the
ONE new evaluation this milestone authorizes: replaying the existing
Milestone 9.5/9.6 polarity-matched evaluation corpus at top-1/3/5/8 source
counts, to produce evidence for a MAX_NLI_SOURCES production default.

Reuses (does not rebuild) evaluation/polarity_matched_dataset.py's real
M5.7-derived cases and evaluation/evidence_aggregation.py's Milestone-9
relation-matrix aggregation, unmodified. For each case, the TRUE premise
chunk (the dataset's own, human-audited evidence) is source #1; sources
2..N are realistic SAME-TOPIC distractor chunks drawn from the companion
document in that topic (each M5.7 topic has exactly two documents — see
evaluation/realistic_corpus.py) — this simulates what a real top-k
retrieval would actually return beyond the single best-matching chunk:
topically related but not necessarily the specific evidence needed.

Measures, at each top-k: whole-CLAIM evidence-state accuracy (via
aggregate_claim_status, not raw per-pair accuracy) against the case's
known-correct status (entailment->SUPPORTED, contradiction->CONTRADICTED,
neutral->UNSUPPORTED), how often distractors spuriously flip a correct
verdict, and batch latency.

REQUIRES THE ISOLATED EVALUATION ENVIRONMENT (torch/transformers):

    source evaluation/.nli-eval-env/.venv/bin/activate
    PYTHONPATH=. python scripts/nli_source_limit_experiment.py

Never imported by, or wired into, any production request path.
"""

from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass
from pathlib import Path

os.environ.setdefault("HF_HOME", str(Path(__file__).resolve().parent.parent / "evaluation" / ".nli-model-cache"))
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

from evaluation.evidence_aggregation import (  # noqa: E402
    ClaimRelationRow,
    SourceRelation,
    aggregate_claim_status,
)
from evaluation.polarity_matched_dataset import CASES, PolarityMatchedCase  # noqa: E402
from evaluation.realistic_corpus import DOCUMENTS_BY_ID, REALISTIC_DOCUMENTS  # noqa: E402
from scripts.nli_feasibility_eval import NLIModel  # noqa: E402

MODEL_ID = "ynie/roberta-large-snli_mnli_fever_anli_R1_R2_R3-nli"
TOP_K_VALUES = (1, 3, 5, 8)

_EXPECTED_STATUS = {"entailment": "SUPPORTED", "contradiction": "CONTRADICTED", "neutral": "UNSUPPORTED"}


def _companion_document_chunks(case: PolarityMatchedCase) -> list[tuple[str, int]]:
    """Every (document_id, chunk_index) in the SAME topic as `case`,
    excluding the case's own true premise chunk — the realistic
    "same-topic distractor" pool a real top-k retrieval would surface."""
    topic_docs = [d for d in REALISTIC_DOCUMENTS if d.topic == case.topic]
    pool: list[tuple[str, int]] = []
    for doc in topic_docs:
        for idx in range(len(doc.chunks)):
            if doc.document_id == case.premise_document_id and idx in case.premise_chunk_indices:
                continue
            pool.append((doc.document_id, idx))
    return pool


def build_source_set(case: PolarityMatchedCase, k: int) -> list[str]:
    """Source #1 is always the case's own true premise. Sources 2..k are
    deterministic (sorted, not random — reproducible) same-topic
    distractor chunks."""
    texts = [case.premise_text()]
    if k <= 1:
        return texts
    distractors = sorted(_companion_document_chunks(case))
    for doc_id, idx in distractors[: k - 1]:
        texts.append(DOCUMENTS_BY_ID[doc_id].chunks[idx].text)
    return texts


@dataclass
class TopKOutcome:
    case_id: str
    k: int
    actual_source_count: int
    expected_status: str
    actual_status: str
    correct: bool
    latency_ms: float


def run_top_k(model: NLIModel, cases: list[PolarityMatchedCase], k: int) -> list[TopKOutcome]:
    outcomes = []
    for case in cases:
        sources = build_source_set(case, k)
        pairs = [(src, case.expected_natural_claim) for src in sources]
        t0 = time.perf_counter()
        predicted_labels, _probs = model.predict_batch(pairs)
        latency_ms = (time.perf_counter() - t0) * 1000

        row = ClaimRelationRow(
            claim=case.expected_natural_claim,
            source_relations=tuple(
                SourceRelation(source_id=f"S{i + 1}", relation=lbl) for i, lbl in enumerate(predicted_labels)
            ),
        )
        status = aggregate_claim_status(row)
        expected = _EXPECTED_STATUS[case.gold_relation]
        outcomes.append(
            TopKOutcome(
                case_id=case.case_id,
                k=k,
                actual_source_count=len(sources),
                expected_status=expected,
                actual_status=status,
                correct=(status == expected),
                latency_ms=latency_ms,
            )
        )
    return outcomes


def summarize(outcomes: list[TopKOutcome]) -> dict[str, object]:
    n = len(outcomes)
    correct = sum(1 for o in outcomes if o.correct)
    by_expected: dict[str, list[TopKOutcome]] = {}
    for o in outcomes:
        by_expected.setdefault(o.expected_status, []).append(o)
    per_class_accuracy = {
        status: sum(1 for o in items if o.correct) / len(items) for status, items in by_expected.items()
    }
    # Dangerous: expected CONTRADICTED but got SUPPORTED, or expected
    # UNSUPPORTED but got SUPPORTED (a false SUPPORTED verdict).
    dangerous = [o for o in outcomes if o.expected_status != "SUPPORTED" and o.actual_status == "SUPPORTED"]
    spurious_conflicted = [o for o in outcomes if o.actual_status == "CONFLICTED"]
    latencies = sorted(o.latency_ms for o in outcomes)
    return {
        "case_count": n,
        "evidence_state_accuracy": correct / n if n else None,
        "per_expected_status_accuracy": per_class_accuracy,
        "dangerous_false_supported_count": len(dangerous),
        "dangerous_false_supported_case_ids": [o.case_id for o in dangerous],
        "spurious_conflicted_count": len(spurious_conflicted),
        "spurious_conflicted_case_ids": [o.case_id for o in spurious_conflicted],
        "latency_ms": {
            "mean": sum(latencies) / len(latencies) if latencies else 0.0,
            "p50": latencies[len(latencies) // 2] if latencies else 0.0,
            "p95": latencies[int(0.95 * (len(latencies) - 1))] if latencies else 0.0,
        },
    }


def main() -> None:
    applicable = [c for c in CASES if c.auto_applicable_expected]
    print(f"cases: {len(applicable)}")

    model = NLIModel.load(MODEL_ID)

    results: dict[str, object] = {"model_id": MODEL_ID, "case_count": len(applicable)}
    for k in TOP_K_VALUES:
        outcomes = run_top_k(model, applicable, k)
        summary = summarize(outcomes)
        results[f"top{k}"] = summary
        print(
            f"top{k}: acc={summary['evidence_state_accuracy']:.3f} "
            f"dangerous_false_supported={summary['dangerous_false_supported_count']} "
            f"spurious_conflicted={summary['spurious_conflicted_count']} "
            f"latency_p50={summary['latency_ms']['p50']:.0f}ms "
            f"latency_mean={summary['latency_ms']['mean']:.0f}ms"
        )
        print(f"  per_expected_status_accuracy: {summary['per_expected_status_accuracy']}")

    reports_dir = Path("evaluation/reports")
    reports_dir.mkdir(parents=True, exist_ok=True)
    timestamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    path = reports_dir / f"nli-source-limit-experiment-{timestamp}.json"
    path.write_text(json.dumps(results, indent=2), encoding="utf-8")
    print(f"written: {path}")


if __name__ == "__main__":
    main()
