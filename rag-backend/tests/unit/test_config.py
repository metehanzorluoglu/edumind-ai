"""Covers the OLLAMA_THINKING_ENABLED and OLLAMA_NUM_PREDICT settings:
default values and env-var parsing. See app/core/llm_provider.py's
OllamaLLMProvider(think=..., options={"num_predict": ...}) wiring in
app/deps.py::get_llm_provider for how these flow into a live chat call.
"""

import pytest
from pydantic import ValidationError

from app.config import Settings

_JWT_SECRET = "x" * 32  # Settings.jwt_secret is required (min_length=16); irrelevant here.


def test_thinking_disabled_by_default(monkeypatch) -> None:
    monkeypatch.delenv("OLLAMA_THINKING_ENABLED", raising=False)

    settings = Settings(jwt_secret=_JWT_SECRET)

    assert settings.ollama_thinking_enabled is False


def test_thinking_enabled_via_env_var(monkeypatch) -> None:
    monkeypatch.setenv("OLLAMA_THINKING_ENABLED", "true")

    settings = Settings(jwt_secret=_JWT_SECRET)

    assert settings.ollama_thinking_enabled is True


def test_thinking_disabled_via_env_var_explicit_false(monkeypatch) -> None:
    monkeypatch.setenv("OLLAMA_THINKING_ENABLED", "false")

    settings = Settings(jwt_secret=_JWT_SECRET)

    assert settings.ollama_thinking_enabled is False


def test_num_predict_defaults_to_512(monkeypatch) -> None:
    monkeypatch.delenv("OLLAMA_NUM_PREDICT", raising=False)

    settings = Settings(jwt_secret=_JWT_SECRET)

    assert settings.ollama_num_predict == 512


def test_num_predict_configurable_via_env_var(monkeypatch) -> None:
    monkeypatch.setenv("OLLAMA_NUM_PREDICT", "1024")

    settings = Settings(jwt_secret=_JWT_SECRET)

    assert settings.ollama_num_predict == 1024


def test_num_predict_rejects_non_positive_values(monkeypatch) -> None:
    monkeypatch.setenv("OLLAMA_NUM_PREDICT", "0")

    with pytest.raises(ValidationError):
        Settings(jwt_secret=_JWT_SECRET)


def test_embedding_batch_size_defaults_to_32(monkeypatch) -> None:
    monkeypatch.delenv("EMBEDDING_BATCH_SIZE", raising=False)

    settings = Settings(jwt_secret=_JWT_SECRET)

    assert settings.embedding_batch_size == 32


def test_embedding_batch_size_configurable_via_env_var(monkeypatch) -> None:
    monkeypatch.setenv("EMBEDDING_BATCH_SIZE", "16")

    settings = Settings(jwt_secret=_JWT_SECRET)

    assert settings.embedding_batch_size == 16


def test_embedding_batch_size_rejects_non_positive_values(monkeypatch) -> None:
    monkeypatch.setenv("EMBEDDING_BATCH_SIZE", "0")

    with pytest.raises(ValidationError):
        Settings(jwt_secret=_JWT_SECRET)


# --- LLM_PROVIDER / MS-S1 vLLM migration --------------------------------


def _clear_llm_env(monkeypatch) -> None:
    for name in ("LLM_PROVIDER", "LLM_BASE_URL", "LLM_MODEL", "LLM_API_KEY"):
        monkeypatch.delenv(name, raising=False)


def test_llm_provider_defaults_to_ollama(monkeypatch) -> None:
    """The original, unchanged behavior for every deployment that doesn't
    opt into the MS-S1 vLLM migration: no LLM_PROVIDER set at all."""
    _clear_llm_env(monkeypatch)

    settings = Settings(jwt_secret=_JWT_SECRET)

    assert settings.llm_provider == "ollama"
    assert settings.effective_llm_model == settings.ollama_llm_model


def test_llm_provider_configurable_via_env_var(monkeypatch) -> None:
    _clear_llm_env(monkeypatch)
    monkeypatch.setenv("LLM_PROVIDER", "openai_compatible")

    settings = Settings(jwt_secret=_JWT_SECRET)

    assert settings.llm_provider == "openai_compatible"


def test_llm_provider_rejects_unknown_value(monkeypatch) -> None:
    _clear_llm_env(monkeypatch)
    monkeypatch.setenv("LLM_PROVIDER", "anthropic")

    with pytest.raises(ValidationError):
        Settings(jwt_secret=_JWT_SECRET)


def test_llm_base_url_model_and_api_key_configurable_via_env_vars(monkeypatch) -> None:
    """Never asserts against the real MS-S1 host — a placeholder value
    proves the env vars are wired through Settings at all."""
    _clear_llm_env(monkeypatch)
    monkeypatch.setenv("LLM_BASE_URL", "http://vllm.example.internal:8000/v1")
    monkeypatch.setenv("LLM_MODEL", "Qwen/Qwen3-4B-Instruct-2507")
    monkeypatch.setenv("LLM_API_KEY", "test-secret-key")

    settings = Settings(jwt_secret=_JWT_SECRET)

    assert settings.llm_base_url == "http://vllm.example.internal:8000/v1"
    assert settings.llm_model == "Qwen/Qwen3-4B-Instruct-2507"
    assert settings.llm_api_key.get_secret_value() == "test-secret-key"


def test_llm_api_key_never_defaults_to_a_real_looking_secret(monkeypatch) -> None:
    _clear_llm_env(monkeypatch)

    settings = Settings(jwt_secret=_JWT_SECRET)

    assert settings.llm_api_key.get_secret_value() == ""


def test_effective_llm_model_follows_llm_provider_selection(monkeypatch) -> None:
    _clear_llm_env(monkeypatch)
    monkeypatch.setenv("LLM_PROVIDER", "openai_compatible")
    monkeypatch.setenv("LLM_MODEL", "Qwen/Qwen3-4B-Instruct-2507")
    monkeypatch.setenv("OLLAMA_LLM_MODEL", "qwen3:8b")

    settings = Settings(jwt_secret=_JWT_SECRET)

    assert settings.effective_llm_model == "Qwen/Qwen3-4B-Instruct-2507"


def test_settings_repr_never_contains_llm_api_key(monkeypatch) -> None:
    """A crude but real guard against the secret leaking into whatever
    incidentally calls repr()/str() on a live Settings instance (an
    unhandled-exception traceback frame, a debug log line, ...)."""
    _clear_llm_env(monkeypatch)
    monkeypatch.setenv("LLM_API_KEY", "super-secret-vllm-key")

    settings = Settings(jwt_secret=_JWT_SECRET)

    assert "super-secret-vllm-key" not in repr(settings)
