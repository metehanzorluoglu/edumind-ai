import json
import logging
from collections.abc import Iterable, Iterator, Mapping
from typing import Literal, Protocol

import httpx
import ollama

from app.core.errors import LLMProviderError
from app.core.ollama_errors import classify_ollama_error
from app.core.request_timing import RequestTimer

logger = logging.getLogger(__name__)


class LLMProvider(Protocol):
    def stream_chat(
        self,
        *,
        system_prompt: str,
        user_prompt: str,
        timer: RequestTimer | None = None,
        options_override: Mapping[str, object] | None = None,
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
        self,
        *,
        system_prompt: str,
        user_prompt: str,
        timer: RequestTimer | None = None,
        options_override: Mapping[str, object] | None = None,
    ) -> Iterator[str]:
        """`timer`, when given, receives Ollama's own reported performance
        fields (model load time, prompt evaluation time, completion token
        count, decode rate — see _record_ollama_metrics below) once the
        stream finishes. Optional and additive: omitting it (the default)
        changes nothing about token delivery, and a timer that's disabled
        (see app/core/request_timing.py) makes every call below a no-op.

        `options_override`, when given, is merged over this instance's own
        `options` for this call only (e.g. a higher `num_predict` for an
        instructional-design request — see app/core/intent_detection.py
        and Settings.ollama_num_predict_lesson_mode) — every other call
        using this same provider instance is unaffected."""
        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ]
        effective_options = (
            {**(self._options or {}), **options_override} if options_override else self._options
        )
        last_chunk: _ChatChunkLike | None = None
        try:
            stream = self._client.chat(
                model=self._model,
                messages=messages,
                stream=True,
                options=effective_options,
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


_DEFAULT_OPENAI_COMPATIBLE_TIMEOUT_SECONDS = 120.0


def _classify_openai_compatible_error(exc: Exception, *, model: str) -> str:
    """The OpenAICompatibleLLMProvider counterpart to
    app/core/ollama_errors.py's classify_ollama_error — same "turn an
    exception into a message a user can act on" contract, covering the
    exception shapes a real `/v1/chat/completions` call against an
    OpenAI-compatible server (vLLM, in production) can raise.

    Never includes the request body, the Authorization header, or the raw
    API key in any returned message — only the upstream status code and
    whatever error text the server itself chose to send back, which is
    the server's own (already-public) response, never a secret this
    backend holds."""
    if isinstance(exc, httpx.TimeoutException):
        return (
            f"The '{model}' model did not respond in time. It may be overloaded, or this "
            "request may be too large to process quickly — try again shortly."
        )
    if isinstance(exc, httpx.ConnectError | ConnectionError):
        return (
            f"Could not reach the inference server to run '{model}'. It may be temporarily "
            "unavailable — try again shortly."
        )
    if isinstance(exc, httpx.HTTPStatusError):
        status_code = exc.response.status_code
        if status_code in (401, 403):
            # Deliberately generic: never echoes the server's own error body
            # here, since some OpenAI-compatible servers include request
            # metadata (occasionally the offending Authorization value
            # itself, truncated or not) in a 401/403 body. The status code
            # alone is enough for an operator to know "check the API key".
            return (
                f"Authentication with the inference server failed while running '{model}'. "
                "Check the configured API key."
            )
        if status_code >= 500:
            return (
                f"The inference server had an internal error running '{model}' "
                f"(HTTP {status_code}). Try again shortly."
            )
        try:
            body = exc.response.json()
            message = body.get("error") or str(body) if isinstance(body, dict) else str(body)
        except ValueError:
            message = exc.response.text or str(exc)
        return f"The inference server returned an error running '{model}': {message}"
    return f"Chat generation with model '{model}' failed: {exc}"


def _record_openai_compatible_usage_metrics(
    timer: RequestTimer, usage: Mapping[str, object]
) -> None:
    """Best-effort counterpart to _record_ollama_metrics below, using the
    `usage` object an OpenAI-compatible server returns on the final SSE
    chunk when the request sets `stream_options: {"include_usage": true}`
    (vLLM supports this). No load/prompt-eval timing breakdown exists in
    the OpenAI wire format the way Ollama's ChatResponse provides it, so
    only token counts are recorded here — still enough to see prompt vs.
    completion size on the profiling timer. Never raises: a profiling
    extraction failure must never break a real chat response."""
    try:
        prompt_tokens = usage.get("prompt_tokens")
        if isinstance(prompt_tokens, int | float):
            timer.record_metric("actual_prompt_tokens", prompt_tokens)
        completion_tokens = usage.get("completion_tokens")
        if isinstance(completion_tokens, int | float):
            timer.record_metric("completion_token_count", completion_tokens)
    except Exception:
        pass


class OpenAICompatibleLLMProvider:
    """LLMProvider implementation for any server exposing an OpenAI-style
    streaming `/v1/chat/completions` endpoint — introduced for the MS-S1
    vLLM migration (a private, Tailscale-only `Qwen/Qwen3-4B-Instruct-2507`
    host requiring `Authorization: Bearer <key>`; see app/deps.py::
    get_llm_provider and Settings.llm_provider). Implements the exact same
    LLMProvider Protocol as OllamaLLMProvider above — RagService
    (app/core/rag_service.py) and the generation worker
    (app/core/generation_manager.py) call `stream_chat` identically either
    way and need no changes: only which HTTP API/auth scheme reaches the
    model differs.

    `options`/`options_override` use this codebase's existing
    Ollama-flavored option names (e.g. `num_predict` — see
    app/api/routes_conversations.py's lesson-mode override, the one place
    that builds an options_override today) so that call site keeps working
    unmodified regardless of which provider is active. `num_predict` is
    translated to OpenAI's `max_tokens` field here; every other option key
    is passed straight through as a top-level request field (e.g.
    `temperature`), matching OllamaLLMProvider's own "plain pass-through"
    contract for `options`.

    The API key is held only in `self._api_key` and sent solely as the
    `Authorization` header value — never logged, never interpolated into
    an exception message (see _classify_openai_compatible_error above),
    and never part of `body` (the JSON payload logged nowhere in this
    class)."""

    def __init__(
        self,
        *,
        model: str,
        base_url: str,
        api_key: str,
        client: httpx.Client | None = None,
        options: Mapping[str, object] | None = None,
        timeout_seconds: float = _DEFAULT_OPENAI_COMPATIBLE_TIMEOUT_SECONDS,
    ) -> None:
        self._model = model
        self._base_url = base_url.rstrip("/")
        self._api_key = api_key
        self._options = options
        self._client: httpx.Client = (
            client if client is not None else httpx.Client(timeout=timeout_seconds)
        )

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self._api_key}"}

    def _request_body(self, options_override: Mapping[str, object] | None) -> dict[str, object]:
        effective_options = (
            {**(self._options or {}), **options_override} if options_override else self._options
        )
        body: dict[str, object] = {
            "model": self._model,
            "stream": True,
            # Asks vLLM to include a final usage-only chunk (empty
            # `choices`) so token counts can be recorded on the timer —
            # see _record_openai_compatible_usage_metrics. A server that
            # doesn't understand this field ignores it; token streaming
            # is unaffected either way.
            "stream_options": {"include_usage": True},
        }
        for key, value in (effective_options or {}).items():
            body["max_tokens" if key == "num_predict" else key] = value
        return body

    def stream_chat(
        self,
        *,
        system_prompt: str,
        user_prompt: str,
        timer: RequestTimer | None = None,
        options_override: Mapping[str, object] | None = None,
    ) -> Iterator[str]:
        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ]
        body = self._request_body(options_override)
        body["messages"] = messages
        usage: Mapping[str, object] | None = None
        try:
            with self._client.stream(
                "POST",
                f"{self._base_url}/chat/completions",
                json=body,
                headers=self._headers(),
            ) as response:
                if response.status_code >= 400:
                    # Read the body before raise_for_status() so the error
                    # classifier below can inspect the server's own JSON
                    # error message — a streamed response's body is empty
                    # until explicitly read.
                    response.read()
                response.raise_for_status()
                for line in response.iter_lines():
                    if not line or not line.startswith("data:"):
                        continue
                    data = line[len("data:") :].strip()
                    if not data or data == "[DONE]":
                        continue
                    try:
                        chunk = json.loads(data)
                    except ValueError:
                        logger.warning("Skipping malformed SSE chunk from inference server")
                        continue
                    chunk_usage = chunk.get("usage")
                    if isinstance(chunk_usage, dict):
                        usage = chunk_usage
                    choices = chunk.get("choices") or []
                    if not choices:
                        continue
                    delta = choices[0].get("delta") or {}
                    content = delta.get("content")
                    if content:
                        yield content
        except LLMProviderError:
            raise
        except Exception as exc:
            message = _classify_openai_compatible_error(exc, model=self._model)
            raise LLMProviderError(message) from exc

        if timer is not None and usage is not None:
            _record_openai_compatible_usage_metrics(timer, usage)


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
