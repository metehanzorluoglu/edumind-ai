"""Milestone 11 (Evidence Service & Shadow Infrastructure Implementation)
§15/§16 — tests for the production-promoted app/core/claim_transformer.py.

This file is deliberately small: the full behavioral test suite for the
transformation logic already lives in
tests/unit/scripts/test_claim_transformer.py (which now exercises the
same code via evaluation/claim_transformer.py's re-export shim — see that
module's docstring). This file exists only to (a) confirm the production
import path works directly, with no dependency on `evaluation/` being
present, and (b) pin the one Milestone 11 §16 regression fix as a
permanent, isolated test."""

from __future__ import annotations

from app.core.claim_transformer import classify_and_transform


class TestProductionImportPath:
    def test_classify_and_transform_importable_from_app_core(self) -> None:
        # No evaluation/ import anywhere in this test — proves the
        # production request path can use this module standalone, matching
        # what the Docker runtime image actually ships (see the module's
        # own docstring: `evaluation/` is never copied into the image).
        result = classify_and_transform("Did X improve Y?")
        assert result.applicable
        assert result.claims == ("X improved Y.",)


class TestFlagMorphologyRegressionFix:
    """Milestone 9.6 disclosed (and explicitly deferred) a morphology bug:
    _past_tense("flag") produced "flaged", missing the consonant-doubling
    a single-syllable CVC verb needs before "-ed" ("flag" -> "flagged").
    Milestone 10 §43 scoped the fix into this milestone as a narrow,
    verb-specific special case (not a general consonant-doubling rule) —
    see app/core/claim_transformer.py's _IRREGULAR_PAST["flag"] entry."""

    def test_flag_past_tense_is_flagged_not_flaged(self) -> None:
        result = classify_and_transform("Did the reviewers flag the outlier cases?")
        assert result.applicable
        assert result.claims == ("The reviewers flagged the outlier cases.",)
        assert "flaged" not in result.claims[0]

    def test_flag_present_3sg_unaffected_by_the_fix(self) -> None:
        # _present_3sg("flag") was never buggy (regular "+s" suffix) — this
        # test exists only to confirm the past-tense-specific fix didn't
        # accidentally touch the present-tense path too.
        result = classify_and_transform("Does the reviewer flag the outlier cases?")
        assert result.applicable
        assert result.claims == ("The reviewer flags the outlier cases.",)
