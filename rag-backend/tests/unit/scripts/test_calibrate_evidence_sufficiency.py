"""Covers Milestone 5.6 (evidence-sufficiency calibration):
scripts/calibrate_evidence_sufficiency.py's pure metric functions
(threshold sweep / confusion matrix, deterministic split, alternative
signals) plus a full-harness run (forced synthetic embeddings — no
external dependency) proving deterministic ordering, machine-readable
JSON output, and general/Zoom-In calibration are never pooled.
"""

import json

import pytest

from scripts.calibrate_evidence_sufficiency import (
    CALIBRATION_SPLIT_SEED,
    ScoredCase,
    best_by_f1,
    deterministic_split,
    evaluate_alternative_signals,
    run,
    score_distribution_dict,
    summarize_signal,
    sweep_thresholds,
)
from scripts.eval_retrieval_controlled import RawCandidate


def _candidate(document_id: str, score: float, chunk_index: int = 0) -> RawCandidate:
    return RawCandidate(
        document_id=document_id, chunk_index=chunk_index,
        key=f"{document_id}::chunk{chunk_index}", score=score, text="text",
    )


def _scored(
    case_id: str, is_positive: bool, scores: list[float], mode: str = "general"
) -> ScoredCase:
    return ScoredCase(
        case_id=case_id, category="exact_terminology", mode=mode, is_positive=is_positive,
        candidates=[_candidate(f"d{i}", s) for i, s in enumerate(scores)],
    )


class TestScoredCaseProperties:
    def test_top_and_second_score(self) -> None:
        case = _scored("A", True, [0.9, 0.7, 0.5])
        assert case.top_score == 0.9
        assert case.second_score == 0.7
        assert case.margin == pytest.approx(0.2)

    def test_second_score_none_with_one_candidate(self) -> None:
        case = _scored("A", True, [0.9])
        assert case.second_score is None
        assert case.margin is None

    def test_empty_candidates(self) -> None:
        case = _scored("A", True, [])
        assert case.top_score is None
        assert case.mean_top3 is None
        assert case.doc_diversity_top3 is None

    def test_mean_top3(self) -> None:
        case = _scored("A", True, [0.9, 0.6, 0.3, 0.1])
        assert case.mean_top3 == pytest.approx((0.9 + 0.6 + 0.3) / 3)

    def test_doc_diversity_top3_all_distinct(self) -> None:
        case = _scored("A", True, [0.9, 0.6, 0.3])
        assert case.doc_diversity_top3 == 3
        assert case.same_doc_multi_chunk_top3 is False

    def test_doc_diversity_top3_same_document(self) -> None:
        case = ScoredCase(
            case_id="A", category="x", mode="general", is_positive=True,
            candidates=[
                _candidate("same-doc", 0.9, chunk_index=0),
                _candidate("same-doc", 0.8, chunk_index=1),
                _candidate("other-doc", 0.3, chunk_index=0),
            ],
        )
        assert case.doc_diversity_top3 == 2
        assert case.same_doc_multi_chunk_top3 is True

    def test_count_above(self) -> None:
        case = _scored("A", True, [0.9, 0.7, 0.5, 0.3])
        assert case.count_above(0.6) == 2
        assert case.count_above(0.0) == 4
        assert case.count_above(0.95) == 0


class TestScoreDistributionDict:
    def test_empty(self) -> None:
        assert score_distribution_dict([]) == {
            "count": 0, "min": None, "max": None, "mean": None, "median": None,
        }

    def test_non_empty(self) -> None:
        result = score_distribution_dict([0.2, 0.5, 0.8])
        assert result["count"] == 3
        assert result["min"] == 0.2
        assert result["max"] == 0.8
        assert result["mean"] == pytest.approx(0.5)


class TestSweepThresholds:
    def test_confusion_matrix_at_a_single_threshold(self) -> None:
        cases = [
            _scored("P1", True, [0.9]),  # positive, high score -> TP at t=0.8
            _scored("P2", True, [0.5]),  # positive, low score -> FN at t=0.8
            _scored("N1", False, [0.9]),  # negative, high score -> FP at t=0.8
            _scored("N2", False, [0.3]),  # negative, low score -> TN at t=0.8
        ]
        [result] = sweep_thresholds(cases, [0.8])
        assert (result.tp, result.fp, result.tn, result.fn) == (1, 1, 1, 1)
        assert result.precision == pytest.approx(0.5)
        assert result.recall == pytest.approx(0.5)
        assert result.specificity == pytest.approx(0.5)
        assert result.f1 == pytest.approx(0.5)
        assert result.false_abstention_rate == pytest.approx(0.5)
        assert result.false_answer_rate == pytest.approx(0.5)

    def test_perfect_separation_at_the_right_threshold(self) -> None:
        cases = [
            _scored("P1", True, [0.9]),
            _scored("P2", True, [0.8]),
            _scored("N1", False, [0.4]),
            _scored("N2", False, [0.3]),
        ]
        [result] = sweep_thresholds(cases, [0.6])
        assert (result.tp, result.fp, result.tn, result.fn) == (2, 0, 2, 0)
        assert result.precision == 1.0
        assert result.recall == 1.0
        assert result.false_abstention_rate == 0.0
        assert result.false_answer_rate == 0.0

    def test_higher_threshold_never_decreases_false_abstention_rate(self) -> None:
        cases = [_scored(f"P{i}", True, [s]) for i, s in enumerate([0.9, 0.7, 0.5, 0.3])]
        results = sweep_thresholds(cases, [0.4, 0.6, 0.8])
        rates = [r.false_abstention_rate for r in results]
        assert rates == sorted(rates)  # type: ignore[type-var]

    def test_empty_class_produces_none_metrics_not_a_crash(self) -> None:
        cases = [_scored("P1", True, [0.9])]  # no negatives at all
        [result] = sweep_thresholds(cases, [0.5])
        assert result.specificity is None
        assert result.false_answer_rate is None
        assert result.tp == 1


class TestBestByF1:
    def test_picks_the_highest_f1_threshold(self) -> None:
        cases = [
            _scored("P1", True, [0.9]),
            _scored("P2", True, [0.85]),
            _scored("N1", False, [0.5]),
            _scored("N2", False, [0.45]),
        ]
        results = sweep_thresholds(cases, [0.3, 0.6, 0.95])
        best = best_by_f1(results)
        assert best is not None
        assert best.threshold == 0.6  # separates both positives from both negatives

    def test_empty_list_returns_none(self) -> None:
        assert best_by_f1([]) is None


class TestDeterministicSplit:
    def test_refuses_when_a_class_is_too_small(self) -> None:
        cases = [_scored(f"P{i}", True, [0.9]) for i in range(3)] + [
            _scored("N1", False, [0.3])
        ]
        split = deterministic_split(cases)
        assert split.meaningful is False
        assert split.holdout == []
        assert split.calibration == cases

    def test_stratified_split_keeps_both_classes_in_both_halves(self) -> None:
        positives = [_scored(f"P{i}", True, [0.9]) for i in range(20)]
        negatives = [_scored(f"N{i}", False, [0.3]) for i in range(20)]
        split = deterministic_split(positives + negatives)
        assert split.meaningful is True
        assert any(c.is_positive for c in split.calibration)
        assert any(not c.is_positive for c in split.calibration)
        assert any(c.is_positive for c in split.holdout)
        assert any(not c.is_positive for c in split.holdout)
        # No case appears in both halves, and every case is accounted for.
        cal_ids = {c.case_id for c in split.calibration}
        hold_ids = {c.case_id for c in split.holdout}
        assert cal_ids.isdisjoint(hold_ids)
        assert cal_ids | hold_ids == {c.case_id for c in positives + negatives}

    def test_same_seed_produces_the_same_split_every_time(self) -> None:
        positives = [_scored(f"P{i}", True, [0.9]) for i in range(20)]
        negatives = [_scored(f"N{i}", False, [0.3]) for i in range(20)]
        split_a = deterministic_split(positives + negatives, seed=CALIBRATION_SPLIT_SEED)
        split_b = deterministic_split(positives + negatives, seed=CALIBRATION_SPLIT_SEED)
        assert {c.case_id for c in split_a.calibration} == {c.case_id for c in split_b.calibration}


class TestAlternativeSignals:
    def test_summarize_signal_reports_the_gap_of_means(self) -> None:
        cases = [
            _scored("P1", True, [0.9]),
            _scored("P2", True, [0.8]),
            _scored("N1", False, [0.3]),
            _scored("N2", False, [0.2]),
        ]
        summary = summarize_signal(cases, lambda c: c.top_score)
        assert summary["positive_mean"] == pytest.approx(0.85)
        assert summary["negative_mean"] == pytest.approx(0.25)
        assert summary["gap_of_means"] == pytest.approx(0.6)

    def test_evaluate_alternative_signals_covers_every_signal(self) -> None:
        cases = [_scored("P1", True, [0.9, 0.7, 0.5]), _scored("N1", False, [0.4, 0.3, 0.2])]
        signals = evaluate_alternative_signals(cases)
        assert set(signals) == {"top_score", "margin_top1_top2", "mean_top3", "doc_diversity_top3"}


class TestFullHarnessRun:
    def test_run_produces_a_json_serializable_report_with_separate_calibrations(
        self, tmp_path
    ) -> None:
        report = run(force_synthetic=True, reports_dir=tmp_path)
        serialized = json.dumps(report)
        reloaded = json.loads(serialized)
        assert reloaded["embedding_mode"] == "synthetic:lexical-hash"
        assert reloaded["dataset"]["general_positive"] >= 30
        assert reloaded["dataset"]["general_negative"] >= 30
        # General and Zoom-In calibration are reported as separate blocks,
        # never merged into one confusion matrix (Milestone 5.6 §10).
        assert "general_calibration" in reloaded
        assert "zoom_in_calibration" in reloaded
        assert reloaded["general_calibration"]["threshold_sweep"] != reloaded[
            "zoom_in_calibration"
        ]["threshold_sweep"]

    def test_two_runs_produce_identical_calibration_content(self, tmp_path) -> None:
        report_a = run(force_synthetic=True, reports_dir=tmp_path)
        report_b = run(force_synthetic=True, reports_dir=tmp_path)
        report_a.pop("generated_at")
        report_b.pop("generated_at")
        assert report_a == report_b

    def test_zoom_in_calibration_never_attempts_a_holdout(self, tmp_path) -> None:
        report = run(force_synthetic=True, reports_dir=tmp_path)
        assert report["zoom_in_calibration"]["split_meaningful"] is False
