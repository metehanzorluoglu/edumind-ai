#!/usr/bin/env python
"""Retrieval-quality evaluation harness (milestone 8 §6/§7).

Runs a JSON question set (see evaluation/README.md for the schema) through
the real retriever + context-preparation pipeline (the exact code path
/search and /chat use) and reports Recall@K, MRR, diversity, dominance,
score distributions, off-topic false-positive rate, insufficient-evidence
accuracy, filter accuracy, and latency.

Usage:
    python scripts/eval_retrieval.py --questions evaluation/fixtures-questions.json
    python scripts/eval_retrieval.py --questions evaluation/real-corpus-questions.json

Requires a reachable Ollama (for embeddings) and Qdrant (embedded or
server) with the target corpus already indexed — this is an online
evaluation tool, not a unit test. It does not require the FastAPI server
itself to be running; it talks to the same app.deps providers directly.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from dataclasses import dataclass, field
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any

from app.config import get_settings
from app.core.context_preparation import prepare_context
from app.core.retrieval_schemas import RetrievalFilters, RetrievedChunk
from app.deps import get_retriever
from cli.reporting import utcnow

RECALL_CUTOFFS = (1, 3, 5, 8)


@dataclass
class EvalQuestion:
    question_id: str
    question: str
    category: str
    expected_relevant_filenames: list[str]
    expected_document_type: str | None
    expected_quartile: str | None
    expect_insufficient_evidence: bool
    filters: RetrievalFilters
    notes: str

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> EvalQuestion:
        raw_filters = data.get("filters") or {}
        assert isinstance(raw_filters, dict)
        return cls(
            question_id=str(data["question_id"]),
            question=str(data["question"]),
            category=str(data["category"]),
            expected_relevant_filenames=list(data.get("expected_relevant_filenames") or []),
            expected_document_type=data.get("expected_document_type"),
            expected_quartile=data.get("expected_quartile"),
            expect_insufficient_evidence=bool(data.get("expect_insufficient_evidence", False)),
            filters=RetrievalFilters(
                document_type=raw_filters.get("document_type"),
                journal_quartile=raw_filters.get("journal_quartile"),
                publication_year_from=raw_filters.get("publication_year_from"),
                publication_year_to=raw_filters.get("publication_year_to"),
            ),
            notes=str(data.get("notes", "")),
        )

    @property
    def has_expected_relevant(self) -> bool:
        return bool(self.expected_relevant_filenames) and not self.expect_insufficient_evidence

    @property
    def has_filter(self) -> bool:
        return any(
            value is not None
            for value in (
                self.filters.document_type,
                self.filters.journal_quartile,
                self.filters.publication_year_from,
                self.filters.publication_year_to,
            )
        )


@dataclass
class QuestionResult:
    question: EvalQuestion
    retrieved: list[RetrievedChunk]
    insufficient_evidence: bool
    latency_seconds: float


@dataclass
class MetricsReport:
    generated_at: str
    questions_path: str
    question_count: int
    recall_at: dict[int, float]
    mean_reciprocal_rank: float
    source_diversity: float
    duplicate_chunk_rate: float
    document_dominance_rate: float
    avg_score_relevant: float | None
    avg_score_off_topic: float | None
    false_positive_rate_off_topic: float | None
    insufficient_evidence_accuracy: float
    filter_accuracy: float | None
    avg_latency_seconds: float
    failures: list[dict[str, object]] = field(default_factory=list)

    def to_dict(self) -> dict[str, object]:
        return {
            "generated_at": self.generated_at,
            "questions_path": self.questions_path,
            "question_count": self.question_count,
            "recall_at": {f"recall@{k}": v for k, v in self.recall_at.items()},
            "mean_reciprocal_rank": self.mean_reciprocal_rank,
            "source_diversity": self.source_diversity,
            "duplicate_chunk_rate": self.duplicate_chunk_rate,
            "document_dominance_rate": self.document_dominance_rate,
            "avg_score_relevant": self.avg_score_relevant,
            "avg_score_off_topic": self.avg_score_off_topic,
            "false_positive_rate_off_topic": self.false_positive_rate_off_topic,
            "insufficient_evidence_accuracy": self.insufficient_evidence_accuracy,
            "filter_accuracy": self.filter_accuracy,
            "avg_latency_seconds": self.avg_latency_seconds,
            "failures": self.failures,
        }

    def to_markdown(self) -> str:
        lines = [
            f"# Retrieval evaluation — {self.generated_at}",
            "",
            f"- Questions file: `{self.questions_path}`",
            f"- Question count: {self.question_count}",
            "",
            "## Metrics",
            "",
            "| Metric | Value |",
            "| --- | --- |",
        ]
        for k, value in self.recall_at.items():
            lines.append(f"| Recall@{k} | {value:.2%} |")
        lines.append(f"| Mean Reciprocal Rank | {self.mean_reciprocal_rank:.3f} |")
        lines.append(
            f"| Source diversity (avg distinct docs/query) | {self.source_diversity:.2f} |"
        )
        lines.append(f"| Duplicate-chunk rate | {self.duplicate_chunk_rate:.2%} |")
        lines.append(f"| Document-dominance rate | {self.document_dominance_rate:.2%} |")

        def _fmt_pct(value: float | None) -> str:
            return "n/a" if value is None else f"{value:.2%}"

        def _fmt_score(value: float | None) -> str:
            return "n/a" if value is None else f"{value:.3f}"

        lines.append(f"| Avg score (relevant results) | {_fmt_score(self.avg_score_relevant)} |")
        lines.append(f"| Avg score (off-topic results) | {_fmt_score(self.avg_score_off_topic)} |")
        lines.append(
            f"| False positive rate (off-topic) | {_fmt_pct(self.false_positive_rate_off_topic)} |"
        )
        lines.append(
            f"| Insufficient-evidence accuracy | {self.insufficient_evidence_accuracy:.2%} |"
        )
        lines.append(f"| Filter accuracy | {_fmt_pct(self.filter_accuracy)} |")
        lines.append(f"| Avg retrieval latency | {self.avg_latency_seconds * 1000:.1f} ms |")

        if self.failures:
            lines += ["", "## Failures by question ID", ""]
            for failure in self.failures:
                lines.append(f"- **{failure['question_id']}**: {failure['reason']}")

        return "\n".join(lines) + "\n"


def _chunk_matches_filename(chunk: RetrievedChunk, filenames: list[str]) -> bool:
    return chunk.source_filename in filenames


def _duplicate_chunk_count(chunks: list[RetrievedChunk], threshold: float) -> int:
    normalized = [" ".join(c.text.split()).lower() for c in chunks]
    duplicate_count = 0
    for i in range(1, len(normalized)):
        for j in range(i):
            if SequenceMatcher(None, normalized[i], normalized[j]).ratio() >= threshold:
                duplicate_count += 1
                break
    return duplicate_count


def _filter_matches(chunk: RetrievedChunk, question: EvalQuestion) -> bool:
    filters = question.filters
    if filters.document_type is not None and chunk.document_type != filters.document_type:
        return False
    if filters.journal_quartile is not None and chunk.journal_quartile != filters.journal_quartile:
        return False
    year_from = filters.publication_year_from
    year_to = filters.publication_year_to
    chunk_year = chunk.publication_year
    if year_from is not None and (chunk_year is None or chunk_year < year_from):
        return False
    return not (year_to is not None and (chunk_year is None or chunk_year > year_to))


def run_evaluation(
    questions: list[EvalQuestion], *, user_id: str, top_k: int = 8
) -> list[QuestionResult]:
    retriever = get_retriever()
    settings = get_settings()
    results: list[QuestionResult] = []

    for question in questions:
        start = time.monotonic()
        retrieved = retriever.retrieve(
            question.question, user_id=user_id, top_k=top_k, filters=question.filters
        )
        latency = time.monotonic() - start

        prepared = prepare_context(
            retrieved,
            max_per_document=settings.context_max_chunks_per_document,
            max_total_chars=settings.context_max_total_chars,
            similarity_threshold=settings.context_dedup_similarity_threshold,
        )
        insufficient_evidence = len(prepared) == 0

        results.append(
            QuestionResult(
                question=question,
                retrieved=retrieved,
                insufficient_evidence=insufficient_evidence,
                latency_seconds=latency,
            )
        )

    return results


def compute_metrics(
    results: list[QuestionResult], *, questions_path: str, dedup_threshold: float
) -> MetricsReport:
    recall_hits: dict[int, int] = dict.fromkeys(RECALL_CUTOFFS, 0)
    reciprocal_ranks: list[float] = []
    recall_eligible = [r for r in results if r.question.has_expected_relevant]

    for result in recall_eligible:
        rank = None
        for index, chunk in enumerate(result.retrieved, start=1):
            if _chunk_matches_filename(chunk, result.question.expected_relevant_filenames):
                rank = index
                break
        reciprocal_ranks.append(1.0 / rank if rank else 0.0)
        for k in RECALL_CUTOFFS:
            if rank is not None and rank <= k:
                recall_hits[k] += 1

    num_eligible = len(recall_eligible)
    recall_at = {
        k: (recall_hits[k] / num_eligible if num_eligible else 0.0) for k in RECALL_CUTOFFS
    }
    mrr = sum(reciprocal_ranks) / len(reciprocal_ranks) if reciprocal_ranks else 0.0

    diversity_values: list[float] = []
    duplicate_total = 0
    chunk_total = 0
    dominance_values: list[float] = []
    for result in results:
        if not result.retrieved:
            continue
        doc_ids = [c.document_id for c in result.retrieved]
        diversity_values.append(len(set(doc_ids)))
        duplicate_total += _duplicate_chunk_count(result.retrieved, dedup_threshold)
        chunk_total += len(result.retrieved)
        dominant_count = max(doc_ids.count(doc_id) for doc_id in set(doc_ids))
        dominance_values.append(dominant_count / len(doc_ids))

    source_diversity = sum(diversity_values) / len(diversity_values) if diversity_values else 0.0
    duplicate_chunk_rate = duplicate_total / chunk_total if chunk_total else 0.0
    document_dominance_rate = (
        sum(dominance_values) / len(dominance_values) if dominance_values else 0.0
    )

    relevant_scores: list[float] = []
    for result in recall_eligible:
        relevant_scores.extend(
            c.score
            for c in result.retrieved
            if _chunk_matches_filename(c, result.question.expected_relevant_filenames)
        )
    avg_score_relevant = sum(relevant_scores) / len(relevant_scores) if relevant_scores else None

    off_topic_results = [r for r in results if r.question.category == "off_topic"]
    off_topic_scores = [c.score for r in off_topic_results for c in r.retrieved]
    avg_score_off_topic = (
        sum(off_topic_scores) / len(off_topic_scores) if off_topic_scores else None
    )
    false_positive_rate_off_topic = (
        sum(1 for r in off_topic_results if not r.insufficient_evidence) / len(off_topic_results)
        if off_topic_results
        else None
    )

    insufficient_evidence_correct = sum(
        1 for r in results if r.insufficient_evidence == r.question.expect_insufficient_evidence
    )
    insufficient_evidence_accuracy = (
        insufficient_evidence_correct / len(results) if results else 0.0
    )

    filtered_results = [r for r in results if r.question.has_filter]
    if filtered_results:
        matching = sum(
            1 for r in filtered_results if all(_filter_matches(c, r.question) for c in r.retrieved)
        )
        filter_accuracy = matching / len(filtered_results)
    else:
        filter_accuracy = None

    avg_latency = sum(r.latency_seconds for r in results) / len(results) if results else 0.0

    failures: list[dict[str, object]] = []
    for result in results:
        expected_ie = result.question.expect_insufficient_evidence
        if result.insufficient_evidence != expected_ie:
            failures.append(
                {
                    "question_id": result.question.question_id,
                    "reason": (
                        f"expected insufficient_evidence={expected_ie}, "
                        f"got {result.insufficient_evidence}"
                    ),
                }
            )
        elif result.question.has_expected_relevant:
            found = any(
                _chunk_matches_filename(c, result.question.expected_relevant_filenames)
                for c in result.retrieved
            )
            if not found:
                failures.append(
                    {
                        "question_id": result.question.question_id,
                        "reason": (
                            f"none of {result.question.expected_relevant_filenames} were retrieved"
                        ),
                    }
                )

    return MetricsReport(
        generated_at=utcnow().isoformat(),
        questions_path=questions_path,
        question_count=len(results),
        recall_at=recall_at,
        mean_reciprocal_rank=mrr,
        source_diversity=source_diversity,
        duplicate_chunk_rate=duplicate_chunk_rate,
        document_dominance_rate=document_dominance_rate,
        avg_score_relevant=avg_score_relevant,
        avg_score_off_topic=avg_score_off_topic,
        false_positive_rate_off_topic=false_positive_rate_off_topic,
        insufficient_evidence_accuracy=insufficient_evidence_accuracy,
        filter_accuracy=filter_accuracy,
        avg_latency_seconds=avg_latency,
        failures=failures,
    )


def write_reports(report: MetricsReport, reports_dir: Path) -> tuple[Path, Path]:
    reports_dir.mkdir(parents=True, exist_ok=True)
    timestamp = utcnow().strftime("%Y%m%dT%H%M%SZ")
    json_path = reports_dir / f"retrieval-eval-{timestamp}.json"
    md_path = reports_dir / f"retrieval-eval-{timestamp}.md"
    json_path.write_text(json.dumps(report.to_dict(), indent=2), encoding="utf-8")
    md_path.write_text(report.to_markdown(), encoding="utf-8")
    return json_path, md_path


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Evaluate retrieval quality against a question set."
    )
    parser.add_argument("--questions", required=True, help="Path to a question-set JSON file.")
    parser.add_argument(
        "--user-id", required=True, help="Owner whose indexed corpus this evaluation runs against."
    )
    parser.add_argument("--top-k", type=int, default=8)
    parser.add_argument("--reports-dir", default="evaluation/reports")
    args = parser.parse_args(argv)

    questions_path = Path(args.questions)
    raw_questions = json.loads(questions_path.read_text(encoding="utf-8"))
    if not raw_questions:
        print(
            f"'{questions_path}' has no questions yet. Nothing to evaluate. "
            "See evaluation/README.md for the schema.",
            file=sys.stderr,
        )
        return 1

    questions = [EvalQuestion.from_dict(q) for q in raw_questions]
    settings = get_settings()  # fail fast on misconfiguration

    results = run_evaluation(questions, user_id=args.user_id, top_k=args.top_k)
    report = compute_metrics(
        results,
        questions_path=str(questions_path),
        dedup_threshold=settings.context_dedup_similarity_threshold,
    )

    json_path, md_path = write_reports(report, Path(args.reports_dir))
    print(f"Reports written: {json_path}, {md_path}")
    print(f"\n{report.to_markdown()}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
