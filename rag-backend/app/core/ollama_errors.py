"""Classifies an exception raised by the `ollama` Python client into a
specific, user-actionable message (milestone V4) — shared by
app/core/llm_provider.py (text chat), app/services/vision_service.py
(vision chat), and app/core/image_generation_service.py (image
generation). The first two call `ollama.Client.chat(..., stream=True)`;
image generation calls Ollama's raw HTTP API directly via httpx instead
(see that module's docstring for why), which raises httpx.HTTPStatusError
rather than ollama.ResponseError for a non-2xx response — handled below
alongside it, since both are just "Ollama sent back a JSON error body",
differing only in which library raised it. One place turning "some
exception" into "a message a user can actually act on" means every
pipeline can never drift on how they explain the same failure.

What ollama/httpx actually raise here — verified against the installed
`ollama` package and a live local Ollama server, not guessed:

- A missing/not-yet-pulled model: `ollama.ResponseError` with
  `.status_code == 404` and `.error` containing "not found".
- Ollama unreachable (wrong port, not running): a raw `httpx.ConnectError`
  propagates all the way up. (`ollama._client` does wrap some *synchronous,
  non-streaming* call sites' `httpx.ConnectError` into a plain
  `ConnectionError` with its own fixed message — but every call in this
  project uses `stream=True`, where the actual HTTP connection is only
  opened once the returned generator is iterated, *after* that wrapping
  try/except has already returned control to the caller. Both exception
  types are handled here regardless, since which one surfaces is a detail
  of ollama's internals this project shouldn't have to track precisely.)
- A stalled/slow generation: a raw `httpx.ReadTimeout` (a `TimeoutException`
  subclass) once `timeout_seconds` elapses.
- Out-of-memory: Ollama has no dedicated status code or exception for
  this — it only ever surfaces as an `ollama.ResponseError` whose `.error`
  text happens to mention memory exhaustion. Detecting it is therefore a
  best-effort keyword match, not a guaranteed classification; anything
  that doesn't match a known keyword still gets a clear (if generic)
  message rather than a bare stack trace.
"""

import httpx
import ollama

from app.core.errors import LLMErrorCategory, VisionErrorCategory

_OOM_KEYWORDS = ("out of memory", "cuda error", "oom", "insufficient memory", "failed to allocate")
_NOT_FOUND_KEYWORDS = ("not found", "no such model")


def _keyword_classified_message(message: str, *, model: str) -> str | None:
    lowered = message.lower()
    if any(keyword in lowered for keyword in _NOT_FOUND_KEYWORDS):
        return f"Model '{model}' is not installed. Run `ollama pull {model}` and try again."
    if any(keyword in lowered for keyword in _OOM_KEYWORDS):
        return (
            f"The '{model}' model ran out of memory processing this request. Try a "
            "smaller image, fewer PDF pages, or a shorter message."
        )
    return None


def classify_ollama_error(exc: Exception, *, model: str, action: str = "Chat generation") -> str:
    if isinstance(exc, httpx.TimeoutException):
        return (
            f"The '{model}' model did not respond in time. It may be overloaded, or this "
            "request (e.g. a large image or many PDF pages) may be too big to process "
            "quickly — try again, or with a smaller attachment."
        )

    if isinstance(exc, httpx.ConnectError | ConnectionError):
        return (
            f"Could not reach the Ollama server to run '{model}'. Check that Ollama is "
            "installed and running (`ollama serve`)."
        )

    if isinstance(exc, ollama.ResponseError):
        message = exc.error or str(exc)
        classified = _keyword_classified_message(message, model=model)
        if classified is not None:
            return classified
        return f"Ollama returned an error running '{model}': {message}"

    if isinstance(exc, httpx.HTTPStatusError):
        try:
            body = exc.response.json()
            message = body.get("error") or str(body) if isinstance(body, dict) else str(body)
        except ValueError:
            message = exc.response.text or str(exc)
        classified = _keyword_classified_message(message, model=model)
        if classified is not None:
            return classified
        return f"Ollama returned an error running '{model}': {message}"

    return f"{action} with model '{model}' failed: {exc}"


def classify_ollama_error_category(exc: Exception) -> LLMErrorCategory:
    """The FailoverLLMProvider counterpart to classify_ollama_error above
    (MS-S1 vLLM migration resilience work) — same exception-type branches,
    returning an LLMErrorCategory instead of a message string, so
    app/core/llm_provider.py::OllamaLLMProvider's raised LLMProviderError
    carries enough structure for FailoverLLMProvider to decide whether a
    failure is eligible for automatic failover, without re-parsing the
    message text. See LLMErrorCategory's own docstring for the exact
    INFRASTRUCTURE/CONFIGURATION/OTHER contract.

    A missing/not-yet-pulled model (ollama.ResponseError, "not found") is
    deliberately CONFIGURATION, not INFRASTRUCTURE: the server is reachable
    and responded — this backend (or its operator) asked for the wrong
    model name, exactly the kind of misconfiguration that should surface
    loudly rather than be silently routed around."""
    if isinstance(exc, httpx.TimeoutException):
        return LLMErrorCategory.INFRASTRUCTURE
    if isinstance(exc, httpx.ConnectError | ConnectionError):
        return LLMErrorCategory.INFRASTRUCTURE
    if isinstance(exc, ollama.ResponseError):
        return LLMErrorCategory.CONFIGURATION
    if isinstance(exc, httpx.HTTPStatusError):
        if exc.response.status_code >= 500:
            return LLMErrorCategory.INFRASTRUCTURE
        return LLMErrorCategory.CONFIGURATION
    return LLMErrorCategory.OTHER


def classify_vision_error_category(
    exc: Exception, *, received_first_token: bool = False
) -> VisionErrorCategory:
    """The category counterpart to classify_ollama_error above — same
    exception-type branches, but returns one of the task-required
    VisionErrorCategory values instead of a message string (see
    app/services/vision_service.py, the only caller). Kept as a separate
    function rather than folded into classify_ollama_error itself so
    app/core/llm_provider.py and app/core/image_generation_service.py
    (the other two callers of classify_ollama_error) are entirely
    unaffected by this — they have no use for a vision-specific category
    and their call sites are unchanged.

    `received_first_token`, supplied by the caller (which is the only
    place that knows whether any ChatResponse chunk had already streamed
    before this exception was raised — see VisionService.stream_chat),
    is what distinguishes MODEL_LOAD_OR_PROMPT_EVAL_TIMEOUT from
    GENERATION_TIMEOUT for an httpx.TimeoutException: Ollama's HTTP API
    gives no signal of its own for "still loading/evaluating" vs "now
    decoding" (the same limitation documented for the text pipeline's
    progress events — see app/schemas/chat.py's ChatProgressEvent), so
    "did we already see output" is the only distinguishing signal
    available on this side of the connection."""
    if isinstance(exc, httpx.TimeoutException):
        return (
            VisionErrorCategory.GENERATION_TIMEOUT
            if received_first_token
            else VisionErrorCategory.MODEL_LOAD_OR_PROMPT_EVAL_TIMEOUT
        )

    if isinstance(exc, httpx.ConnectError | ConnectionError):
        return VisionErrorCategory.OLLAMA_UNAVAILABLE

    if isinstance(exc, ollama.ResponseError):
        message = (exc.error or str(exc)).lower()
        if any(keyword in message for keyword in _NOT_FOUND_KEYWORDS):
            return VisionErrorCategory.OLLAMA_UNAVAILABLE
        if any(keyword in message for keyword in _OOM_KEYWORDS):
            return VisionErrorCategory.REQUEST_TOO_LARGE
        return VisionErrorCategory.OTHER

    if isinstance(exc, httpx.HTTPStatusError):
        try:
            body = exc.response.json()
            message = (
                (body.get("error") or str(body)) if isinstance(body, dict) else str(body)
            ).lower()
        except ValueError:
            message = (exc.response.text or str(exc)).lower()
        if any(keyword in message for keyword in _NOT_FOUND_KEYWORDS):
            return VisionErrorCategory.OLLAMA_UNAVAILABLE
        if any(keyword in message for keyword in _OOM_KEYWORDS):
            return VisionErrorCategory.REQUEST_TOO_LARGE
        return VisionErrorCategory.OTHER

    return VisionErrorCategory.OTHER
