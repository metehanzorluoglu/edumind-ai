#!/usr/bin/env python
"""Milestone 5.6 (evidence-sufficiency calibration): determines whether a
production-safe evidence-sufficiency signal (a raw-score threshold, a
simple deterministic multi-signal combination, or neither) is statistically
and operationally defensible — using REAL mxbai-embed-large scores (see
scripts/eval_retrieval_controlled.py's `select_embedding_provider`) against
evaluation/controlled_corpus.py's expanded case set.

Extends, not duplicates, the Milestone 5/5.5 harness: reuses
ingest_controlled_corpus/select_embedding_provider/CONTROLLED_CASES/
RawCandidate/chunk_key from scripts/eval_retrieval_controlled.py, and
mirrors scripts/calibrate_threshold.py's TP/FP/TN/FN/precision/recall/F1
methodology (already established in this repo for exactly this kind of
calibration) rather than inventing a new one — same "scripts importing
scripts" pattern calibrate_threshold.py already uses for eval_retrieval.py.

General ("Prioritize"/unscoped) and Zoom-In calibration are computed
SEPARATELY and never pooled (Milestone 5.6 §10): a Zoom-In case's ground
truth is `scope_contains_answer` (is the answer inside THIS case's
simulated selected scope?), not `case.answerable` (does the answer exist
ANYWHERE in the corpus?) — pooling the two would conflate two different
questions.

Scores are captured BEFORE MMR (Milestone 5.6 §6) via a direct
`vector_store.search()` call per case (general: no conversation_id filter;
Zoom-In: tag case.scope_document_ids with a fresh conversation_id, filter
by it) — the same underlying QdrantVectorStore.search() production
Retriever.retrieve() calls internally, just captured directly rather than
via the full Retriever/MMR pipeline, since MMR's own first pick is always
the top raw-score candidate anyway (see app/core/mmr.py's select_mmr:
`if not selected: best = max(remaining, key=lambda c: c[2])`) — so
top_score is identical before/after MMR by construction; only the
lower-ranked signals (margin, mean-top-3) could differ, which is exactly
why they are captured pre-MMR here rather than reusing the post-MMR
Retriever output.

This module change NOTHING in production: no Settings default, no
Retriever/RagService/prompt_builder/Zoom-In code touched. Calibration only.

Usage:
    python scripts/calibrate_evidence_sufficiency.py
    # mechanics only — never a valid basis for a production recommendation:
    python scripts/calibrate_evidence_sufficiency.py --force-synthetic-embeddings
"""

from __future__ import annotations

import argparse
import json
import random
import statistics
import sys
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from app.config import Settings, get_settings
from app.core.embedding_provider import EmbeddingProvider
from app.vectorstore.qdrant_client import QdrantVectorStore
from cli.reporting import utcnow
from evaluation.controlled_corpus import (
    CONTROLLED_CASES,
    CONTROLLED_DOCUMENTS,
    ControlledDocument,
    EvalCase,
)
from scripts.eval_retrieval_controlled import (
    EVAL_USER_ID,
    RawCandidate,
    chunk_key,
    ingest_controlled_corpus,
    select_embedding_provider,
)

# Deterministic calibration/holdout split (Milestone 5.6 §15) — fixed,
# documented seed so the split is exactly reproducible across runs, never
# silently different from one invocation to the next.
CALIBRATION_SPLIT_SEED = 56
CALIBRATION_FRACTION = 0.7
# mxbai-embed-large's observed cosine-similarity range on this corpus
# (Milestone 5.5: relevant top results ~0.66-0.86, non-relevant ~0.50-0.72)
# — swept finer than scripts/calibrate_threshold.py's generic 0.05-step
# sweep (built for a since-different, wider-range corpus) to actually
# resolve the operating region that matters here.
THRESHOLD_SWEEP = [round(0.50 + 0.01 * i, 2) for i in range(41)]  # 0.50 .. 0.90
MIN_HOLDOUT_CLASS_SIZE = 8  # below this, a holdout split is not meaningful


@dataclass(frozen=True)
class ScoredCase:
    case_id: str
    category: str
    mode: str  # "general" | "zoom_in"
    is_positive: bool  # ground truth: should the system answer (not abstain)?
    candidates: list[RawCandidate]  # pre-MMR, sorted by score descending
    # Milestone 5.7 §17: document/topic-group key for group-level (not
    # row-level) calibration/holdout splitting — None for every Milestone
    # 5/5.6 case (falls back to deterministic_split's row-level behavior).
    topic: str | None = None

    @property
    def top_score(self) -> float | None:
        return self.candidates[0].score if self.candidates else None

    @property
    def second_score(self) -> float | None:
        return self.candidates[1].score if len(self.candidates) > 1 else None

    @property
    def margin(self) -> float | None:
        if self.top_score is None or self.second_score is None:
            return None
        return self.top_score - self.second_score

    @property
    def mean_top3(self) -> float | None:
        top3 = self.candidates[:3]
        return statistics.mean(c.score for c in top3) if top3 else None

    @property
    def doc_diversity_top3(self) -> int | None:
        top3 = self.candidates[:3]
        return len({c.document_id for c in top3}) if top3 else None

    @property
    def same_doc_multi_chunk_top3(self) -> bool:
        top3 = self.candidates[:3]
        diversity = self.doc_diversity_top3
        return len(top3) >= 2 and diversity is not None and diversity < len(top3)

    def count_above(self, threshold: float) -> int:
        return sum(1 for c in self.candidates if c.score >= threshold)


def _raw_candidates(
    vector_store: QdrantVectorStore,
    embedding_provider: EmbeddingProvider,
    query: str,
    *,
    user_id: str,
    fetch_k: int,
    conversation_id: str | None,
) -> list[RawCandidate]:
    """Direct pre-MMR candidate capture — the same vector_store.search()
    call app/core/retriever.py's Retriever.retrieve() makes internally,
    exposed here without going through MMR selection at all (see module
    docstring for why top_score is unaffected either way, and why the
    lower-ranked signals below are captured pre-MMR on purpose)."""
    query_vector = embedding_provider.embed_batch([query])[0]
    results = vector_store.search(
        query_vector,
        limit=fetch_k,
        user_id=user_id,
        with_vectors=False,
        conversation_id=conversation_id,
    )
    candidates = [
        RawCandidate(
            document_id=r.payload.document_id,
            chunk_index=r.payload.chunk_index,
            key=chunk_key(r.payload.document_id, r.payload.chunk_index),
            score=r.score,
            text=r.payload.text,
        )
        for r in results
    ]
    return sorted(candidates, key=lambda c: c.score, reverse=True)


def score_all_cases(
    cases: list[EvalCase],
    *,
    vector_store: QdrantVectorStore,
    embedding_provider: EmbeddingProvider,
    fetch_k: int,
    user_id: str = EVAL_USER_ID,
) -> list[ScoredCase]:
    scored: list[ScoredCase] = []
    for case in cases:
        if case.scope_document_ids is None:
            candidates = _raw_candidates(
                vector_store, embedding_provider, case.query,
                user_id=user_id, fetch_k=fetch_k, conversation_id=None,
            )
            scored.append(
                ScoredCase(
                    case_id=case.case_id, category=case.category, mode="general",
                    is_positive=case.should_answer, candidates=candidates, topic=case.topic,
                )
            )
        else:
            conversation_id = f"m56-calib-{case.case_id}"
            for document_id in case.scope_document_ids:
                vector_store.update_scope_associations(
                    document_id, user_id=user_id, conversation_ids=[conversation_id], project_ids=[]
                )
            candidates = _raw_candidates(
                vector_store, embedding_provider, case.query,
                user_id=user_id, fetch_k=fetch_k, conversation_id=conversation_id,
            )
            for document_id in case.scope_document_ids:
                vector_store.update_scope_associations(
                    document_id, user_id=user_id, conversation_ids=[], project_ids=[]
                )
            assert case.scope_contains_answer is not None  # enforced by EvalCase.__post_init__
            scored.append(
                ScoredCase(
                    case_id=case.case_id, category=case.category, mode="zoom_in",
                    is_positive=case.scope_contains_answer, candidates=candidates, topic=case.topic,
                )
            )
    return scored


# ---------------------------------------------------------------------------
# Threshold sweep (confusion matrix at each candidate threshold)
# ---------------------------------------------------------------------------


@dataclass
class ThresholdResult:
    threshold: float
    tp: int
    fp: int
    tn: int
    fn: int
    precision: float | None
    recall: float | None
    specificity: float | None
    f1: float | None
    false_abstention_rate: float | None  # FN / (TP+FN) — valid evidence wrongly rejected
    false_answer_rate: float | None  # FP / (FP+TN) — insufficient evidence wrongly accepted

    def to_dict(self) -> dict[str, object]:
        return {
            "threshold": self.threshold,
            "tp": self.tp, "fp": self.fp, "tn": self.tn, "fn": self.fn,
            "precision": self.precision, "recall": self.recall,
            "specificity": self.specificity, "f1": self.f1,
            "false_abstention_rate": self.false_abstention_rate,
            "false_answer_rate": self.false_answer_rate,
        }


def sweep_thresholds(
    scored_cases: list[ScoredCase], thresholds: list[float]
) -> list[ThresholdResult]:
    """"Positive" = ground truth says the system SHOULD answer (valid
    evidence exists in the evaluated scope). At each threshold, a case is
    PREDICTED positive (system would answer) iff its top_score >= threshold
    — i.e. this evaluates top_score alone as the candidate signal (see
    evaluate_alternative_signals for margin/mean-top-3/etc.). Cases with no
    candidates at all (top_score is None) are excluded — never occurs in
    this corpus (every query returns something), but excluded rather than
    silently miscounted if it ever did."""
    results = []
    scoreable = [c for c in scored_cases if c.top_score is not None]
    for threshold in thresholds:
        tp = fp = tn = fn = 0
        for case in scoreable:
            predicted_sufficient = case.top_score is not None and case.top_score >= threshold
            if case.is_positive and predicted_sufficient:
                tp += 1
            elif case.is_positive and not predicted_sufficient:
                fn += 1
            elif not case.is_positive and predicted_sufficient:
                fp += 1
            else:
                tn += 1
        precision = tp / (tp + fp) if (tp + fp) else None
        recall = tp / (tp + fn) if (tp + fn) else None
        specificity = tn / (tn + fp) if (tn + fp) else None
        f1 = (
            2 * precision * recall / (precision + recall)
            if precision is not None and recall is not None and (precision + recall) > 0
            else None
        )
        false_abstention_rate = fn / (tp + fn) if (tp + fn) else None
        false_answer_rate = fp / (fp + tn) if (fp + tn) else None
        results.append(
            ThresholdResult(
                threshold=threshold, tp=tp, fp=fp, tn=tn, fn=fn,
                precision=precision, recall=recall, specificity=specificity, f1=f1,
                false_abstention_rate=false_abstention_rate, false_answer_rate=false_answer_rate,
            )
        )
    return results


def best_by_f1(results: list[ThresholdResult]) -> ThresholdResult | None:
    scored = [r for r in results if r.f1 is not None]
    return max(scored, key=lambda r: r.f1) if scored else None  # type: ignore[arg-type,return-value]


# ---------------------------------------------------------------------------
# Deterministic calibration/holdout split
# ---------------------------------------------------------------------------


@dataclass
class SplitResult:
    calibration: list[ScoredCase]
    holdout: list[ScoredCase]
    meaningful: bool
    reason: str


def deterministic_split(
    scored_cases: list[ScoredCase], *, seed: int = CALIBRATION_SPLIT_SEED
) -> SplitResult:
    """Stratified by is_positive so both splits keep both classes
    represented. Refuses (meaningful=False) rather than silently reporting
    an unreliable holdout when either class is too small — see module
    docstring / Milestone 5.6 §15."""
    positives = [c for c in scored_cases if c.is_positive]
    negatives = [c for c in scored_cases if not c.is_positive]
    if len(positives) < MIN_HOLDOUT_CLASS_SIZE or len(negatives) < MIN_HOLDOUT_CLASS_SIZE:
        return SplitResult(
            calibration=scored_cases, holdout=[], meaningful=False,
            reason=(
                f"too few cases per class for a meaningful holdout "
                f"(positives={len(positives)}, negatives={len(negatives)}, "
                f"minimum={MIN_HOLDOUT_CLASS_SIZE} each) — calibrating on the full sample only"
            ),
        )

    rng = random.Random(seed)
    pos_ids = sorted(c.case_id for c in positives)
    neg_ids = sorted(c.case_id for c in negatives)
    rng.shuffle(pos_ids)
    rng.shuffle(neg_ids)
    pos_cal_count = round(len(pos_ids) * CALIBRATION_FRACTION)
    neg_cal_count = round(len(neg_ids) * CALIBRATION_FRACTION)
    calibration_ids = set(pos_ids[:pos_cal_count]) | set(neg_ids[:neg_cal_count])

    calibration = [c for c in scored_cases if c.case_id in calibration_ids]
    holdout = [c for c in scored_cases if c.case_id not in calibration_ids]
    fraction_label = f"{CALIBRATION_FRACTION:.0%}/{1 - CALIBRATION_FRACTION:.0%}"
    return SplitResult(
        calibration=calibration, holdout=holdout, meaningful=True,
        reason=f"deterministic row-level {fraction_label} stratified split, seed={seed}",
    )


def deterministic_group_split(
    scored_cases: list[ScoredCase], *, seed: int = CALIBRATION_SPLIT_SEED
) -> SplitResult:
    """Milestone 5.7 §17: splits by DOCUMENT/TOPIC GROUP (every case
    sharing a `topic` lands in the same half), never by individual case
    row — row-level splitting (deterministic_split above, still used for
    Milestone 5/5.6's own corpus, which predates topic tagging) risks a
    near-duplicate/related query about the same underlying document
    leaking structural information from calibration into holdout. Cases
    with no `topic` (None) are treated as their own singleton group (their
    case_id), so a caller that mixes topic-less and topic-tagged cases
    still gets a safe, defined split rather than a crash.

    Groups are assigned to calibration/holdout as whole units — shuffled
    deterministically, then greedily accumulated until the target
    calibration fraction of the TOTAL CASE COUNT is reached — which
    guarantees zero topic overlap between the two halves. Class balance
    (both positive and negative cases present in both halves) is checked
    afterward and reported, not force-guaranteed, since enforcing both
    "never split a topic" and "perfectly stratify" simultaneously can be
    infeasible on a small number of topic groups."""
    if not scored_cases:
        return SplitResult(calibration=[], holdout=[], meaningful=False, reason="no cases given")

    groups: dict[str, list[ScoredCase]] = {}
    for case in scored_cases:
        key = case.topic if case.topic is not None else f"__case__{case.case_id}"
        groups.setdefault(key, []).append(case)

    positives = [c for c in scored_cases if c.is_positive]
    negatives = [c for c in scored_cases if not c.is_positive]
    if len(positives) < MIN_HOLDOUT_CLASS_SIZE or len(negatives) < MIN_HOLDOUT_CLASS_SIZE:
        return SplitResult(
            calibration=scored_cases, holdout=[], meaningful=False,
            reason=(
                f"too few cases per class for a meaningful holdout "
                f"(positives={len(positives)}, negatives={len(negatives)}, "
                f"minimum={MIN_HOLDOUT_CLASS_SIZE} each) — calibrating on the full sample only"
            ),
        )
    if len(groups) < 4:
        return SplitResult(
            calibration=scored_cases, holdout=[], meaningful=False,
            reason=(
                f"only {len(groups)} document/topic group(s) — too few to split by group "
                "without a group dominating one half entirely"
            ),
        )

    rng = random.Random(seed)
    group_keys = sorted(groups)
    rng.shuffle(group_keys)
    total = len(scored_cases)
    target_calibration_count = round(total * CALIBRATION_FRACTION)

    calibration_keys: set[str] = set()
    running_count = 0
    for key in group_keys:
        if running_count >= target_calibration_count and len(calibration_keys) > 0:
            break
        calibration_keys.add(key)
        running_count += len(groups[key])

    calibration = [c for key in calibration_keys for c in groups[key]]
    holdout = [c for key in group_keys if key not in calibration_keys for c in groups[key]]

    calibration_ids_set = {c.case_id for c in calibration}
    holdout_ids_set = {c.case_id for c in holdout}
    assert calibration_ids_set.isdisjoint(holdout_ids_set), "group split must never overlap"

    both_classes_present = (
        any(c.is_positive for c in calibration) and any(not c.is_positive for c in calibration)
        and any(c.is_positive for c in holdout) and any(not c.is_positive for c in holdout)
    )
    fraction_label = f"{CALIBRATION_FRACTION:.0%}/{1 - CALIBRATION_FRACTION:.0%}"
    return SplitResult(
        calibration=calibration, holdout=holdout,
        meaningful=both_classes_present,
        reason=(
            f"deterministic GROUP-level {fraction_label} split by topic/document group, "
            f"seed={seed}, {len(calibration_keys)}/{len(group_keys)} groups in calibration"
            + ("" if both_classes_present else " — REFUSED: one half is missing a class entirely")
        ),
    )
    fraction_label = f"{CALIBRATION_FRACTION:.0%}/{1 - CALIBRATION_FRACTION:.0%}"
    return SplitResult(
        calibration=calibration, holdout=holdout, meaningful=True,
        reason=f"deterministic {fraction_label} stratified split, seed={seed}",
    )


# ---------------------------------------------------------------------------
# Alternative signals (§7) — descriptive comparison only, no second sweep
# per signal (interpretable-signals-first, no ML classifier).
# ---------------------------------------------------------------------------


def summarize_signal(
    scored_cases: list[ScoredCase], accessor: Callable[[ScoredCase], float | int | None]
) -> dict[str, object]:
    positive_values: list[float] = [
        float(v) for c in scored_cases if c.is_positive and (v := accessor(c)) is not None
    ]
    negative_values: list[float] = [
        float(v) for c in scored_cases if not c.is_positive and (v := accessor(c)) is not None
    ]
    return {
        "positive_mean": statistics.mean(positive_values) if positive_values else None,
        "positive_median": statistics.median(positive_values) if positive_values else None,
        "negative_mean": statistics.mean(negative_values) if negative_values else None,
        "negative_median": statistics.median(negative_values) if negative_values else None,
        "gap_of_means": (
            statistics.mean(positive_values) - statistics.mean(negative_values)
            if positive_values and negative_values
            else None
        ),
    }


def evaluate_alternative_signals(scored_cases: list[ScoredCase]) -> dict[str, object]:
    return {
        "top_score": summarize_signal(scored_cases, lambda c: c.top_score),
        "margin_top1_top2": summarize_signal(scored_cases, lambda c: c.margin),
        "mean_top3": summarize_signal(scored_cases, lambda c: c.mean_top3),
        "doc_diversity_top3": summarize_signal(scored_cases, lambda c: c.doc_diversity_top3),
    }


# ---------------------------------------------------------------------------
# Report assembly
# ---------------------------------------------------------------------------


def score_distribution_dict(values: list[float]) -> dict[str, object]:
    if not values:
        return {"count": 0, "min": None, "max": None, "mean": None, "median": None}
    return {
        "count": len(values), "min": min(values), "max": max(values),
        "mean": statistics.mean(values), "median": statistics.median(values),
    }


def build_report(
    *,
    embedding_mode: str,
    settings: Settings,
    general_scored: list[ScoredCase],
    zoom_in_scored: list[ScoredCase],
    general_split: SplitResult,
    zoom_in_split: SplitResult | None = None,
    dataset_version: str = "controlled-corpus-v2-m5.6",
    total_case_count: int | None = None,
) -> dict[str, object]:
    general_sweep = sweep_thresholds(general_split.calibration, THRESHOLD_SWEEP)
    general_holdout_sweep = (
        sweep_thresholds(general_split.holdout, THRESHOLD_SWEEP) if general_split.holdout else []
    )
    if zoom_in_split is not None and zoom_in_split.meaningful:
        zoom_in_calibration_cases = zoom_in_split.calibration
        zoom_in_holdout_sweep = sweep_thresholds(zoom_in_split.holdout, THRESHOLD_SWEEP)
    else:
        zoom_in_calibration_cases = zoom_in_scored  # too small to split — calibrate on all of it
        zoom_in_holdout_sweep = []
    zoom_in_sweep = sweep_thresholds(zoom_in_calibration_cases, THRESHOLD_SWEEP)

    general_best = best_by_f1(general_sweep)
    zoom_in_best = best_by_f1(zoom_in_sweep)

    return {
        "generated_at": utcnow().isoformat(),
        "dataset_version": dataset_version,
        "embedding_mode": embedding_mode,
        "frozen_production_config": {
            "generation_model": settings.ollama_llm_model,
            "embedding_model_configured": settings.ollama_embed_model,
            "top_k": settings.retrieval_top_k,
            "fetch_k": settings.retrieval_fetch_k,
            "mmr_relevance_weight": settings.retrieval_mmr_relevance_weight,
            "retrieval_min_score_unchanged": settings.retrieval_min_score,
        },
        "dataset": {
            "total_cases": (
                total_case_count if total_case_count is not None else len(CONTROLLED_CASES)
            ),
            "general_positive": sum(1 for c in general_scored if c.is_positive),
            "general_negative": sum(1 for c in general_scored if not c.is_positive),
            "zoom_in_positive": sum(1 for c in zoom_in_scored if c.is_positive),
            "zoom_in_negative": sum(1 for c in zoom_in_scored if not c.is_positive),
        },
        "score_distributions": {
            "general_positive_top_score": _top_scores_dict(general_scored, positive=True),
            "general_negative_top_score": _top_scores_dict(general_scored, positive=False),
            "zoom_in_positive_top_score": _top_scores_dict(zoom_in_scored, positive=True),
            "zoom_in_negative_top_score": _top_scores_dict(zoom_in_scored, positive=False),
        },
        "general_calibration": {
            "split_meaningful": general_split.meaningful,
            "split_reason": general_split.reason,
            "calibration_case_count": len(general_split.calibration),
            "holdout_case_count": len(general_split.holdout),
            "threshold_sweep": [r.to_dict() for r in general_sweep],
            "best_by_f1": general_best.to_dict() if general_best else None,
            "holdout_sweep": [r.to_dict() for r in general_holdout_sweep],
        },
        "zoom_in_calibration": {
            "split_meaningful": zoom_in_split.meaningful if zoom_in_split is not None else False,
            "split_reason": (
                zoom_in_split.reason
                if zoom_in_split is not None
                else f"only {len(zoom_in_scored)} Zoom-In cases total — no holdout attempted"
            ),
            "calibration_case_count": len(zoom_in_calibration_cases),
            "holdout_case_count": len(zoom_in_split.holdout) if zoom_in_split is not None else 0,
            "threshold_sweep": [r.to_dict() for r in zoom_in_sweep],
            "best_by_f1": zoom_in_best.to_dict() if zoom_in_best else None,
            "holdout_sweep": [r.to_dict() for r in zoom_in_holdout_sweep],
        },
        "alternative_signals": {
            "general": evaluate_alternative_signals(general_split.calibration),
            "zoom_in": evaluate_alternative_signals(zoom_in_calibration_cases),
        },
        "category_breakdown": {
            "general_negative_by_category": _category_score_breakdown(
                general_scored, positive=False
            ),
            "general_positive_by_category": _category_score_breakdown(
                general_scored, positive=True
            ),
        },
    }


def _top_scores_dict(scored_cases: list[ScoredCase], *, positive: bool) -> dict[str, object]:
    scores = [
        c.top_score for c in scored_cases if c.is_positive == positive and c.top_score is not None
    ]
    return score_distribution_dict(scores)


def _category_score_breakdown(
    scored_cases: list[ScoredCase], *, positive: bool
) -> dict[str, object]:
    by_category: dict[str, list[float]] = {}
    for case in scored_cases:
        if case.is_positive != positive or case.top_score is None:
            continue
        by_category.setdefault(case.category, []).append(case.top_score)
    return {
        category: score_distribution_dict(scores)
        for category, scores in sorted(by_category.items())
    }


def write_report(report: dict[str, object], reports_dir: Path) -> Path:
    reports_dir.mkdir(parents=True, exist_ok=True)
    timestamp = utcnow().strftime("%Y%m%dT%H%M%SZ")
    json_path = reports_dir / f"evidence-sufficiency-calibration-{timestamp}.json"
    json_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    return json_path


def run(
    *,
    force_synthetic: bool,
    reports_dir: Path,
    documents: list[ControlledDocument] | None = None,
    cases: list[EvalCase] | None = None,
    collection_name: str = "m56-calibration",
    dataset_version: str = "controlled-corpus-v2-m5.6",
    use_group_split: bool = False,
) -> dict[str, object]:
    """`documents`/`cases` default to the Milestone 5/5.6 controlled
    corpus — pass evaluation.realistic_corpus.REALISTIC_DOCUMENTS/
    ALL_REALISTIC_CASES (Milestone 5.7) to calibrate against that corpus
    instead. `use_group_split=True` uses deterministic_group_split
    (splits by EvalCase.topic, never by row — see Milestone 5.7 §17) in
    place of Milestone 5.6's row-level deterministic_split; pass True only
    when every case actually carries a `topic` (the realistic corpus
    does; the Milestone 5/5.6 corpus does not, so this stays False by
    default to preserve that corpus's exact prior calibration behavior)."""
    settings = get_settings()
    effective_documents = documents if documents is not None else CONTROLLED_DOCUMENTS
    effective_cases = cases if cases is not None else CONTROLLED_CASES
    embedding_provider, embedding_mode, _mode = select_embedding_provider(
        force_synthetic=force_synthetic, settings=settings
    )
    vector_store = QdrantVectorStore(
        collection_name=collection_name, vector_size=embedding_provider.dimensions, mode="memory"
    )
    vector_store.ensure_collection()
    ingest_controlled_corpus(
        vector_store, embedding_provider, user_id=EVAL_USER_ID, documents=effective_documents
    )

    general_cases = [c for c in effective_cases if c.scope_document_ids is None]
    zoom_in_cases = [c for c in effective_cases if c.scope_document_ids is not None]

    general_scored = score_all_cases(
        general_cases, vector_store=vector_store, embedding_provider=embedding_provider,
        fetch_k=settings.retrieval_fetch_k,
    )
    zoom_in_scored = score_all_cases(
        zoom_in_cases, vector_store=vector_store, embedding_provider=embedding_provider,
        fetch_k=settings.retrieval_fetch_k,
    )
    vector_store.close()

    split_fn = deterministic_group_split if use_group_split else deterministic_split
    general_split = split_fn(general_scored)
    zoom_in_split = split_fn(zoom_in_scored)

    return build_report(
        embedding_mode=embedding_mode, settings=settings,
        general_scored=general_scored, zoom_in_scored=zoom_in_scored,
        general_split=general_split, zoom_in_split=zoom_in_split,
        dataset_version=dataset_version, total_case_count=len(effective_cases),
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Milestone 5.6 evidence-sufficiency threshold calibration sweep."
    )
    parser.add_argument("--force-synthetic-embeddings", action="store_true")
    parser.add_argument("--reports-dir", default="evaluation/reports")
    args = parser.parse_args(argv)

    reports_dir = Path(args.reports_dir)
    report = run(force_synthetic=args.force_synthetic_embeddings, reports_dir=reports_dir)
    path = write_report(report, reports_dir)
    print(f"Report written: {path}")
    print(f"embedding_mode = {report['embedding_mode']}")
    if not str(report["embedding_mode"]).startswith("real"):
        print(
            "WARNING: this run used SYNTHETIC embeddings — mechanics-only, "
            "NOT a valid basis for a production threshold recommendation.",
            file=sys.stderr,
        )
    print(json.dumps(report["dataset"], indent=2))
    best = report["general_calibration"]["best_by_f1"]  # type: ignore[index]
    print("Best general-mode threshold by F1:", json.dumps(best, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
