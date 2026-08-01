"""Covers app/deps.py::get_llm_provider's Settings -> OllamaLLMProvider
wiring for OLLAMA_NUM_PREDICT — the actual env-var-to-live-provider path,
end to end, complementing tests/unit/test_config.py (Settings parsing only)
and tests/unit/core/test_llm_provider.py (OllamaLLMProvider's own
request-shaping, given an options dict directly)."""

from app.config import get_settings
from app.deps import get_llm_provider

_JWT_SECRET = "x" * 32  # Settings.jwt_secret is required (min_length=16); irrelevant here.


def _reset_caches() -> None:
    # get_settings and get_llm_provider are both @lru_cache'd singletons
    # (app/deps.py) — a real request never rebuilds them mid-process, but a
    # test that changes env vars between cases must clear both, or a later
    # test would silently see an earlier test's cached instance.
    get_settings.cache_clear()
    get_llm_provider.cache_clear()


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
