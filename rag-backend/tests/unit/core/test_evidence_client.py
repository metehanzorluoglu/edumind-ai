"""Milestone 11 (Evidence Service & Shadow Infrastructure Implementation)
§13/§34 — tests for app/core/evidence_client.py. A fake `_HttpPoster` (no
real network call, no httpx transport) drives every failure/success path
— matches this repo's existing convention for external-service clients
(see tests/unit/core/test_llm_provider.py's fake ollama client)."""

from __future__ import annotations

import httpx
import pytest

from app.core.evidence_client import EvidenceClient


class _FakeHttpPoster:
    def __init__(self, *, response: httpx.Response | None = None, raises: Exception | None = None):
        self._response = response
        self._raises = raises
        self.calls: list[dict[str, object]] = []

    def post(self, url: str, *, json: dict[str, object], timeout: float) -> httpx.Response:
        self.calls.append({"url": url, "json": json, "timeout": timeout})
        if self._raises is not None:
            raise self._raises
        assert self._response is not None
        return self._response


def _ok_response(*, results: list[dict[str, object]] | None = None) -> httpx.Response:
    body = {
        "results": results
        if results is not None
        else [
            {
                "source_id": "S1",
                "label": "ENTAILMENT",
                "probabilities": {"entailment": 0.9, "neutral": 0.05, "contradiction": 0.05},
            }
        ],
        "model_id": "ynie/roberta-large-snli_mnli_fever_anli_R1_R2_R3-nli",
        "model_revision": "5b605abab9b75bc87ab66cfc049ef58d9d64b8ed",
        "latency_ms": 42.5,
    }
    return httpx.Response(200, json=body)


class TestClassifyBatchSuccess:
    def test_successful_call_returns_ok_outcome(self) -> None:
        fake = _FakeHttpPoster(response=_ok_response())
        client = EvidenceClient(base_url="http://evidence-service:8100", client=fake)
        outcome = client.classify_batch(claim="X improved Y.", sources=[("S1", "evidence text")])
        assert outcome.ok is True
        assert outcome.failure is None
        assert outcome.results[0].source_id == "S1"
        assert outcome.results[0].label == "entailment"
        assert outcome.model_id == "ynie/roberta-large-snli_mnli_fever_anli_R1_R2_R3-nli"
        assert outcome.latency_ms == 42.5

    def test_request_body_shape(self) -> None:
        fake = _FakeHttpPoster(response=_ok_response())
        client = EvidenceClient(base_url="http://evidence-service:8100", client=fake)
        client.classify_batch(claim="X improved Y.", sources=[("S1", "a"), ("S2", "b")])
        sent = fake.calls[0]["json"]
        assert sent == {
            "claim": "X improved Y.",
            "sources": [{"source_id": "S1", "text": "a"}, {"source_id": "S2", "text": "b"}],
        }

    def test_url_is_classify_batch(self) -> None:
        fake = _FakeHttpPoster(response=_ok_response())
        client = EvidenceClient(base_url="http://evidence-service:8100/", client=fake)
        client.classify_batch(claim="X.", sources=[("S1", "a")])
        assert fake.calls[0]["url"] == "http://evidence-service:8100/classify_batch"

    def test_label_lowercased_for_internal_use(self) -> None:
        fake = _FakeHttpPoster(
            response=_ok_response(
                results=[
                    {
                        "source_id": "S1",
                        "label": "CONTRADICTION",
                        "probabilities": {
                            "entailment": 0.02,
                            "neutral": 0.03,
                            "contradiction": 0.95,
                        },
                    }
                ]
            )
        )
        client = EvidenceClient(base_url="http://evidence-service:8100", client=fake)
        outcome = client.classify_batch(claim="X.", sources=[("S1", "a")])
        assert outcome.results[0].label == "contradiction"


class TestClassifyBatchNoSources:
    def test_empty_sources_returns_invalid_request_without_a_network_call(self) -> None:
        fake = _FakeHttpPoster(response=_ok_response())
        client = EvidenceClient(base_url="http://evidence-service:8100", client=fake)
        outcome = client.classify_batch(claim="X.", sources=[])
        assert outcome.ok is False
        assert outcome.failure == "invalid_request"
        assert fake.calls == []


class TestClassifyBatchFailureModes:
    def test_timeout_exception_maps_to_timeout_failure(self) -> None:
        fake = _FakeHttpPoster(raises=httpx.TimeoutException("timed out"))
        client = EvidenceClient(base_url="http://evidence-service:8100", client=fake)
        outcome = client.classify_batch(claim="X.", sources=[("S1", "a")])
        assert outcome.ok is False
        assert outcome.failure == "timeout"

    def test_connect_error_maps_to_unavailable(self) -> None:
        fake = _FakeHttpPoster(raises=httpx.ConnectError("refused"))
        client = EvidenceClient(base_url="http://evidence-service:8100", client=fake)
        outcome = client.classify_batch(claim="X.", sources=[("S1", "a")])
        assert outcome.ok is False
        assert outcome.failure == "unavailable"

    def test_other_httpx_error_maps_to_unknown_error(self) -> None:
        fake = _FakeHttpPoster(raises=httpx.HTTPError("weird"))
        client = EvidenceClient(base_url="http://evidence-service:8100", client=fake)
        outcome = client.classify_batch(claim="X.", sources=[("S1", "a")])
        assert outcome.ok is False
        assert outcome.failure == "unknown_error"

    def test_503_not_ready_maps_to_not_ready(self) -> None:
        fake = _FakeHttpPoster(
            response=httpx.Response(503, json={"error": "not_ready", "detail": "loading"})
        )
        client = EvidenceClient(base_url="http://evidence-service:8100", client=fake)
        outcome = client.classify_batch(claim="X.", sources=[("S1", "a")])
        assert outcome.ok is False
        assert outcome.failure == "not_ready"

    def test_503_queue_full_maps_to_queue_full(self) -> None:
        fake = _FakeHttpPoster(
            response=httpx.Response(503, json={"error": "queue_full", "detail": "full"})
        )
        client = EvidenceClient(base_url="http://evidence-service:8100", client=fake)
        outcome = client.classify_batch(claim="X.", sources=[("S1", "a")])
        assert outcome.ok is False
        assert outcome.failure == "queue_full"

    def test_503_with_unparseable_body_defaults_to_queue_full(self) -> None:
        fake = _FakeHttpPoster(response=httpx.Response(503, content=b"not json"))
        client = EvidenceClient(base_url="http://evidence-service:8100", client=fake)
        outcome = client.classify_batch(claim="X.", sources=[("S1", "a")])
        assert outcome.ok is False
        assert outcome.failure == "queue_full"

    def test_504_maps_to_timeout(self) -> None:
        fake = _FakeHttpPoster(
            response=httpx.Response(504, json={"error": "timeout", "detail": "slow"})
        )
        client = EvidenceClient(base_url="http://evidence-service:8100", client=fake)
        outcome = client.classify_batch(claim="X.", sources=[("S1", "a")])
        assert outcome.ok is False
        assert outcome.failure == "timeout"

    def test_400_maps_to_invalid_request(self) -> None:
        fake = _FakeHttpPoster(
            response=httpx.Response(400, json={"error": "claim_too_long", "detail": "..."})
        )
        client = EvidenceClient(base_url="http://evidence-service:8100", client=fake)
        outcome = client.classify_batch(claim="X.", sources=[("S1", "a")])
        assert outcome.ok is False
        assert outcome.failure == "invalid_request"

    def test_unexpected_status_maps_to_unknown_error(self) -> None:
        fake = _FakeHttpPoster(response=httpx.Response(500, json={}))
        client = EvidenceClient(base_url="http://evidence-service:8100", client=fake)
        outcome = client.classify_batch(claim="X.", sources=[("S1", "a")])
        assert outcome.ok is False
        assert outcome.failure == "unknown_error"

    def test_malformed_200_body_maps_to_malformed_response(self) -> None:
        fake = _FakeHttpPoster(response=httpx.Response(200, json={"unexpected": "shape"}))
        client = EvidenceClient(base_url="http://evidence-service:8100", client=fake)
        outcome = client.classify_batch(claim="X.", sources=[("S1", "a")])
        assert outcome.ok is False
        assert outcome.failure == "malformed_response"

    def test_unrecognized_label_maps_to_malformed_response(self) -> None:
        fake = _FakeHttpPoster(
            response=_ok_response(
                results=[
                    {
                        "source_id": "S1",
                        "label": "MAYBE",
                        "probabilities": {"entailment": 0.3, "neutral": 0.4, "contradiction": 0.3},
                    }
                ]
            )
        )
        client = EvidenceClient(base_url="http://evidence-service:8100", client=fake)
        outcome = client.classify_batch(claim="X.", sources=[("S1", "a")])
        assert outcome.ok is False
        assert outcome.failure == "malformed_response"


class TestNoAutomaticRetry:
    def test_a_single_failure_results_in_exactly_one_call(self) -> None:
        fake = _FakeHttpPoster(raises=httpx.TimeoutException("timed out"))
        client = EvidenceClient(base_url="http://evidence-service:8100", client=fake)
        client.classify_batch(claim="X.", sources=[("S1", "a")])
        assert len(fake.calls) == 1
