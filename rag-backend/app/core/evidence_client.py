"""Milestone 11 (Evidence Service & Shadow Infrastructure Implementation)
§13 — the backend's HTTP client for the standalone evidence-service (see
evidence-service/ at the repo root — a wholly separate container, never
imported directly). Mirrors app/core/image_generation_service.py's
"injectable httpx client, wrap every failure into one typed outcome"
shape (that module's own docstring explains why raw httpx is used
directly here too, rather than the `ollama` package convention
llm_provider.py/embedding_provider.py use — this talks to a plain FastAPI
JSON API, not Ollama).

Fail-safe by design: every method here returns an EvidenceClassification
result type (never raises for a "the service said no"/timeout/overload
outcome) — see ClassificationOutcome. This matters because Milestone 11
§23 requires shadow-job failures to be completely invisible to the user;
a client that raised on every network hiccup would push that burden onto
every call site instead of centralizing it here once.

No automatic retry (Milestone 11 §13's explicit default: "no automatic
retry in shadow mode") — a retried call would double this service's CPU
cost for a mode whose entire value proposition is bounded, predictable
resource impact (Milestone 10 §25's contention analysis). A single
attempt, a client-side timeout, done.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Protocol

import httpx

NLILabel = Literal["entailment", "neutral", "contradiction"]

#: The fixed, named set of ways a classify_batch call can fail —
#: Milestone 11 §27's evidence_analysis_error/evidence_analysis_timeout
#: observability fields use this same vocabulary. "ok" is not a failure —
#: see ClassificationOutcome.failure, which is None exactly when ok.
FailureReason = Literal[
    "not_ready",
    "queue_full",
    "timeout",
    "unavailable",
    "invalid_request",
    "malformed_response",
    "unknown_error",
]


@dataclass(frozen=True)
class SourceRelationResult:
    source_id: str
    label: NLILabel
    probability_entailment: float
    probability_neutral: float
    probability_contradiction: float


@dataclass(frozen=True)
class ClassificationOutcome:
    """The one return type every EvidenceClient method uses — success and
    failure are both ordinary values, never an exception a caller must
    remember to catch (Milestone 11 §23's "shadow failure must be
    invisible" is far easier to guarantee when the client's own contract
    makes failure a plain, checkable field)."""

    ok: bool
    results: tuple[SourceRelationResult, ...] = ()
    model_id: str = ""
    model_revision: str = ""
    latency_ms: float = 0.0
    failure: FailureReason | None = None


class _HttpPoster(Protocol):
    def post(self, url: str, *, json: dict[str, object], timeout: float) -> httpx.Response: ...


def _normalize_label(raw: str) -> NLILabel:
    lowered = raw.lower()
    if lowered not in ("entailment", "neutral", "contradiction"):
        raise ValueError(f"unrecognized label from evidence service: {raw!r}")
    return lowered  # type: ignore[return-value]


class EvidenceClient:
    """One instance per process (see app/deps.py::get_evidence_client),
    matching every other external-service client in this codebase
    (OllamaLLMProvider, ImageGenerationService)."""

    def __init__(
        self,
        *,
        base_url: str,
        timeout_seconds: float = 2.5,
        client: _HttpPoster | None = None,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._timeout_seconds = timeout_seconds
        self._client: _HttpPoster = (
            client if client is not None else httpx.Client(timeout=timeout_seconds)
        )

    def classify_batch(
        self, *, claim: str, sources: list[tuple[str, str]]
    ) -> ClassificationOutcome:
        """`sources`: list of (source_id, text) pairs — the FINAL,
        already-prepared retrieval context (Milestone 10 §16: the
        generator's context is never filtered based on this call's
        result; this call only ever produces diagnostic labels).
        Never raises: every failure mode (connection refused, timeout,
        4xx/5xx, malformed JSON) is caught and returned as
        ClassificationOutcome(ok=False, failure=...) — see the class
        docstring."""
        if not sources:
            return ClassificationOutcome(ok=False, failure="invalid_request")

        payload = {
            "claim": claim,
            "sources": [{"source_id": sid, "text": text} for sid, text in sources],
        }
        try:
            response = self._client.post(
                f"{self._base_url}/classify_batch", json=payload, timeout=self._timeout_seconds
            )
        except httpx.TimeoutException:
            return ClassificationOutcome(ok=False, failure="timeout")
        except httpx.ConnectError:
            return ClassificationOutcome(ok=False, failure="unavailable")
        except httpx.HTTPError:
            return ClassificationOutcome(ok=False, failure="unknown_error")

        if response.status_code == 503:
            # The service itself distinguishes "not loaded yet" from
            # "queue full" in its own error body (evidence-service/
            # app/schemas.py's ErrorResponse.error) — read defensively,
            # since a body-parse failure here must not become an
            # unhandled exception either.
            try:
                error_code = response.json().get("error")
            except Exception:  # noqa: BLE001
                error_code = None
            return ClassificationOutcome(
                ok=False, failure="not_ready" if error_code == "not_ready" else "queue_full"
            )
        if response.status_code == 504:
            return ClassificationOutcome(ok=False, failure="timeout")
        if response.status_code == 400:
            return ClassificationOutcome(ok=False, failure="invalid_request")
        if response.status_code != 200:
            return ClassificationOutcome(ok=False, failure="unknown_error")

        try:
            body = response.json()
            results = tuple(
                SourceRelationResult(
                    source_id=item["source_id"],
                    label=_normalize_label(item["label"]),
                    probability_entailment=item["probabilities"]["entailment"],
                    probability_neutral=item["probabilities"]["neutral"],
                    probability_contradiction=item["probabilities"]["contradiction"],
                )
                for item in body["results"]
            )
            return ClassificationOutcome(
                ok=True,
                results=results,
                model_id=body["model_id"],
                model_revision=body["model_revision"],
                latency_ms=body["latency_ms"],
            )
        except (KeyError, ValueError, TypeError):
            return ClassificationOutcome(ok=False, failure="malformed_response")
