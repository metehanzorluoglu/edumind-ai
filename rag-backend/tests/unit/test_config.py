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


# --- LLM_PROVIDER=failover / automatic MS-S1 failover resilience -------


def _clear_llm_failover_env(monkeypatch) -> None:
    for name in ("LLM_PRIMARY_PROVIDER", "LLM_FALLBACK_PROVIDER", "LLM_FAILOVER_COOLDOWN_SECONDS"):
        monkeypatch.delenv(name, raising=False)


def test_llm_provider_accepts_failover_value(monkeypatch) -> None:
    """ "failover" is a new, additive third value — "ollama" and
    "openai_compatible" (tested above) keep their exact original meaning
    (a plain single provider, never any automatic fallback)."""
    _clear_llm_env(monkeypatch)
    _clear_llm_failover_env(monkeypatch)
    monkeypatch.setenv("LLM_PROVIDER", "failover")

    settings = Settings(jwt_secret=_JWT_SECRET)

    assert settings.llm_provider == "failover"


def test_llm_primary_and_fallback_provider_default_to_openai_compatible_and_ollama(
    monkeypatch,
) -> None:
    _clear_llm_env(monkeypatch)
    _clear_llm_failover_env(monkeypatch)

    settings = Settings(jwt_secret=_JWT_SECRET)

    assert settings.llm_primary_provider == "openai_compatible"
    assert settings.llm_fallback_provider == "ollama"


def test_llm_failover_refuses_identical_primary_and_fallback_provider(monkeypatch) -> None:
    """Failing over to the exact provider that just failed serves no
    purpose — refused at startup rather than silently accepted."""
    _clear_llm_env(monkeypatch)
    _clear_llm_failover_env(monkeypatch)
    monkeypatch.setenv("LLM_PROVIDER", "failover")
    monkeypatch.setenv("LLM_PRIMARY_PROVIDER", "ollama")
    monkeypatch.setenv("LLM_FALLBACK_PROVIDER", "ollama")

    with pytest.raises(ValidationError):
        Settings(jwt_secret=_JWT_SECRET)


def test_llm_failover_identical_roles_allowed_when_not_in_failover_mode(monkeypatch) -> None:
    """The validator only fires when LLM_PROVIDER=failover — an operator
    who never touches LLM_PRIMARY_PROVIDER/LLM_FALLBACK_PROVIDER at all
    (both left at their identical-looking defaults is impossible today,
    but nothing should ever depend on that) must not be blocked while
    running plain "ollama"/"openai_compatible" mode."""
    _clear_llm_env(monkeypatch)
    _clear_llm_failover_env(monkeypatch)
    monkeypatch.setenv("LLM_PROVIDER", "ollama")
    monkeypatch.setenv("LLM_PRIMARY_PROVIDER", "ollama")
    monkeypatch.setenv("LLM_FALLBACK_PROVIDER", "ollama")

    settings = Settings(jwt_secret=_JWT_SECRET)

    assert settings.llm_provider == "ollama"


def test_llm_failover_cooldown_seconds_defaults_to_20(monkeypatch) -> None:
    _clear_llm_env(monkeypatch)
    _clear_llm_failover_env(monkeypatch)

    settings = Settings(jwt_secret=_JWT_SECRET)

    assert settings.llm_failover_cooldown_seconds == 20.0


def test_llm_failover_cooldown_seconds_configurable_via_env_var(monkeypatch) -> None:
    _clear_llm_env(monkeypatch)
    _clear_llm_failover_env(monkeypatch)
    monkeypatch.setenv("LLM_FAILOVER_COOLDOWN_SECONDS", "5")

    settings = Settings(jwt_secret=_JWT_SECRET)

    assert settings.llm_failover_cooldown_seconds == 5.0


def test_effective_llm_model_in_failover_mode_follows_primary_role(monkeypatch) -> None:
    _clear_llm_env(monkeypatch)
    _clear_llm_failover_env(monkeypatch)
    monkeypatch.setenv("LLM_PROVIDER", "failover")
    monkeypatch.setenv("LLM_PRIMARY_PROVIDER", "openai_compatible")
    monkeypatch.setenv("LLM_FALLBACK_PROVIDER", "ollama")
    monkeypatch.setenv("LLM_MODEL", "Qwen/Qwen3-4B-Instruct-2507")
    monkeypatch.setenv("OLLAMA_LLM_MODEL", "qwen3:8b")

    settings = Settings(jwt_secret=_JWT_SECRET)

    assert settings.effective_llm_model == "Qwen/Qwen3-4B-Instruct-2507"


def test_effective_llm_model_in_failover_mode_follows_primary_role_when_ollama_is_primary(
    monkeypatch,
) -> None:
    """The primary/fallback roles are generic — even though production only
    ever configures openai_compatible as primary, effective_llm_model must
    still resolve correctly if the roles were ever reversed."""
    _clear_llm_env(monkeypatch)
    _clear_llm_failover_env(monkeypatch)
    monkeypatch.setenv("LLM_PROVIDER", "failover")
    monkeypatch.setenv("LLM_PRIMARY_PROVIDER", "ollama")
    monkeypatch.setenv("LLM_FALLBACK_PROVIDER", "openai_compatible")
    monkeypatch.setenv("LLM_MODEL", "Qwen/Qwen3-4B-Instruct-2507")
    monkeypatch.setenv("OLLAMA_LLM_MODEL", "qwen3:8b")

    settings = Settings(jwt_secret=_JWT_SECRET)

    assert settings.effective_llm_model == "qwen3:8b"
