"""Milestone 11 — pure-logic tests for app/model.py that need no torch
import (module-level code in app/model.py never imports torch —
see that module's docstring; only .load()/.predict_batch() do, lazily)."""

from __future__ import annotations

import pytest

from app.model import (
    SANITY_EXPECTED_LABEL,
    SANITY_HYPOTHESIS,
    SANITY_PREMISE,
    ModelSanityCheckFailed,
    NLIModel,
    _normalize_label,
)


class TestNormalizeLabel:
    def test_lowercases_known_labels(self) -> None:
        assert _normalize_label("ENTAILMENT") == "entailment"
        assert _normalize_label("Neutral") == "neutral"
        assert _normalize_label("contradiction") == "contradiction"

    def test_rejects_unknown_label(self) -> None:
        with pytest.raises(ValueError, match="unrecognized NLI label"):
            _normalize_label("something_else")


def _make_model(sanity_label: str) -> NLIModel:
    def _predict_batch(pairs: list[tuple[str, str]]) -> tuple[list[str], list[list[float]]]:
        return [sanity_label] * len(pairs), [[0.33, 0.33, 0.34]] * len(pairs)

    model = NLIModel(
        model_id="fake",
        model_revision="fake-rev",
        tokenizer=object(),
        model=object(),
        label_from_index={0: "entailment", 1: "neutral", 2: "contradiction"},
        label_to_index={"entailment": 0, "neutral": 1, "contradiction": 2},
    )
    model.predict_batch = _predict_batch  # type: ignore[method-assign]
    return model


class TestRunSanityCheck:
    def test_passes_when_self_entailment_predicted(self) -> None:
        model = _make_model(SANITY_EXPECTED_LABEL)
        model.run_sanity_check()  # must not raise

    def test_fails_when_label_mapping_is_wrong(self) -> None:
        model = _make_model("contradiction")
        with pytest.raises(ModelSanityCheckFailed, match="startup sanity check failed"):
            model.run_sanity_check()

    def test_sanity_pair_is_a_true_self_entailment(self) -> None:
        # Guards against a future edit accidentally making the sanity
        # pair itself non-trivial (e.g. two different sentences) — it
        # must stay a literal self-entailment for the check to be
        # meaningful.
        assert SANITY_PREMISE == SANITY_HYPOTHESIS
