#!/usr/bin/env python
"""Grounded-answer evaluation harness (milestone 8 §10).

Runs a question set through the real RagService.run() pipeline — the exact
code the /chat route uses, non-streaming — and reports deterministic
metrics only. Semantic judgments (is the answer actually correct, complete,
clear; does it contain an unsupported claim) cannot be reliably automated
without another model acting as judge, and this project does not use the
same local generation model to grade its own answers. Those judgments are
left to evaluation/human-review-template.csv, populated with real answers
from this script's --emit-review-csv output.

Usage:
    python scripts/eval_answers.py --questions evaluation/fixtures-questions.json
    python scripts/eval_answers.py --questions evaluation/real-corpus-questions.json \\
        --emit-review-csv evaluation/reports/answer-review-<timestamp>.csv

Known limitation: generation token counts are not reported. Getting them
from Ollama requires a second, non-streaming call per question (the
streaming LLMProvider interface used by /chat and this script's RagService
does not surface eval_count), which would double generation cost purely
for a nice-to-have metric — not done here. Reported as "not available",
not silently omitted.
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path

from app.config import get_settings
from app.core.citation_validation import validate_citations
from app.core.rag_service import ChatPipelineResult
from app.deps import get_rag_service
from cli.reporting import utcnow
from scripts.eval_retrieval import EvalQuestion


@dataclass
class QuestionAnswerMetrics:
    question_id: str
    category: str
    insufficient_evidence: bool
    expected_insufficient_evidence: bool
    insufficient_evidence_correct: bool
    citation_count: int
    cited_count: int
    citation_coverage: float | None
    unknown_citation_count: int
    malformed_citation_count: int
    cited_source_relevance: float | None
    source_diversity: int
    answer_length_words: int
    latency_ms: float
    answer_preview: str


@dataclass
class AnswerEvalReport:
    generated_at: str
    questions_path: str
    question_count: int
    insufficient_evidence_accuracy: float
    avg_citation_coverage: float | None
    total_unknown_citations: int
    total_malformed_citations: int
    avg_cited_source_relevance: float | None
    avg_source_diversity: float
    avg_answer_length_words: float
    avg_latency_ms: float
    generation_token_count: str
    per_question: list[QuestionAnswerMetrics] = field(default_factory=list)

    def to_dict(self) -> dict[str, object]:
        data = asdict(self)
        return data

    def to_markdown(self) -> str:
        def fmt(value: float | None) -> str:
            return "n/a" if value is None else f"{value:.3f}"

        lines = [
            f"# Answer evaluation — {self.generated_at}",
            "",
            f"- Questions file: `{self.questions_path}`",
            f"- Question count: {self.question_count}",
            "",
            "## Deterministic metrics",
            "",
            "| Metric | Value |",
            "| --- | --- |",
            f"| Insufficient-evidence accuracy | {self.insufficient_evidence_accuracy:.2%} |",
            f"| Avg citation coverage | {fmt(self.avg_citation_coverage)} |",
            f"| Total unknown citations | {self.total_unknown_citations} |",
            f"| Total malformed citations | {self.total_malformed_citations} |",
            (
                "| Avg cited-source relevance (score proxy) | "
                f"{fmt(self.avg_cited_source_relevance)} |"
            ),
            f"| Avg source diversity | {self.avg_source_diversity:.2f} |",
            f"| Avg answer length (words, concision proxy) | {self.avg_answer_length_words:.1f} |",
            f"| Avg latency | {self.avg_latency_ms:.1f} ms |",
            f"| Generation token count | {self.generation_token_count} |",
            "",
            "## Not automated — requires human review",
            "",
            "- Unsupported-claim rate",
            "- Answer completeness",
            "- Answer clarity/concision (beyond the word-count proxy above)",
            "- Answer correctness",
            "",
            "See `evaluation/human-review-template.csv`. Use `--emit-review-csv` to generate a "
            "starter CSV pre-filled with question IDs and real answer previews.",
            "",
            "## Per-question",
            "",
            "| ID | Category | IE correct | Coverage | Unknown | Malformed | Diversity | Latency |",
            "| --- | --- | --- | --- | --- | --- | --- | --- |",
        ]
        for q in self.per_question:
            ie_ok = "yes" if q.insufficient_evidence_correct else "NO"
            lines.append(
                f"| {q.question_id} | {q.category} | {ie_ok} | {fmt(q.citation_coverage)} | "
                f"{q.unknown_citation_count} | {q.malformed_citation_count} | "
                f"{q.source_diversity} | {q.latency_ms:.1f} ms |"
            )

        return "\n".join(lines) + "\n"


def evaluate_answer(question: EvalQuestion, result: ChatPipelineResult) -> QuestionAnswerMetrics:
    validation = validate_citations(result.answer, result.citations)
    cited_ids = set(validation.cited_source_ids)
    offered_ids = {c.source_id for c in result.citations}
    valid_cited_ids = cited_ids & offered_ids

    citation_coverage = len(valid_cited_ids) / len(offered_ids) if offered_ids else None
    cited_scores = [c.score for c in result.citations if c.source_id in valid_cited_ids]
    cited_source_relevance = sum(cited_scores) / len(cited_scores) if cited_scores else None
    source_diversity = len({c.document_id for c in result.citations})

    return QuestionAnswerMetrics(
        question_id=question.question_id,
        category=question.category,
        insufficient_evidence=result.insufficient_evidence,
        expected_insufficient_evidence=question.expect_insufficient_evidence,
        insufficient_evidence_correct=(
            result.insufficient_evidence == question.expect_insufficient_evidence
        ),
        citation_count=len(offered_ids),
        cited_count=len(valid_cited_ids),
        citation_coverage=citation_coverage,
        unknown_citation_count=len(validation.unknown_source_ids),
        malformed_citation_count=len(validation.malformed_tokens),
        cited_source_relevance=cited_source_relevance,
        source_diversity=source_diversity,
        answer_length_words=len(result.answer.split()),
        latency_ms=result.latency_ms,
        answer_preview=result.answer[:200],
    )


def run_evaluation(
    questions: list[EvalQuestion], *, user_id: str, top_k: int
) -> list[QuestionAnswerMetrics]:
    rag_service = get_rag_service()
    metrics: list[QuestionAnswerMetrics] = []
    for question in questions:
        result = rag_service.run(
            question.question, user_id=user_id, top_k=top_k, filters=question.filters
        )
        metrics.append(evaluate_answer(question, result))
    return metrics


def build_report(metrics: list[QuestionAnswerMetrics], *, questions_path: str) -> AnswerEvalReport:
    ie_correct = sum(1 for m in metrics if m.insufficient_evidence_correct)
    ie_accuracy = ie_correct / len(metrics) if metrics else 0.0

    coverages = [m.citation_coverage for m in metrics if m.citation_coverage is not None]
    avg_coverage = sum(coverages) / len(coverages) if coverages else None

    relevances = [m.cited_source_relevance for m in metrics if m.cited_source_relevance is not None]
    avg_relevance = sum(relevances) / len(relevances) if relevances else None

    diversities = [m.source_diversity for m in metrics]
    avg_diversity = sum(diversities) / len(diversities) if diversities else 0.0

    lengths = [m.answer_length_words for m in metrics]
    avg_length = sum(lengths) / len(lengths) if lengths else 0.0

    latencies = [m.latency_ms for m in metrics]
    avg_latency = sum(latencies) / len(latencies) if latencies else 0.0

    return AnswerEvalReport(
        generated_at=utcnow().isoformat(),
        questions_path=questions_path,
        question_count=len(metrics),
        insufficient_evidence_accuracy=ie_accuracy,
        avg_citation_coverage=avg_coverage,
        total_unknown_citations=sum(m.unknown_citation_count for m in metrics),
        total_malformed_citations=sum(m.malformed_citation_count for m in metrics),
        avg_cited_source_relevance=avg_relevance,
        avg_source_diversity=avg_diversity,
        avg_answer_length_words=avg_length,
        avg_latency_ms=avg_latency,
        generation_token_count=(
            "not available (would require a second non-streaming Ollama call per "
            "question; see module docstring)"
        ),
        per_question=metrics,
    )


def write_reports(report: AnswerEvalReport, reports_dir: Path) -> tuple[Path, Path]:
    reports_dir.mkdir(parents=True, exist_ok=True)
    timestamp = utcnow().strftime("%Y%m%dT%H%M%SZ")
    json_path = reports_dir / f"answer-eval-{timestamp}.json"
    md_path = reports_dir / f"answer-eval-{timestamp}.md"
    json_path.write_text(json.dumps(report.to_dict(), indent=2), encoding="utf-8")
    md_path.write_text(report.to_markdown(), encoding="utf-8")
    return json_path, md_path


def write_review_csv(metrics: list[QuestionAnswerMetrics], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as csv_file:
        writer = csv.writer(csv_file)
        writer.writerow(
            [
                "question_id",
                "answer_preview",
                "answer_correct",
                "answer_supported",
                "citations_correct",
                "answer_complete",
                "answer_clear",
                "unsupported_claims",
                "reviewer_notes",
            ]
        )
        for m in metrics:
            writer.writerow([m.question_id, m.answer_preview, "", "", "", "", "", "", ""])


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Evaluate grounded-answer quality.")
    parser.add_argument("--questions", required=True)
    parser.add_argument(
        "--user-id", required=True, help="Owner whose indexed corpus this evaluation runs against."
    )
    parser.add_argument("--top-k", type=int, default=8)
    parser.add_argument("--reports-dir", default="evaluation/reports")
    parser.add_argument(
        "--emit-review-csv", help="Also write a human-review starter CSV to this path."
    )
    args = parser.parse_args(argv)

    questions_path = Path(args.questions)
    raw_questions = json.loads(questions_path.read_text(encoding="utf-8"))
    if not raw_questions:
        print(f"'{questions_path}' has no questions yet. Nothing to evaluate.", file=sys.stderr)
        return 1

    questions = [EvalQuestion.from_dict(q) for q in raw_questions]
    get_settings()

    if len(questions) < 20:
        print(
            f"Warning: only {len(questions)} question(s) — milestone 8 asks for at least 20 for "
            "a representative answer-quality evaluation. Proceeding anyway; treat results as "
            "indicative only.",
            file=sys.stderr,
        )

    metrics = run_evaluation(questions, user_id=args.user_id, top_k=args.top_k)
    report = build_report(metrics, questions_path=str(questions_path))

    json_path, md_path = write_reports(report, Path(args.reports_dir))
    print(f"Reports written: {json_path}, {md_path}")

    if args.emit_review_csv:
        review_path = Path(args.emit_review_csv)
        write_review_csv(metrics, review_path)
        print(f"Human-review starter CSV written: {review_path}")

    print(f"\n{report.to_markdown()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
