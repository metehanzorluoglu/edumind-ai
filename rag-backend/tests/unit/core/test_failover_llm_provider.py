"""Covers app/core/llm_provider.py::FailoverLLMProvider — the MS-S1
automatic-failover resilience work. Uses plain fake LLMProvider-shaped
test doubles (not httpx-shaped ones — see test_openai_compatible_llm_
provider.py for that layer, which is unchanged by this module) so the
failover decision logic itself is exercised directly, independent of any
one concrete provider's own request/response shape.

Covers, at minimum, every scenario the migration's design explicitly
calls out: primary healthy -> primary used; primary unreachable/timeout/
5xx before any token -> fallback used; primary emits tokens then fails ->
NO fallback (the critical streaming-safety rule); 401/403 -> NO silent
fallback; cancellation -> no unexpected fallback; both providers
unavailable -> a controlled error; recovery -> the very next call prefers
the primary again; RAG prompt content passed through unchanged; the API
key never appears in any log line this class emits."""

import logging
from collections.abc import Iterator, Mapping

import httpx
import pytest

from app.core.errors import LLMErrorCategory, LLMProviderError
from app.core.llm_provider import FailoverLLMProvider, OpenAICompatibleLLMProvider
from app.core.request_timing import RequestTimer


class _FakeProvider:
    """A minimal LLMProvider test double: yields `tokens`, then (if
    `error` is set) raises it. Records every call's kwargs so tests can
    assert exactly what reached this provider (prompt content,
    options_override, timer)."""

    def __init__(
        self,
        *,
        tokens: list[str] | None = None,
        error: Exception | None = None,
        results: list[tuple[list[str], Exception | None]] | None = None,
    ) -> None:
        """`results`, when given, overrides `tokens`/`error` with a queue of
        (tokens, error) pairs consumed one per call — used to simulate a
        provider that fails on its first call and recovers on a later one
        (see the recovery tests below). Falls back to always returning the
        same (tokens, error) pair when `results` is None."""
        self._results = results
        self._tokens = tokens or []
        self._error = error
        self.calls: list[dict[str, object]] = []
        self.closed = False

    def stream_chat(
        self,
        *,
        system_prompt: str,
        user_prompt: str,
        timer: RequestTimer | None = None,
        options_override: Mapping[str, object] | None = None,
    ) -> Iterator[str]:
        self.calls.append(
            {
                "system_prompt": system_prompt,
                "user_prompt": user_prompt,
                "options_override": dict(options_override) if options_override else None,
            }
        )
        if self._results is not None:
            tokens, error = self._results[len(self.calls) - 1]
        else:
            tokens, error = self._tokens, self._error
        try:
            yield from tokens
            if error is not None:
                raise error
        except GeneratorExit:
            self.closed = True
            raise


def _infra_error(message: str = "unreachable") -> LLMProviderError:
    return LLMProviderError(message, category=LLMErrorCategory.INFRASTRUCTURE)


def _config_error(message: str = "bad api key") -> LLMProviderError:
    return LLMProviderError(message, category=LLMErrorCategory.CONFIGURATION)


def _provider(
    primary: _FakeProvider, fallback: _FakeProvider, **kwargs: object
) -> FailoverLLMProvider:
    return FailoverLLMProvider(primary=primary, fallback=fallback, **kwargs)  # type: ignore[arg-type]


# --- 1. Primary available -> primary used -------------------------------


def test_primary_used_when_available() -> None:
    primary = _FakeProvider(tokens=["Paris", " is the capital."])
    fallback = _FakeProvider(tokens=["should never be used"])
    failover = _provider(primary, fallback)

    tokens = list(failover.stream_chat(system_prompt="sys", user_prompt="capital of France?"))

    assert tokens == ["Paris", " is the capital."]
    assert len(fallback.calls) == 0


# --- 2-4. Primary fails before first token -> fallback used --------------


@pytest.mark.parametrize(
    "error",
    [
        _infra_error("connection refused"),
        _infra_error("timed out"),
        _infra_error("HTTP 503"),
    ],
    ids=["unreachable", "timeout", "5xx"],
)
def test_falls_over_to_fallback_when_primary_fails_before_first_token(
    error: LLMProviderError,
) -> None:
    primary = _FakeProvider(tokens=[], error=error)
    fallback = _FakeProvider(tokens=["fallback answer"])
    failover = _provider(primary, fallback)

    tokens = list(failover.stream_chat(system_prompt="sys", user_prompt="hi"))

    assert tokens == ["fallback answer"]
    assert len(fallback.calls) == 1


# --- 5. Primary emits tokens then fails -> NO fallback (critical rule) ---


def test_no_failover_once_primary_has_emitted_a_token() -> None:
    """The critical streaming-safety rule: once real output has reached the
    caller, this class must never restart the answer using the fallback
    provider (duplicated/contradictory answers)."""
    primary = _FakeProvider(tokens=["Partial answer"], error=_infra_error("dropped connection"))
    fallback = _FakeProvider(tokens=["a completely different fallback answer"])
    failover = _provider(primary, fallback)

    received: list[str] = []
    with pytest.raises(LLMProviderError, match="dropped connection"):
        for token in failover.stream_chat(system_prompt="sys", user_prompt="hi"):
            received.append(token)

    assert received == ["Partial answer"]
    assert len(fallback.calls) == 0


# --- 6-7. Configuration errors -> NO silent fallback ----------------------


@pytest.mark.parametrize("category_error", [_config_error("401"), _config_error("403")])
def test_no_failover_on_configuration_error(category_error: LLMProviderError) -> None:
    primary = _FakeProvider(tokens=[], error=category_error)
    fallback = _FakeProvider(tokens=["should never be used"])
    failover = _provider(primary, fallback)

    with pytest.raises(LLMProviderError):
        list(failover.stream_chat(system_prompt="sys", user_prompt="hi"))

    assert len(fallback.calls) == 0


def test_no_failover_on_unclassified_other_error() -> None:
    """An LLMProviderError raised with no explicit category (defaults to
    OTHER) must be treated the same as CONFIGURATION — never
    failover-eligible by omission."""
    primary = _FakeProvider(tokens=[], error=LLMProviderError("something unexpected"))
    fallback = _FakeProvider(tokens=["should never be used"])
    failover = _provider(primary, fallback)

    with pytest.raises(LLMProviderError):
        list(failover.stream_chat(system_prompt="sys", user_prompt="hi"))

    assert len(fallback.calls) == 0


# --- 8. Cancellation -> no unexpected fallback ----------------------------


def test_cancellation_after_commit_closes_primary_without_using_fallback() -> None:
    """Once committed to the primary, closing the returned generator (the
    real mechanism generation_manager.py's cancellation relies on — see
    that module's docstring on GeneratorExit propagation) must tear down
    the primary's own stream, never start the fallback."""
    primary = _FakeProvider(tokens=["one", "two", "three"])
    fallback = _FakeProvider(tokens=["should never be used"])
    failover = _provider(primary, fallback)

    gen = failover.stream_chat(system_prompt="sys", user_prompt="hi")
    first = next(gen)
    assert first == "one"
    gen.close()

    assert primary.closed is True
    assert len(fallback.calls) == 0


# --- 9. Both providers unavailable -> controlled error --------------------


def test_both_providers_unavailable_raises_fallbacks_own_error() -> None:
    primary = _FakeProvider(tokens=[], error=_infra_error("MS-S1 unreachable"))
    fallback = _FakeProvider(tokens=[], error=_infra_error("Ollama also unreachable"))
    failover = _provider(primary, fallback)

    with pytest.raises(LLMProviderError, match="Ollama also unreachable"):
        list(failover.stream_chat(system_prompt="sys", user_prompt="hi"))


def test_both_providers_unavailable_yields_no_stuck_partial_state() -> None:
    """A generator that raises immediately, with nothing yielded first,
    leaves the caller (generation_manager.py) with a clean, empty partial
    answer to persist — never a hang."""
    primary = _FakeProvider(tokens=[], error=_infra_error("MS-S1 unreachable"))
    fallback = _FakeProvider(tokens=[], error=_infra_error("Ollama also unreachable"))
    failover = _provider(primary, fallback)

    received: list[str] = []
    with pytest.raises(LLMProviderError):
        for token in failover.stream_chat(system_prompt="sys", user_prompt="hi"):
            received.append(token)

    assert received == []


# --- 10. Recovery -> the next call prefers the primary again -------------


def test_recovery_next_call_retries_primary_with_zero_cooldown() -> None:
    """cooldown_seconds=0 disables the skip-window entirely — every call
    retries the primary fresh, so a primary that has recovered is used on
    the very next request with no restart/manual step."""
    primary = _FakeProvider(
        results=[
            ([], _infra_error("MS-S1 down")),
            (["MS-S1 is back"], None),
        ]
    )
    fallback = _FakeProvider(tokens=["fallback answer"])
    failover = _provider(primary, fallback, cooldown_seconds=0)

    first_call = list(failover.stream_chat(system_prompt="sys", user_prompt="q1"))
    assert first_call == ["fallback answer"]

    second_call = list(failover.stream_chat(system_prompt="sys", user_prompt="q2"))
    assert second_call == ["MS-S1 is back"]
    assert len(primary.calls) == 2


def test_cooldown_skips_primary_entirely_until_it_elapses() -> None:
    """A nonzero cooldown means the primary is not even attempted again
    until the cooldown window has passed — verified with an injected fake
    clock so this test needs no real sleep."""
    clock = {"now": 0.0}
    primary = _FakeProvider(
        results=[
            ([], _infra_error("MS-S1 down")),
            (["MS-S1 is back"], None),
        ]
    )
    fallback = _FakeProvider(tokens=["fallback answer"])
    failover = _provider(primary, fallback, cooldown_seconds=30.0, now_fn=lambda: clock["now"])

    first_call = list(failover.stream_chat(system_prompt="sys", user_prompt="q1"))
    assert first_call == ["fallback answer"]
    assert len(primary.calls) == 1

    # Still inside the 30s cooldown: primary must not be attempted again.
    clock["now"] = 10.0
    second_call = list(failover.stream_chat(system_prompt="sys", user_prompt="q2"))
    assert second_call == ["fallback answer"]
    assert len(primary.calls) == 1  # unchanged — primary was skipped

    # Past the cooldown: the real generation attempt retries the primary.
    clock["now"] = 31.0
    third_call = list(failover.stream_chat(system_prompt="sys", user_prompt="q3"))
    assert third_call == ["MS-S1 is back"]
    assert len(primary.calls) == 2


# --- 11. RAG prompts/context passed unchanged -----------------------------


def test_prompt_and_options_reach_primary_unchanged() -> None:
    primary = _FakeProvider(tokens=["ok"])
    fallback = _FakeProvider(tokens=[])
    failover = _provider(primary, fallback)

    list(
        failover.stream_chat(
            system_prompt="You are EduM8. Cite sources as [1].",
            user_prompt="Context:\n[1] chunk\n\nQuestion: what is X?",
            options_override={"num_predict": 1536},
        )
    )

    assert primary.calls[0]["system_prompt"] == "You are EduM8. Cite sources as [1]."
    assert primary.calls[0]["user_prompt"] == "Context:\n[1] chunk\n\nQuestion: what is X?"
    assert primary.calls[0]["options_override"] == {"num_predict": 1536}


def test_prompt_and_options_reach_fallback_unchanged_on_failover() -> None:
    primary = _FakeProvider(tokens=[], error=_infra_error("down"))
    fallback = _FakeProvider(tokens=["ok"])
    failover = _provider(primary, fallback)

    list(
        failover.stream_chat(
            system_prompt="You are EduM8. Cite sources as [1].",
            user_prompt="Context:\n[1] chunk\n\nQuestion: what is X?",
            options_override={"num_predict": 1536},
        )
    )

    assert fallback.calls[0]["system_prompt"] == "You are EduM8. Cite sources as [1]."
    assert fallback.calls[0]["user_prompt"] == "Context:\n[1] chunk\n\nQuestion: what is X?"
    assert fallback.calls[0]["options_override"] == {"num_predict": 1536}


# --- 13. API key / secret never appears in a log line ---------------------


def test_failover_log_lines_never_mention_any_provider_secret(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """FailoverLLMProvider logs only provider *labels* (e.g. "primary",
    "openai_compatible") — never a secret. Guards against a future change
    accidentally interpolating the underlying exception's message (which
    could, in principle, carry a value from the request) directly."""
    primary = _FakeProvider(tokens=[], error=_infra_error("saw Authorization: Bearer sekrit-value"))
    fallback = _FakeProvider(tokens=["ok"])
    failover = _provider(
        primary, fallback, primary_label="openai_compatible", fallback_label="ollama"
    )

    with caplog.at_level(logging.INFO):
        list(failover.stream_chat(system_prompt="sys", user_prompt="hi"))

    for record in caplog.records:
        assert "sekrit-value" not in record.getMessage()


# --- Timer tagging (observability: "which provider actually served it") --


def test_timer_records_which_provider_served_the_generation() -> None:
    timer = RequestTimer(enabled=True, label="test")
    primary = _FakeProvider(tokens=["ok"])
    fallback = _FakeProvider(tokens=[])
    failover = _provider(primary, fallback, primary_label="primary", fallback_label="fallback")

    list(failover.stream_chat(system_prompt="sys", user_prompt="hi", timer=timer))

    assert timer.tags_dict()["llm_served_by"] == "primary"


def test_timer_records_fallback_as_server_on_failover() -> None:
    timer = RequestTimer(enabled=True, label="test")
    primary = _FakeProvider(tokens=[], error=_infra_error("down"))
    fallback = _FakeProvider(tokens=["ok"])
    failover = _provider(primary, fallback, primary_label="primary", fallback_label="fallback")

    list(failover.stream_chat(system_prompt="sys", user_prompt="hi", timer=timer))

    assert timer.tags_dict()["llm_served_by"] == "fallback"
    assert timer.tags_dict()["llm_failover"] == "primary_unavailable"


# --- Empty completion from primary is a success, not a failure -----------


def test_empty_primary_completion_is_not_treated_as_a_failure() -> None:
    primary = _FakeProvider(tokens=[])
    fallback = _FakeProvider(tokens=["should never be used"])
    failover = _provider(primary, fallback)

    tokens = list(failover.stream_chat(system_prompt="sys", user_prompt="hi"))

    assert tokens == []
    assert len(fallback.calls) == 0


# --- Regression: the exact real exception/path seen against a live,
# actually-unreachable MS-S1 in production (an httpx.ConnectError from a
# closed TCP port, `Connection refused`) --------------------------------
#
# The tests above exercise FailoverLLMProvider against a bare
# LLMProviderError manufactured directly with an explicit `category=` —
# that proves the *decision logic* is correct given a correctly-classified
# error, but it never proves the *real* OpenAICompatibleLLMProvider
# actually produces that classification for the *real* exception a closed
# MS-S1 port raises, wired through a *real* FailoverLLMProvider instance.
# A live production check against the actually-unreachable MS-S1 host
# confirmed OpenAICompatibleLLMProvider raises exactly
# `LLMProviderError(category=LLMErrorCategory.INFRASTRUCTURE)` with
# `__cause__` a real `httpx.ConnectError` for this exact failure — this
# test reproduces that exact chain (real OpenAICompatibleLLMProvider,
# real httpx.ConnectError, real FailoverLLMProvider) end to end, rather
# than only a synthetic LLMProviderError.


class _ConnectionRefusedClient:
    """Reproduces exactly what httpx raises when TCP connect() to MS-S1's
    port is refused (`vLLM not listening` / `MS-S1 unreachable`) — the real
    exception observed against the actual production MS-S1 host, not a
    synthetic stand-in."""

    def stream(self, method: str, url: str, *, json: dict[str, object], headers: dict[str, str]):
        raise httpx.ConnectError("[Errno 111] Connection refused")


class TestRealMSS1UnreachableExceptionReproduction:
    def test_real_openai_compatible_provider_connect_error_fails_over_to_fallback(self) -> None:
        primary = OpenAICompatibleLLMProvider(
            model="Qwen/Qwen3-4B-Instruct-2507",
            base_url="http://100.73.9.108:8000/v1",
            api_key="irrelevant-for-a-connection-that-never-completes",
            client=_ConnectionRefusedClient(),  # type: ignore[arg-type]
        )
        fallback = _FakeProvider(tokens=["Ollama answered instead"])
        failover = FailoverLLMProvider(
            primary=primary,
            fallback=fallback,
            primary_label="openai_compatible",
            fallback_label="ollama",
        )

        tokens = list(failover.stream_chat(system_prompt="sys", user_prompt="hi"))

        assert tokens == ["Ollama answered instead"]
        assert len(fallback.calls) == 1

    def test_real_openai_compatible_provider_connect_error_is_classified_infrastructure(
        self,
    ) -> None:
        """Documents the exact classification this migration relies on —
        if a future change to OpenAICompatibleLLMProvider or
        classify_openai_compatible_error_category ever stopped tagging a
        real ConnectError as INFRASTRUCTURE, this fails loudly instead of
        silently breaking failover in production again."""
        primary = OpenAICompatibleLLMProvider(
            model="Qwen/Qwen3-4B-Instruct-2507",
            base_url="http://100.73.9.108:8000/v1",
            api_key="irrelevant",
            client=_ConnectionRefusedClient(),  # type: ignore[arg-type]
        )

        with pytest.raises(LLMProviderError) as exc_info:
            list(primary.stream_chat(system_prompt="sys", user_prompt="hi"))

        assert exc_info.value.category is LLMErrorCategory.INFRASTRUCTURE
        assert isinstance(exc_info.value.__cause__, httpx.ConnectError)
