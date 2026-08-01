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
