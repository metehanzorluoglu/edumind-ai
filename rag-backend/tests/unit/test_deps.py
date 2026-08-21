"""Covers app/deps.py::get_llm_provider's Settings -> OllamaLLMProvider
wiring for OLLAMA_NUM_PREDICT — the actual env-var-to-live-provider path,
end to end, complementing tests/unit/test_config.py (Settings parsing only)
and tests/unit/core/test_llm_provider.py (OllamaLLMProvider's own
request-shaping, given an options dict directly). Also covers the
LLM_PROVIDER switch (MS-S1 vLLM migration) selecting
OpenAICompatibleLLMProvider instead."""

from app.config import get_settings
from app.core.llm_provider import (
    FailoverLLMProvider,
    OllamaLLMProvider,
    OpenAICompatibleLLMProvider,
)
from app.deps import get_llm_provider

_JWT_SECRET = "x" * 32  # Settings.jwt_secret is required (min_length=16); irrelevant here.


def _reset_caches() -> None:
    # get_settings and get_llm_provider are both @lru_cache'd singletons
    # (app/deps.py) — a real request never rebuilds them mid-process, but a
    # test that changes env vars between cases must clear both, or a later
    # test would silently see an earlier test's cached instance.
    get_settings.cache_clear()
    get_llm_provider.cache_clear()


def _clear_llm_env(monkeypatch) -> None:
    for name in (
        "LLM_PROVIDER",
        "LLM_BASE_URL",
        "LLM_MODEL",
        "LLM_API_KEY",
        "LLM_PRIMARY_PROVIDER",
        "LLM_FALLBACK_PROVIDER",
        "LLM_FAILOVER_COOLDOWN_SECONDS",
    ):
        monkeypatch.delenv(name, raising=False)


def test_get_llm_provider_defaults_num_predict_to_512(monkeypatch) -> None:
    monkeypatch.setenv("JWT_SECRET", _JWT_SECRET)
    monkeypatch.delenv("OLLAMA_NUM_PREDICT", raising=False)
    _reset_caches()

    try:
        provider = get_llm_provider()
        assert provider._options == {"num_predict": 512}
    finally:
        _reset_caches()


def test_get_llm_provider_wires_num_predict_from_settings(monkeypatch) -> None:
    monkeypatch.setenv("JWT_SECRET", _JWT_SECRET)
    monkeypatch.setenv("OLLAMA_NUM_PREDICT", "777")
    _reset_caches()

    try:
        provider = get_llm_provider()
        assert provider._options == {"num_predict": 777}
    finally:
        _reset_caches()


def test_get_llm_provider_wires_thinking_and_num_predict_together(monkeypatch) -> None:
    """Both settings-driven parameters are threaded onto the same
    OllamaLLMProvider instance (see get_llm_provider) — proves neither
    wiring path overwrites the other."""
    monkeypatch.setenv("JWT_SECRET", _JWT_SECRET)
    monkeypatch.setenv("OLLAMA_THINKING_ENABLED", "true")
    monkeypatch.setenv("OLLAMA_NUM_PREDICT", "2048")
    _reset_caches()

    try:
        provider = get_llm_provider()
        assert provider._think is True
        assert provider._options == {"num_predict": 2048}
    finally:
        _reset_caches()


def test_get_llm_provider_defaults_to_ollama_when_llm_provider_unset(monkeypatch) -> None:
    """No LLM_PROVIDER set at all (every pre-existing deployment) must keep
    returning an OllamaLLMProvider — the whole point of this being an
    opt-in migration, not a breaking default change."""
    monkeypatch.setenv("JWT_SECRET", _JWT_SECRET)
    _clear_llm_env(monkeypatch)
    _reset_caches()

    try:
        provider = get_llm_provider()
        assert isinstance(provider, OllamaLLMProvider)
    finally:
        _reset_caches()


def test_get_llm_provider_selects_openai_compatible_from_settings(monkeypatch) -> None:
    """LLM_PROVIDER=openai_compatible (the MS-S1 vLLM migration) must wire
    LLM_BASE_URL/LLM_MODEL/LLM_API_KEY/LLM_REQUEST_TIMEOUT_SECONDS onto an
    OpenAICompatibleLLMProvider instead of OllamaLLMProvider — the actual
    env-var-to-live-provider path this migration adds."""
    monkeypatch.setenv("JWT_SECRET", _JWT_SECRET)
    _clear_llm_env(monkeypatch)
    monkeypatch.setenv("LLM_PROVIDER", "openai_compatible")
    monkeypatch.setenv("LLM_BASE_URL", "http://vllm.example.internal:8000/v1")
    monkeypatch.setenv("LLM_MODEL", "Qwen/Qwen3-4B-Instruct-2507")
    monkeypatch.setenv("LLM_API_KEY", "test-secret-key")
    monkeypatch.setenv("LLM_REQUEST_TIMEOUT_SECONDS", "45")
    _reset_caches()

    try:
        provider = get_llm_provider()
        assert isinstance(provider, OpenAICompatibleLLMProvider)
        assert provider._model == "Qwen/Qwen3-4B-Instruct-2507"
        assert provider._base_url == "http://vllm.example.internal:8000/v1"
        # The real secret must reach the provider (it needs the actual
        # value to authenticate) but must never appear anywhere else this
        # test can observe — see test_config.py's repr guard for the
        # complementary "never printed" check.
        assert provider._api_key == "test-secret-key"
    finally:
        _reset_caches()


def test_get_llm_provider_ollama_mode_is_never_wrapped_in_failover(monkeypatch) -> None:
    """Existing explicit LLM_PROVIDER=ollama must keep returning a plain
    OllamaLLMProvider — never wrapped in FailoverLLMProvider — even though
    LLM_PRIMARY_PROVIDER/LLM_FALLBACK_PROVIDER now exist as settings."""
    monkeypatch.setenv("JWT_SECRET", _JWT_SECRET)
    _clear_llm_env(monkeypatch)
    monkeypatch.setenv("LLM_PROVIDER", "ollama")
    _reset_caches()

    try:
        provider = get_llm_provider()
        assert isinstance(provider, OllamaLLMProvider)
        assert not isinstance(provider, FailoverLLMProvider)
    finally:
        _reset_caches()


def test_get_llm_provider_openai_compatible_mode_is_never_wrapped_in_failover(monkeypatch) -> None:
    """Existing explicit LLM_PROVIDER=openai_compatible must keep returning
    a plain OpenAICompatibleLLMProvider — MS-S1 only, no automatic
    fallback of any kind."""
    monkeypatch.setenv("JWT_SECRET", _JWT_SECRET)
    _clear_llm_env(monkeypatch)
    monkeypatch.setenv("LLM_PROVIDER", "openai_compatible")
    monkeypatch.setenv("LLM_BASE_URL", "http://vllm.example.internal:8000/v1")
    monkeypatch.setenv("LLM_MODEL", "Qwen/Qwen3-4B-Instruct-2507")
    monkeypatch.setenv("LLM_API_KEY", "test-secret-key")
    _reset_caches()

    try:
        provider = get_llm_provider()
        assert isinstance(provider, OpenAICompatibleLLMProvider)
        assert not isinstance(provider, FailoverLLMProvider)
    finally:
        _reset_caches()


def test_get_llm_provider_failover_mode_wraps_primary_and_fallback(monkeypatch) -> None:
    """LLM_PROVIDER=failover (the default LLM_PRIMARY_PROVIDER=
    openai_compatible/LLM_FALLBACK_PROVIDER=ollama roles) must build a
    FailoverLLMProvider wrapping one real OpenAICompatibleLLMProvider and
    one real OllamaLLMProvider, wired from the exact same settings a plain
    single-provider deployment would use."""
    monkeypatch.setenv("JWT_SECRET", _JWT_SECRET)
    _clear_llm_env(monkeypatch)
    monkeypatch.setenv("LLM_PROVIDER", "failover")
    monkeypatch.setenv("LLM_BASE_URL", "http://vllm.example.internal:8000/v1")
    monkeypatch.setenv("LLM_MODEL", "Qwen/Qwen3-4B-Instruct-2507")
    monkeypatch.setenv("LLM_API_KEY", "test-secret-key")
    monkeypatch.setenv("OLLAMA_LLM_MODEL", "qwen3:8b")
    monkeypatch.setenv("LLM_FAILOVER_COOLDOWN_SECONDS", "7")
    _reset_caches()

    try:
        provider = get_llm_provider()
        assert isinstance(provider, FailoverLLMProvider)
        assert isinstance(provider._primary, OpenAICompatibleLLMProvider)
        assert isinstance(provider._fallback, OllamaLLMProvider)
        assert provider._primary._base_url == "http://vllm.example.internal:8000/v1"
        assert provider._fallback._model == "qwen3:8b"
        assert provider._cooldown_seconds == 7.0
    finally:
        _reset_caches()


def test_get_llm_provider_failover_mode_respects_reversed_roles(monkeypatch) -> None:
    """The primary/fallback roles are read from settings, not hardcoded —
    reversing them must reverse which concrete class plays which role."""
    monkeypatch.setenv("JWT_SECRET", _JWT_SECRET)
    _clear_llm_env(monkeypatch)
    monkeypatch.setenv("LLM_PROVIDER", "failover")
    monkeypatch.setenv("LLM_PRIMARY_PROVIDER", "ollama")
    monkeypatch.setenv("LLM_FALLBACK_PROVIDER", "openai_compatible")
    monkeypatch.setenv("LLM_BASE_URL", "http://vllm.example.internal:8000/v1")
    monkeypatch.setenv("LLM_API_KEY", "test-secret-key")
    _reset_caches()

    try:
        provider = get_llm_provider()
        assert isinstance(provider, FailoverLLMProvider)
        assert isinstance(provider._primary, OllamaLLMProvider)
        assert isinstance(provider._fallback, OpenAICompatibleLLMProvider)
    finally:
        _reset_caches()
