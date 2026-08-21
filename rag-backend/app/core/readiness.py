import logging
import time
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Protocol

import httpx
import ollama

from app.vectorstore.qdrant_client import QdrantVectorStore

logger = logging.getLogger(__name__)


class _ModelLike(Protocol):
    @property
    def model(self) -> str | None: ...


class _ListResponseLike(Protocol):
    @property
    def models(self) -> Sequence[_ModelLike]: ...


class _ListableClient(Protocol):
    def list(self) -> _ListResponseLike: ...


@dataclass
class ReadinessStatus:
    ollama_reachable: bool
    qdrant_reachable: bool
    models_available: dict[str, bool]
    # None when the corresponding service wasn't reachable at all
    # (milestone V4 — a Settings/Developer page metric): a failed or
    # timed-out call has no meaningful "how long did it take" answer, so
    # this is never populated with a failed attempt's elapsed time.
    ollama_latency_ms: float | None = None
    qdrant_latency_ms: float | None = None
    # --- Chat LLM readiness (MS-S1 vLLM migration) -----------------------
    # Independent of ollama_reachable/models_available above whenever
    # Settings.llm_provider="openai_compatible" points chat generation at
    # a *different* server than the one serving embeddings/vision — see
    # check_readiness below. When llm_provider="ollama" (the default),
    # these mirror the Ollama check exactly (same server, same one round
    # trip), so nothing about the original behavior changes for a caller
    # that only looks at ollama_reachable/models_available.
    llm_provider: str = "ollama"
    llm_reachable: bool = False
    llm_latency_ms: float | None = None
    llm_model_available: bool = False
    # --- Automatic LLM failover observability (MS-S1 resilience work) ----
    # All None/unset unless llm_provider == "failover" — the plain
    # "ollama"/"openai_compatible" modes above are entirely unaffected and
    # leave these at their defaults, matching every other additive field
    # this dataclass has picked up over time. `llm_reachable` above already
    # reports "can chat generation be served AT ALL right now" (true if
    # EITHER role is reachable) for is_ready's purposes; these fields exist
    # so a caller (GET /health/ready, GET /status) can additionally show
    # *which* provider that is, and whether the other one is also healthy.
    llm_primary_provider: str | None = None
    llm_primary_reachable: bool | None = None
    llm_fallback_provider: str | None = None
    llm_fallback_reachable: bool | None = None
    # "primary" | "fallback" — which provider a new chat request would
    # actually be served by right now, mirroring
    # FailoverLLMProvider._primary_available_now()'s own decision (a fresh
    # probe made here, not a read of that live in-process cooldown state —
    # see check_readiness's module-level docstring note below).
    llm_currently_preferred: str | None = None

    @property
    def is_ready(self) -> bool:
        return (
            self.ollama_reachable
            and self.qdrant_reachable
            and self.llm_reachable
            and self.llm_model_available
            and all(self.models_available.values())
        )


def _model_installed(required: str, installed_names: set[str]) -> bool:
    return any(name == required or name.startswith(f"{required}:") for name in installed_names)


@dataclass
class _OllamaCheckResult:
    reachable: bool
    latency_ms: float | None
    models_available: dict[str, bool]
    installed_names: set[str] = field(default_factory=set)


def _check_ollama(
    *,
    ollama_base_url: str,
    required_models: list[str],
    ollama_client: _ListableClient | None,
) -> _OllamaCheckResult:
    try:
        client = ollama_client if ollama_client is not None else ollama.Client(host=ollama_base_url)
        started_at = time.monotonic()
        response = client.list()
        latency_ms = (time.monotonic() - started_at) * 1000
        installed_names = {model.model for model in response.models if model.model}
        return _OllamaCheckResult(
            reachable=True,
            latency_ms=latency_ms,
            models_available={
                required: _model_installed(required, installed_names)
                for required in required_models
            },
            installed_names=installed_names,
        )
    except Exception:
        return _OllamaCheckResult(
            reachable=False,
            latency_ms=None,
            models_available=dict.fromkeys(required_models, False),
        )


class _OpenAICompatibleListClient(Protocol):
    def get(self, url: str, *, headers: dict[str, str]) -> httpx.Response: ...


def _check_openai_compatible_llm(
    *,
    base_url: str,
    api_key: str,
    model: str,
    client: _OpenAICompatibleListClient | None,
) -> tuple[bool, float | None, bool]:
    """Returns (reachable, latency_ms, model_available) for an
    OpenAI-compatible server's `GET /v1/models` — the cheapest real call
    that both confirms the server (and the configured Bearer token) work
    and reports which model ids it currently serves, mirroring what
    _check_ollama's `client.list()` call does for Ollama. Never raises:
    any failure (unreachable, timeout, wrong API key, malformed body)
    reports as (False, None, False) — this is a readiness probe, not a
    place to surface an exception."""
    try:
        http_client = client if client is not None else httpx.Client(timeout=5.0)
        started_at = time.monotonic()
        response = http_client.get(
            f"{base_url.rstrip('/')}/models", headers={"Authorization": f"Bearer {api_key}"}
        )
        response.raise_for_status()
        latency_ms = (time.monotonic() - started_at) * 1000
        body = response.json()
        installed_ids = {
            item.get("id")
            for item in (body.get("data") or [])
            if isinstance(item, dict) and item.get("id")
        }
        return True, latency_ms, model in installed_ids
    except Exception:
        return False, None, False


def check_readiness(
    *,
    ollama_base_url: str,
    required_models: list[str],
    vector_store: QdrantVectorStore | None,
    ollama_client: _ListableClient | None = None,
    llm_provider: str = "ollama",
    llm_model: str | None = None,
    llm_base_url: str | None = None,
    llm_api_key: str = "",
    llm_client: _OpenAICompatibleListClient | None = None,
    llm_primary_provider: str | None = None,
    llm_primary_model: str | None = None,
    llm_fallback_model: str | None = None,
) -> ReadinessStatus:
    """`required_models` covers whatever this deployment always serves via
    Ollama (embeddings, vision, image generation) — it should NOT include
    the chat LLM's own model name when llm_provider="openai_compatible" or
    "failover", since that model doesn't (necessarily) live on the Ollama
    server at all; the caller (see app/api/routes_health.py/
    routes_status.py) decides that.

    `llm_model`/`llm_base_url`/`llm_api_key`/`llm_client` are only read
    when llm_provider="openai_compatible" — a caller that leaves
    llm_provider at its default "ollama" gets the exact same single Ollama
    round trip this function always made, with the chat LLM's reachability/
    model-availability simply mirrored from that same call (see below),
    never a second network call. Both untouched, byte-for-byte, by the
    "failover" mode added below.

    `llm_primary_provider`/`llm_primary_model`/`llm_fallback_model` are
    only read when llm_provider="failover" (MS-S1 automatic-failover
    resilience work): this probes BOTH the primary and the fallback
    (reusing `llm_base_url`/`llm_api_key`/`llm_client` for whichever role
    is "openai_compatible", and `ollama_result` below for whichever role
    is "ollama" — never a third, separate configuration surface). This is
    a deliberately different tradeoff from FailoverLLMProvider's own
    "never health-check ahead of a real request" design: GET /health/ready
    and GET /status are themselves already dedicated, separately-polled
    health-check endpoints (not part of the per-chat-message path this
    migration's design explicitly protects), so probing both providers
    here is the same cost this function already paid for the plain
    "openai_compatible" mode above, just duplicated across two providers
    instead of one — it does not add a round trip to any chat request."""
    ollama_result = _check_ollama(
        ollama_base_url=ollama_base_url,
        required_models=required_models,
        ollama_client=ollama_client,
    )

    primary_provider_label: str | None = None
    fallback_provider_label: str | None = None
    primary_reachable: bool | None = None
    fallback_reachable: bool | None = None
    currently_preferred: str | None = None

    if llm_provider == "failover":
        primary_provider_label = llm_primary_provider or "openai_compatible"
        fallback_provider_label = (
            "ollama" if primary_provider_label == "openai_compatible" else "openai_compatible"
        )

        def _check_role(kind: str, model: str | None) -> tuple[bool, float | None, bool]:
            if kind == "openai_compatible":
                return _check_openai_compatible_llm(
                    base_url=llm_base_url or "",
                    api_key=llm_api_key,
                    model=model or "",
                    client=llm_client,
                )
            reachable = ollama_result.reachable
            latency_ms = ollama_result.latency_ms
            model_available = (
                _model_installed(model, ollama_result.installed_names)
                if model and ollama_result.reachable
                else False
            )
            return reachable, latency_ms, model_available

        primary_reachable, primary_latency_ms, primary_model_available = _check_role(
            primary_provider_label, llm_primary_model
        )
        fallback_reachable, fallback_latency_ms, fallback_model_available = _check_role(
            fallback_provider_label, llm_fallback_model
        )

        currently_preferred = "primary" if primary_reachable else "fallback"
        llm_reachable = primary_reachable or fallback_reachable
        llm_model_available = (
            primary_model_available if primary_reachable else fallback_model_available
        )
        llm_latency_ms = primary_latency_ms if primary_reachable else fallback_latency_ms
    elif llm_provider == "openai_compatible":
        llm_reachable, llm_latency_ms, llm_model_available = _check_openai_compatible_llm(
            base_url=llm_base_url or "",
            api_key=llm_api_key,
            model=llm_model or "",
            client=llm_client,
        )
    else:
        llm_reachable = ollama_result.reachable
        llm_latency_ms = ollama_result.latency_ms
        llm_model_available = (
            _model_installed(llm_model, ollama_result.installed_names)
            if llm_model and ollama_result.reachable
            else False
        )

    # vector_store is None when even constructing the store failed (e.g. a
    # local/embedded store whose on-disk path is already locked open by
    # this same process's own singleton) — that failure means Qdrant is
    # not usably reachable, same as a ping() failure below.
    qdrant_reachable = False
    qdrant_latency_ms: float | None = None
    if vector_store is not None:
        try:
            started_at = time.monotonic()
            vector_store.ping()
            qdrant_latency_ms = (time.monotonic() - started_at) * 1000
            qdrant_reachable = True
        except Exception as exc:
            logger.warning("Qdrant ping failed during readiness check: %s", exc)
            qdrant_reachable = False
            qdrant_latency_ms = None

    return ReadinessStatus(
        ollama_reachable=ollama_result.reachable,
        qdrant_reachable=qdrant_reachable,
        models_available=ollama_result.models_available,
        ollama_latency_ms=ollama_result.latency_ms,
        qdrant_latency_ms=qdrant_latency_ms,
        llm_provider=llm_provider,
        llm_reachable=llm_reachable,
        llm_latency_ms=llm_latency_ms,
        llm_model_available=llm_model_available,
        llm_primary_provider=primary_provider_label,
        llm_primary_reachable=primary_reachable,
        llm_fallback_provider=fallback_provider_label,
        llm_fallback_reachable=fallback_reachable,
        llm_currently_preferred=currently_preferred,
    )
