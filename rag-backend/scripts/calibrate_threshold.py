#!/usr/bin/env python
"""Relevance-threshold calibration (milestone 8 §8).

Milestone 6/7 documented that the backend has no relevance threshold.
This script determines, from a real evaluation question set run against a
real indexed corpus, whether a RETRIEVAL_MIN_SCORE value can reliably tell
relevant results apart from off-topic/no-match ones — it does not assume
one exists, and it never writes anything to .env itself.

Method:
1. Score distributions come from two disjoint populations, not from
   expect_insufficient_evidence: "positive" is chunks matching a
   non-off-topic question's expected_relevant_filenames; "negative" is
   every chunk retrieved for a category="off_topic" question. (Questions
   whose expect_insufficient_evidence is true are typically a filter
   matching zero documents — they retrieve nothing, so they can never
   contribute a score to either distribution; that flag is only used
   below, for the TP/FP/TN/FN classification.)
2. For each candidate threshold, the retriever is re-queried per question
   with that min_score applied (exercising the exact same code path
   Retriever.retrieve()'s min_score parameter uses in production), then
   passed through the real prepare_context() to get a real
   insufficient_evidence value.
3. TP/FP/TN/FN, precision/recall/F1, and insufficient-evidence accuracy are
   reported per candidate. TP = truly-has-evidence AND predicted
   has-evidence; FP = truly off-topic/no-match AND predicted has-evidence
   (threshold too permissive); FN = truly-has-evidence AND predicted
   insufficient (threshold too aggressive, breaking a real question); TN =
   truly off-topic AND predicted insufficient (threshold worked).

Usage:
    python scripts/calibrate_threshold.py --questions evaluation/fixtures-questions.json

This never enables RETRIEVAL_MIN_SCORE itself — it only reports whether the
evidence supports doing so, per milestone 8 §8 ("keep it disabled by
default until validated").
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path

from app.config import get_settings
from app.core.context_preparation import prepare_context
from app.core.retrieval_schemas import RetrievedChunk
from app.deps import get_retriever
from cli.reporting import utcnow
from scripts.eval_retrieval import EvalQuestion, _chunk_matches_filename

DEFAULT_CANDIDATE_THRESHOLDS = [round(0.05 * i, 2) for i in range(1, 20)]  # 0.05 .. 0.95


@dataclass
class ScoreDistribution:
    count: int
    min: float | None
    max: float | None
    mean: float | None
    median: float | None

    @classmethod
    def from_scores(cls, scores: list[float]) -> ScoreDistribution:
        if not scores:
            return cls(count=0, min=None, max=None, mean=None, median=None)
        return cls(
            count=len(scores),
            min=min(scores),
            max=max(scores),
            mean=statistics.mean(scores),
            median=statistics.median(scores),
        )


@dataclass
class ThresholdCandidateResult:
    threshold: float
    true_positive: int
    false_positive: int
    true_negative: int
    false_negative: int

    @property
    def precision(self) -> float | None:
        denom = self.true_positive + self.false_positive
        return self.true_positive / denom if denom else None

    @property
    def recall(self) -> float | None:
        denom = self.true_positive + self.false_negative
        return self.true_positive / denom if denom else None

    @property
    def f1(self) -> float | None:
        precision, recall = self.precision, self.recall
        if not precision or not recall or (precision + recall) == 0:
            return None
        return 2 * precision * recall / (precision + recall)

    @property
    def insufficient_evidence_accuracy(self) -> float:
        total = self.true_positive + self.false_positive + self.true_negative + self.false_negative
        correct = self.true_positive + self.true_negative
        return correct / total if total else 0.0


@dataclass
class CalibrationReport:
    generated_at: str
    questions_path: str
    question_count: int
    positive_distribution: ScoreDistribution
    negative_distribution: ScoreDistribution
    separation_gap: float | None
    candidates: list[ThresholdCandidateResult]
    recommendation: str
    recommended_threshold: float | None = field(default=None)

    def to_dict(self) -> dict[str, object]:
        return {
            "generated_at": self.generated_at,
            "questions_path": self.questions_path,
            "question_count": self.question_count,
            "positive_distribution": asdict(self.positive_distribution),
            "negative_distribution": asdict(self.negative_distribution),
            "separation_gap": self.separation_gap,
            "candidates": [
                {
                    "threshold": c.threshold,
                    "true_positive": c.true_positive,
                    "false_positive": c.false_positive,
                    "true_negative": c.true_negative,
                    "false_negative": c.false_negative,
                    "precision": c.precision,
                    "recall": c.recall,
                    "f1": c.f1,
                    "insufficient_evidence_accuracy": c.insufficient_evidence_accuracy,
                }
                for c in self.candidates
            ],
            "recommendation": self.recommendation,
            "recommended_threshold": self.recommended_threshold,
        }

    def to_markdown(self) -> str:
        lines = [
            f"# Threshold calibration — {self.generated_at}",
            "",
            f"- Questions file: `{self.questions_path}`",
            f"- Question count: {self.question_count}",
            "",
            "## Score distributions",
            "",
            "| Group | N | Min | Max | Mean | Median |",
            "| --- | --- | --- | --- | --- | --- |",
        ]

        def fmt(value: float | None) -> str:
            return "n/a" if value is None else f"{value:.3f}"

        pos, neg = self.positive_distribution, self.negative_distribution
        lines.append(
            f"| Positive (expect evidence) | {pos.count} | {fmt(pos.min)} | {fmt(pos.max)} | "
            f"{fmt(pos.mean)} | {fmt(pos.median)} |"
        )
        lines.append(
            f"| Negative (expect insufficient) | {neg.count} | {fmt(neg.min)} | {fmt(neg.max)} | "
            f"{fmt(neg.mean)} | {fmt(neg.median)} |"
        )
        gap_text = "n/a" if self.separation_gap is None else f"{self.separation_gap:.3f}"
        lines.append(f"\n**Separation gap (min positive minus max negative):** {gap_text}")
        lines.append(
            "(Positive if clean separation is possible; negative or near-zero means "
            "positive and negative scores overlap and no threshold cleanly separates them.)"
        )

        lines += [
            "",
            "## Candidate thresholds",
            "",
            "| Threshold | TP | FP | TN | FN | Precision | Recall | F1 | IE accuracy |",
            "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
        ]
        for c in self.candidates:
            lines.append(
                f"| {c.threshold} | {c.true_positive} | {c.false_positive} | {c.true_negative} | "
                f"{c.false_negative} | {fmt(c.precision)} | {fmt(c.recall)} | {fmt(c.f1)} | "
                f"{c.insufficient_evidence_accuracy:.2%} |"
            )

        lines += ["", "## Recommendation", "", self.recommendation]
        if self.recommended_threshold is not None:
            lines.append(f"\nCandidate threshold: **{self.recommended_threshold}**")

        return "\n".join(lines) + "\n"


def _is_relevant_chunk(chunk: RetrievedChunk, question: EvalQuestion) -> bool:
    return _chunk_matches_filename(chunk, question.expected_relevant_filenames)


def collect_score_distributions(
    questions: list[EvalQuestion], *, user_id: str, top_k: int
) -> tuple[ScoreDistribution, ScoreDistribution]:
    retriever = get_retriever()
    positive_scores: list[float] = []
    negative_scores: list[float] = []

    for question in questions:
        chunks = retriever.retrieve(
            question.question,
            user_id=user_id,
            top_k=top_k,
            filters=question.filters,
            min_score=None,
        )
        # Deliberately NOT keyed on expect_insufficient_evidence: today that
        # flag is only true when a filter matches zero documents, which by
        # construction retrieves zero chunks — it can never contribute a
        # score to either distribution. The genuinely useful "negative"
        # examples are off-topic questions that still retrieve chunks (no
        # threshold exists yet), same population eval_retrieval.py's
        # avg_score_off_topic metric uses.
        if question.category == "off_topic":
            negative_scores.extend(c.score for c in chunks)
        elif question.has_expected_relevant:
            positive_scores.extend(
                chunk.score for chunk in chunks if _is_relevant_chunk(chunk, question)
            )

    return ScoreDistribution.from_scores(positive_scores), ScoreDistribution.from_scores(
        negative_scores
    )


def evaluate_candidate(
    questions: list[EvalQuestion], threshold: float, *, user_id: str, top_k: int
) -> ThresholdCandidateResult:
    retriever = get_retriever()
    settings = get_settings()
    tp = fp = tn = fn = 0

    for question in questions:
        chunks = retriever.retrieve(
            question.question,
            user_id=user_id,
            top_k=top_k,
            filters=question.filters,
            min_score=threshold,
        )
        prepared = prepare_context(
            chunks,
            max_per_document=settings.context_max_chunks_per_document,
            max_total_chars=settings.context_max_total_chars,
            similarity_threshold=settings.context_dedup_similarity_threshold,
        )
        predicted_has_evidence = len(prepared) > 0
        truly_has_evidence = not question.expect_insufficient_evidence

        if truly_has_evidence and predicted_has_evidence:
            tp += 1
        elif not truly_has_evidence and predicted_has_evidence:
            fp += 1
        elif not truly_has_evidence and not predicted_has_evidence:
            tn += 1
        else:
            fn += 1

    return ThresholdCandidateResult(
        threshold=threshold,
        true_positive=tp,
        false_positive=fp,
        true_negative=tn,
        false_negative=fn,
    )


def build_recommendation(
    candidates: list[ThresholdCandidateResult], separation_gap: float | None, question_count: int
) -> tuple[str, float | None]:
    if question_count < 20:
        return (
            f"Only {question_count} question(s) evaluated — well below a trustworthy sample size "
            "for a calibration decision. Do not enable RETRIEVAL_MIN_SCORE from this run alone.",
            None,
        )

    if separation_gap is None or separation_gap <= 0:
        return (
            "Positive and negative score distributions overlap (no clean separation gap). "
            "No single threshold can distinguish relevant from off-topic/no-match queries "
            "without trading off real recall loss. Do not enable RETRIEVAL_MIN_SCORE.",
            None,
        )

    perfect = [c for c in candidates if c.false_positive == 0 and c.false_negative == 0]
    if perfect:
        mid = perfect[len(perfect) // 2]
        return (
            f"{len(perfect)} candidate threshold(s) achieved zero false positives and zero false "
            "negatives on this question set, consistent with the observed separation gap. This is "
            "a real, evidence-based finding for THIS corpus/question-set/embedding-model "
            "combination only — re-validate after any corpus or embedding-model change.",
            mid.threshold,
        )

    best = max(candidates, key=lambda c: c.f1 or 0.0)
    if (best.f1 or 0.0) >= 0.9:
        return (
            f"No candidate achieved perfect separation, but threshold {best.threshold} reached "
            f"F1={best.f1:.3f}. Consider enabling with caution and monitoring false negatives "
            "(real questions wrongly reported as insufficient evidence).",
            best.threshold,
        )

    return (
        f"Best candidate (threshold={best.threshold}) only reached F1="
        f"{best.f1 if best.f1 is not None else 0.0:.3f}. Not reliable enough to recommend "
        "enabling RETRIEVAL_MIN_SCORE.",
        None,
    )


def write_reports(report: CalibrationReport, reports_dir: Path) -> tuple[Path, Path]:
    reports_dir.mkdir(parents=True, exist_ok=True)
    timestamp = utcnow().strftime("%Y%m%dT%H%M%SZ")
    json_path = reports_dir / f"threshold-calibration-{timestamp}.json"
    md_path = reports_dir / f"threshold-calibration-{timestamp}.md"
    json_path.write_text(json.dumps(report.to_dict(), indent=2), encoding="utf-8")
    md_path.write_text(report.to_markdown(), encoding="utf-8")
    return json_path, md_path


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Calibrate a relevance threshold from real data.")
    parser.add_argument("--questions", required=True)
    parser.add_argument(
        "--user-id", required=True, help="Owner whose indexed corpus this calibration runs against."
    )
    parser.add_argument("--top-k", type=int, default=8)
    parser.add_argument("--reports-dir", default="evaluation/reports")
    parser.add_argument(
        "--thresholds",
        type=float,
        nargs="+",
        default=DEFAULT_CANDIDATE_THRESHOLDS,
        help="Candidate thresholds to evaluate (default: 0.05 .. 0.95 step 0.05).",
    )
    args = parser.parse_args(argv)

    questions_path = Path(args.questions)
    raw_questions = json.loads(questions_path.read_text(encoding="utf-8"))
    if not raw_questions:
        print(f"'{questions_path}' has no questions yet. Nothing to calibrate.", file=sys.stderr)
        return 1

    questions = [EvalQuestion.from_dict(q) for q in raw_questions]
    get_settings()

    positive_dist, negative_dist = collect_score_distributions(
        questions, user_id=args.user_id, top_k=args.top_k
    )
    separation_gap = (
        positive_dist.min - negative_dist.max
        if positive_dist.min is not None and negative_dist.max is not None
        else None
    )

    candidates = [
        evaluate_candidate(questions, t, user_id=args.user_id, top_k=args.top_k)
        for t in sorted(args.thresholds)
    ]
    recommendation, recommended_threshold = build_recommendation(
        candidates, separation_gap, len(questions)
    )

    report = CalibrationReport(
        generated_at=utcnow().isoformat(),
        questions_path=str(questions_path),
        question_count=len(questions),
        positive_distribution=positive_dist,
        negative_distribution=negative_dist,
        separation_gap=separation_gap,
        candidates=candidates,
        recommendation=recommendation,
        recommended_threshold=recommended_threshold,
    )

    json_path, md_path = write_reports(report, Path(args.reports_dir))
    print(f"Reports written: {json_path}, {md_path}")
    print(f"\n{report.to_markdown()}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
