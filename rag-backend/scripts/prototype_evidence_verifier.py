#!/usr/bin/env python
"""Milestone 6 (Evidence Reasoning Architecture) — EVALUATION-ONLY
prototype of an Evidence Reasoner: given a query and the evidence a real
chat turn would actually receive (embed -> Qdrant search -> production
select_mmr() -> production prepare_context() -> production build_citations(),
all imported unmodified from app.core), asks a candidate Ollama model to
classify the evidence as SUFFICIENT / PARTIAL / INSUFFICIENT / CONTRADICTORY
and scores it against evaluation/verifier_eval_subset.py's hand-reviewed
labels.

THIS SCRIPT IS NEVER IMPORTED BY, OR WIRED INTO, ANY PRODUCTION REQUEST
PATH. It is invoked manually, exactly like scripts/eval_retrieval_controlled.py
and scripts/calibrate_evidence_sufficiency.py, and touches no production
Settings, no production prompt_builder.py, and no real chat route.

Reuses (does not reimplement) evaluation/realistic_corpus.py's corpus,
evaluation/verifier_eval_subset.py's reviewed labels, and
scripts/eval_retrieval_controlled.py's select_embedding_provider /
ingest_controlled_corpus / chunk_key — the same M5.7 real-embedding
methodology, never a second corpus or a fifth eval framework.

Usage:
    python scripts/prototype_evidence_verifier.py --model qwen3:4b
    python scripts/prototype_evidence_verifier.py --model qwen3:8b
    python scripts/prototype_evidence_verifier.py --model qwen3:4b --reports-dir evaluation/reports

Requires a reachable Ollama with both the configured embedding model and
the candidate verifier model already pulled — this script does NOT
download or silently substitute models (mirrors Milestone 5.5's rule);
it fails loudly (BLOCKED) if the real embedding path is unreachable,
exactly like calibrate_evidence_sufficiency.py.
"""

from __future__ import annotations

import argparse
import json
import re
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

import ollama

from app.config import get_settings
from app.core.citation import build_citations
from app.core.context_preparation import prepare_context
from app.core.mmr import select_mmr
from app.core.retrieval_schemas import RetrievedChunk
from app.core.retriever import Retriever
from app.vectorstore.qdrant_client import QdrantVectorStore
from cli.reporting import utcnow
from evaluation.controlled_corpus import EvalCase
from evaluation.realistic_corpus import DOCUMENTS_BY_ID, REALISTIC_DOCUMENTS
from evaluation.verifier_eval_subset import Sufficiency, reviewed_eval_cases
from scripts.eval_retrieval_controlled import (
    chunk_key,
    ingest_controlled_corpus,
    select_embedding_provider,
)

EVAL_USER_ID = "m6-verifier-eval-user"
VERDICTS: tuple[Sufficiency, ...] = ("SUFFICIENT", "PARTIAL", "INSUFFICIENT", "CONTRADICTORY")

# ---------------------------------------------------------------------------
# Retrieval: identical primitives to scripts/eval_retrieval_controlled.py's
# run_case(), just also keeping the final prepared RetrievedChunk/Citation
# objects (run_case() discards those after computing citation_count) — this
# script needs actual chunk *text* + S-ids to build the verifier prompt, not
# just recall metrics.
# ---------------------------------------------------------------------------


def _retrieve_general(
    case: EvalCase, *, vector_store: QdrantVectorStore, embedding_provider, settings
) -> list[RetrievedChunk]:
    query_vector = embedding_provider.embed_batch([case.query])[0]
    raw_results = vector_store.search(
        query_vector,
        limit=max(settings.retrieval_top_k, settings.retrieval_fetch_k),
        user_id=EVAL_USER_ID,
        with_vectors=True,
    )
    mmr_input = [
        (
            RetrievedChunk(
                score=r.score,
                text=r.payload.text,
                document_id=r.payload.document_id,
                chunk_id=chunk_key(r.payload.document_id, r.payload.chunk_index),
                document_type=r.payload.document_type,
                journal_quartile=r.payload.journal_quartile,
                title=r.payload.title,
                authors=r.payload.authors,
                publication_year=r.payload.publication_year,
                source_filename=r.payload.source_filename,
                chunk_index=r.payload.chunk_index,
                page_number=DOCUMENTS_BY_ID[r.payload.document_id].chunks[r.payload.chunk_index].page_number,
            ),
            r.vector,
            r.score,
        )
        for r in raw_results
        if r.vector is not None
    ]
    # select_mmr[T] returns list[T] (just the selected items, in its own
    # chosen order) — since T=RetrievedChunk here, mmr_topk already is the
    # final selected-chunk list, no further unpacking needed.
    mmr_topk = select_mmr(
        mmr_input, top_k=settings.retrieval_top_k, relevance_weight=settings.retrieval_mmr_relevance_weight
    )
    return prepare_context(
        mmr_topk,
        max_per_document=settings.context_max_chunks_per_document,
        max_total_chars=settings.context_max_total_chars,
        similarity_threshold=settings.context_dedup_similarity_threshold,
    )


def _retrieve_zoom_in(
    case: EvalCase, *, vector_store: QdrantVectorStore, embedding_provider, settings
) -> list[RetrievedChunk]:
    assert case.scope_document_ids is not None
    conversation_id = f"m6-verifier-zoomin-{uuid.uuid4()}"
    for document_id in case.scope_document_ids:
        vector_store.update_scope_associations(
            document_id, user_id=EVAL_USER_ID, conversation_ids=[conversation_id], project_ids=[]
        )
    retriever = Retriever(
        embedding_provider=embedding_provider,
        vector_store=vector_store,
        relevance_weight=settings.retrieval_mmr_relevance_weight,
        fetch_k=settings.retrieval_fetch_k,
    )
    retrieved = retriever.retrieve(
        case.query, user_id=EVAL_USER_ID, top_k=settings.retrieval_top_k, conversation_id=conversation_id
    )
    return prepare_context(
        retrieved,
        max_per_document=settings.context_max_chunks_per_document,
        max_total_chars=settings.context_max_total_chars,
        similarity_threshold=settings.context_dedup_similarity_threshold,
    )


def retrieve_evidence(
    case: EvalCase, *, vector_store: QdrantVectorStore, embedding_provider, settings
) -> list[RetrievedChunk]:
    if case.scope_document_ids is not None:
        return _retrieve_zoom_in(case, vector_store=vector_store, embedding_provider=embedding_provider, settings=settings)
    return _retrieve_general(case, vector_store=vector_store, embedding_provider=embedding_provider, settings=settings)


# ---------------------------------------------------------------------------
# The verifier prompt itself — EVALUATION-ONLY. Deliberately not added to
# app/core/prompt_builder.py (Milestone 6 §9: "Do not modify production
# prompt_builder.py"). Mirrors that module's existing [S1]/[S2] source-id
# convention and <source> tag wrapping (see prompt_builder._SYSTEM_PROMPT)
# so a future production integration would feel like a natural extension
# of it, not a foreign format — but this string itself never executes on
# a real user request.
# ---------------------------------------------------------------------------

_VERIFIER_SYSTEM_PROMPT = """You check whether numbered evidence sources are enough to answer a \
question. Judge ONLY from the evidence given below — never use outside knowledge.

Verdicts:
- SUFFICIENT: the evidence directly and completely answers the question.
- PARTIAL: the evidence answers only part of a multi-part question, comparison, or synthesis \
(e.g. one side of a comparison is present, the other is not).
- INSUFFICIENT: the evidence is on-topic but does not contain enough information to answer; \
nothing in it actively contradicts the question.
- CONTRADICTORY: the evidence contains an explicit statement that contradicts a factual premise \
or claim in the question."""

# Milestone 6 §10/§26/§27 finding: asking a qwen3 model for freeform JSON
# (even with an aggressive "output only JSON, no reasoning" instruction) does
# NOT reliably produce parseable output within any practical token budget —
# empirically measured at 0/51 (150 tokens) and 0/18 (500 tokens) parse
# success, the model instead reasons in plain text about the task AND about
# its own output formatting indefinitely (observed still unresolved at 900
# tokens/~130s on a trivial 2-source case). Ollama's grammar-constrained
# structured output (the `format` chat-API parameter, a JSON Schema) fixes
# this completely — decoding is constrained token-by-token to only ever
# produce schema-valid JSON, so the model cannot "wander" into prose at all.
# This is the load-bearing fix, not a prompt-wording tweak — see the
# Milestone 6 report §10/§17 for the measured before/after.
_VERIFIER_JSON_SCHEMA: dict[str, object] = {
    "type": "object",
    "properties": {
        "verdict": {
            "type": "string",
            "enum": ["SUFFICIENT", "PARTIAL", "INSUFFICIENT", "CONTRADICTORY"],
        },
        "supporting_source_ids": {"type": "array", "items": {"type": "string"}},
        "contradicting_source_ids": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["verdict", "supporting_source_ids", "contradicting_source_ids"],
}


def _build_verifier_user_prompt(query: str, sources: list[RetrievedChunk], citations) -> str:
    parts = [f"Question: {query}", "", "Evidence:"]
    for citation, chunk in zip(citations, sources, strict=True):
        parts.append(f'<source id="{citation.source_id}">{chunk.text}</source>')
    return "\n".join(parts)


# ---------------------------------------------------------------------------
# Model call + fail-closed parsing
# ---------------------------------------------------------------------------


@dataclass
class VerifierCallResult:
    verdict: str | None  # one of VERDICTS, or None on parse failure
    supporting_source_ids: list[str]
    contradicting_source_ids: list[str]
    raw_response: str
    latency_ms: float
    parse_ok: bool


_JSON_OBJECT_RE = re.compile(r"\{.*\}", re.DOTALL)


def _parse_verifier_output(raw: str) -> tuple[str | None, list[str], list[str]]:
    """Fail-closed: returns (None, [], []) on any parse problem rather than
    guessing — Milestone 6 §10/§11 explicitly forbid silently defaulting to
    SUFFICIENT, and returning None (not a guessed verdict) is how this
    script's own scoring keeps 'the model failed to produce valid output'
    visibly distinct from any real verdict, including INSUFFICIENT."""
    match = _JSON_OBJECT_RE.search(raw)
    if match is None:
        return None, [], []
    try:
        data = json.loads(match.group(0))
    except json.JSONDecodeError:
        return None, [], []
    verdict = data.get("verdict")
    if verdict not in VERDICTS:
        return None, [], []
    supporting = data.get("supporting_source_ids", [])
    contradicting = data.get("contradicting_source_ids", [])
    if not isinstance(supporting, list) or not all(isinstance(s, str) for s in supporting):
        supporting = []
    if not isinstance(contradicting, list) or not all(isinstance(s, str) for s in contradicting):
        contradicting = []
    return verdict, supporting, contradicting


def call_verifier(
    client: ollama.Client, *, model: str, query: str, sources: list[RetrievedChunk], citations,
    num_predict: int = 150,
) -> VerifierCallResult:
    user_prompt = _build_verifier_user_prompt(query, sources, citations)
    t0 = time.perf_counter()
    response = client.chat(
        model=model,
        messages=[
            {"role": "system", "content": _VERIFIER_SYSTEM_PROMPT},
            {"role": "user", "content": user_prompt},
        ],
        stream=False,
        think=False,
        format=_VERIFIER_JSON_SCHEMA,
        options={"temperature": 0, "num_predict": num_predict, "seed": 42},
    )
    latency_ms = (time.perf_counter() - t0) * 1000
    raw = response.message.content or ""
    verdict, supporting, contradicting = _parse_verifier_output(raw)
    return VerifierCallResult(
        verdict=verdict,
        supporting_source_ids=supporting,
        contradicting_source_ids=contradicting,
        raw_response=raw,
        latency_ms=latency_ms,
        parse_ok=verdict is not None,
    )


# ---------------------------------------------------------------------------
# Metrics
# ---------------------------------------------------------------------------


@dataclass
class CaseOutcome:
    case_id: str
    gold: str
    predicted: str | None
    latency_ms: float
    parse_ok: bool
    supporting_source_ids: list[str]
    contradicting_source_ids: list[str]
    raw_response: str = ""  # kept for debugging parse failures; truncated in the report


def _confusion_matrix(outcomes: list[CaseOutcome]) -> dict[str, dict[str, int]]:
    """Rows are gold labels, columns are predicted labels; an unparseable
    prediction is counted under a synthetic 'PARSE_FAILURE' column so it is
    never silently merged into any real verdict's count."""
    labels = (*VERDICTS, "PARSE_FAILURE")
    matrix = {gold: {pred: 0 for pred in labels} for gold in VERDICTS}
    for outcome in outcomes:
        predicted_label = outcome.predicted if outcome.predicted is not None else "PARSE_FAILURE"
        matrix[outcome.gold][predicted_label] += 1
    return matrix


def _per_class_prf(outcomes: list[CaseOutcome]) -> dict[str, dict[str, float]]:
    result: dict[str, dict[str, float]] = {}
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


def _dangerous_errors(outcomes: list[CaseOutcome]) -> dict[str, object]:
    """Milestone 6 §9/§23: false approvals — a bad verdict that would let
    generation proceed on evidence that should have blocked/qualified it.
    Reported as raw counts + the specific case ids, never buried inside an
    aggregate accuracy number."""

    def _cases(gold: str, predicted: str) -> list[str]:
        return [o.case_id for o in outcomes if o.gold == gold and o.predicted == predicted]

    contradictory_to_sufficient = _cases("CONTRADICTORY", "SUFFICIENT")
    insufficient_to_sufficient = _cases("INSUFFICIENT", "SUFFICIENT")
    partial_to_sufficient = _cases("PARTIAL", "SUFFICIENT")
    sufficient_to_insufficient = _cases("SUFFICIENT", "INSUFFICIENT")
    return {
        "contradictory_to_sufficient_count": len(contradictory_to_sufficient),
        "contradictory_to_sufficient_case_ids": contradictory_to_sufficient,
        "insufficient_to_sufficient_count": len(insufficient_to_sufficient),
        "insufficient_to_sufficient_case_ids": insufficient_to_sufficient,
        "partial_to_sufficient_count": len(partial_to_sufficient),
        "partial_to_sufficient_case_ids": partial_to_sufficient,
        "sufficient_to_insufficient_count": len(sufficient_to_insufficient),
        "sufficient_to_insufficient_case_ids": sufficient_to_insufficient,
    }


def _binary_safety_view(outcomes: list[CaseOutcome]) -> dict[str, object]:
    """Milestone 6 §24: collapse to SAFE_TO_GENERATE (SUFFICIENT) vs.
    NOT_FULLY_SUPPORTED (PARTIAL/INSUFFICIENT/CONTRADICTORY) and report the
    2x2 confusion separately — a false SAFE_TO_GENERATE prediction (gold
    NOT_FULLY_SUPPORTED, predicted SAFE_TO_GENERATE) is the single most
    dangerous error class this whole milestone is measuring for."""

    def _bucket(label: str | None) -> str:
        if label == "SUFFICIENT":
            return "SAFE_TO_GENERATE"
        if label in ("PARTIAL", "INSUFFICIENT", "CONTRADICTORY"):
            return "NOT_FULLY_SUPPORTED"
        return "PARSE_FAILURE"

    tp = fp = tn = fn = parse_failures = 0
    for o in outcomes:
        gold_bucket = _bucket(o.gold)
        pred_bucket = _bucket(o.predicted)
        if pred_bucket == "PARSE_FAILURE":
            parse_failures += 1
            continue
        if gold_bucket == "SAFE_TO_GENERATE" and pred_bucket == "SAFE_TO_GENERATE":
            tp += 1
        elif gold_bucket == "NOT_FULLY_SUPPORTED" and pred_bucket == "SAFE_TO_GENERATE":
            fp += 1  # dangerous: approved evidence that should not have been
        elif gold_bucket == "NOT_FULLY_SUPPORTED" and pred_bucket == "NOT_FULLY_SUPPORTED":
            tn += 1
        else:
            fn += 1  # over-cautious: blocked evidence that was actually fine
    total_scored = tp + fp + tn + fn
    return {
        "safe_to_generate_tp": tp,
        "dangerous_false_approval_fp": fp,
        "not_fully_supported_tn": tn,
        "over_cautious_false_block_fn": fn,
        "parse_failures_excluded": parse_failures,
        "dangerous_false_approval_rate": fp / (fp + tn) if (fp + tn) > 0 else None,
        "over_cautious_block_rate": fn / (fn + tp) if (fn + tp) > 0 else None,
        "binary_accuracy": (tp + tn) / total_scored if total_scored > 0 else None,
    }


@dataclass
class VerifierBenchmarkReport:
    generated_at: str
    model: str
    embedding_mode: str
    case_count: int
    label_counts: dict[str, int]
    parse_failure_count: int
    parse_failure_case_ids: list[str]
    accuracy: float | None
    macro_f1: float | None
    per_class: dict[str, dict[str, float]]
    confusion_matrix: dict[str, dict[str, int]]
    dangerous_errors: dict[str, object]
    binary_safety: dict[str, object]
    latency_ms: dict[str, float]
    cases: list[dict[str, object]] = field(default_factory=list)

    def to_dict(self) -> dict[str, object]:
        return {
            "generated_at": self.generated_at,
            "model": self.model,
            "embedding_mode": self.embedding_mode,
            "case_count": self.case_count,
            "label_counts": self.label_counts,
            "parse_failure_count": self.parse_failure_count,
            "parse_failure_case_ids": self.parse_failure_case_ids,
            "accuracy": self.accuracy,
            "macro_f1": self.macro_f1,
            "per_class": self.per_class,
            "confusion_matrix": self.confusion_matrix,
            "dangerous_errors": self.dangerous_errors,
            "binary_safety": self.binary_safety,
            "latency_ms": self.latency_ms,
            "cases": self.cases,
        }


def _percentile(values: list[float], pct: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, round(pct * (len(ordered) - 1))))
    return ordered[index]


def build_report(model: str, embedding_mode: str, outcomes: list[CaseOutcome]) -> VerifierBenchmarkReport:
    label_counts = {label: sum(1 for o in outcomes if o.gold == label) for label in VERDICTS}
    parse_failures = [o for o in outcomes if not o.parse_ok]
    scored = [o for o in outcomes if o.parse_ok]

    correct = sum(1 for o in scored if o.predicted == o.gold)
    accuracy = correct / len(scored) if scored else None

    per_class = _per_class_prf(outcomes)
    f1_values = [v["f1"] for v in per_class.values() if v["f1"] is not None]
    macro_f1 = sum(f1_values) / len(f1_values) if f1_values else None

    latencies = [o.latency_ms for o in outcomes]
    latency_stats = {
        "cold_first_call_ms": outcomes[0].latency_ms if outcomes else 0.0,
        "warm_mean_ms": sum(latencies[1:]) / len(latencies[1:]) if len(latencies) > 1 else 0.0,
        "warm_p50_ms": _percentile(latencies[1:], 0.50) if len(latencies) > 1 else 0.0,
        "warm_p95_ms": _percentile(latencies[1:], 0.95) if len(latencies) > 1 else 0.0,
        "warm_min_ms": min(latencies[1:]) if len(latencies) > 1 else 0.0,
        "warm_max_ms": max(latencies[1:]) if len(latencies) > 1 else 0.0,
    }

    return VerifierBenchmarkReport(
        generated_at=utcnow().isoformat(),
        model=model,
        embedding_mode=embedding_mode,
        case_count=len(outcomes),
        label_counts=label_counts,
        parse_failure_count=len(parse_failures),
        parse_failure_case_ids=[o.case_id for o in parse_failures],
        accuracy=accuracy,
        macro_f1=macro_f1,
        per_class=per_class,
        confusion_matrix=_confusion_matrix(outcomes),
        dangerous_errors=_dangerous_errors(outcomes),
        binary_safety=_binary_safety_view(outcomes),
        latency_ms=latency_stats,
        cases=[
            {
                "case_id": o.case_id,
                "gold": o.gold,
                "predicted": o.predicted,
                "latency_ms": round(o.latency_ms, 1),
                "parse_ok": o.parse_ok,
                "supporting_source_ids": o.supporting_source_ids,
                "contradicting_source_ids": o.contradicting_source_ids,
                "raw_response_preview": o.raw_response[:200],
            }
            for o in outcomes
        ],
    )


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------


def run(
    *, model: str, reports_dir: Path, force_synthetic: bool = False, num_predict: int = 150,
    case_ids: list[str] | None = None,
) -> VerifierBenchmarkReport:
    settings = get_settings()
    embedding_provider, embedding_mode, mode = select_embedding_provider(
        force_synthetic=force_synthetic, settings=settings
    )
    if mode == "synthetic":
        raise RuntimeError(
            "Real mxbai-embed-large embeddings are required for the evidence verifier "
            "benchmark (Milestone 6 §12) — got synthetic fallback. BLOCKED, not proceeding."
        )

    vector_store = QdrantVectorStore(
        collection_name="m6-verifier-eval", vector_size=embedding_provider.dimensions, mode="memory"
    )
    vector_store.ensure_collection()
    ingest_controlled_corpus(
        vector_store, embedding_provider, user_id=EVAL_USER_ID, documents=REALISTIC_DOCUMENTS
    )

    client = ollama.Client(host=settings.ollama_base_url)

    outcomes: list[CaseOutcome] = []
    all_reviewed = reviewed_eval_cases()
    selected = (
        [(c, label) for c, label in all_reviewed if c.case_id in case_ids]
        if case_ids is not None
        else all_reviewed
    )
    for case, gold_label in selected:
        sources = retrieve_evidence(
            case, vector_store=vector_store, embedding_provider=embedding_provider, settings=settings
        )
        citations = build_citations(sources)
        result = call_verifier(
            client, model=model, query=case.query, sources=sources, citations=citations,
            num_predict=num_predict,
        )
        outcomes.append(
            CaseOutcome(
                case_id=case.case_id,
                gold=gold_label,
                predicted=result.verdict,
                latency_ms=result.latency_ms,
                parse_ok=result.parse_ok,
                supporting_source_ids=result.supporting_source_ids,
                contradicting_source_ids=result.contradicting_source_ids,
                raw_response=result.raw_response,
            )
        )

    vector_store.close()
    return build_report(model, embedding_mode, outcomes)


def write_report(report: VerifierBenchmarkReport, reports_dir: Path) -> Path:
    reports_dir.mkdir(parents=True, exist_ok=True)
    timestamp = utcnow().strftime("%Y%m%dT%H%M%SZ")
    safe_model = report.model.replace(":", "-")
    json_path = reports_dir / f"evidence-verifier-prototype-{safe_model}-{timestamp}.json"
    json_path.write_text(json.dumps(report.to_dict(), indent=2), encoding="utf-8")
    return json_path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", required=True, help="Ollama model to use as the verifier")
    parser.add_argument("--reports-dir", type=Path, default=Path("evaluation/reports"))
    parser.add_argument("--force-synthetic-embeddings", action="store_true")
    parser.add_argument("--num-predict", type=int, default=150)
    parser.add_argument("--case-ids", type=str, default=None, help="Comma-separated case_id subset")
    args = parser.parse_args()

    case_ids = args.case_ids.split(",") if args.case_ids else None
    report = run(
        model=args.model, reports_dir=args.reports_dir, force_synthetic=args.force_synthetic_embeddings,
        num_predict=args.num_predict, case_ids=case_ids,
    )
    path = write_report(report, args.reports_dir)
    print(f"embedding_mode={report.embedding_mode}")
    print(f"model={report.model}")
    print(f"accuracy={report.accuracy} macro_f1={report.macro_f1}")
    print(f"written: {path}")


if __name__ == "__main__":
    main()
