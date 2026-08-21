"""Covers app/core/llm_provider.py::OpenAICompatibleLLMProvider — the
MS-S1 vLLM migration's LLMProvider implementation for any OpenAI-style
streaming `/v1/chat/completions` backend. Uses fake httpx-shaped test
doubles throughout; no real MS-S1/vLLM server is required or contacted.

Mirrors test_llm_provider.py's existing OllamaLLMProvider coverage where
the same concept applies (request shape, options_override, timer
metrics), plus this provider's own concerns: Bearer auth, SSE chunk
parsing, and classifying the upstream HTTP failures a real vLLM
deployment behind Tailscale can produce (401/403 wrong key, 5xx, timeout,
connection failure, a broken/interrupted stream)."""

import httpx
import pytest

from app.core.errors import LLMProviderError
from app.core.llm_provider import OpenAICompatibleLLMProvider
from app.core.request_timing import RequestTimer

_API_KEY = "test-secret-vllm-key"


class _FakeStreamResponse:
    """Fake httpx.Response, usable both as the object `Client.stream()`
    returns and as a context manager (matching `with client.stream(...) as
    response:` in OpenAICompatibleLLMProvider.stream_chat)."""

    def __init__(
        self,
        *,
        status_code: int = 200,
        lines: list[str] | None = None,
        json_body: object = None,
        text: str = "",
        raise_on_iter: Exception | None = None,
    ) -> None:
        self.status_code = status_code
        self._lines = lines or []
        self._json_body = json_body
        self.text = text
        self._raise_on_iter = raise_on_iter
        self.read_called = False

    def __enter__(self) -> "_FakeStreamResponse":
        return self

    def __exit__(self, *exc_info: object) -> bool:
        return False

    def read(self) -> None:
        self.read_called = True

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            request = httpx.Request("POST", "http://vllm.test/v1/chat/completions")
            raise httpx.HTTPStatusError(
                f"HTTP {self.status_code}",
                request=request,
                response=self,  # type: ignore[arg-type]
            )

    def json(self) -> object:
        return self._json_body

    def iter_lines(self):
        yield from self._lines
        if self._raise_on_iter is not None:
            raise self._raise_on_iter


class _FakeStreamClient:
    """Fake httpx.Client — records every `.stream()` call's kwargs and
    returns a fixed, pre-built _FakeStreamResponse."""

    def __init__(self, response: _FakeStreamResponse) -> None:
        self.response = response
        self.calls: list[dict[str, object]] = []

    def stream(self, method: str, url: str, *, json: dict[str, object], headers: dict[str, str]):
        self.calls.append({"method": method, "url": url, "json": json, "headers": headers})
        return self.response


def _sse(*payloads: dict[str, object]) -> list[str]:
    import json as json_module

    return [f"data: {json_module.dumps(payload)}" for payload in payloads] + ["data: [DONE]"]


def _provider(client: _FakeStreamClient, **kwargs: object) -> OpenAICompatibleLLMProvider:
    return OpenAICompatibleLLMProvider(
        model="Qwen/Qwen3-4B-Instruct-2507",
        base_url="http://100.73.9.108:8000/v1",
        api_key=_API_KEY,
        client=client,  # type: ignore[arg-type]
        **kwargs,
    )


def test_stream_chat_sends_bearer_authorization_header() -> None:
    response = _FakeStreamResponse(lines=_sse({"choices": [{"delta": {"content": "Hi"}}]}))
    client = _FakeStreamClient(response)
    provider = _provider(client)

    list(provider.stream_chat(system_prompt="sys", user_prompt="hello"))

    assert client.calls[0]["headers"] == {"Authorization": f"Bearer {_API_KEY}"}


def test_stream_chat_uses_configured_model_and_endpoint() -> None:
    response = _FakeStreamResponse(lines=_sse({"choices": [{"delta": {"content": "Hi"}}]}))
    client = _FakeStreamClient(response)
    provider = _provider(client)

    list(provider.stream_chat(system_prompt="sys", user_prompt="hello"))

    call = client.calls[0]
    assert call["url"] == "http://100.73.9.108:8000/v1/chat/completions"
    assert call["json"]["model"] == "Qwen/Qwen3-4B-Instruct-2507"
    assert call["json"]["stream"] is True


def test_stream_chat_sends_system_and_user_messages_unchanged() -> None:
    """RAG/prompt content must reach the provider exactly as built by
    RagService/prompt_builder — no reshaping, truncation, or added
    wrapper text."""
    response = _FakeStreamResponse(lines=_sse({"choices": [{"delta": {"content": "ok"}}]}))
    client = _FakeStreamClient(response)
    provider = _provider(client)

    list(
        provider.stream_chat(
            system_prompt="You are EduM8. Cite sources as [1].",
            user_prompt="Context:\n[1] some retrieved chunk\n\nQuestion: what is X?",
        )
    )

    assert client.calls[0]["json"]["messages"] == [
        {"role": "system", "content": "You are EduM8. Cite sources as [1]."},
        {
            "role": "user",
            "content": "Context:\n[1] some retrieved chunk\n\nQuestion: what is X?",
        },
    ]


def test_stream_chat_parses_multiple_streaming_chunks() -> None:
    response = _FakeStreamResponse(
        lines=_sse(
            {"choices": [{"delta": {"content": "Paris"}}]},
            {"choices": [{"delta": {"content": " is the capital"}}]},
            {"choices": [{"delta": {"content": " of France."}}]},
        )
    )
    client = _FakeStreamClient(response)
    provider = _provider(client)

    tokens = list(provider.stream_chat(system_prompt="sys", user_prompt="capital of France?"))

    assert tokens == ["Paris", " is the capital", " of France."]


def test_stream_chat_single_chunk_full_answer() -> None:
    """A degenerate 'non-streaming-shaped' response — the whole answer in
    one SSE chunk — must still work: this is the same code path a real
    very-short completion takes."""
    response = _FakeStreamResponse(
        lines=_sse({"choices": [{"delta": {"content": "The answer is 42."}}]})
    )
    client = _FakeStreamClient(response)
    provider = _provider(client)

    tokens = list(provider.stream_chat(system_prompt="sys", user_prompt="the answer?"))

    assert "".join(tokens) == "The answer is 42."


def test_stream_chat_ignores_chunks_with_no_content_delta() -> None:
    """A role-only first chunk (`{"delta": {"role": "assistant"}}`, which
    real OpenAI-compatible servers send) and an empty-choices usage-only
    final chunk must not yield empty-string tokens."""
    response = _FakeStreamResponse(
        lines=_sse(
            {"choices": [{"delta": {"role": "assistant"}}]},
            {"choices": [{"delta": {"content": "Hi"}}]},
            {"choices": [], "usage": {"prompt_tokens": 10, "completion_tokens": 1}},
        )
    )
    client = _FakeStreamClient(response)
    provider = _provider(client)

    tokens = list(provider.stream_chat(system_prompt="sys", user_prompt="hi"))

    assert tokens == ["Hi"]


def test_stream_chat_skips_malformed_json_chunk_without_crashing() -> None:
    response = _FakeStreamResponse(
        lines=[
            "data: {not valid json",
            'data: {"choices": [{"delta": {"content": "still works"}}]}',
            "data: [DONE]",
        ]
    )
    client = _FakeStreamClient(response)
    provider = _provider(client)

    tokens = list(provider.stream_chat(system_prompt="sys", user_prompt="hi"))

    assert tokens == ["still works"]


def test_stream_chat_translates_num_predict_override_to_max_tokens() -> None:
    """app/api/routes_conversations.py's lesson-mode override builds
    options_override={"num_predict": N} regardless of which provider is
    active — this provider must translate that to OpenAI's `max_tokens`
    field rather than sending an unrecognized `num_predict` key."""
    response = _FakeStreamResponse(lines=_sse({"choices": [{"delta": {"content": "ok"}}]}))
    client = _FakeStreamClient(response)
    provider = _provider(client, options={"num_predict": 512})

    list(
        provider.stream_chat(
            system_prompt="sys", user_prompt="hi", options_override={"num_predict": 1536}
        )
    )

    body = client.calls[0]["json"]
    assert body["max_tokens"] == 1536
    assert "num_predict" not in body


def test_stream_chat_passes_through_other_option_keys_unchanged() -> None:
    response = _FakeStreamResponse(lines=_sse({"choices": [{"delta": {"content": "ok"}}]}))
    client = _FakeStreamClient(response)
    provider = _provider(client, options={"temperature": 0, "num_predict": 512})

    list(provider.stream_chat(system_prompt="sys", user_prompt="hi"))

    body = client.calls[0]["json"]
    assert body["temperature"] == 0
    assert body["max_tokens"] == 512


def test_stream_chat_records_usage_metrics_on_timer() -> None:
    response = _FakeStreamResponse(
        lines=_sse(
            {"choices": [{"delta": {"content": "Hi"}}]},
            {"choices": [], "usage": {"prompt_tokens": 123, "completion_tokens": 7}},
        )
    )
    client = _FakeStreamClient(response)
    provider = _provider(client)
    timer = RequestTimer(enabled=True, label="test")

    list(provider.stream_chat(system_prompt="sys", user_prompt="hi", timer=timer))

    metrics = timer.as_dict()
    assert metrics["actual_prompt_tokens"] == 123
    assert metrics["completion_token_count"] == 7


def test_stream_chat_timer_none_by_default_records_nothing() -> None:
    response = _FakeStreamResponse(lines=_sse({"choices": [{"delta": {"content": "Hi"}}]}))
    client = _FakeStreamClient(response)
    provider = _provider(client)

    tokens = list(provider.stream_chat(system_prompt="sys", user_prompt="hi"))

    assert tokens == ["Hi"]


def test_stream_chat_raises_llm_provider_error_on_timeout() -> None:
    class _TimingOutClient:
        def stream(self, method, url, *, json, headers):
            raise httpx.ReadTimeout("timed out")

    provider = _provider(_TimingOutClient())  # type: ignore[arg-type]

    with pytest.raises(LLMProviderError) as exc_info:
        list(provider.stream_chat(system_prompt="sys", user_prompt="hi"))

    assert "did not respond in time" in str(exc_info.value)
    assert _API_KEY not in str(exc_info.value)


def test_stream_chat_raises_llm_provider_error_on_connect_failure() -> None:
    class _UnreachableClient:
        def stream(self, method, url, *, json, headers):
            raise httpx.ConnectError("connection refused")

    provider = _provider(_UnreachableClient())  # type: ignore[arg-type]

    with pytest.raises(LLMProviderError) as exc_info:
        list(provider.stream_chat(system_prompt="sys", user_prompt="hi"))

    assert "Could not reach the inference server" in str(exc_info.value)
    assert _API_KEY not in str(exc_info.value)


@pytest.mark.parametrize("status_code", [401, 403])
def test_stream_chat_raises_llm_provider_error_on_auth_failure(status_code: int) -> None:
    response = _FakeStreamResponse(
        status_code=status_code,
        json_body={"error": f"Unauthorized (saw Bearer {_API_KEY})"},
        text=f"Unauthorized (saw Bearer {_API_KEY})",
    )
    client = _FakeStreamClient(response)
    provider = _provider(client)

    with pytest.raises(LLMProviderError) as exc_info:
        list(provider.stream_chat(system_prompt="sys", user_prompt="hi"))

    message = str(exc_info.value)
    assert "Check the configured API key" in message
    # The server's own error body is deliberately never echoed for a
    # 401/403 — some servers include request metadata (occasionally the
    # Authorization value itself) in that body.
    assert _API_KEY not in message


def test_stream_chat_raises_llm_provider_error_on_5xx() -> None:
    response = _FakeStreamResponse(status_code=503, text="Service Unavailable")
    client = _FakeStreamClient(response)
    provider = _provider(client)

    with pytest.raises(LLMProviderError) as exc_info:
        list(provider.stream_chat(system_prompt="sys", user_prompt="hi"))

    message = str(exc_info.value)
    assert "503" in message
    assert _API_KEY not in message


def test_stream_chat_broken_stream_yields_partial_tokens_then_raises() -> None:
    """A connection that drops mid-stream (e.g. the vLLM process restarting
    partway through a reply) must surface every token already received —
    the caller (app/core/generation_manager.py) persists a partial answer
    rather than discarding it — before raising LLMProviderError."""
    response = _FakeStreamResponse(
        lines=_sse({"choices": [{"delta": {"content": "Partial"}}]})[:-1],  # drop [DONE]
        raise_on_iter=httpx.ReadError("connection dropped"),
    )
    client = _FakeStreamClient(response)
    provider = _provider(client)

    received: list[str] = []
    with pytest.raises(LLMProviderError):
        for token in provider.stream_chat(system_prompt="sys", user_prompt="hi"):
            received.append(token)

    assert received == ["Partial"]


def test_stream_chat_never_includes_api_key_in_any_raised_error() -> None:
    """Broad guard across every error path this provider can take."""
    cases: list[Exception | _FakeStreamResponse] = [
        httpx.ReadTimeout("timed out"),
        httpx.ConnectError("refused"),
    ]
    for exc in cases:

        class _RaisingClient:
            def stream(self, method, url, *, json, headers, _exc=exc):
                raise _exc

        provider = _provider(_RaisingClient())  # type: ignore[arg-type]
        with pytest.raises(LLMProviderError) as exc_info:
            list(provider.stream_chat(system_prompt="sys", user_prompt="hi"))
        assert _API_KEY not in str(exc_info.value)

    for status_code in (401, 403, 500, 503):
        response = _FakeStreamResponse(status_code=status_code, text=f"body mentions {_API_KEY}")
        client = _FakeStreamClient(response)
        provider = _provider(client)
        with pytest.raises(LLMProviderError) as exc_info:
            list(provider.stream_chat(system_prompt="sys", user_prompt="hi"))
        assert _API_KEY not in str(exc_info.value)
