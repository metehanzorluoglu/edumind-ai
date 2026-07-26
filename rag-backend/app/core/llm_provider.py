from collections.abc import Iterable, Iterator, Mapping
from typing import Literal, Protocol

import ollama

from app.core.errors import LLMProviderError
from app.core.ollama_errors import classify_ollama_error


class LLMProvider(Protocol):
    def stream_chat(self, *, system_prompt: str, user_prompt: str) -> Iterator[str]: ...


class _MessageLike(Protocol):
    @property
    def content(self) -> str | None: ...


class _ChatChunkLike(Protocol):
    @property
    def message(self) -> _MessageLike: ...


class _ChatCapableClient(Protocol):
    def chat(
        self,
        *,
        model: str,
        messages: list[dict[str, str]],
        stream: Literal[True],
        options: Mapping[str, object] | None = None,
        think: bool | None = None,
    ) -> Iterable[_ChatChunkLike]: ...


class OllamaLLMProvider:
    def __init__(
        self,
        *,
        model: str,
        base_url: str = "http://localhost:11434",
        client: _ChatCapableClient | None = None,
        options: Mapping[str, object] | None = None,
        think: bool | None = None,
    ) -> None:
        """`options` (e.g. {"temperature": 0, "seed": 42}) and `think` are
        None by default, meaning "don't pass anything, use Ollama's own
        defaults" — this preserves existing production behavior exactly.
        They exist so callers that need reproducible output (e.g. the live
        prompt-injection evaluation in
        tests/integration/test_live_ollama_smoke.py — see milestone 9 §12)
        can opt in explicitly, without changing the default chat experience.
        Note temperature=0 reduces but does not guarantee bit-for-bit
        determinism (floating-point summation order can still vary with
        batching/GPU kernels), so this is a mitigation, not a proof."""
        self._model = model
        self._client: _ChatCapableClient = (
            client if client is not None else ollama.Client(host=base_url)
        )
        self._options = options
        self._think = think

    def stream_chat(self, *, system_prompt: str, user_prompt: str) -> Iterator[str]:
        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ]
        try:
            stream = self._client.chat(
                model=self._model,
                messages=messages,
                stream=True,
                options=self._options,
                think=self._think,
            )
            for chunk in stream:
                content = chunk.message.content
                if content:
                    yield content
        except LLMProviderError:
            raise
        except Exception as exc:
            raise LLMProviderError(classify_ollama_error(exc, model=self._model)) from exc
