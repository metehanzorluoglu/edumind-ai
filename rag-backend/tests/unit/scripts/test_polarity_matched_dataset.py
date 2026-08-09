"""Milestone 9.5 (Polarity-Matched Claim + NLI Validation) — integrity
tests for evaluation/polarity_matched_dataset.py. Pure-Python, no torch
dependency, runs in the ordinary production venv."""

from __future__ import annotations

from evaluation.claim_transformer import classify_and_transform
from evaluation.polarity_matched_dataset import CASES, CATEGORIES, by_claim_family, by_relation
from scripts.nli_polarity_matched_eval import split_dev_holdout


class TestDatasetIntegrity:
    def test_meets_minimum_size_per_class(self) -> None:
        counts = {label: len(cases) for label, cases in by_relation().items()}
        for label in ("entailment", "neutral", "contradiction"):
            assert counts.get(label, 0) >= 20, f"{label} below minimum of 20"

    def test_no_duplicate_case_ids(self) -> None:
        ids = [c.case_id for c in CASES]
        assert len(ids) == len(set(ids))

    def test_every_required_category_represented(self) -> None:
        represented = {c.category for c in CASES}
        assert set(CATEGORIES) <= represented

    def test_premise_text_resolves_for_every_case(self) -> None:
        for case in CASES:
            text = case.premise_text()
            assert isinstance(text, str) and len(text) > 0

    def test_every_claim_family_holds_claim_text_fixed(self) -> None:
        """The core experimental-design invariant this dataset exists to
        enforce (Milestone 9.5 §1/§2): within one claim family, the
        proposition being tested must never vary across premises — only
        the evidence varies. A family with inconsistent claim text would
        silently reintroduce the exact polarity confound this milestone
        was chartered to eliminate."""
        for family, members in by_claim_family().items():
            claims = {m.expected_natural_claim for m in members}
            assert len(claims) == 1, f"family {family!r} has inconsistent claims: {claims}"


class TestGroundTruthAudit:
    """Verifies the dataset's own auto_applicable_expected field (and, for
    applicable cases, the expected claim text) matches what
    evaluation/claim_transformer.py actually does RIGHT NOW — the
    Milestone 9.5 §17 audit requirement, encoded as a regression test so a
    future transformer change that silently breaks this alignment is
    caught immediately, and so a future dataset edit that assumes
    applicability without checking is caught too."""

    def test_every_case_applicability_expectation_matches_live_transformer(self) -> None:
        for case in CASES:
            result = classify_and_transform(case.question)
            assert result.applicable == case.auto_applicable_expected, (
                f"{case.case_id}: expected auto_applicable_expected="
                f"{case.auto_applicable_expected} but transformer returned "
                f"applicable={result.applicable}"
            )

    def test_every_applicable_case_produces_exactly_the_expected_claim(self) -> None:
        for case in CASES:
            if not case.auto_applicable_expected:
                continue
            result = classify_and_transform(case.question)
            assert len(result.claims) == 1, f"{case.case_id}: expected exactly 1 claim"
            assert result.claims[0] == case.expected_natural_claim, (
                f"{case.case_id}: transformer produced {result.claims[0]!r}, "
                f"expected {case.expected_natural_claim!r}"
            )

    def test_seven_known_coverage_gaps_are_the_only_declined_cases(self) -> None:
        """Documents the exact §17 audit finding: 'span', the 'caused'
        participle trigger, and 'include' are not in the transformer's
        recognized vocabulary — a real, disclosed gap, not silently
        patched. If this set ever changes, either the transformer's
        vocabulary changed (update this test deliberately) or a new,
        undocumented gap appeared (investigate, don't just widen the set)."""
        known_gap_ids = {"PM-041", "PM-042", "PM-043", "PM-044", "PM-045", "PM-079", "PM-080"}
        declined_ids = {c.case_id for c in CASES if not c.auto_applicable_expected}
        assert declined_ids == known_gap_ids


class TestDevHoldoutSplit:
    """scripts/nli_polarity_matched_eval.py's split_dev_holdout — pure
    Python, no torch dependency, so it's tested directly here rather than
    only via a manual isolated-venv run."""

    def _applicable_cases(self) -> list:
        return [c for c in CASES if c.auto_applicable_expected]

    def test_split_is_deterministic(self) -> None:
        cases = self._applicable_cases()
        first = split_dev_holdout(cases)
        second = split_dev_holdout(cases)
        assert first.dev_ids == second.dev_ids
        assert first.holdout_ids == second.holdout_ids

    def test_split_accounts_for_every_case_exactly_once(self) -> None:
        cases = self._applicable_cases()
        split = split_dev_holdout(cases)
        all_ids = set(split.dev_ids) | set(split.holdout_ids)
        assert all_ids == {c.case_id for c in cases}
        assert len(split.dev_ids) + len(split.holdout_ids) == len(cases)

    def test_no_case_in_both_halves(self) -> None:
        split = split_dev_holdout(self._applicable_cases())
        assert set(split.dev_ids).isdisjoint(split.holdout_ids)

    def test_split_is_meaningful_on_the_real_applicable_subset(self) -> None:
        split = split_dev_holdout(self._applicable_cases())
        assert split.meaningful, split.reason

    def test_no_topic_leaks_across_dev_and_holdout(self) -> None:
        cases = self._applicable_cases()
        split = split_dev_holdout(cases)
        id_to_topic = {c.case_id: c.topic for c in cases}
        dev_topics = {id_to_topic[i] for i in split.dev_ids}
        holdout_topics = {id_to_topic[i] for i in split.holdout_ids}
        assert dev_topics.isdisjoint(holdout_topics)
