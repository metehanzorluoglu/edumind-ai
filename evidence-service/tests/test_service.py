"""Milestone 11 (Evidence Service & Shadow Infrastructure Implementation)
§33 — service-level tests: health before/after ready, request validation,
label mapping, batch order, source ID preservation, probability schema,
max source rejection, timeout/overload behavior, queue limits,
model-not-ready, malformed payload. All against the FakeNLIModel (see
conftest.py) — no torch, no internet, no real model download."""

from __future__ import annotations

import pytest

from app.config import Settings


class TestHealth:
    def test_health_reports_ready_after_successful_load(self, client) -> None:
        resp = client.get("/health")
        assert resp.status_code == 200
        body = resp.json()
        assert body["ready"] is True
        assert body["status"] == "ready"
        assert body["model_id"] == "fake/nli-model"
        assert body["model_revision"] == "fake-revision-0000000"
        assert "error" not in body or body["error"] is None

    def test_health_never_includes_predictions_or_content(self, client) -> None:
        body = client.get("/health").json()
        allowed_keys = {"status", "ready", "model_id", "model_revision", "error"}
        assert set(body.keys()) <= allowed_keys

    def test_health_reports_error_status_on_load_failure(self, make_client) -> None:
        async def _failing_loader():
            raise RuntimeError("simulated model load failure")

        app_settings = Settings()
        from app.main import create_app
        from fastapi.testclient import TestClient

        app = create_app(settings=app_settings, model_loader=_failing_loader)
        with TestClient(app) as broken_client:
            resp = broken_client.get("/health")
            body = resp.json()
            assert body["ready"] is False
            assert body["status"] == "error"
            assert "simulated model load failure" in body["error"]
            # No stack trace leaked — just the exception message.
            assert "Traceback" not in body["error"]


class TestClassifyBatchNotReady:
    def test_classify_batch_returns_503_when_not_ready(self, client) -> None:
        client.app.state.evidence.ready = False
        resp = client.post(
            "/classify_batch",
            json={"claim": "X improved Y.", "sources": [{"source_id": "S1", "text": "evidence"}]},
        )
        assert resp.status_code == 503
        assert resp.json()["error"] == "not_ready"


class TestClassifyBatchHappyPath:
    def test_label_mapping_entailment(self, client) -> None:
        resp = client.post(
            "/classify_batch",
            json={
                "claim": "X improved Y.",
                "sources": [{"source_id": "S1", "text": "ENTAIL_ME this text supports it"}],
            },
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["results"][0]["label"] == "ENTAILMENT"
        assert body["results"][0]["probabilities"]["entailment"] == pytest.approx(0.95)

    def test_label_mapping_contradiction(self, client) -> None:
        resp = client.post(
            "/classify_batch",
            json={
                "claim": "X improved Y.",
                "sources": [{"source_id": "S1", "text": "CONTRADICT_ME this text opposes it"}],
            },
        )
        body = resp.json()
        assert body["results"][0]["label"] == "CONTRADICTION"

    def test_label_mapping_neutral(self, client) -> None:
        resp = client.post(
            "/classify_batch",
            json={
                "claim": "X improved Y.",
                "sources": [{"source_id": "S1", "text": "unrelated background text"}],
            },
        )
        body = resp.json()
        assert body["results"][0]["label"] == "NEUTRAL"

    def test_probability_schema_sums_close_to_one(self, client) -> None:
        resp = client.post(
            "/classify_batch",
            json={
                "claim": "X improved Y.",
                "sources": [{"source_id": "S1", "text": "ENTAIL_ME"}],
            },
        )
        probs = resp.json()["results"][0]["probabilities"]
        assert set(probs.keys()) == {"entailment", "neutral", "contradiction"}
        assert sum(probs.values()) == pytest.approx(1.0, abs=0.01)

    def test_batch_order_and_source_id_preserved(self, client) -> None:
        resp = client.post(
            "/classify_batch",
            json={
                "claim": "X improved Y.",
                "sources": [
                    {"source_id": "S1", "text": "CONTRADICT_ME first"},
                    {"source_id": "S2", "text": "ENTAIL_ME second"},
                    {"source_id": "S3", "text": "plain third"},
                ],
            },
        )
        body = resp.json()
        assert [r["source_id"] for r in body["results"]] == ["S1", "S2", "S3"]
        assert [r["label"] for r in body["results"]] == ["CONTRADICTION", "ENTAILMENT", "NEUTRAL"]

    def test_response_reports_model_id_and_revision(self, client) -> None:
        body = client.post(
            "/classify_batch",
            json={"claim": "X.", "sources": [{"source_id": "S1", "text": "t"}]},
        ).json()
        assert body["model_id"] == "fake/nli-model"
        assert body["model_revision"] == "fake-revision-0000000"

    def test_response_reports_latency(self, client) -> None:
        body = client.post(
            "/classify_batch",
            json={"claim": "X.", "sources": [{"source_id": "S1", "text": "t"}]},
        ).json()
        assert body["latency_ms"] >= 0


class TestRequestValidation:
    def test_empty_claim_rejected(self, client) -> None:
        resp = client.post(
            "/classify_batch",
            json={"claim": "", "sources": [{"source_id": "S1", "text": "t"}]},
        )
        assert resp.status_code == 422  # pydantic field validation (min_length)

    def test_empty_sources_rejected(self, client) -> None:
        resp = client.post("/classify_batch", json={"claim": "X.", "sources": []})
        assert resp.status_code == 422

    def test_duplicate_source_ids_rejected(self, client) -> None:
        resp = client.post(
            "/classify_batch",
            json={
                "claim": "X.",
                "sources": [
                    {"source_id": "S1", "text": "a"},
                    {"source_id": "S1", "text": "b"},
                ],
            },
        )
        assert resp.status_code == 422

    def test_too_many_sources_rejected(self, client) -> None:
        sources = [{"source_id": f"S{i}", "text": "t"} for i in range(10)]
        resp = client.post("/classify_batch", json={"claim": "X.", "sources": sources})
        assert resp.status_code == 400
        assert resp.json()["error"] == "too_many_sources"

    def test_claim_too_long_rejected(self, client) -> None:
        resp = client.post(
            "/classify_batch",
            json={"claim": "x" * 5000, "sources": [{"source_id": "S1", "text": "t"}]},
        )
        assert resp.status_code == 400
        assert resp.json()["error"] == "claim_too_long"

    def test_source_too_long_rejected(self, client) -> None:
        resp = client.post(
            "/classify_batch",
            json={"claim": "X.", "sources": [{"source_id": "S1", "text": "x" * 10000}]},
        )
        assert resp.status_code == 400
        assert resp.json()["error"] == "source_too_long"

    def test_malformed_payload_returns_422_not_500(self, client) -> None:
        resp = client.post("/classify_batch", json={"not_a_valid_field": True})
        assert resp.status_code == 422

    def test_malformed_payload_never_leaks_stack_trace(self, client) -> None:
        resp = client.post("/classify_batch", data="not even json")
        assert resp.status_code in (400, 422)
        assert "Traceback" not in resp.text

    def test_error_responses_use_the_fixed_error_schema(self, client) -> None:
        resp = client.post(
            "/classify_batch",
            json={"claim": "x" * 5000, "sources": [{"source_id": "S1", "text": "t"}]},
        )
        body = resp.json()
        assert set(body.keys()) == {"error", "detail"}


class TestQueueAndOverload:
    def test_queue_full_returns_503(self, make_client) -> None:
        import threading
        import time as time_module

        from app.config import Settings as ServiceSettings

        from .conftest import FakeNLIModel

        slow_model = FakeNLIModel(delay_seconds=0.3)
        settings = ServiceSettings(concurrency=1, queue_depth=1, request_timeout_seconds=5.0)
        with make_client(settings=settings, model=slow_model) as c:
            results: list[int] = []

            def _post() -> None:
                resp = c.post(
                    "/classify_batch",
                    json={"claim": "X.", "sources": [{"source_id": "S1", "text": "t"}]},
                )
                results.append(resp.status_code)

            threads = [threading.Thread(target=_post) for _ in range(4)]
            for t in threads:
                t.start()
                time_module.sleep(0.02)  # stagger so admission order is deterministic-ish
            for t in threads:
                t.join(timeout=10)

            # concurrency=1 + queue_depth=1 admits at most 2 in flight;
            # with 4 concurrent requests, at least one must be rejected.
            assert 503 in results

    def test_timeout_returns_504(self, make_client) -> None:
        from app.config import Settings as ServiceSettings

        from .conftest import FakeNLIModel

        slow_model = FakeNLIModel(delay_seconds=1.0)
        settings = ServiceSettings(concurrency=1, queue_depth=8, request_timeout_seconds=0.05)
        with make_client(settings=settings, model=slow_model) as c:
            resp = c.post(
                "/classify_batch",
                json={"claim": "X.", "sources": [{"source_id": "S1", "text": "t"}]},
            )
            assert resp.status_code == 504
            assert resp.json()["error"] == "timeout"
