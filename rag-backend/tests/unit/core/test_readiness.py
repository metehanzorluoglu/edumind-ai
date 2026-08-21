"""Covers app/core/readiness.py::check_readiness — both the original
Ollama-only path (byte-for-byte unchanged for a caller that doesn't pass
any llm_provider="openai_compatible" params) and the MS-S1 vLLM migration's
new chat-LLM-specific reachability check, which is independent of the
Ollama check whenever the two are actually different servers."""

from dataclasses import dataclass

import httpx

from app.core.readiness import check_readiness

_API_KEY = "test-secret-vllm-key"


@dataclass
class _FakeModel:
    model: str | None


@dataclass
class _FakeListResponse:
    models: list[_FakeModel]


class _FakeOllamaClient:
    def __init__(self, *, installed: list[str] | None = None, fails: bool = False) -> None:
        self._installed = installed or []
        self._fails = fails

    def list(self) -> _FakeListResponse:
        if self._fails:
            raise ConnectionError("ollama unreachable")
        return _FakeListResponse(models=[_FakeModel(model=name) for name in self._installed])


class _FakeModelsResponse:
    def __init__(self, *, status_code: int = 200, json_body: object = None) -> None:
        self.status_code = status_code
        self._json_body = json_body

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            request = httpx.Request("GET", "http://vllm.test/v1/models")
            raise httpx.HTTPStatusError("error", request=request, response=self)  # type: ignore[arg-type]

    def json(self) -> object:
        return self._json_body


class _FakeOpenAICompatibleClient:
    def __init__(self, response: _FakeModelsResponse) -> None:
        self.response = response
        self.calls: list[dict[str, object]] = []

    def get(self, url: str, *, headers: dict[str, str]) -> _FakeModelsResponse:
        self.calls.append({"url": url, "headers": headers})
        return self.response


def test_ollama_provider_path_is_unchanged_when_reachable() -> None:
    """The default llm_provider="ollama" must produce the exact same
    ollama_reachable/models_available/is_ready contract this function had
    before the MS-S1 migration — no second network call, no new required
    param."""
    ollama_client = _FakeOllamaClient(installed=["qwen3:8b", "mxbai-embed-large"])

    status = check_readiness(
        ollama_base_url="http://ollama:11434",
        required_models=["qwen3:8b", "mxbai-embed-large"],
        vector_store=None,
        ollama_client=ollama_client,
    )

    assert status.ollama_reachable is True
    assert status.models_available == {"qwen3:8b": True, "mxbai-embed-large": True}
    assert status.llm_provider == "ollama"


def test_ollama_provider_llm_reachability_mirrors_ollama_check() -> None:
    """When llm_provider="ollama" (the default), llm_reachable/
    llm_model_available must mirror the single Ollama round trip already
    made — never a second call."""
    ollama_client = _FakeOllamaClient(installed=["qwen3:8b", "mxbai-embed-large"])

    status = check_readiness(
        ollama_base_url="http://ollama:11434",
        required_models=["qwen3:8b", "mxbai-embed-large"],
        vector_store=None,
        ollama_client=ollama_client,
        llm_provider="ollama",
        llm_model="qwen3:8b",
    )

    assert status.llm_reachable is True
    assert status.llm_model_available is True


def test_ollama_unreachable_marks_not_ready() -> None:
    ollama_client = _FakeOllamaClient(fails=True)

    status = check_readiness(
        ollama_base_url="http://ollama:11434",
        required_models=["qwen3:8b"],
        vector_store=None,
        ollama_client=ollama_client,
    )

    assert status.ollama_reachable is False
    assert status.ollama_latency_ms is None
    assert status.is_ready is False


def test_openai_compatible_llm_reachable_and_model_available() -> None:
    """The MS-S1 vLLM migration's actual new path: llm_provider=
    "openai_compatible" checks GET /v1/models with Bearer auth against
    LLM_BASE_URL, independent of the Ollama server (still checked
    separately for embeddings/vision via required_models)."""
    ollama_client = _FakeOllamaClient(installed=["mxbai-embed-large"])
    llm_client = _FakeOpenAICompatibleClient(
        _FakeModelsResponse(json_body={"data": [{"id": "Qwen/Qwen3-4B-Instruct-2507"}]})
    )

    status = check_readiness(
        ollama_base_url="http://ollama:11434",
        required_models=["mxbai-embed-large"],
        vector_store=None,
        ollama_client=ollama_client,
        llm_provider="openai_compatible",
        llm_model="Qwen/Qwen3-4B-Instruct-2507",
        llm_base_url="http://100.73.9.108:8000/v1",
        llm_api_key=_API_KEY,
        llm_client=llm_client,
    )

    assert status.llm_provider == "openai_compatible"
    assert status.llm_reachable is True
    assert status.llm_model_available is True
    # Embedding/vision reachability is still the Ollama server's own check,
    # entirely unaffected by the chat LLM living elsewhere.
    assert status.ollama_reachable is True
    assert status.models_available == {"mxbai-embed-large": True}


def test_openai_compatible_sends_bearer_auth_header() -> None:
    llm_client = _FakeOpenAICompatibleClient(_FakeModelsResponse(json_body={"data": []}))

    check_readiness(
        ollama_base_url="http://ollama:11434",
        required_models=[],
        vector_store=None,
        ollama_client=_FakeOllamaClient(installed=[]),
        llm_provider="openai_compatible",
        llm_model="Qwen/Qwen3-4B-Instruct-2507",
        llm_base_url="http://100.73.9.108:8000/v1",
        llm_api_key=_API_KEY,
        llm_client=llm_client,
    )

    assert llm_client.calls[0]["headers"] == {"Authorization": f"Bearer {_API_KEY}"}
    assert llm_client.calls[0]["url"] == "http://100.73.9.108:8000/v1/models"


def test_openai_compatible_wrong_api_key_marks_llm_unreachable() -> None:
    llm_client = _FakeOpenAICompatibleClient(_FakeModelsResponse(status_code=401))

    status = check_readiness(
        ollama_base_url="http://ollama:11434",
        required_models=[],
        vector_store=None,
        ollama_client=_FakeOllamaClient(installed=[]),
        llm_provider="openai_compatible",
        llm_model="Qwen/Qwen3-4B-Instruct-2507",
        llm_base_url="http://100.73.9.108:8000/v1",
        llm_api_key="wrong-key",
        llm_client=llm_client,
    )

    assert status.llm_reachable is False
    assert status.llm_latency_ms is None
    assert status.llm_model_available is False
    assert status.is_ready is False


def test_openai_compatible_unreachable_server_marks_not_ready() -> None:
    class _UnreachableClient:
        def get(self, url: str, *, headers: dict[str, str]) -> _FakeModelsResponse:
            raise httpx.ConnectError("connection refused")

    status = check_readiness(
        ollama_base_url="http://ollama:11434",
        required_models=[],
        vector_store=None,
        ollama_client=_FakeOllamaClient(installed=[]),
        llm_provider="openai_compatible",
        llm_model="Qwen/Qwen3-4B-Instruct-2507",
        llm_base_url="http://100.73.9.108:8000/v1",
        llm_api_key=_API_KEY,
        llm_client=_UnreachableClient(),  # type: ignore[arg-type]
    )

    assert status.llm_reachable is False
    assert status.is_ready is False


def test_failover_prefers_primary_when_both_reachable() -> None:
    """MS-S1 automatic-failover resilience work: llm_provider="failover"
    probes both roles independently and reports "primary" as currently
    preferred when it's reachable, mirroring
    FailoverLLMProvider._primary_available_now()'s own real decision
    (this is a separate, dedicated readiness/status probe — see
    check_readiness's own docstring for why duplicating one cheap call
    here is fine even though the live per-chat-request path never does
    this)."""
    ollama_client = _FakeOllamaClient(installed=["qwen3:8b", "mxbai-embed-large"])
    llm_client = _FakeOpenAICompatibleClient(
        _FakeModelsResponse(json_body={"data": [{"id": "Qwen/Qwen3-4B-Instruct-2507"}]})
    )

    status = check_readiness(
        ollama_base_url="http://ollama:11434",
        required_models=["mxbai-embed-large"],
        vector_store=None,
        ollama_client=ollama_client,
        llm_provider="failover",
        llm_base_url="http://100.73.9.108:8000/v1",
        llm_api_key=_API_KEY,
        llm_client=llm_client,
        llm_primary_provider="openai_compatible",
        llm_primary_model="Qwen/Qwen3-4B-Instruct-2507",
        llm_fallback_model="qwen3:8b",
    )

    assert status.llm_provider == "failover"
    assert status.llm_primary_provider == "openai_compatible"
    assert status.llm_primary_reachable is True
    assert status.llm_fallback_provider == "ollama"
    assert status.llm_fallback_reachable is True
    assert status.llm_currently_preferred == "primary"
    # llm_reachable/llm_model_available (not the whole-system is_ready,
    # which also depends on qdrant_reachable — orthogonal to LLM failover
    # and not exercised here with vector_store=None) is what actually
    # captures "chat generation can currently be served".
    assert status.llm_reachable is True
    assert status.llm_model_available is True


def test_failover_prefers_fallback_when_primary_unreachable() -> None:
    """The primary being down must not make the whole system not_ready as
    long as the fallback can still serve chat — that's the entire point
    of automatic failover."""

    class _UnreachablePrimaryClient:
        def get(self, url: str, *, headers: dict[str, str]) -> _FakeModelsResponse:
            raise httpx.ConnectError("MS-S1 unreachable")

    ollama_client = _FakeOllamaClient(installed=["qwen3:8b", "mxbai-embed-large"])

    status = check_readiness(
        ollama_base_url="http://ollama:11434",
        required_models=["mxbai-embed-large"],
        vector_store=None,
        ollama_client=ollama_client,
        llm_provider="failover",
        llm_base_url="http://100.73.9.108:8000/v1",
        llm_api_key=_API_KEY,
        llm_client=_UnreachablePrimaryClient(),  # type: ignore[arg-type]
        llm_primary_provider="openai_compatible",
        llm_primary_model="Qwen/Qwen3-4B-Instruct-2507",
        llm_fallback_model="qwen3:8b",
    )

    assert status.llm_primary_reachable is False
    assert status.llm_fallback_reachable is True
    assert status.llm_currently_preferred == "fallback"
    # The primary being down must not make chat-serving readiness False —
    # that's the entire point of automatic failover (see
    # test_failover_not_ready_when_both_primary_and_fallback_unreachable
    # below for the case where it correctly does go False).
    assert status.llm_reachable is True
    assert status.llm_model_available is True


def test_failover_not_ready_when_both_primary_and_fallback_unreachable() -> None:
    class _UnreachablePrimaryClient:
        def get(self, url: str, *, headers: dict[str, str]) -> _FakeModelsResponse:
            raise httpx.ConnectError("MS-S1 unreachable")

    status = check_readiness(
        ollama_base_url="http://ollama:11434",
        required_models=[],
        vector_store=None,
        ollama_client=_FakeOllamaClient(fails=True),
        llm_provider="failover",
        llm_base_url="http://100.73.9.108:8000/v1",
        llm_api_key=_API_KEY,
        llm_client=_UnreachablePrimaryClient(),  # type: ignore[arg-type]
        llm_primary_provider="openai_compatible",
        llm_primary_model="Qwen/Qwen3-4B-Instruct-2507",
        llm_fallback_model="qwen3:8b",
    )

    assert status.llm_primary_reachable is False
    assert status.llm_fallback_reachable is False
    assert status.llm_currently_preferred == "fallback"
    assert status.llm_reachable is False
    assert status.is_ready is False


def test_failover_with_ollama_as_primary_role_reversed() -> None:
    """The primary/fallback roles are read from the caller's
    llm_primary_provider, not hardcoded — reversing them must reverse
    which check backs "primary" vs "fallback"."""
    ollama_client = _FakeOllamaClient(installed=["qwen3:8b"])
    llm_client = _FakeOpenAICompatibleClient(
        _FakeModelsResponse(json_body={"data": [{"id": "Qwen/Qwen3-4B-Instruct-2507"}]})
    )

    status = check_readiness(
        ollama_base_url="http://ollama:11434",
        required_models=[],
        vector_store=None,
        ollama_client=ollama_client,
        llm_provider="failover",
        llm_base_url="http://100.73.9.108:8000/v1",
        llm_api_key=_API_KEY,
        llm_client=llm_client,
        llm_primary_provider="ollama",
        llm_primary_model="qwen3:8b",
        llm_fallback_model="Qwen/Qwen3-4B-Instruct-2507",
    )

    assert status.llm_primary_provider == "ollama"
    assert status.llm_fallback_provider == "openai_compatible"
    assert status.llm_primary_reachable is True
    assert status.llm_fallback_reachable is True
    assert status.llm_currently_preferred == "primary"


def test_openai_compatible_model_missing_from_server_reports_unavailable() -> None:
    llm_client = _FakeOpenAICompatibleClient(
        _FakeModelsResponse(json_body={"data": [{"id": "some-other-model"}]})
    )

    status = check_readiness(
        ollama_base_url="http://ollama:11434",
        required_models=[],
        vector_store=None,
        ollama_client=_FakeOllamaClient(installed=[]),
        llm_provider="openai_compatible",
        llm_model="Qwen/Qwen3-4B-Instruct-2507",
        llm_base_url="http://100.73.9.108:8000/v1",
        llm_api_key=_API_KEY,
        llm_client=llm_client,
    )

    assert status.llm_reachable is True
    assert status.llm_model_available is False
    assert status.is_ready is False
