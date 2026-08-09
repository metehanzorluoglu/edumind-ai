#!/usr/bin/env python
"""Milestone 5 (retrieval quality baseline / evidence-sufficiency
evaluation): runs evaluation/controlled_corpus.py's hand-authored,
ground-truth-known corpus through the REAL production retrieval pipeline
(app.core.embedding_provider, app.vectorstore.qdrant_client.QdrantVectorStore,
app.core.mmr.select_mmr, app.core.context_preparation.prepare_context,
app.core.citation.build_citations) — the exact functions Retriever.retrieve()
and RagService.prepare() call, never a reimplementation of them — and
reports document-level AND chunk-level Recall@K/MRR, category breakdowns,
pre-MMR vs. MMR vs. raw-dense-order comparisons, score-distribution
analysis, an evidence-sufficiency baseline, Zoom-In-specific findings, a
citation-grounding check, and latency (mean/p50/p95, embedding vs.
retrieval vs. MMR post-processing kept separate).

This is a companion to scripts/eval_retrieval.py, not a replacement: that
script evaluates a real, already-ingested user corpus (schema:
EvalQuestion, filename-only ground truth, requires --user-id + a reachable
Ollama/Qdrant with real data already indexed). This script instead builds
its OWN embedded, in-memory corpus with document_id/chunk_index-level
ground truth known by construction, and never depends on any external
ingestion step or reachable production Qdrant — reproducible from a fresh
checkout.

Deliberately does NOT change top_k/fetch_k/MMR relevance weight, does NOT
add a relevance-score cutoff, does NOT call BM25/a reranker, and does NOT
touch any production Settings default — every value it evaluates against
is read from app.config.get_settings() unmodified (see _frozen_config()).

Real vs. synthetic embeddings (Milestone 5 §3): tries the real,
production-configured Ollama embedding model first; if unreachable, falls
back to a clearly-labeled, deterministic, dependency-free LEXICAL (word-
overlap hash) embedding — explicitly NOT a semantic model. Every report
this script writes records which one was actually used
(embedding_mode: "real:<model>" | "synthetic:lexical-hash"), and the
Milestone 5 report never draws a semantic-quality conclusion from a
synthetic-mode run.

Usage:
    python scripts/eval_retrieval_controlled.py
    python scripts/eval_retrieval_controlled.py --force-synthetic-embeddings
    python scripts/eval_retrieval_controlled.py --reports-dir evaluation/reports

Requires nothing running — builds its own embedded Qdrant (mode="memory")
and, if Ollama is unreachable, falls back to the synthetic embedding
automatically (never blocks). To force the real embedding model, ensure
`ollama serve` is running with `ollama_embed_model` (see app/config.py)
pulled, then run without --force-synthetic-embeddings.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import statistics
import sys
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

from app.config import Settings, get_settings
from app.core.citation import build_citations
from app.core.context_preparation import prepare_context
from app.core.embedding_provider import (
    MXBAI_EMBED_LARGE_DIMENSIONS,
    EmbeddingProvider,
    OllamaEmbeddingProvider,
)
from app.core.mmr import select_mmr
from app.core.retrieval_schemas import RetrievedChunk
from app.core.retriever import Retriever
from app.ingestion.chunker import Chunk
from app.ingestion.metadata_schema import DocumentMetadata
from app.vectorstore.qdrant_client import QdrantVectorStore
from cli.reporting import utcnow
from evaluation.controlled_corpus import (
    CONTROLLED_CASES,
    CONTROLLED_DOCUMENTS,
    DOCUMENTS_BY_ID,
    ControlledDocument,
    EvalCase,
)

RECALL_CUTOFFS = (1, 3, 5, 8)
EVAL_USER_ID = "m5-eval-user"
_HASH_DIMENSIONS = 256


# ---------------------------------------------------------------------------
# Embedding provider selection (real Ollama, or a clearly-labeled synthetic
# fallback — see module docstring)
# ---------------------------------------------------------------------------


class _LexicalHashEmbeddingProvider:
    """Deterministic, dependency-free, word-overlap embedding — NOT a
    semantic model. Used ONLY when a real Ollama embedding model is
    unreachable (see select_embedding_provider). Cosine similarity under
    this scheme reflects shared-vocabulary overlap (closer to a crude
    lexical/BM25-like signal than to dense semantic similarity) — every
    report this script emits is labeled with which provider actually ran,
    and the Milestone 5 report explicitly does not draw a semantic-quality
    conclusion from a run using this provider (see that report's §3)."""

    dimensions = _HASH_DIMENSIONS

    def embed_batch(self, texts: list[str]) -> list[list[float]]:
        return [self._embed_one(text) for text in texts]

    def _embed_one(self, text: str) -> list[float]:
        vector = [0.0] * _HASH_DIMENSIONS
        normalized = "".join(ch.lower() if ch.isalnum() else " " for ch in text)
        for word in normalized.split():
            index = int(hashlib.md5(word.encode("utf-8")).hexdigest(), 16) % _HASH_DIMENSIONS
            vector[index] += 1.0
        norm = math.sqrt(sum(v * v for v in vector))
        if norm == 0.0:
            return vector
        return [v / norm for v in vector]


EmbeddingMode = Literal["real", "synthetic"]


def select_embedding_provider(
    *, force_synthetic: bool, settings: Settings
) -> tuple[EmbeddingProvider, str, EmbeddingMode]:
    """Returns (provider, mode_label, mode). Tries the real, production-
    configured Ollama embedding model first (a single connectivity-check
    call, so a mid-run failure never silently mixes real and synthetic
    results within one report) unless force_synthetic is set."""
    if not force_synthetic:
        try:
            provider: EmbeddingProvider = OllamaEmbeddingProvider(
                model=settings.ollama_embed_model,
                dimensions=MXBAI_EMBED_LARGE_DIMENSIONS,
                base_url=settings.ollama_base_url,
            )
            provider.embed_batch(["connectivity check"])
            return provider, f"real:{settings.ollama_embed_model}", "real"
        except Exception:
            pass
    return _LexicalHashEmbeddingProvider(), "synthetic:lexical-hash", "synthetic"


# ---------------------------------------------------------------------------
# Corpus ingestion
# ---------------------------------------------------------------------------


def _stable_sha256(document_id: str) -> str:
    return hashlib.sha256(document_id.encode("utf-8")).hexdigest()


def ingest_controlled_corpus(
    vector_store: QdrantVectorStore,
    embedding_provider: EmbeddingProvider,
    *,
    user_id: str,
    documents: list[ControlledDocument] | None = None,
) -> None:
    """`documents` defaults to CONTROLLED_DOCUMENTS (Milestone 5's own
    corpus) — passing evaluation.realistic_corpus.REALISTIC_DOCUMENTS
    (Milestone 5.7) ingests that corpus instead, through the exact same
    code path, never a second ingestion implementation."""
    for document in documents if documents is not None else CONTROLLED_DOCUMENTS:
        metadata = DocumentMetadata(
            document_id=document.document_id,
            source_filename=document.source_filename,
            file_format="pdf",
            sha256=_stable_sha256(document.document_id),
            file_size_bytes=1000,
            page_count=len(document.chunks),
            document_type=document.document_type,
            journal_quartile=document.journal_quartile,
            title=document.title,
            authors=document.authors,
            publication_year=document.publication_year,
            ingested_at=utcnow(),
        )
        chunks = [
            Chunk(chunk_index=c.chunk_index, page_number=c.page_number, text=c.text)
            for c in document.chunks
        ]
        embeddings = embedding_provider.embed_batch([c.text for c in chunks])
        vector_store.upsert_chunks(metadata, chunks, embeddings, user_id=user_id)


def chunk_key(document_id: str, chunk_index: int) -> str:
    """The eval harness's OWN ground-truth identifier — document_id +
    chunk_index, matching ControlledDocument.chunk_id() exactly.
    Deliberately independent of Qdrant's own internal point-id scheme (see
    RetrievedChunk.chunk_id / VectorSearchResult.id): using document_id +
    chunk_index directly (both already carried on every RetrievedChunk)
    means this harness never needs to know or depend on how Qdrant's own
    point ids are constructed."""
    return f"{document_id}::chunk{chunk_index}"


# ---------------------------------------------------------------------------
# Per-case retrieval with pre-MMR / MMR / raw-dense-order diagnostics
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class RawCandidate:
    document_id: str
    chunk_index: int
    key: str
    score: float
    text: str


@dataclass
class CaseTiming:
    embedding_ms: float
    qdrant_retrieval_ms: float
    mmr_ms: float

    @property
    def total_ms(self) -> float:
        return self.embedding_ms + self.qdrant_retrieval_ms + self.mmr_ms


@dataclass
class CaseResult:
    case: EvalCase
    candidate_pool: list[RawCandidate]  # full pre-MMR fetch_k pool
    raw_dense_topk: list[RawCandidate]  # candidate_pool sorted by score, sliced to top_k (no MMR)
    mmr_topk: list[RawCandidate]  # production select_mmr() output
    timing: CaseTiming
    insufficient_evidence: bool
    citation_count: int
    expected_chunk_survived_to_citation: bool | None
    zoom_in_topk: list[RawCandidate] | None = None
    zoom_in_insufficient_evidence: bool | None = None
    zoom_in_leaked_out_of_scope_document: bool | None = None


def _to_retrieved_chunk(document: ControlledDocument, candidate: RawCandidate) -> RetrievedChunk:
    """Minimal, eval-only RawCandidate -> RetrievedChunk conversion — a
    fresh, small mapping (not an import of app.core.retriever's private
    _to_retrieved_chunk) so this script never depends on that module's
    internal, leading-underscore helper; the two are independent, both
    trivial field copies from the same source data."""
    return RetrievedChunk(
        score=candidate.score,
        text=candidate.text,
        document_id=document.document_id,
        chunk_id=candidate.key,
        document_type=document.document_type,
        journal_quartile=document.journal_quartile,
        title=document.title,
        authors=document.authors,
        publication_year=document.publication_year,
        source_filename=document.source_filename,
        chunk_index=candidate.chunk_index,
        page_number=document.chunks[candidate.chunk_index].page_number,
    )


def run_case(
    case: EvalCase,
    *,
    vector_store: QdrantVectorStore,
    embedding_provider: EmbeddingProvider,
    top_k: int,
    fetch_k: int,
    mmr_relevance_weight: float,
    settings: Settings,
    user_id: str = EVAL_USER_ID,
    documents_by_id: dict[str, ControlledDocument] | None = None,
) -> CaseResult:
    """`documents_by_id` defaults to controlled_corpus.DOCUMENTS_BY_ID
    (Milestone 5's own corpus) — pass evaluation.realistic_corpus.
    DOCUMENTS_BY_ID (Milestone 5.7) to run this exact same function
    against that corpus instead."""
    documents_by_id = documents_by_id if documents_by_id is not None else DOCUMENTS_BY_ID
    t0 = time.perf_counter()
    query_vector = embedding_provider.embed_batch([case.query])[0]
    embedding_ms = (time.perf_counter() - t0) * 1000

    t1 = time.perf_counter()
    raw_results = vector_store.search(
        query_vector, limit=max(top_k, fetch_k), user_id=user_id, with_vectors=True
    )
    qdrant_ms = (time.perf_counter() - t1) * 1000

    candidate_pool = [
        RawCandidate(
            document_id=r.payload.document_id,
            chunk_index=r.payload.chunk_index,
            key=chunk_key(r.payload.document_id, r.payload.chunk_index),
            score=r.score,
            text=r.payload.text,
        )
        for r in raw_results
    ]
    vectors_by_key = {
        chunk_key(r.payload.document_id, r.payload.chunk_index): r.vector for r in raw_results
    }

    raw_dense_topk = sorted(candidate_pool, key=lambda c: c.score, reverse=True)[:top_k]

    t2 = time.perf_counter()
    mmr_input: list[tuple[RawCandidate, list[float], float]] = []
    for c in candidate_pool:
        vector = vectors_by_key.get(c.key)
        if vector is not None:
            mmr_input.append((c, vector, c.score))
    mmr_topk = select_mmr(mmr_input, top_k=top_k, relevance_weight=mmr_relevance_weight)
    mmr_ms = (time.perf_counter() - t2) * 1000

    mmr_chunks = [_to_retrieved_chunk(documents_by_id[c.document_id], c) for c in mmr_topk]
    prepared = prepare_context(
        mmr_chunks,
        max_per_document=settings.context_max_chunks_per_document,
        max_total_chars=settings.context_max_total_chars,
        similarity_threshold=settings.context_dedup_similarity_threshold,
    )
    insufficient_evidence = len(prepared) == 0
    citations = build_citations(prepared)

    expected_survived: bool | None = None
    if case.expected_chunk_ids:
        survived_keys = {chunk_key(c.document_id, c.chunk_index) for c in prepared}
        expected_survived = bool(survived_keys & set(case.expected_chunk_ids))

    result = CaseResult(
        case=case,
        candidate_pool=candidate_pool,
        raw_dense_topk=raw_dense_topk,
        mmr_topk=mmr_topk,
        timing=CaseTiming(embedding_ms, qdrant_ms, mmr_ms),
        insufficient_evidence=insufficient_evidence,
        citation_count=len(citations),
        expected_chunk_survived_to_citation=expected_survived,
    )

    if case.scope_document_ids is not None:
        _run_zoom_in_case(
            result,
            vector_store=vector_store,
            embedding_provider=embedding_provider,
            top_k=top_k,
            fetch_k=fetch_k,
            mmr_relevance_weight=mmr_relevance_weight,
            settings=settings,
            user_id=user_id,
            documents_by_id=documents_by_id,
        )

    return result


def _run_zoom_in_case(
    result: CaseResult,
    *,
    vector_store: QdrantVectorStore,
    embedding_provider: EmbeddingProvider,
    top_k: int,
    fetch_k: int,
    mmr_relevance_weight: float,
    settings: Settings,
    user_id: str,
    documents_by_id: dict[str, ControlledDocument],
) -> None:
    """Simulates Zoom-In (Milestone 4) exactly as production does: tags
    only case.scope_document_ids with a fresh, case-unique conversation_id
    in the vector store's payload, then calls the REAL Retriever.retrieve()
    with that conversation_id — the exact same call the "chat" tier makes
    in app/core/scoped_retrieval.py's execute_scope_plan() when
    include_project=False/include_general=False (Zoom-In's own
    _effective_scope_flags — see rag-backend's app/api/routes_conversations.py).
    Not a re-implementation of scope resolution; a single-tier plan and a
    direct conversation_id-scoped retrieve() call are identical by
    construction (resolve_scope_plan with only include_chat=True produces
    exactly one tier, itself)."""
    assert result.case.scope_document_ids is not None
    conversation_id = f"m5-zoomin-{uuid.uuid4()}"
    for document_id in result.case.scope_document_ids:
        vector_store.update_scope_associations(
            document_id, user_id=user_id, conversation_ids=[conversation_id], project_ids=[]
        )

    retriever = Retriever(
        embedding_provider=embedding_provider,
        vector_store=vector_store,
        relevance_weight=mmr_relevance_weight,
        fetch_k=fetch_k,
    )
    retrieved = retriever.retrieve(
        result.case.query, user_id=user_id, top_k=top_k, conversation_id=conversation_id
    )
    zoom_in_topk = [
        RawCandidate(
            document_id=c.document_id,
            chunk_index=c.chunk_index,
            key=chunk_key(c.document_id, c.chunk_index),
            score=c.score,
            text=c.text,
        )
        for c in retrieved
    ]
    result.zoom_in_topk = zoom_in_topk
    prepared = prepare_context(
        retrieved,
        max_per_document=settings.context_max_chunks_per_document,
        max_total_chars=settings.context_max_total_chars,
        similarity_threshold=settings.context_dedup_similarity_threshold,
    )
    result.zoom_in_insufficient_evidence = len(prepared) == 0
    out_of_scope_docs = set(documents_by_id) - set(result.case.scope_document_ids)
    result.zoom_in_leaked_out_of_scope_document = any(
        c.document_id in out_of_scope_docs for c in zoom_in_topk
    )

    # Undo the tagging so later cases (and re-runs against the same
    # in-memory store within one process) never see stale associations.
    for document_id in result.case.scope_document_ids:
        vector_store.update_scope_associations(
            document_id, user_id=user_id, conversation_ids=[], project_ids=[]
        )


# ---------------------------------------------------------------------------
# Metrics (pure functions — unit tested directly, see
# tests/unit/scripts/test_eval_retrieval_controlled.py)
# ---------------------------------------------------------------------------


def find_document_rank(
    ranked: list[RawCandidate], expected_document_ids: list[str], *, require_all: bool
) -> int | None:
    """Rank (1-indexed) at which the document-level recall condition is
    first satisfied, or None if never satisfied within `ranked`.
    require_all=False: rank of the first chunk whose document_id is in
    expected_document_ids (Recall@K's usual "any expected item" meaning).
    require_all=True (cross-document comparison cases): the rank by which
    EVERY expected document_id has appeared at least once — a comparison
    question is not "answerable" until both/all required documents are
    present, not merely one of them."""
    if not expected_document_ids:
        return None
    if not require_all:
        for index, candidate in enumerate(ranked, start=1):
            if candidate.document_id in expected_document_ids:
                return index
        return None
    seen: set[str] = set()
    for index, candidate in enumerate(ranked, start=1):
        if candidate.document_id in expected_document_ids:
            seen.add(candidate.document_id)
        if seen == set(expected_document_ids):
            return index
    return None


def find_chunk_rank(ranked: list[RawCandidate], expected_chunk_keys: list[str]) -> int | None:
    if not expected_chunk_keys:
        return None
    for index, candidate in enumerate(ranked, start=1):
        if candidate.key in expected_chunk_keys:
            return index
    return None


def recall_at_k(ranks: list[int | None], k: int) -> float:
    if not ranks:
        return 0.0
    hits = sum(1 for r in ranks if r is not None and r <= k)
    return hits / len(ranks)


def mean_reciprocal_rank(ranks: list[int | None]) -> float:
    if not ranks:
        return 0.0
    return sum((1.0 / r) if r else 0.0 for r in ranks) / len(ranks)


@dataclass
class ScoreDistributionSummary:
    count: int
    min: float | None
    max: float | None
    mean: float | None
    median: float | None

    @classmethod
    def from_scores(cls, scores: list[float]) -> ScoreDistributionSummary:
        if not scores:
            return cls(count=0, min=None, max=None, mean=None, median=None)
        return cls(
            count=len(scores),
            min=min(scores),
            max=max(scores),
            mean=statistics.mean(scores),
            median=statistics.median(scores),
        )

    def to_dict(self) -> dict[str, object]:
        return {
            "count": self.count,
            "min": self.min,
            "max": self.max,
            "mean": self.mean,
            "median": self.median,
        }


def latency_percentiles(values_ms: list[float]) -> dict[str, float]:
    if not values_ms:
        return {"mean": 0.0, "p50": 0.0, "p95": 0.0}
    ordered = sorted(values_ms)
    return {
        "mean": statistics.mean(ordered),
        "p50": statistics.median(ordered),
        "p95": ordered[min(len(ordered) - 1, math.ceil(0.95 * len(ordered)) - 1)],
    }


@dataclass
class AggregateMetrics:
    document_recall_at: dict[int, float]
    chunk_recall_at: dict[int, float]
    document_mrr: float
    chunk_mrr: float
    document_hit_rate: float
    chunk_hit_rate: float
    no_answer_false_positive_rate: float | None
    no_answer_top_scores: ScoreDistributionSummary

    def to_dict(self) -> dict[str, object]:
        return {
            "document_recall_at": {f"recall@{k}": v for k, v in self.document_recall_at.items()},
            "chunk_recall_at": {f"recall@{k}": v for k, v in self.chunk_recall_at.items()},
            "document_mrr": self.document_mrr,
            "chunk_mrr": self.chunk_mrr,
            "document_hit_rate": self.document_hit_rate,
            "chunk_hit_rate": self.chunk_hit_rate,
            "no_answer_false_positive_rate": self.no_answer_false_positive_rate,
            "no_answer_top_scores": self.no_answer_top_scores.to_dict(),
        }


def compute_aggregate_metrics(results: list[CaseResult]) -> AggregateMetrics:
    answerable = [r for r in results if r.case.answerable]

    doc_ranks = [
        find_document_rank(
            r.mmr_topk, r.case.expected_document_ids, require_all=r.case.require_all_documents
        )
        for r in answerable
    ]
    chunk_eligible = [r for r in answerable if r.case.expected_chunk_ids]
    chunk_ranks = [find_chunk_rank(r.mmr_topk, r.case.expected_chunk_ids) for r in chunk_eligible]

    document_recall_at = {k: recall_at_k(doc_ranks, k) for k in RECALL_CUTOFFS}
    chunk_recall_at = {k: recall_at_k(chunk_ranks, k) for k in RECALL_CUTOFFS}

    no_answer_results = [r for r in results if not r.case.answerable]
    no_answer_fp_rate = (
        sum(1 for r in no_answer_results if not r.insufficient_evidence) / len(no_answer_results)
        if no_answer_results
        else None
    )
    no_answer_top_scores = ScoreDistributionSummary.from_scores(
        [r.mmr_topk[0].score for r in no_answer_results if r.mmr_topk]
    )

    return AggregateMetrics(
        document_recall_at=document_recall_at,
        chunk_recall_at=chunk_recall_at,
        document_mrr=mean_reciprocal_rank(doc_ranks),
        chunk_mrr=mean_reciprocal_rank(chunk_ranks),
        document_hit_rate=(
            sum(1 for r in doc_ranks if r is not None) / len(doc_ranks) if doc_ranks else 0.0
        ),
        chunk_hit_rate=(
            sum(1 for r in chunk_ranks if r is not None) / len(chunk_ranks) if chunk_ranks else 0.0
        ),
        no_answer_false_positive_rate=no_answer_fp_rate,
        no_answer_top_scores=no_answer_top_scores,
    )


CANDIDATE_RECALL_CUTOFFS = (1, 3, 5, 8, 24)


def compute_candidate_vs_final_recall(results: list[CaseResult]) -> dict[str, object]:
    """Milestone 5.7 §9 ("Candidate vs Final Ranking"): distinguishes "the
    expected document never entered the fetch_k candidate pool at all"
    (a genuine retrieval-recall miss) from "it entered the pool but did
    not survive into the final top_k after MMR" (a ranking-stage miss) —
    the same distinction Milestone 5.5's report made by hand, now
    reported as a standard metric. candidate_pool is the raw, pre-MMR,
    already-score-sorted fetch_k pool (see run_case); mmr_topk is the
    final, post-MMR top_k actually used for context/generation."""
    answerable = [r for r in results if r.case.answerable]
    candidate_ranks = [
        find_document_rank(
            r.candidate_pool, r.case.expected_document_ids, require_all=r.case.require_all_documents
        )
        for r in answerable
    ]
    final_ranks = [
        find_document_rank(
            r.mmr_topk, r.case.expected_document_ids, require_all=r.case.require_all_documents
        )
        for r in answerable
    ]
    never_in_candidates = sum(1 for r in candidate_ranks if r is None)
    in_candidates_not_final = sum(
        1 for c, f in zip(candidate_ranks, final_ranks, strict=True) if c is not None and f is None
    )
    return {
        "candidate_recall_at": {
            f"recall@{k}": recall_at_k(candidate_ranks, k) for k in CANDIDATE_RECALL_CUTOFFS
        },
        "final_recall_at": {f"recall@{k}": recall_at_k(final_ranks, k) for k in RECALL_CUTOFFS},
        "candidate_hit_rate": (
            sum(1 for r in candidate_ranks if r is not None) / len(candidate_ranks)
            if candidate_ranks
            else 0.0
        ),
        "final_window_hit_rate": (
            sum(1 for r in final_ranks if r is not None) / len(final_ranks) if final_ranks else 0.0
        ),
        "recall_failures_never_in_candidate_pool": never_in_candidates,
        "ranking_failures_in_candidates_not_final_window": in_candidates_not_final,
        "eligible_case_count": len(answerable),
    }


@dataclass(frozen=True)
class _CoverageRow:
    case_id: str
    required_document_count: int
    covered_document_count: int
    coverage: float
    fully_covered: bool
    top_score: float | None

    def to_dict(self) -> dict[str, object]:
        return {
            "case_id": self.case_id,
            "required_document_count": self.required_document_count,
            "covered_document_count": self.covered_document_count,
            "coverage": self.coverage,
            "fully_covered": self.fully_covered,
            "top_score": self.top_score,
        }


def compute_evidence_coverage(results: list[CaseResult]) -> dict[str, object]:
    """Milestone 5.7 §9/§15/§16: for multi-document-required cases (2+
    expected_document_ids), what FRACTION of the required documents
    actually appear in the final top_k — as opposed to top_score, which
    only reflects how well the single best-matching document scored.
    Compares coverage's separation power against top_score for exactly
    this subset, to test whether "coverage/completeness" is a stronger
    sufficiency signal than "similarity strength" for multi-document
    questions (see the module docstring's MMR-placement note for why
    this is evaluation-only, never a production signal)."""
    multi_doc = [r for r in results if len(r.case.expected_document_ids) >= 2]
    if not multi_doc:
        return {"multi_document_case_count": 0}

    rows: list[_CoverageRow] = []
    for r in multi_doc:
        required = set(r.case.expected_document_ids)
        retrieved_docs = {c.document_id for c in r.mmr_topk}
        covered = required & retrieved_docs
        coverage = len(covered) / len(required)
        rows.append(
            _CoverageRow(
                case_id=r.case.case_id,
                required_document_count=len(required),
                covered_document_count=len(covered),
                coverage=coverage,
                fully_covered=coverage == 1.0,
                top_score=r.mmr_topk[0].score if r.mmr_topk else None,
            )
        )

    coverages = [row.coverage for row in rows]
    top_scores = [row.top_score for row in rows if row.top_score is not None]
    fully_covered_count = sum(1 for row in rows if row.fully_covered)
    # Cases with strong top_score but incomplete coverage — the exact
    # failure mode Milestone 5.6/5.7 flagged: "high top-1 relevance but
    # still insufficient evidence because only one required side of a
    # comparison was retrieved."
    high_score_incomplete = [
        row for row in rows
        if row.top_score is not None and row.top_score >= 0.7 and not row.fully_covered
    ]

    return {
        "multi_document_case_count": len(multi_doc),
        "fully_covered_count": fully_covered_count,
        "fully_covered_rate": fully_covered_count / len(multi_doc),
        "mean_coverage": statistics.mean(coverages) if coverages else None,
        "mean_top_score_multi_doc": statistics.mean(top_scores) if top_scores else None,
        "high_score_but_incomplete_coverage_count": len(high_score_incomplete),
        "high_score_but_incomplete_coverage_case_ids": [
            row.case_id for row in high_score_incomplete
        ],
        "cases": [row.to_dict() for row in rows],
    }


def compute_category_breakdown(results: list[CaseResult]) -> dict[str, dict[str, object]]:
    from evaluation.controlled_corpus import CATEGORIES

    breakdown: dict[str, dict[str, object]] = {}
    for category in CATEGORIES:
        in_category = [r for r in results if r.case.category == category]
        answerable_in_category = [r for r in in_category if r.case.answerable]
        doc_ranks = [
            find_document_rank(
                r.mmr_topk, r.case.expected_document_ids, require_all=r.case.require_all_documents
            )
            for r in answerable_in_category
        ]
        breakdown[category] = {
            "case_count": len(in_category),
            "document_recall_at_5": recall_at_k(doc_ranks, 5),
            "document_mrr": mean_reciprocal_rank(doc_ranks),
            "document_hit_rate": (
                sum(1 for r in doc_ranks if r is not None) / len(doc_ranks) if doc_ranks else None
            ),
        }
    return breakdown


@dataclass
class MMRImpact:
    improved_count: int
    hurt_count: int
    unchanged_count: int
    avg_source_diversity_raw_dense: float
    avg_source_diversity_mmr: float

    def to_dict(self) -> dict[str, object]:
        return {
            "cases_where_mmr_improved_document_rank": self.improved_count,
            "cases_where_mmr_hurt_document_rank": self.hurt_count,
            "cases_unchanged": self.unchanged_count,
            "avg_source_diversity_raw_dense_topk": self.avg_source_diversity_raw_dense,
            "avg_source_diversity_mmr_topk": self.avg_source_diversity_mmr,
        }


def compute_mmr_impact(results: list[CaseResult]) -> MMRImpact:
    answerable = [r for r in results if r.case.answerable]
    improved = hurt = unchanged = 0
    for r in answerable:
        raw_rank = find_document_rank(
            r.raw_dense_topk, r.case.expected_document_ids, require_all=r.case.require_all_documents
        )
        mmr_rank = find_document_rank(
            r.mmr_topk, r.case.expected_document_ids, require_all=r.case.require_all_documents
        )
        raw_key = raw_rank if raw_rank is not None else len(r.raw_dense_topk) + 1
        mmr_key = mmr_rank if mmr_rank is not None else len(r.mmr_topk) + 1
        if mmr_key < raw_key:
            improved += 1
        elif mmr_key > raw_key:
            hurt += 1
        else:
            unchanged += 1

    def _diversity(cands_list: list[list[RawCandidate]]) -> float:
        values = [len({c.document_id for c in cands}) for cands in cands_list if cands]
        return statistics.mean(values) if values else 0.0

    return MMRImpact(
        improved_count=improved,
        hurt_count=hurt,
        unchanged_count=unchanged,
        avg_source_diversity_raw_dense=_diversity([r.raw_dense_topk for r in results]),
        avg_source_diversity_mmr=_diversity([r.mmr_topk for r in results]),
    )


def compute_score_distribution(results: list[CaseResult]) -> dict[str, object]:
    """§7: raw (pre-MMR) top-result scores across the four/five requested
    buckets."""
    relevant_top_scores: list[float] = []
    irrelevant_top_scores: list[float] = []
    answerable_top_scores: list[float] = []
    unanswerable_top_scores: list[float] = []
    zoom_in_absent_top_scores: list[float] = []

    for r in results:
        if not r.candidate_pool:
            continue
        top = r.candidate_pool[0]
        if r.case.answerable:
            answerable_top_scores.append(top.score)
            expected = set(r.case.expected_document_ids)
            if top.document_id in expected:
                relevant_top_scores.append(top.score)
            else:
                irrelevant_top_scores.append(top.score)
        else:
            unanswerable_top_scores.append(top.score)
        if r.case.scope_contains_answer is False and r.zoom_in_topk:
            zoom_in_absent_top_scores.append(r.zoom_in_topk[0].score)

    return {
        "relevant_top_result": ScoreDistributionSummary.from_scores(relevant_top_scores).to_dict(),
        "irrelevant_top_result": ScoreDistributionSummary.from_scores(
            irrelevant_top_scores
        ).to_dict(),
        "answerable_query_top_result": ScoreDistributionSummary.from_scores(
            answerable_top_scores
        ).to_dict(),
        "unanswerable_query_top_result": ScoreDistributionSummary.from_scores(
            unanswerable_top_scores
        ).to_dict(),
        "zoom_in_scope_missing_answer_top_result": ScoreDistributionSummary.from_scores(
            zoom_in_absent_top_scores
        ).to_dict(),
    }


def _zoom_in_hit_within_scope(result: CaseResult) -> bool:
    scope = result.case.scope_document_ids or []
    candidates = result.zoom_in_topk or []
    return any(c.document_id in scope for c in candidates)


def compute_zoom_in_findings(results: list[CaseResult]) -> dict[str, object]:
    zoom_in_results = [r for r in results if r.case.scope_document_ids is not None]
    if not zoom_in_results:
        return {"case_count": 0}
    leaked = [r for r in zoom_in_results if r.zoom_in_leaked_out_of_scope_document]
    absent_cases = [r for r in zoom_in_results if r.case.scope_contains_answer is False]
    present_cases = [r for r in zoom_in_results if r.case.scope_contains_answer is True]
    return {
        "case_count": len(zoom_in_results),
        "leakage_count": len(leaked),
        "leaked_case_ids": [r.case.case_id for r in leaked],
        "scope_absent_case_count": len(absent_cases),
        "scope_absent_correctly_flagged_insufficient": (
            sum(1 for r in absent_cases if r.zoom_in_insufficient_evidence) / len(absent_cases)
            if absent_cases
            else None
        ),
        "scope_absent_returned_unrelated_evidence_anyway": sum(
            1 for r in absent_cases if not r.zoom_in_insufficient_evidence
        ),
        "scope_present_case_count": len(present_cases),
        "scope_present_document_hit_rate": (
            sum(1 for r in present_cases if _zoom_in_hit_within_scope(r))
            / len(present_cases)
            if present_cases
            else None
        ),
    }


def compute_evidence_sufficiency(results: list[CaseResult]) -> dict[str, object]:
    no_answer = [r for r in results if not r.case.answerable]
    rows = []
    for r in no_answer:
        top = r.candidate_pool[0] if r.candidate_pool else None
        rows.append(
            {
                "case_id": r.case.case_id,
                "returned_at_least_one_chunk": bool(r.candidate_pool),
                "top_score": top.score if top else None,
                "would_call_llm": not r.insufficient_evidence,
                "insufficient_evidence_shortcut_fired": r.insufficient_evidence,
            }
        )
    return {
        "no_answer_case_count": len(no_answer),
        "always_returned_at_least_one_chunk": (
            all(row["returned_at_least_one_chunk"] for row in rows) if rows else None
        ),
        "shortcut_fired_rate": (
            sum(1 for row in rows if row["insufficient_evidence_shortcut_fired"]) / len(rows)
            if rows
            else None
        ),
        "cases": rows,
    }


def compute_citation_grounding(results: list[CaseResult]) -> dict[str, object]:
    eligible = [r for r in results if r.case.expected_chunk_ids]
    survived = [r for r in eligible if r.expected_chunk_survived_to_citation]
    return {
        "eligible_case_count": len(eligible),
        "expected_chunk_survived_to_citation_rate": (
            len(survived) / len(eligible) if eligible else None
        ),
        "failed_case_ids": [
            r.case.case_id for r in eligible if not r.expected_chunk_survived_to_citation
        ],
    }


def compute_latency(results: list[CaseResult]) -> dict[str, dict[str, float]]:
    return {
        "embedding_ms": latency_percentiles([r.timing.embedding_ms for r in results]),
        "qdrant_retrieval_ms": latency_percentiles([r.timing.qdrant_retrieval_ms for r in results]),
        "mmr_ms": latency_percentiles([r.timing.mmr_ms for r in results]),
        "total_ms": latency_percentiles([r.timing.total_ms for r in results]),
    }


# ---------------------------------------------------------------------------
# Report assembly
# ---------------------------------------------------------------------------


@dataclass
class BaselineReport:
    generated_at: str
    dataset_version: str
    embedding_mode: str
    model: str
    embedding_model_configured: str
    top_k: int
    fetch_k: int
    mmr_relevance_weight: float
    context_max_total_chars: int
    context_max_chunks_per_document: int
    case_count: int
    document_count: int
    chunk_count: int
    aggregate: AggregateMetrics
    category_breakdown: dict[str, dict[str, object]]
    mmr_impact: MMRImpact
    score_distribution: dict[str, object]
    zoom_in_findings: dict[str, object]
    evidence_sufficiency: dict[str, object]
    citation_grounding: dict[str, object]
    latency: dict[str, dict[str, float]]
    candidate_vs_final: dict[str, object] = field(default_factory=dict)
    evidence_coverage: dict[str, object] = field(default_factory=dict)

    def to_dict(self) -> dict[str, object]:
        return {
            "generated_at": self.generated_at,
            "dataset_version": self.dataset_version,
            "embedding_mode": self.embedding_mode,
            "frozen_production_config": {
                "generation_model": self.model,
                "embedding_model_configured": self.embedding_model_configured,
                "top_k": self.top_k,
                "fetch_k": self.fetch_k,
                "mmr_relevance_weight": self.mmr_relevance_weight,
                "context_max_total_chars": self.context_max_total_chars,
                "context_max_chunks_per_document": self.context_max_chunks_per_document,
            },
            "dataset": {
                "case_count": self.case_count,
                "document_count": self.document_count,
                "chunk_count": self.chunk_count,
            },
            "aggregate_metrics": self.aggregate.to_dict(),
            "category_breakdown": self.category_breakdown,
            "mmr_impact": self.mmr_impact.to_dict(),
            "score_distribution": self.score_distribution,
            "zoom_in_findings": self.zoom_in_findings,
            "evidence_sufficiency": self.evidence_sufficiency,
            "citation_grounding": self.citation_grounding,
            "latency": self.latency,
            "candidate_vs_final": self.candidate_vs_final,
            "evidence_coverage": self.evidence_coverage,
        }

    def to_markdown(self) -> str:
        lines = [
            f"# Retrieval quality baseline (controlled corpus) — {self.generated_at}",
            "",
            f"- Embedding mode: **{self.embedding_mode}**"
            + (
                ""
                if self.embedding_mode.startswith("real")
                else " (SYNTHETIC — mechanics only, not a semantic-quality signal)"
            ),
            f"- Dataset: {self.case_count} cases / {self.document_count} documents / "
            f"{self.chunk_count} chunks (dataset_version={self.dataset_version})",
            f"- top_k={self.top_k} fetch_k={self.fetch_k} "
            f"mmr_relevance_weight={self.mmr_relevance_weight}",
            "",
            "## Aggregate metrics",
            "",
            "| Metric | Value |",
            "| --- | --- |",
        ]
        for k, v in self.aggregate.document_recall_at.items():
            lines.append(f"| Document Recall@{k} | {v:.2%} |")
        for k, v in self.aggregate.chunk_recall_at.items():
            lines.append(f"| Chunk Recall@{k} | {v:.2%} |")
        lines.append(f"| Document MRR | {self.aggregate.document_mrr:.3f} |")
        lines.append(f"| Chunk MRR | {self.aggregate.chunk_mrr:.3f} |")
        lines.append(f"| Document hit rate | {self.aggregate.document_hit_rate:.2%} |")
        lines.append(f"| Chunk hit rate | {self.aggregate.chunk_hit_rate:.2%} |")
        fp = self.aggregate.no_answer_false_positive_rate
        lines.append(f"| No-answer false-positive rate | {'n/a' if fp is None else f'{fp:.2%}'} |")

        lines += [
            "",
            "## Category breakdown",
            "",
            "| Category | N | Doc Recall@5 | Doc MRR |",
            "| --- | --- | --- | --- |",
        ]
        for category, stats in self.category_breakdown.items():
            r5 = stats["document_recall_at_5"]
            mrr = stats["document_mrr"]
            lines.append(f"| {category} | {stats['case_count']} | {r5:.2%} | {mrr:.3f} |")

        lines += [
            "",
            "## Latency (ms)",
            "",
            "| Stage | mean | p50 | p95 |",
            "| --- | --- | --- | --- |",
        ]
        for stage, values in self.latency.items():
            mean_ms, p50_ms, p95_ms = values["mean"], values["p50"], values["p95"]
            lines.append(f"| {stage} | {mean_ms:.2f} | {p50_ms:.2f} | {p95_ms:.2f} |")

        return "\n".join(lines) + "\n"


DATASET_VERSION = "controlled-corpus-v1"


def build_report(
    results: list[CaseResult],
    *,
    embedding_mode: str,
    settings: Settings,
    top_k: int,
    fetch_k: int,
    documents: list[ControlledDocument] | None = None,
    cases: list[EvalCase] | None = None,
    dataset_version: str = DATASET_VERSION,
) -> BaselineReport:
    effective_documents = documents if documents is not None else CONTROLLED_DOCUMENTS
    effective_cases = cases if cases is not None else CONTROLLED_CASES
    return BaselineReport(
        generated_at=utcnow().isoformat(),
        dataset_version=dataset_version,
        embedding_mode=embedding_mode,
        model=settings.ollama_llm_model,
        embedding_model_configured=settings.ollama_embed_model,
        top_k=top_k,
        fetch_k=fetch_k,
        mmr_relevance_weight=settings.retrieval_mmr_relevance_weight,
        context_max_total_chars=settings.context_max_total_chars,
        context_max_chunks_per_document=settings.context_max_chunks_per_document,
        case_count=len(effective_cases),
        document_count=len(effective_documents),
        chunk_count=sum(len(d.chunks) for d in effective_documents),
        aggregate=compute_aggregate_metrics(results),
        category_breakdown=compute_category_breakdown(results),
        mmr_impact=compute_mmr_impact(results),
        score_distribution=compute_score_distribution(results),
        zoom_in_findings=compute_zoom_in_findings(results),
        evidence_sufficiency=compute_evidence_sufficiency(results),
        citation_grounding=compute_citation_grounding(results),
        latency=compute_latency(results),
        candidate_vs_final=compute_candidate_vs_final_recall(results),
        evidence_coverage=compute_evidence_coverage(results),
    )


def write_reports(report: BaselineReport, reports_dir: Path) -> tuple[Path, Path]:
    reports_dir.mkdir(parents=True, exist_ok=True)
    timestamp = utcnow().strftime("%Y%m%dT%H%M%SZ")
    json_path = reports_dir / f"retrieval-baseline-{timestamp}.json"
    md_path = reports_dir / f"retrieval-baseline-{timestamp}.md"
    json_path.write_text(json.dumps(report.to_dict(), indent=2), encoding="utf-8")
    md_path.write_text(report.to_markdown(), encoding="utf-8")
    return json_path, md_path


def run(
    *,
    force_synthetic: bool,
    top_k: int | None,
    reports_dir: Path,
    documents: list[ControlledDocument] | None = None,
    cases: list[EvalCase] | None = None,
    collection_name: str = "m5-controlled-eval",
    dataset_version: str = DATASET_VERSION,
) -> BaselineReport:
    """`documents`/`cases` default to the Milestone 5 controlled corpus —
    pass evaluation.realistic_corpus.REALISTIC_DOCUMENTS/ALL_REALISTIC_CASES
    (Milestone 5.7) to run this exact same harness against that corpus
    instead, with zero duplicated ingestion/retrieval/metric logic."""
    settings = get_settings()
    effective_top_k = top_k if top_k is not None else settings.retrieval_top_k
    effective_documents = documents if documents is not None else CONTROLLED_DOCUMENTS
    effective_cases = cases if cases is not None else CONTROLLED_CASES
    documents_by_id = {d.document_id: d for d in effective_documents}
    embedding_provider, embedding_mode, _mode = select_embedding_provider(
        force_synthetic=force_synthetic, settings=settings
    )
    dimensions = embedding_provider.dimensions
    vector_store = QdrantVectorStore(
        collection_name=collection_name, vector_size=dimensions, mode="memory"
    )
    vector_store.ensure_collection()
    ingest_controlled_corpus(
        vector_store, embedding_provider, user_id=EVAL_USER_ID, documents=effective_documents
    )

    results = [
        run_case(
            case,
            vector_store=vector_store,
            embedding_provider=embedding_provider,
            top_k=effective_top_k,
            fetch_k=settings.retrieval_fetch_k,
            mmr_relevance_weight=settings.retrieval_mmr_relevance_weight,
            settings=settings,
            documents_by_id=documents_by_id,
        )
        for case in effective_cases
    ]
    vector_store.close()

    return build_report(
        results,
        embedding_mode=embedding_mode,
        settings=settings,
        top_k=effective_top_k,
        fetch_k=settings.retrieval_fetch_k,
        documents=effective_documents,
        cases=effective_cases,
        dataset_version=dataset_version,
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Milestone 5 retrieval-quality baseline against the controlled corpus."
    )
    parser.add_argument(
        "--force-synthetic-embeddings",
        action="store_true",
        help="Skip the real-Ollama connectivity check and use the lexical-hash fallback directly.",
    )
    parser.add_argument(
        "--top-k",
        type=int,
        default=None,
        help="Override top_k for this run only (default: Settings.retrieval_top_k).",
    )
    parser.add_argument("--reports-dir", default="evaluation/reports")
    args = parser.parse_args(argv)

    report = run(
        force_synthetic=args.force_synthetic_embeddings,
        top_k=args.top_k,
        reports_dir=Path(args.reports_dir),
    )
    json_path, md_path = write_reports(report, Path(args.reports_dir))
    print(f"Reports written: {json_path}, {md_path}")
    print(f"\n{report.to_markdown()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
