from collections.abc import Iterable, Iterator, Mapping
from typing import Literal, Protocol

import ollama

from app.core.errors import LLMProviderError
from app.core.ollama_errors import classify_ollama_error
from app.core.request_timing import RequestTimer


class LLMProvider(Protocol):
    def stream_chat(
        self, *, system_prompt: str, user_prompt: str, timer: RequestTimer | None = None
    ) -> Iterator[str]: ...


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
        None by default at this class level, meaning "don't pass anything,
        use Ollama's own defaults" — a caller that constructs this class
        directly without passing `think` still gets that behavior unchanged.
        They exist so callers that need reproducible output (e.g. the live
        prompt-injection evaluation in
        tests/integration/test_live_ollama_smoke.py — see milestone 9 §12)
        can opt in explicitly, without changing the default chat experience.
        Note temperature=0 reduces but does not guarantee bit-for-bit
        determinism (floating-point summation order can still vary with
        batching/GPU kernels), so this is a mitigation, not a proof.

        Production wiring (app/deps.py::get_llm_provider) does not rely on
        either None default: it always passes an explicit `think` derived
        from Settings.ollama_thinking_enabled (env var
        OLLAMA_THINKING_ENABLED, default false) and an explicit `options`
        containing at least `num_predict` from Settings.ollama_num_predict
        (env var OLLAMA_NUM_PREDICT, default 512). qwen3's thinking trace
        routinely outweighs the visible answer on this CPU-only host (see
        the performance investigation), so ordinary chat turns run with
        thinking off by default; setting OLLAMA_THINKING_ENABLED=true turns
        it back on globally — e.g. for a future "deep reasoning" mode — with
        no code change, since both parameters already flow straight through
        to Ollama's chat API on every call unchanged (see stream_chat
        below). `num_predict` exists because neither Ollama nor qwen3:8b's
        Modelfile caps completion length by default — generation was
        previously bounded only by the model's context window, so a
        pathological/looping completion had no ceiling below that. A future
        "deep response" mode needing a longer cap is a separate
        OllamaLLMProvider instance constructed with its own
        `options={"num_predict": N}` (e.g. a second app/deps.py provider
        function) — this class places no upper bound on the value passed
        here, and Settings.ollama_num_predict only ever determines what the
        one app-wide default instance uses, never what this class accepts."""
        self._model = model
        self._client: _ChatCapableClient = (
            client if client is not None else ollama.Client(host=base_url)
        )
        self._options = options
        self._think = think

    def stream_chat(
        self, *, system_prompt: str, user_prompt: str, timer: RequestTimer | None = None
    ) -> Iterator[str]:
        """`timer`, when given, receives Ollama's own reported performance
        fields (model load time, prompt evaluation time, completion token
        count, decode rate — see _record_ollama_metrics below) once the
        stream finishes. Optional and additive: omitting it (the default)
        changes nothing about token delivery, and a timer that's disabled
        (see app/core/request_timing.py) makes every call below a no-op."""
        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ]
        last_chunk: _ChatChunkLike | None = None
        try:
            stream = self._client.chat(
                model=self._model,
                messages=messages,
                stream=True,
                options=self._options,
                think=self._think,
            )
            for chunk in stream:
                last_chunk = chunk
                content = chunk.message.content
                if content:
                    yield content
        except LLMProviderError:
            raise
        except Exception as exc:
            raise LLMProviderError(classify_ollama_error(exc, model=self._model)) from exc

        if timer is not None and last_chunk is not None:
            _record_ollama_metrics(timer, last_chunk)


def _record_ollama_metrics(timer: RequestTimer, final_chunk: object) -> None:
    """Extracts Ollama's own performance fields from the final chunk of a
    chat stream (present as `ollama.ChatResponse` attributes, nanoseconds
    for every duration) and records them onto the profiling timer.

    Read defensively via getattr rather than added to _ChatChunkLike:
    these fields are a real `ollama.Client`/`ollama.AsyncClient` response
    detail, not part of the minimal structural Protocol test doubles
    implement, and their presence is itself not guaranteed across Ollama
    versions — "when available" is a real possibility this function must
    handle quietly, not an edge case to assert against. Never raises: a
    profiling extraction failure must never break a real chat response."""
    try:
        load_duration_ns = getattr(final_chunk, "load_duration", None)
        if isinstance(load_duration_ns, int | float):
            timer.record("ollama_load_ms", load_duration_ns / 1_000_000)

        prompt_eval_duration_ns = getattr(final_chunk, "prompt_eval_duration", None)
        if isinstance(prompt_eval_duration_ns, int | float):
            timer.record("ollama_prompt_eval_ms", prompt_eval_duration_ns / 1_000_000)

        prompt_eval_count = getattr(final_chunk, "prompt_eval_count", None)
        if isinstance(prompt_eval_count, int | float):
            timer.record_metric("actual_prompt_tokens", prompt_eval_count)

        eval_count = getattr(final_chunk, "eval_count", None)
        if isinstance(eval_count, int | float):
            timer.record_metric("completion_token_count", eval_count)

        eval_duration_ns = getattr(final_chunk, "eval_duration", None)
        if (
            isinstance(eval_count, int | float)
            and isinstance(eval_duration_ns, int | float)
            and eval_duration_ns > 0
        ):
            decode_tokens_per_second = eval_count / (eval_duration_ns / 1_000_000_000)
            timer.record_metric("decode_tokens_per_second", round(decode_tokens_per_second, 2))
    except Exception:
        pass
