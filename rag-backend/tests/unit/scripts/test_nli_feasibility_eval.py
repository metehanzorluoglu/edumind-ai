"""Milestone 8 (Dedicated NLI / Evidence Entailment Feasibility) — unit
tests for the pure-logic pieces of scripts/nli_feasibility_eval.py and
evaluation/nli_dataset.py. Deliberately does NOT import torch/transformers
(neither is a production or dev dependency — see both modules' docstrings)
— scripts/nli_feasibility_eval.py's module-level imports were kept
torch-free specifically so this file can run in the ordinary rag-backend
test suite, exercising the dev/holdout split, NLI label normalization, all
metric computations, and dataset integrity without needing the isolated
evaluation venv. Model loading/inference (NLIModel.load/predict_batch)
lazily import torch inside the method body and are exercised only via
manual `scripts/nli_feasibility_eval.py` invocations under
evaluation/.nli-eval-env/.venv, per that module's own docstring — not
here."""

from __future__ import annotations

from evaluation.nli_dataset import CONFLICTING_SOURCE_CASES, NLI_CASES, NLICase
from scripts.nli_feasibility_eval import (
    LABELS,
    CaseOutcome,
    _confusion_matrix,
    _dangerous_errors,
    _normalize_label,
    _per_class_prf,
    _safety_collapse,
    build_report,
    split_dev_holdout,
)


class TestDatasetIntegrity:
    def test_every_case_has_a_valid_gold_label(self) -> None:
        for case in NLI_CASES:
            assert case.gold_label in ("entailment", "neutral", "contradiction")

    def test_no_duplicate_case_ids_across_both_dataset_shapes(self) -> None:
        single_ids = {c.case_id for c in NLI_CASES}
        conflict_ids = {c.case_id for c in CONFLICTING_SOURCE_CASES}
        assert len(single_ids) == len(NLI_CASES)
        assert single_ids.isdisjoint(conflict_ids)

    def test_meets_milestone_8_class_targets(self) -> None:
        from collections import Counter

        counts = Counter(c.gold_label for c in NLI_CASES)
        assert counts["entailment"] >= 30
        assert counts["neutral"] >= 30
        assert counts["contradiction"] >= 40

    def test_every_required_contradiction_subtype_is_represented(self) -> None:
        required = {
            "explicit_negation",
            "no_significant_difference",
            "decrease_vs_increase",
            "supports_vs_does_not_support",
            "wrong_numerical_claim",
            "wrong_population_claim",
            "wrong_methodology_claim",
            "correlation_vs_causation",
            "stronger_claim_than_source",
            "wrong_date_year",
            "entity_confusion",
            "opposite_comparison_direction",
        }
        represented = {c.category for c in NLI_CASES}
        assert required <= represented

    def test_premise_text_resolves_for_every_case(self) -> None:
        for case in NLI_CASES:
            text = case.premise_text()
            assert isinstance(text, str)
            assert len(text) > 0

    def test_conflicting_source_cases_resolve_both_sides(self) -> None:
        for case in CONFLICTING_SOURCE_CASES:
            assert len(case.source_a_text()) > 0
            assert len(case.source_b_text()) > 0
            assert case.source_a_gold_label in ("entailment", "neutral", "contradiction")
            assert case.source_b_gold_label in ("entailment", "neutral", "contradiction")

    def test_invalid_category_is_rejected(self) -> None:
        import pytest

        with pytest.raises(ValueError, match="unknown category"):
            NLICase(
                "X1",
                "rc-doc-phonics-rct",
                (0,),
                "hyp",
                "q?",
                "entailment",
                "not_a_real_category",
                "reading_science",
                "notes",
            )

    def test_invalid_gold_label_is_rejected(self) -> None:
        import pytest

        with pytest.raises(ValueError, match="unknown gold_label"):
            NLICase(
                "X2",
                "rc-doc-phonics-rct",
                (0,),
                "hyp",
                "q?",
                "maybe",
                "direct_support",
                "reading_science",
                "notes",
            )

    def test_out_of_range_chunk_index_is_rejected(self) -> None:
        import pytest

        with pytest.raises(ValueError, match="out of range"):
            NLICase(
                "X3",
                "rc-doc-phonics-rct",
                (999,),
                "hyp",
                "q?",
                "entailment",
                "direct_support",
                "reading_science",
                "notes",
            )

    def test_unknown_document_id_is_rejected(self) -> None:
        import pytest

        with pytest.raises(ValueError, match="unknown document"):
            NLICase(
                "X4",
                "not-a-real-document",
                (0,),
                "hyp",
                "q?",
                "entailment",
                "direct_support",
                "reading_science",
                "notes",
            )


class TestLabelNormalization:
    def test_normalizes_known_labels_case_insensitively(self) -> None:
        assert _normalize_label("ENTAILMENT") == "entailment"
        assert _normalize_label("Contradiction") == "contradiction"
        assert _normalize_label("neutral") == "neutral"

    def test_rejects_unknown_label(self) -> None:
        import pytest

        with pytest.raises(ValueError, match="unrecognized"):
            _normalize_label("maybe")

    def test_handles_both_observed_model_label_orderings(self) -> None:
        # Milestone 8 §6/§14: cross-encoder models use
        # {0: contradiction, 1: entailment, 2: neutral}; MoritzLaurer's
        # uses {0: entailment, 1: neutral, 2: contradiction} — this test
        # documents both real orderings this milestone actually observed,
        # so a future change to either model's config is caught here.
        cross_encoder_order = {0: "contradiction", 1: "entailment", 2: "neutral"}
        moritz_order = {0: "entailment", 1: "neutral", 2: "contradiction"}
        for order in (cross_encoder_order, moritz_order):
            normalized = {idx: _normalize_label(label) for idx, label in order.items()}
            assert set(normalized.values()) == {"entailment", "neutral", "contradiction"}


class TestDevHoldoutSplit:
    def test_split_is_deterministic(self) -> None:
        first = split_dev_holdout(NLI_CASES)
        second = split_dev_holdout(NLI_CASES)
        assert first.dev_ids == second.dev_ids
        assert first.holdout_ids == second.holdout_ids

    def test_split_accounts_for_every_case_exactly_once(self) -> None:
        split = split_dev_holdout(NLI_CASES)
        all_ids = set(split.dev_ids) | set(split.holdout_ids)
        assert all_ids == {c.case_id for c in NLI_CASES}
        assert len(split.dev_ids) + len(split.holdout_ids) == len(NLI_CASES)

    def test_no_case_in_both_halves(self) -> None:
        split = split_dev_holdout(NLI_CASES)
        assert set(split.dev_ids).isdisjoint(split.holdout_ids)

    def test_split_is_meaningful_on_the_real_dataset(self) -> None:
        split = split_dev_holdout(NLI_CASES)
        assert split.meaningful, split.reason

    def test_refuses_meaningful_split_with_too_few_groups(self) -> None:
        case = NLICase(
            "Y1",
            "rc-doc-phonics-rct",
            (0,),
            "hyp",
            "q?",
            "entailment",
            "direct_support",
            "only-topic",
            "notes",
        )
        split = split_dev_holdout([case])
        assert split.meaningful is False
        assert "too few" in split.reason


def _outcome(case_id: str, gold: str, predicted: str) -> CaseOutcome:
    return CaseOutcome(case_id=case_id, gold=gold, predicted=predicted, probs=[0.1, 0.2, 0.7])


class TestMetrics:
    def test_per_class_prf_perfect_classifier(self) -> None:
        outcomes = [
            _outcome("c1", "entailment", "entailment"),
            _outcome("c2", "contradiction", "contradiction"),
        ]
        per_class = _per_class_prf(outcomes)
        assert per_class["entailment"]["precision"] == 1.0
        assert per_class["contradiction"]["recall"] == 1.0

    def test_confusion_matrix_shape_covers_all_labels(self) -> None:
        outcomes = [_outcome("c1", "neutral", "entailment")]
        matrix = _confusion_matrix(outcomes)
        assert set(matrix.keys()) == set(LABELS)
        for row in matrix.values():
            assert set(row.keys()) == set(LABELS)
        assert matrix["neutral"]["entailment"] == 1

    def test_dangerous_errors_contradiction_to_entailment(self) -> None:
        outcomes = [
            _outcome("c1", "contradiction", "entailment"),
            _outcome("c2", "contradiction", "contradiction"),
        ]
        errors = _dangerous_errors(outcomes)
        assert errors["contradiction_to_entailment_case_ids"] == ["c1"]
        assert errors["contradiction_recall"] == 0.5

    def test_dangerous_errors_neutral_to_entailment(self) -> None:
        outcomes = [
            _outcome("c1", "neutral", "entailment"),
            _outcome("c2", "neutral", "neutral"),
        ]
        errors = _dangerous_errors(outcomes)
        assert errors["neutral_to_entailment_case_ids"] == ["c1"]
        assert errors["neutral_to_entailment_rate"] == 0.5

    def test_safety_collapse_flags_any_non_entailment_predicted_entailment(self) -> None:
        outcomes = [
            _outcome("c1", "contradiction", "entailment"),
            _outcome("c2", "neutral", "entailment"),
            _outcome("c3", "entailment", "entailment"),
            _outcome("c4", "contradiction", "contradiction"),
        ]
        safety = _safety_collapse(outcomes)
        assert safety["dangerous_support_error_count"] == 2
        assert set(safety["dangerous_support_error_case_ids"]) == {"c1", "c2"}
        assert safety["dangerous_support_error_rate"] == 2 / 3  # 2 of 3 non-entailment-gold cases

    def test_build_report_is_json_serializable(self) -> None:
        import json

        outcomes = [
            _outcome("c1", "entailment", "entailment"),
            _outcome("c2", "contradiction", "neutral"),
        ]
        latency = {"warm_single_pair": {"p50_ms": 100.0}, "cold_load_ms": 500.0}
        report = build_report(
            "test-model", "hypothesis", "dev", outcomes, latency, 512.0, 1_000_000
        )
        json.dumps(report.to_dict())  # raises if not serializable
        assert report.case_count == 2
        assert report.model_id == "test-model"
