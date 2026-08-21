import json
import logging
import threading
import time
from collections.abc import Callable, Iterable, Iterator, Mapping
from typing import Literal, Protocol

import httpx
import ollama

from app.core.errors import LLMErrorCategory, LLMProviderError
from app.core.ollama_errors import classify_ollama_error, classify_ollama_error_category
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
            raise LLMProviderError(
                classify_ollama_error(exc, model=self._model),
                category=classify_ollama_error_category(exc),
            ) from exc

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


def _classify_openai_compatible_error_category(exc: Exception) -> LLMErrorCategory:
    """The category counterpart to _classify_openai_compatible_error above
    (MS-S1 vLLM migration resilience work) — read by
    app/core/llm_provider.py::FailoverLLMProvider to decide whether a
    primary-provider failure is eligible for automatic failover. Kept as a
    separate function rather than folded into _classify_openai_compatible_error
    itself, mirroring app/core/ollama_errors.py's identical
    classify_ollama_error / classify_ollama_error_category split.

    A timeout or connection failure means the server/network path itself is
    unavailable — INFRASTRUCTURE, eligible for failover. A 5xx means the
    server is up but internally broken — also INFRASTRUCTURE: a healthy
    secondary provider can serve where a broken upstream inference server
    cannot. A 401/403 means this backend's own configured API key is
    wrong — CONFIGURATION, deliberately never failover-eligible (silently
    routing around a bad key would hide a real misconfiguration instead of
    surfacing it, per this migration's explicit design requirement). Any
    other status code (400 malformed request, 404 unknown model, etc.) is
    also CONFIGURATION for the same reason. Anything unrecognized falls
    through to LLMProviderError's own OTHER default, matching
    classify_ollama_error_category's identical fallthrough."""
    if isinstance(exc, httpx.TimeoutException):
        return LLMErrorCategory.INFRASTRUCTURE
    if isinstance(exc, httpx.ConnectError | ConnectionError):
        return LLMErrorCategory.INFRASTRUCTURE
    if isinstance(exc, httpx.HTTPStatusError):
        if exc.response.status_code in (401, 403):
            return LLMErrorCategory.CONFIGURATION
        if exc.response.status_code >= 500:
            return LLMErrorCategory.INFRASTRUCTURE
        return LLMErrorCategory.CONFIGURATION
    return LLMErrorCategory.OTHER


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
            category = _classify_openai_compatible_error_category(exc)
            raise LLMProviderError(message, category=category) from exc

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


_DEFAULT_FAILOVER_COOLDOWN_SECONDS = 20.0


class FailoverLLMProvider:
    """Wraps a primary and a fallback LLMProvider (MS-S1 vLLM migration
    resilience work: primary=OpenAICompatibleLLMProvider talking to MS-S1,
    fallback=OllamaLLMProvider talking to the local Oracle Ollama) so
    RagService/generation_manager see one ordinary LLMProvider and need no
    changes at all — this class implements the exact same Protocol as
    OllamaLLMProvider/OpenAICompatibleLLMProvider above.

    Design (deliberately simple over deliberately clever, matching this
    module's existing style):

    - NO separate health-check request is ever made. The primary is always
      attempted directly, and "did it work" is answered by the real
      generation attempt itself — avoiding both the extra round-trip a
      pre-flight health check would add to every single request, and the
      TOCTOU race a health check has against the real call that follows it
      (healthy-at-check-time, dead-a-moment-later is exactly the failure
      mode a pre-flight check cannot close).

    - Failover is a one-shot decision made ONLY before the primary has
      produced its first token. `stream_chat` pulls exactly one item from
      the primary's generator via `next()`: if that raises an
      INFRASTRUCTURE-classified LLMProviderError (see LLMErrorCategory),
      the fallback provider serves the entire request instead. If it
      raises anything else (CONFIGURATION/OTHER — a bad API key, a
      malformed request, an unrecognized failure), that exception is
      re-raised unchanged and NO failover happens — silently routing
      around a misconfiguration would hide it instead of surfacing it,
      which is this design's explicit, deliberate line (see
      LLMErrorCategory's own docstring).

    - Once the primary has yielded even one token, this class is fully
      committed to the primary for the rest of the stream: the remaining
      tokens are forwarded via a plain `yield from`, entirely outside any
      try/except here, so a disconnect partway through propagates exactly
      as it would with no failover wrapper at all — the caller's existing
      interrupted-generation handling (generation_manager.py's
      LLMProviderError branch: persist what streamed so far, mark the
      message "error") is completely unchanged. This is the one hard rule
      the migration's design explicitly calls out: never restart or splice
      in a second answer from a different provider after real output has
      already reached the user, since that could deliver a duplicated or
      contradictory answer.

    - Cancellation is untouched: this class adds no cancel-awareness of
      its own. `run_text_generation`'s cancel check runs between tokens of
      whatever iterator this class's `stream_chat` returns, regardless of
      which underlying provider is actually yielding them, and
      GeneratorExit (from that iterator being closed) propagates through
      the plain `yield`/`yield from` statements below into whichever
      provider is currently suspended at its own `with self._client.stream
      (...)` block exactly as it does today for a single provider — see
      OpenAICompatibleLLMProvider.stream_chat's own such block.

    - A short, bounded cooldown (`cooldown_seconds`, default
      _DEFAULT_FAILOVER_COOLDOWN_SECONDS) is the one piece of state this
      class keeps: after an INFRASTRUCTURE failure, the primary is skipped
      (fallback used immediately, no attempt at all) until the cooldown
      elapses — bounding the worst case where the primary is not merely
      refusing connections (fails in milliseconds either way) but silently
      unreachable (e.g. a severed Tailscale link with packets simply
      dropped), where a real connect attempt can block for the provider's
      full configured request timeout. Without this, every single request
      during such an outage would pay that full timeout before falling
      back. The cooldown is never permanent and needs no restart/manual
      reset to clear: the very next `stream_chat` call after it elapses
      tries the primary again directly (the real generation attempt is
      again the only "health check" that ever runs), which is what makes
      recovery automatic. A cooldown of 0 (accepted for tests) disables
      this skip entirely — every call retries the primary fresh."""

    def __init__(
        self,
        *,
        primary: LLMProvider,
        fallback: LLMProvider,
        primary_label: str = "primary",
        fallback_label: str = "fallback",
        cooldown_seconds: float = _DEFAULT_FAILOVER_COOLDOWN_SECONDS,
        now_fn: Callable[[], float] = time.monotonic,
    ) -> None:
        self._primary = primary
        self._fallback = fallback
        self._primary_label = primary_label
        self._fallback_label = fallback_label
        self._cooldown_seconds = cooldown_seconds
        self._now_fn = now_fn
        self._state_lock = threading.Lock()
        # monotonic timestamp before which the primary is skipped entirely
        # (0.0 — i.e. "never skip" — until the first INFRASTRUCTURE failure).
        self._primary_unhealthy_until = 0.0

    def _primary_available_now(self) -> bool:
        with self._state_lock:
            return self._now_fn() >= self._primary_unhealthy_until

    def _mark_primary_unhealthy(self) -> None:
        if self._cooldown_seconds <= 0:
            return
        with self._state_lock:
            self._primary_unhealthy_until = self._now_fn() + self._cooldown_seconds

    def _mark_primary_healthy(self) -> None:
        with self._state_lock:
            self._primary_unhealthy_until = 0.0

    def stream_chat(
        self,
        *,
        system_prompt: str,
        user_prompt: str,
        timer: RequestTimer | None = None,
        options_override: Mapping[str, object] | None = None,
    ) -> Iterator[str]:
        if self._primary_available_now():
            primary_stream = self._primary.stream_chat(
                system_prompt=system_prompt,
                user_prompt=user_prompt,
                timer=timer,
                options_override=options_override,
            )
            try:
                first_token = next(primary_stream)
            except StopIteration:
                # Primary produced a genuinely empty completion — a
                # successful (if unusual) outcome, not a failure to
                # recover from. Nothing was yielded either way.
                self._mark_primary_healthy()
                return
            except LLMProviderError as exc:
                if exc.category is not LLMErrorCategory.INFRASTRUCTURE:
                    # Configuration/auth/unrecognized failure: never
                    # silently mask this behind the fallback provider.
                    raise
                self._mark_primary_unhealthy()
                logger.warning(
                    "Primary LLM (%s) unavailable before generation; using fallback provider (%s)",
                    self._primary_label,
                    self._fallback_label,
                )
                if timer is not None:
                    timer.record_tag("llm_failover", "primary_unavailable")
                    timer.record_tag("llm_served_by", self._fallback_label)
                yield from self._fallback.stream_chat(
                    system_prompt=system_prompt,
                    user_prompt=user_prompt,
                    timer=timer,
                    options_override=options_override,
                )
                return
            else:
                # Primary produced real output — fully committed from here:
                # no further exception handling wraps the rest of the
                # stream, so an interruption partway through behaves
                # exactly as it would with no failover wrapper at all.
                self._mark_primary_healthy()
                if timer is not None:
                    timer.record_tag("llm_served_by", self._primary_label)
                yield first_token
                yield from primary_stream
                return

        # Primary is in its post-failure cooldown window: skip straight to
        # the fallback without attempting the primary at all, avoiding a
        # repeat of whatever made it slow/unreachable in the first place.
        logger.info(
            "Primary LLM (%s) in cooldown after a recent failure; using fallback provider (%s)",
            self._primary_label,
            self._fallback_label,
        )
        if timer is not None:
            timer.record_tag("llm_failover", "primary_cooldown")
            timer.record_tag("llm_served_by", self._fallback_label)
        yield from self._fallback.stream_chat(
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            timer=timer,
            options_override=options_override,
        )
