"""Milestone 11 (Evidence Service & Shadow Infrastructure Implementation)
§32/§33 — shared test fixtures. NO torch/transformers import anywhere in
this file or in tests/test_*.py (except the explicitly-marked, opt-in
tests/test_model_real.py — see its own module docstring): a fake model
object stands in for the real one everywhere else, so the whole
FastAPI/concurrency/validation surface is testable without downloading or
running the 355M-parameter model, per Milestone 11 §32's explicit CI
requirement."""

from __future__ import annotations

from dataclasses import dataclass, field

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app


@dataclass
class FakeNLIModel:
    """Deterministic stand-in for app.model.NLIModel. Which label a pair
    predicts is controlled by a keyword embedded in the SOURCE text (by
    convention in these tests: "ENTAIL_ME" / "CONTRADICT_ME" / neither ->
    neutral) — never randomness, so every test is exactly reproducible."""

    model_id: str = "fake/nli-model"
    model_revision: str = "fake-revision-0000000"
    label_from_index: dict[int, str] = field(
        default_factory=lambda: {0: "entailment", 1: "neutral", 2: "contradiction"}
    )
    label_to_index: dict[str, int] = field(
        default_factory=lambda: {"entailment": 0, "neutral": 1, "contradiction": 2}
    )
    #: Set by a test to simulate slow inference (BoundedInferenceExecutor
    #: timeout/queue tests) — seconds to sleep (via time.sleep, since the
    #: real predict_batch is itself synchronous/blocking) before
    #: returning. 0 by default (instant).
    delay_seconds: float = 0.0

    def predict_batch(self, pairs: list[tuple[str, str]]) -> tuple[list[str], list[list[float]]]:
        import time

        if self.delay_seconds:
            time.sleep(self.delay_seconds)
        labels = []
        probs = []
        for premise, _hypothesis in pairs:
            if "CONTRADICT_ME" in premise:
                labels.append("contradiction")
                probs.append([0.02, 0.03, 0.95])
            elif "ENTAIL_ME" in premise:
                labels.append("entailment")
                probs.append([0.95, 0.03, 0.02])
            else:
                labels.append("neutral")
                probs.append([0.1, 0.85, 0.05])
        return labels, probs


@pytest.fixture
def fake_model() -> FakeNLIModel:
    return FakeNLIModel()


@pytest.fixture
def make_client(fake_model: FakeNLIModel):
    """Returns a factory so a test can pass custom Settings (e.g. a
    smaller queue_depth) while still getting the same fake, torch-free
    model."""

    def _make(settings: Settings | None = None, model=None) -> TestClient:
        resolved_model = model if model is not None else fake_model

        async def _loader():
            return resolved_model

        app = create_app(settings=settings or Settings(), model_loader=_loader)
        return TestClient(app)

    return _make


@pytest.fixture
def client(make_client) -> TestClient:
    with make_client() as c:
        yield c
