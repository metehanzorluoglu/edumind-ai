"""Covers the OLLAMA_THINKING_ENABLED wiring (app/deps.py -> Settings ->
OllamaLLMProvider(think=...) -> ollama.Client.chat(..., think=...)).

qwen3:8b's "thinking" trace routinely dwarfs the visible answer on a
CPU-only host (observed ~120 hidden reasoning tokens for a one-sentence
reply during the production performance investigation), so ordinary chat
turns now run with thinking off by default. These tests verify the `think`
value the provider was constructed with is the exact value forwarded to
the Ollama client on every call — nothing more, nothing less — using a
fake client so no real Ollama server is required.
"""

from dataclasses import dataclass

from app.core.llm_provider import OllamaLLMProvider


@dataclass
class _FakeMessage:
    content: str | None


@dataclass
class _FakeChunk:
    message: _FakeMessage


class _RecordingClient:
    """Fake `ollama.Client` that records every `.chat()` call's kwargs and
    streams back a fixed two-token reply, matching the shape
    `OllamaLLMProvider.stream_chat` expects from the real client."""

    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []

    def chat(self, *, model, messages, stream, options=None, think=None):
        self.calls.append(
            {
                "model": model,
                "messages": messages,
                "stream": stream,
                "options": options,
                "think": think,
            }
        )
        return [
            _FakeChunk(message=_FakeMessage(content="Paris")),
            _FakeChunk(message=_FakeMessage(content=" is the capital.")),
        ]


def test_stream_chat_defaults_think_to_none_when_unset() -> None:
    """A caller that constructs OllamaLLMProvider directly without `think`
    (e.g. existing test code, or a future call site) must keep the old
    "don't pass anything, use Ollama's own default" behavior unchanged."""
    client = _RecordingClient()
    provider = OllamaLLMProvider(model="qwen3:8b", client=client)

    chunks = list(provider.stream_chat(system_prompt="sys", user_prompt="capital of France?"))

    assert chunks == ["Paris", " is the capital."]
    assert client.calls[0]["think"] is None


def test_stream_chat_disables_thinking_when_configured_off() -> None:
    """This is the actual latency fix: OLLAMA_THINKING_ENABLED=false (the
    new application default, see app/deps.py::get_llm_provider) must reach
    Ollama's chat API as think=False on every call."""
    client = _RecordingClient()
    provider = OllamaLLMProvider(model="qwen3:8b", client=client, think=False)

    list(provider.stream_chat(system_prompt="sys", user_prompt="capital of France?"))

    assert client.calls[0]["think"] is False


def test_stream_chat_enables_thinking_when_configured_on() -> None:
    """OLLAMA_THINKING_ENABLED=true must still reach the client as
    think=True — the "deep reasoning" escape hatch this task explicitly
    asks to preserve, not a capability that was removed."""
    client = _RecordingClient()
    provider = OllamaLLMProvider(model="qwen3:8b", client=client, think=True)

    list(provider.stream_chat(system_prompt="sys", user_prompt="capital of France?"))

    assert client.calls[0]["think"] is True


def test_thinking_toggle_does_not_change_request_shape() -> None:
    """Guard against the thinking-mode change leaking into anything else:
    messages, the stream flag, and options must be exactly what they were
    before this feature existed, regardless of the `think` value."""
    client = _RecordingClient()
    provider = OllamaLLMProvider(
        model="qwen3:8b", client=client, think=False, options={"temperature": 0}
    )

    list(provider.stream_chat(system_prompt="You are helpful.", user_prompt="Hi"))

    call = client.calls[0]
    assert call["model"] == "qwen3:8b"
    assert call["messages"] == [
        {"role": "system", "content": "You are helpful."},
        {"role": "user", "content": "Hi"},
    ]
    assert call["stream"] is True
    assert call["options"] == {"temperature": 0}


def test_stream_chat_passes_num_predict_via_options() -> None:
    """The completion-length cap this task adds (OLLAMA_NUM_PREDICT,
    default 512 — see app/deps.py::get_llm_provider) reaches Ollama as
    options={"num_predict": 512}: `options` is a plain pass-through
    Mapping, so num_predict travels exactly the same path temperature/seed
    already did (see test_thinking_toggle_does_not_change_request_shape
    above) — no special-cased handling was added for it."""
    client = _RecordingClient()
    provider = OllamaLLMProvider(model="qwen3:8b", client=client, options={"num_predict": 512})

    list(provider.stream_chat(system_prompt="sys", user_prompt="Hi"))

    assert client.calls[0]["options"] == {"num_predict": 512}


def test_stream_chat_allows_a_different_num_predict_for_a_future_deep_response_mode() -> None:
    """The class places no ceiling on num_predict and does not clamp or
    reinterpret it — a future "deep response" mode is just a second
    OllamaLLMProvider instance constructed with a larger value (see
    app/core/llm_provider.py's docstring), and that value must reach the
    client completely unmodified."""
    client = _RecordingClient()
    provider = OllamaLLMProvider(model="qwen3:8b", client=client, options={"num_predict": 4096})

    list(provider.stream_chat(system_prompt="sys", user_prompt="Hi"))

    assert client.calls[0]["options"] == {"num_predict": 4096}


def test_num_predict_and_thinking_mode_do_not_interfere() -> None:
    """app/deps.py::get_llm_provider wires `think` and `options` (with
    num_predict) into the same instance from two independent settings —
    this guards against either ever clobbering or being coupled to the
    other; each must reach the client exactly as given."""
    client = _RecordingClient()
    provider = OllamaLLMProvider(
        model="qwen3:8b", client=client, think=False, options={"num_predict": 512}
    )

    list(provider.stream_chat(system_prompt="sys", user_prompt="Hi"))

    call = client.calls[0]
    assert call["think"] is False
    assert call["options"] == {"num_predict": 512}
