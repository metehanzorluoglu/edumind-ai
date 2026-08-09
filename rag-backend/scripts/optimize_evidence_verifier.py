#!/usr/bin/env python
"""Milestone 7 (Evidence Verifier Optimization & Readiness Gate) —
EVALUATION-ONLY optimization harness for the Milestone 6 evidence-verifier
prototype. Never imported by, or wired into, any production request path.

Reuses (does not reimplement) Milestone 6's retrieval helpers
(scripts/prototype_evidence_verifier.py's retrieve_evidence/EVAL_USER_ID),
Milestone 5.7's real-embedding corpus/select_embedding_provider, and
evaluation/verifier_eval_subset.py's 51 hand-reviewed cases. Adds only what
Milestone 7 needs on top: a topic-group dev/holdout split, a small matrix
of (thinking, schema, token-budget, evidence-size, prompt-variant)
configurations, and the same rich metric suite Milestone 6 introduced
(4-class + macro F1 + per-class + confusion matrix + dangerous-error +
binary-safety), now also capturing Ollama's own load/prompt-eval/eval
duration fields per call for root-cause latency analysis.

Usage:
    python scripts/optimize_evidence_verifier.py --experiment thinking
    python scripts/optimize_evidence_verifier.py --experiment schema
    python scripts/optimize_evidence_verifier.py --experiment tokens
    python scripts/optimize_evidence_verifier.py --experiment evidence-size
    python scripts/optimize_evidence_verifier.py --experiment variants --split dev
    python scripts/optimize_evidence_verifier.py --experiment variants --split holdout --variant v1
"""

from __future__ import annotations

import argparse
import json
import random
import time
from dataclasses import dataclass, field
from pathlib import Path

import ollama

from app.config import get_settings
from app.core.citation import build_citations
from app.core.retrieval_schemas import RetrievedChunk
from app.vectorstore.qdrant_client import QdrantVectorStore
from cli.reporting import utcnow
from evaluation.controlled_corpus import EvalCase
from evaluation.realistic_corpus import REALISTIC_DOCUMENTS
from evaluation.verifier_eval_subset import Sufficiency, reviewed_eval_cases
from scripts.eval_retrieval_controlled import ingest_controlled_corpus, select_embedding_provider
from scripts.prototype_evidence_verifier import EVAL_USER_ID, retrieve_evidence

VERDICTS: tuple[Sufficiency, ...] = ("SUFFICIENT", "PARTIAL", "INSUFFICIENT", "CONTRADICTORY")

# ---------------------------------------------------------------------------
# §10: deterministic topic-group dev/holdout split — same algorithmic shape
# as evaluation's Milestone 5.7 deterministic_group_split (grouped by
# EvalCase.topic, whole groups assigned, never row-level), reimplemented
# small and self-contained here since it operates on
# (EvalCase, Sufficiency) pairs, not ScoredCase objects. Every class present
# in both halves is checked explicitly, not assumed.
# ---------------------------------------------------------------------------

SPLIT_SEED = 72
DEV_FRACTION = 0.70


@dataclass(frozen=True)
class SplitResult:
    dev_case_ids: list[str]
    holdout_case_ids: list[str]
    dev_group_keys: list[str]
    holdout_group_keys: list[str]
    meaningful: bool
    reason: str


def split_dev_holdout(cases: list[tuple[EvalCase, Sufficiency]]) -> SplitResult:
    by_group: dict[str, list[tuple[EvalCase, Sufficiency]]] = {}
    for case, label in cases:
        key = case.topic if case.topic else f"__case__{case.case_id}"
        by_group.setdefault(key, []).append((case, label))

    group_keys = list(by_group.keys())
    if len(group_keys) < 4:
        return SplitResult(
            [],
            [],
            [],
            [],
            False,
            f"only {len(group_keys)} topic groups — too few for a group split",
        )

    rng = random.Random(SPLIT_SEED)
    rng.shuffle(group_keys)

    target_dev_count = round(len(cases) * DEV_FRACTION)
    dev_groups: list[str] = []
    dev_case_ids: list[str] = []
    for key in group_keys:
        if len(dev_case_ids) >= target_dev_count:
            break
        dev_groups.append(key)
        dev_case_ids.extend(c.case_id for c, _label in by_group[key])
    holdout_groups = [k for k in group_keys if k not in dev_groups]
    holdout_case_ids = [c.case_id for k in holdout_groups for c, _label in by_group[k]]

    dev_labels = {label for cid in dev_case_ids for c, label in cases if c.case_id == cid}
    holdout_labels = {label for cid in holdout_case_ids for c, label in cases if c.case_id == cid}
    missing_from_dev = set(VERDICTS) - dev_labels
    missing_from_holdout = set(VERDICTS) - holdout_labels
    meaningful = not missing_from_dev and not missing_from_holdout
    reason = (
        f"deterministic GROUP-level {int(DEV_FRACTION * 100)}%/{int((1 - DEV_FRACTION) * 100)}% "
        f"split by topic, seed={SPLIT_SEED}, {len(dev_groups)}/{len(group_keys)} groups in dev"
    )
    if missing_from_dev:
        reason += f"; WARNING classes missing from dev: {sorted(missing_from_dev)}"
    if missing_from_holdout:
        reason += f"; WARNING classes missing from holdout: {sorted(missing_from_holdout)}"

    return SplitResult(
        dev_case_ids, holdout_case_ids, dev_groups, holdout_groups, meaningful, reason
    )


# ---------------------------------------------------------------------------
# Prompt variants (§9) and schema variants (§3) — evaluation-only, never
# added to app/core/prompt_builder.py.
# ---------------------------------------------------------------------------

# V0: Milestone 6's exact original system prompt (the one that measured
# 16.3s mean warm latency, 56% accuracy, 0/10 CONTRADICTORY recall) —
# reproduced verbatim here (not imported) so V0's behavior is pinned even
# if scripts/prototype_evidence_verifier.py's own prompt constant changes
# later; this is the fixed baseline every other variant is compared against.
PROMPT_V0 = """You check whether numbered evidence sources are enough to answer a question. Judge \
ONLY from the evidence given below — never use outside knowledge.

Verdicts:
- SUFFICIENT: the evidence directly and completely answers the question.
- PARTIAL: the evidence answers only part of a multi-part question, comparison, or synthesis \
(e.g. one side of a comparison is present, the other is not).
- INSUFFICIENT: the evidence is on-topic but does not contain enough information to answer; \
nothing in it actively contradicts the question.
- CONTRADICTORY: the evidence contains an explicit statement that contradicts a factual premise \
or claim in the question."""

# V1: short definitions + the two contradiction-vs-insufficient examples
# from the Milestone 7 spec §7, verbatim in spirit — no adversarial
# "do not think" scaffolding (Milestone 7 §1/§2 found that scaffolding was
# itself a cause of extra hidden reasoning, not a fix for it).
PROMPT_V1 = """Judge whether the evidence sources below answer the question. Use ONLY the evidence \
given.

- SUFFICIENT: evidence directly and completely answers the question.
- PARTIAL: evidence answers only part of a multi-part question or comparison.
- INSUFFICIENT: evidence is silent on the requested fact — it does not address it either way.
- CONTRADICTORY: evidence explicitly refutes a premise or claim in the question.

INSUFFICIENT vs CONTRADICTORY — the key distinction:
Question: "How much did the intervention improve far-transfer performance?"
Evidence: "No statistically significant improvement in far-transfer performance was observed."
Verdict: CONTRADICTORY — evidence explicitly refutes the presupposed improvement.

Question: "What was the far-transfer improvement?"
Evidence: "The study discusses far-transfer testing but reports no result."
Verdict: INSUFFICIENT — evidence is silent; nothing is refuted."""

# V2: V1 + the multi-document completeness examples from §8 — judge actual
# coverage, not question shape.
PROMPT_V2 = (
    PROMPT_V1
    + """

Multi-part questions — judge actual coverage, not the question's shape:
Question: "Compare A and B."
Evidence: contains both A's result and B's result.
Verdict: SUFFICIENT — a comparison question, but fully covered, so NOT automatically PARTIAL.

Question: "Compare A and B."
Evidence: contains only A's result.
Verdict: PARTIAL — only one required side of the comparison is present."""
)

PROMPT_VARIANTS: dict[str, str] = {"v0": PROMPT_V0, "v1": PROMPT_V1, "v2": PROMPT_V2}

SCHEMA_A_MINIMAL: dict[str, object] = {
    "type": "object",
    "properties": {"verdict": {"type": "string", "enum": list(VERDICTS)}},
    "required": ["verdict"],
}
SCHEMA_B_WITH_SOURCES: dict[str, object] = {
    "type": "object",
    "properties": {
        "verdict": {"type": "string", "enum": list(VERDICTS)},
        "supporting_source_ids": {"type": "array", "items": {"type": "string"}},
        "contradicting_source_ids": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["verdict", "supporting_source_ids", "contradicting_source_ids"],
}
SCHEMAS: dict[str, dict[str, object]] = {
    "A_minimal": SCHEMA_A_MINIMAL,
    "B_with_sources": SCHEMA_B_WITH_SOURCES,
}


@dataclass(frozen=True)
class VerifierConfig:
    label: str
    prompt_variant: str  # key into PROMPT_VARIANTS
    schema_variant: str  # key into SCHEMAS
    thinking: bool
    num_predict: int
    evidence_top_n: int | None  # None = all prepared sources (production behavior)
    model: str = "qwen3:4b"


def _build_user_prompt(
    query: str, sources: list[RetrievedChunk], citations, top_n: int | None
) -> str:
    limited_sources = sources[:top_n] if top_n is not None else sources
    limited_citations = citations[: len(limited_sources)]
    parts = [f"Question: {query}", "", "Evidence:"]
    for citation, chunk in zip(limited_citations, limited_sources, strict=True):
        parts.append(f'<source id="{citation.source_id}">{chunk.text}</source>')
    return "\n".join(parts)


# ---------------------------------------------------------------------------
# Model call
# ---------------------------------------------------------------------------


@dataclass
class RawCallStats:
    verdict: str | None
    supporting_source_ids: list[str]
    contradicting_source_ids: list[str]
    parse_ok: bool
    latency_ms: float
    load_duration_ms: float
    prompt_eval_count: int
    prompt_eval_duration_ms: float
    eval_count: int
    eval_duration_ms: float
    thinking_char_count: int


def parse_verdict_response(raw: str) -> tuple[str | None, list[str], list[str], bool]:
    """Fail-closed structured-output parser: returns (verdict, supporting_ids,
    contradicting_ids, parse_ok). Any parse problem — invalid JSON, a missing
    or unknown verdict, a malformed id list — returns (None, [], [], False)
    rather than guessing, so a caller can never mistake a parse failure for
    any real verdict, including INSUFFICIENT (Milestone 6 §10/§11's
    never-silently-widen-trust rule)."""
    verdict: str | None = None
    supporting: list[str] = []
    contradicting: list[str] = []
    parse_ok = False
    try:
        data = json.loads(raw)
        candidate_verdict = data.get("verdict")
        if candidate_verdict in VERDICTS:
            verdict = candidate_verdict
            parse_ok = True
            supp = data.get("supporting_source_ids", [])
            contra = data.get("contradicting_source_ids", [])
            supporting = (
                supp if isinstance(supp, list) and all(isinstance(s, str) for s in supp) else []
            )
            contradicting = (
                contra
                if isinstance(contra, list) and all(isinstance(s, str) for s in contra)
                else []
            )
    except (json.JSONDecodeError, AttributeError):
        pass
    return verdict, supporting, contradicting, parse_ok


def call_verifier(
    client: ollama.Client,
    *,
    config: VerifierConfig,
    query: str,
    sources: list[RetrievedChunk],
    citations,
) -> RawCallStats:
    system_prompt = PROMPT_VARIANTS[config.prompt_variant]
    schema = SCHEMAS[config.schema_variant]
    user_prompt = _build_user_prompt(query, sources, citations, config.evidence_top_n)

    t0 = time.perf_counter()
    response = client.chat(
        model=config.model,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        stream=False,
        think=config.thinking,
        format=schema,
        options={"temperature": 0, "num_predict": config.num_predict, "seed": 42},
    )
    latency_ms = (time.perf_counter() - t0) * 1000

    verdict, supporting, contradicting, parse_ok = parse_verdict_response(
        response.message.content or ""
    )
    thinking_text = getattr(response.message, "thinking", None) or ""

    return RawCallStats(
        verdict=verdict,
        supporting_source_ids=supporting,
        contradicting_source_ids=contradicting,
        parse_ok=parse_ok,
        latency_ms=latency_ms,
        load_duration_ms=(response.load_duration or 0) / 1e6,
        prompt_eval_count=response.prompt_eval_count or 0,
        prompt_eval_duration_ms=(response.prompt_eval_duration or 0) / 1e6,
        eval_count=response.eval_count or 0,
        eval_duration_ms=(response.eval_duration or 0) / 1e6,
        thinking_char_count=len(thinking_text),  # length only — never the text itself, never logged
    )


# ---------------------------------------------------------------------------
# Metrics (same shapes as Milestone 6's prototype_evidence_verifier.py,
# reproduced here rather than imported so this script's metric definitions
# stay pinned/self-contained across future edits to that module)
# ---------------------------------------------------------------------------


@dataclass
class CaseOutcome:
    case_id: str
    gold: str
    predicted: str | None
    stats: RawCallStats


def _per_class_prf(outcomes: list[CaseOutcome]) -> dict[str, dict[str, float | None]]:
    result: dict[str, dict[str, float | None]] = {}
    for label in VERDICTS:
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
    labels = (*VERDICTS, "PARSE_FAILURE")
    matrix = {gold: dict.fromkeys(labels, 0) for gold in VERDICTS}
    for o in outcomes:
        matrix[o.gold][o.predicted if o.predicted is not None else "PARSE_FAILURE"] += 1
    return matrix


def _dangerous_errors(outcomes: list[CaseOutcome]) -> dict[str, object]:
    def _rate(gold: str, predicted: str) -> tuple[int, list[str]]:
        ids = [o.case_id for o in outcomes if o.gold == gold and o.predicted == predicted]
        return len(ids), ids

    contra_to_suff_n, contra_to_suff_ids = _rate("CONTRADICTORY", "SUFFICIENT")
    insuff_to_suff_n, insuff_to_suff_ids = _rate("INSUFFICIENT", "SUFFICIENT")
    partial_to_suff_n, partial_to_suff_ids = _rate("PARTIAL", "SUFFICIENT")
    suff_blocked_ids = [
        o.case_id for o in outcomes if o.gold == "SUFFICIENT" and o.predicted != "SUFFICIENT"
    ]
    suff_blocked_n = len(suff_blocked_ids)
    contradictory_recall = None
    contra_support = sum(1 for o in outcomes if o.gold == "CONTRADICTORY")
    if contra_support > 0:
        contra_correct = sum(
            1 for o in outcomes if o.gold == "CONTRADICTORY" and o.predicted == "CONTRADICTORY"
        )
        contradictory_recall = contra_correct / contra_support
    return {
        "contradictory_recall": contradictory_recall,
        "contradictory_to_sufficient_rate": contra_to_suff_n / contra_support
        if contra_support
        else None,
        "contradictory_to_sufficient_case_ids": contra_to_suff_ids,
        "insufficient_to_sufficient_count": insuff_to_suff_n,
        "insufficient_to_sufficient_case_ids": insuff_to_suff_ids,
        "partial_to_sufficient_count": partial_to_suff_n,
        "partial_to_sufficient_case_ids": partial_to_suff_ids,
        "sufficient_false_block_count": suff_blocked_n,
        "sufficient_false_block_case_ids": suff_blocked_ids,
    }


def _binary_safety(outcomes: list[CaseOutcome]) -> dict[str, object]:
    def _bucket(label: str | None) -> str:
        if label == "SUFFICIENT":
            return "SAFE_TO_GENERATE"
        if label in ("PARTIAL", "INSUFFICIENT", "CONTRADICTORY"):
            return "NOT_FULLY_SUPPORTED"
        return "PARSE_FAILURE"

    tp = fp = tn = fn = parse_failures = 0
    for o in outcomes:
        gold_b, pred_b = _bucket(o.gold), _bucket(o.predicted)
        if pred_b == "PARSE_FAILURE":
            parse_failures += 1
            continue
        if gold_b == "SAFE_TO_GENERATE" and pred_b == "SAFE_TO_GENERATE":
            tp += 1
        elif gold_b == "NOT_FULLY_SUPPORTED" and pred_b == "SAFE_TO_GENERATE":
            fp += 1
        elif gold_b == "NOT_FULLY_SUPPORTED" and pred_b == "NOT_FULLY_SUPPORTED":
            tn += 1
        else:
            fn += 1
    return {
        "safe_to_generate_tp": tp,
        "dangerous_false_approval_fp": fp,
        "not_fully_supported_tn": tn,
        "sufficient_false_block_fn": fn,
        "parse_failures_excluded": parse_failures,
        "dangerous_false_approval_rate": fp / (fp + tn) if (fp + tn) > 0 else None,
        "sufficient_false_block_rate": fn / (fn + tp) if (fn + tp) > 0 else None,
        "binary_accuracy": (tp + tn) / (tp + fp + tn + fn) if (tp + fp + tn + fn) > 0 else None,
    }


def _percentile(values: list[float], pct: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    idx = min(len(ordered) - 1, max(0, round(pct * (len(ordered) - 1))))
    return ordered[idx]


@dataclass
class VariantReport:
    config: VerifierConfig
    split_used: str
    case_count: int
    accuracy: float | None
    macro_f1: float | None
    per_class: dict[str, dict[str, float | None]]
    confusion_matrix: dict[str, dict[str, int]]
    dangerous_errors: dict[str, object]
    binary_safety: dict[str, object]
    parse_failure_count: int
    latency_ms: dict[str, float]
    ollama_timing: dict[str, float]
    cases: list[dict[str, object]] = field(default_factory=list)

    def to_dict(self) -> dict[str, object]:
        return {
            "config": {
                "label": self.config.label,
                "prompt_variant": self.config.prompt_variant,
                "schema_variant": self.config.schema_variant,
                "thinking": self.config.thinking,
                "num_predict": self.config.num_predict,
                "evidence_top_n": self.config.evidence_top_n,
                "model": self.config.model,
            },
            "split_used": self.split_used,
            "case_count": self.case_count,
            "accuracy": self.accuracy,
            "macro_f1": self.macro_f1,
            "per_class": self.per_class,
            "confusion_matrix": self.confusion_matrix,
            "dangerous_errors": self.dangerous_errors,
            "binary_safety": self.binary_safety,
            "parse_failure_count": self.parse_failure_count,
            "latency_ms": self.latency_ms,
            "ollama_timing": self.ollama_timing,
            "cases": self.cases,
        }


def build_variant_report(
    config: VerifierConfig, split_used: str, outcomes: list[CaseOutcome]
) -> VariantReport:
    scored = [o for o in outcomes if o.predicted is not None]
    correct = sum(1 for o in scored if o.predicted == o.gold)
    accuracy = correct / len(scored) if scored else None
    per_class = _per_class_prf(outcomes)
    f1s = [v["f1"] for v in per_class.values() if v["f1"] is not None]
    macro_f1 = sum(f1s) / len(f1s) if f1s else None

    latencies = [o.stats.latency_ms for o in outcomes]
    latency_stats = {
        "mean_ms": sum(latencies) / len(latencies) if latencies else 0.0,
        "p50_ms": _percentile(latencies, 0.50),
        "p95_ms": _percentile(latencies, 0.95),
        "min_ms": min(latencies) if latencies else 0.0,
        "max_ms": max(latencies) if latencies else 0.0,
        "cold_first_call_ms": latencies[0] if latencies else 0.0,
        "warm_mean_ms": sum(latencies[1:]) / len(latencies[1:]) if len(latencies) > 1 else 0.0,
        "warm_p50_ms": _percentile(latencies[1:], 0.50) if len(latencies) > 1 else 0.0,
    }
    loads = [o.stats.load_duration_ms for o in outcomes]
    prompt_evals = [o.stats.prompt_eval_duration_ms for o in outcomes]
    prompt_counts = [o.stats.prompt_eval_count for o in outcomes]
    eval_durations = [o.stats.eval_duration_ms for o in outcomes]
    eval_counts = [o.stats.eval_count for o in outcomes]
    total_prompt_tokens = sum(prompt_counts)
    total_prompt_ms = sum(prompt_evals)
    total_eval_tokens = sum(eval_counts)
    total_eval_ms = sum(eval_durations)
    ollama_timing = {
        "mean_load_duration_ms": sum(loads) / len(loads) if loads else 0.0,
        "mean_prompt_eval_count": sum(prompt_counts) / len(prompt_counts) if prompt_counts else 0.0,
        "mean_prompt_eval_duration_ms": sum(prompt_evals) / len(prompt_evals)
        if prompt_evals
        else 0.0,
        "mean_eval_count": sum(eval_counts) / len(eval_counts) if eval_counts else 0.0,
        "mean_eval_duration_ms": sum(eval_durations) / len(eval_durations)
        if eval_durations
        else 0.0,
        "prompt_tokens_per_sec": total_prompt_tokens / (total_prompt_ms / 1000)
        if total_prompt_ms > 0
        else 0.0,
        "output_tokens_per_sec": total_eval_tokens / (total_eval_ms / 1000)
        if total_eval_ms > 0
        else 0.0,
        "mean_thinking_char_count": sum(o.stats.thinking_char_count for o in outcomes)
        / len(outcomes)
        if outcomes
        else 0.0,
    }

    return VariantReport(
        config=config,
        split_used=split_used,
        case_count=len(outcomes),
        accuracy=accuracy,
        macro_f1=macro_f1,
        per_class=per_class,
        confusion_matrix=_confusion_matrix(outcomes),
        dangerous_errors=_dangerous_errors(outcomes),
        binary_safety=_binary_safety(outcomes),
        parse_failure_count=sum(1 for o in outcomes if o.predicted is None),
        latency_ms=latency_stats,
        ollama_timing=ollama_timing,
        cases=[
            {
                "case_id": o.case_id,
                "gold": o.gold,
                "predicted": o.predicted,
                "latency_ms": round(o.stats.latency_ms, 1),
                "eval_count": o.stats.eval_count,
                "prompt_eval_count": o.stats.prompt_eval_count,
                "thinking_char_count": o.stats.thinking_char_count,
            }
            for o in outcomes
        ],
    )


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------


def run_variant(
    config: VerifierConfig,
    case_ids: list[str],
    *,
    vector_store: QdrantVectorStore,
    embedding_provider,
    client: ollama.Client,
    settings,
) -> list[CaseOutcome]:
    all_cases = {c.case_id: (c, label) for c, label in reviewed_eval_cases()}
    outcomes: list[CaseOutcome] = []
    for case_id in case_ids:
        case, gold = all_cases[case_id]
        sources = retrieve_evidence(
            case,
            vector_store=vector_store,
            embedding_provider=embedding_provider,
            settings=settings,
        )
        citations = build_citations(sources)
        stats = call_verifier(
            client, config=config, query=case.query, sources=sources, citations=citations
        )
        outcomes.append(
            CaseOutcome(case_id=case_id, gold=gold, predicted=stats.verdict, stats=stats)
        )
    return outcomes


def build_corpus_and_client(settings) -> tuple[QdrantVectorStore, object, str, ollama.Client]:
    embedding_provider, embedding_mode, mode = select_embedding_provider(
        force_synthetic=False, settings=settings
    )
    if mode == "synthetic":
        raise RuntimeError(
            "Real mxbai-embed-large embeddings are required (Milestone 7 inherits Milestone 6 "
            "§12). BLOCKED."
        )
    vector_store = QdrantVectorStore(
        collection_name="m7-verifier-optimize",
        vector_size=embedding_provider.dimensions,
        mode="memory",
    )
    vector_store.ensure_collection()
    ingest_controlled_corpus(
        vector_store, embedding_provider, user_id=EVAL_USER_ID, documents=REALISTIC_DOCUMENTS
    )
    client = ollama.Client(host=settings.ollama_base_url)
    return vector_store, embedding_provider, embedding_mode, client


def write_report(report: VariantReport, reports_dir: Path, tag: str) -> Path:
    reports_dir.mkdir(parents=True, exist_ok=True)
    timestamp = utcnow().strftime("%Y%m%dT%H%M%SZ")
    path = reports_dir / f"evidence-verifier-optimize-{tag}-{timestamp}.json"
    path.write_text(json.dumps(report.to_dict(), indent=2), encoding="utf-8")
    return path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--tag", required=True, help="Short label for this run, used in the output filename"
    )
    parser.add_argument("--prompt-variant", default="v1", choices=list(PROMPT_VARIANTS))
    parser.add_argument("--schema-variant", default="A_minimal", choices=list(SCHEMAS))
    parser.add_argument("--thinking", action="store_true")
    parser.add_argument("--num-predict", type=int, default=64)
    parser.add_argument("--evidence-top-n", type=int, default=None)
    parser.add_argument("--model", default="qwen3:4b")
    parser.add_argument(
        "--case-ids",
        type=str,
        default=None,
        help="Comma-separated case_id subset; default = dev split",
    )
    parser.add_argument("--split", choices=["dev", "holdout", "all"], default="dev")
    parser.add_argument("--reports-dir", type=Path, default=Path("evaluation/reports"))
    args = parser.parse_args()

    settings = get_settings()
    vector_store, embedding_provider, embedding_mode, client = build_corpus_and_client(settings)

    split = split_dev_holdout(reviewed_eval_cases())
    print(f"split: {split.reason}")
    if args.case_ids:
        case_ids = args.case_ids.split(",")
    elif args.split == "dev":
        case_ids = split.dev_case_ids
    elif args.split == "holdout":
        case_ids = split.holdout_case_ids
    else:
        case_ids = split.dev_case_ids + split.holdout_case_ids

    config = VerifierConfig(
        label=args.tag,
        prompt_variant=args.prompt_variant,
        schema_variant=args.schema_variant,
        thinking=args.thinking,
        num_predict=args.num_predict,
        evidence_top_n=args.evidence_top_n,
        model=args.model,
    )
    t0 = time.time()
    outcomes = run_variant(
        config,
        case_ids,
        vector_store=vector_store,
        embedding_provider=embedding_provider,
        client=client,
        settings=settings,
    )
    vector_store.close()
    report = build_variant_report(config, args.split, outcomes)
    path = write_report(report, args.reports_dir, args.tag)
    print(f"embedding_mode={embedding_mode}")
    print(f"elapsed={time.time() - t0:.1f}s cases={len(outcomes)}")
    print(f"accuracy={report.accuracy} macro_f1={report.macro_f1}")
    print(f"contradictory_recall={report.dangerous_errors['contradictory_recall']}")
    print(f"dangerous_false_approval_rate={report.binary_safety['dangerous_false_approval_rate']}")
    print(f"sufficient_false_block_rate={report.binary_safety['sufficient_false_block_rate']}")
    print(
        f"warm_mean_ms={report.latency_ms['warm_mean_ms']:.0f} "
        f"warm_p50_ms={report.latency_ms['warm_p50_ms']:.0f}"
    )
    print(f"written: {path}")


if __name__ == "__main__":
    main()
