"""Milestone 9.6 (NLI Contradiction & Negation Recovery) — unit tests for
evaluation/nli_safety_policy.py and evaluation/nli_failure_analysis_m96.py.
Pure Python, no torch dependency, runs in the ordinary production venv."""

from __future__ import annotations

from evaluation.nli_failure_analysis_m96 import FAILURES, category_counts, dangerous_failures
from evaluation.nli_safety_policy import (
    FAILURE_CATEGORIES,
    ClassProbabilities,
    apply_safety_policy,
    evaluate_policy,
    find_zero_dangerous_threshold,
    sweep_policy,
)


def _row(case_id: str, gold: str, p_ent: float, p_neu: float, p_con: float) -> ClassProbabilities:
    return ClassProbabilities(
        case_id=case_id, gold=gold, p_entailment=p_ent, p_neutral=p_neu, p_contradiction=p_con
    )


class TestApplySafetyPolicy:
    def test_high_entailment_confidence_is_supported(self) -> None:
        row = _row("c1", "entailment", 0.95, 0.03, 0.02)
        assert apply_safety_policy(row, t_entailment=0.9, t_contradiction=0.9) == "SUPPORTED"

    def test_high_contradiction_confidence_is_contradicted(self) -> None:
        row = _row("c1", "contradiction", 0.02, 0.03, 0.95)
        assert apply_safety_policy(row, t_entailment=0.9, t_contradiction=0.9) == "CONTRADICTED"

    def test_low_confidence_on_both_is_unknown(self) -> None:
        row = _row("c1", "neutral", 0.3, 0.5, 0.2)
        assert apply_safety_policy(row, t_entailment=0.9, t_contradiction=0.9) == "UNKNOWN"

    def test_entailment_checked_before_contradiction(self) -> None:
        # A (contrived) case clearing both bars resolves SUPPORTED, not
        # CONTRADICTED — entailment is checked first (see the function's
        # own docstring for why).
        row = _row("c1", "entailment", 0.95, 0.0, 0.92)
        assert apply_safety_policy(row, t_entailment=0.9, t_contradiction=0.9) == "SUPPORTED"

    def test_threshold_boundary_is_inclusive(self) -> None:
        row = _row("c1", "entailment", 0.9, 0.05, 0.05)
        assert apply_safety_policy(row, t_entailment=0.9, t_contradiction=0.9) == "SUPPORTED"


class TestEvaluatePolicy:
    def test_dangerous_support_flags_non_entailment_gold_supported(self) -> None:
        rows = [
            _row(
                "c1", "contradiction", 0.95, 0.02, 0.03
            ),  # dangerous: SUPPORTED but gold=contradiction
            _row("c2", "entailment", 0.95, 0.02, 0.03),  # correct SUPPORTED
        ]
        report = evaluate_policy(rows, t_entailment=0.9, t_contradiction=0.9)
        assert report.dangerous_support_count == 1
        assert report.dangerous_support_case_ids == ("c1",)

    def test_neutral_gold_landing_unknown_is_correct_not_a_coverage_loss(self) -> None:
        rows = [_row("c1", "neutral", 0.3, 0.5, 0.2)]
        report = evaluate_policy(rows, t_entailment=0.9, t_contradiction=0.9)
        assert report.neutral_correctly_unknown_rate == 1.0

    def test_decisive_coverage_only_counts_entailment_and_contradiction_gold(self) -> None:
        rows = [
            _row("c1", "entailment", 0.95, 0.02, 0.03),  # decisive
            _row("c2", "contradiction", 0.3, 0.4, 0.3),  # UNKNOWN, not decisive
            _row("c3", "neutral", 0.3, 0.5, 0.2),  # correctly excluded from denominator
        ]
        report = evaluate_policy(rows, t_entailment=0.9, t_contradiction=0.9)
        assert report.decisive_coverage == 0.5  # 1 of 2 ENT+CONTRA cases decided

    def test_contradiction_recall_measured_against_all_contradiction_gold(self) -> None:
        rows = [
            _row("c1", "contradiction", 0.02, 0.03, 0.95),  # caught
            _row("c2", "contradiction", 0.3, 0.4, 0.3),  # missed (UNKNOWN)
        ]
        report = evaluate_policy(rows, t_entailment=0.9, t_contradiction=0.9)
        assert report.contradiction_recall == 0.5

    def test_raising_threshold_never_increases_dangerous_support_count(self) -> None:
        rows = [
            _row("c1", "contradiction", 0.96, 0.02, 0.02),
            _row("c2", "entailment", 0.99, 0.005, 0.005),
        ]
        loose = evaluate_policy(rows, t_entailment=0.5, t_contradiction=0.5)
        strict = evaluate_policy(rows, t_entailment=0.97, t_contradiction=0.97)
        assert strict.dangerous_support_count <= loose.dangerous_support_count


class TestSweepAndZeroDangerousThreshold:
    def test_sweep_returns_one_report_per_threshold_pair(self) -> None:
        rows = [_row("c1", "entailment", 0.95, 0.02, 0.03)]
        thresholds = [(0.5, 0.5), (0.9, 0.9), (0.99, 0.99)]
        reports = sweep_policy(rows, thresholds)
        assert len(reports) == 3

    def test_find_zero_dangerous_threshold_finds_the_first_safe_policy(self) -> None:
        rows = [
            _row("c1", "contradiction", 0.96, 0.02, 0.02),  # dangerous at loose thresholds
            _row("c2", "entailment", 0.99, 0.005, 0.005),
        ]
        thresholds = [(0.5, 0.5), (0.97, 0.97), (0.99, 0.99)]
        found = find_zero_dangerous_threshold(rows, thresholds)
        assert found is not None
        assert found.dangerous_support_count == 0
        assert found.t_entailment == 0.97  # the first (lowest, in sweep order) safe policy

    def test_find_zero_dangerous_threshold_returns_none_if_unreachable(self) -> None:
        rows = [_row("c1", "contradiction", 0.999, 0.0005, 0.0005)]
        thresholds = [(0.5, 0.5), (0.9, 0.9)]
        assert find_zero_dangerous_threshold(rows, thresholds) is None


class TestFailureCategorization:
    def test_every_category_used_is_in_the_fixed_taxonomy(self) -> None:
        for f in FAILURES:
            assert f.category in FAILURE_CATEGORIES

    def test_invalid_category_is_rejected(self) -> None:
        import pytest

        from evaluation.nli_safety_policy import FailureRecord

        with pytest.raises(ValueError, match="unknown failure category"):
            FailureRecord(
                "X1",
                "q",
                "claim",
                "evidence",
                "contradiction",
                "neutral",
                0.1,
                0.8,
                0.1,
                "NOT_A_REAL_CATEGORY",
            )

    def test_dangerous_failures_are_exactly_the_ones_predicted_entailment(self) -> None:
        dangerous = dangerous_failures()
        assert all(f.prediction == "entailment" for f in dangerous)
        assert all(f.gold == "contradiction" for f in dangerous)

    def test_dangerous_failures_are_a_strict_subset_of_all_failures(self) -> None:
        assert {f.case_id for f in dangerous_failures()} <= {f.case_id for f in FAILURES}

    def test_category_counts_sum_to_total_failures(self) -> None:
        assert sum(category_counts().values()) == len(FAILURES)

    def test_no_duplicate_case_ids_in_failure_analysis(self) -> None:
        ids = [f.case_id for f in FAILURES]
        assert len(ids) == len(set(ids))
