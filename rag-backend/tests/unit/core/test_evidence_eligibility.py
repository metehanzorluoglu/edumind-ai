"""Milestone 11 (Evidence Service & Shadow Infrastructure Implementation)
§17/§19/§34 — tests for app/core/evidence_eligibility.py. Pure Python, no
model/DB/HTTP dependency."""

from __future__ import annotations

from app.core.evidence_eligibility import (
    evidence_analysis_eligible,
    should_sample,
    validate_sample_rate,
)

_BASE_KWARGS = {
    "master_enabled": True,
    "mode": "shadow",
    "zoom_in_mode": True,
    "source_count": 3,
    "transform_applicable": True,
    "claim_count": 1,
}


class TestEvidenceAnalysisEligible:
    def test_fully_eligible_request(self) -> None:
        result = evidence_analysis_eligible(**_BASE_KWARGS)
        assert result.eligible is True
        assert result.reason is None

    def test_master_disabled_is_ineligible(self) -> None:
        result = evidence_analysis_eligible(**{**_BASE_KWARGS, "master_enabled": False})
        assert result.eligible is False
        assert result.reason == "master_disabled"

    def test_mode_off_is_ineligible(self) -> None:
        result = evidence_analysis_eligible(**{**_BASE_KWARGS, "mode": "off"})
        assert result.eligible is False
        assert result.reason == "mode_not_shadow"

    def test_zoom_in_enforced_mode_is_not_eligible_in_this_milestone(self) -> None:
        # Milestone 11 §24: the enforcement code path is not implemented
        # yet, so even the "zoom_in_enforced" mode value must never make a
        # request eligible for anything in this milestone.
        result = evidence_analysis_eligible(**{**_BASE_KWARGS, "mode": "zoom_in_enforced"})
        assert result.eligible is False
        assert result.reason == "mode_not_shadow"

    def test_general_mode_is_ineligible(self) -> None:
        result = evidence_analysis_eligible(**{**_BASE_KWARGS, "zoom_in_mode": False})
        assert result.eligible is False
        assert result.reason == "not_zoom_in"

    def test_zero_sources_is_ineligible(self) -> None:
        result = evidence_analysis_eligible(**{**_BASE_KWARGS, "source_count": 0})
        assert result.eligible is False
        assert result.reason == "no_sources"

    def test_non_applicable_transform_is_ineligible(self) -> None:
        result = evidence_analysis_eligible(**{**_BASE_KWARGS, "transform_applicable": False})
        assert result.eligible is False
        assert result.reason == "not_transform_applicable"

    def test_bypass_style_open_ended_request_is_ineligible(self) -> None:
        # An open-ended/bypass request (e.g. "Summarize this document")
        # yields TransformationResult(applicable=False, ...) from the
        # claim transformer — modeled here directly as the caller would
        # pass it through.
        result = evidence_analysis_eligible(
            **{**_BASE_KWARGS, "transform_applicable": False, "claim_count": 0}
        )
        assert result.eligible is False
        assert result.reason == "not_transform_applicable"

    def test_exactly_max_claims_is_eligible(self) -> None:
        result = evidence_analysis_eligible(**{**_BASE_KWARGS, "claim_count": 2})
        assert result.eligible is True

    def test_more_than_max_claims_is_ineligible_not_truncated(self) -> None:
        result = evidence_analysis_eligible(**{**_BASE_KWARGS, "claim_count": 3})
        assert result.eligible is False
        assert result.reason == "too_many_claims"

    def test_custom_max_claims_respected(self) -> None:
        result = evidence_analysis_eligible(**{**_BASE_KWARGS, "claim_count": 2}, max_claims=1)
        assert result.eligible is False
        assert result.reason == "too_many_claims"


class TestSampleRateValidation:
    def test_zero_is_valid(self) -> None:
        validate_sample_rate(0.0)

    def test_one_is_valid(self) -> None:
        validate_sample_rate(1.0)

    def test_mid_range_is_valid(self) -> None:
        validate_sample_rate(0.05)

    def test_negative_is_rejected(self) -> None:
        import pytest

        with pytest.raises(ValueError, match="evidence_analysis_sample_rate"):
            validate_sample_rate(-0.01)

    def test_above_one_is_rejected(self) -> None:
        import pytest

        with pytest.raises(ValueError, match="evidence_analysis_sample_rate"):
            validate_sample_rate(1.01)


class _FixedRng:
    def __init__(self, value: float) -> None:
        self._value = value

    def random(self) -> float:
        return self._value


class TestShouldSample:
    def test_below_rate_is_sampled(self) -> None:
        assert should_sample(0.5, rng=_FixedRng(0.1)) is True

    def test_above_rate_is_not_sampled(self) -> None:
        assert should_sample(0.5, rng=_FixedRng(0.9)) is False

    def test_rate_zero_never_samples(self) -> None:
        assert should_sample(0.0, rng=_FixedRng(0.0)) is False

    def test_rate_one_always_samples(self) -> None:
        assert should_sample(1.0, rng=_FixedRng(0.999999)) is True
