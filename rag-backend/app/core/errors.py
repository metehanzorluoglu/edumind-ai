from enum import StrEnum


class CoreError(Exception):
    pass


class EmbeddingProviderError(CoreError):
    pass


class LLMErrorCategory(StrEnum):
    """Classifies *why* an LLMProvider.stream_chat call failed — read by
    app/core/llm_provider.py::FailoverLLMProvider to decide whether an
    error is eligible for automatic failover to a secondary provider
    (MS-S1/vLLM migration resilience work).

    INFRASTRUCTURE means the provider itself (the process/host/network path
    to it) is the thing that's broken — connection refused, DNS failure,
    a connect/read timeout, or an upstream 5xx — exactly the class of
    failure a healthy secondary provider can plausibly route around.
    Automatic failover is only ever considered for this category.

    CONFIGURATION means the provider responded (or refused to) in a way
    that means *this backend's own setup* is wrong — a bad/expired API key
    (401/403), a model name the server doesn't know about, a malformed
    request. Failing over here would silently mask a real misconfiguration
    behind a fallback provider that "happens to still work" — see the
    module docstring's explicit warning about this — so these never
    trigger automatic failover.

    OTHER is the safe default for anything not explicitly classified
    (mirrors VisionErrorCategory.OTHER's identical default-to-safe
    convention above) — deliberately treated the same as CONFIGURATION by
    FailoverLLMProvider (i.e. never eligible for failover): an
    unrecognized failure shape is exactly the case where silently masking
    it behind a different provider is least appropriate."""

    INFRASTRUCTURE = "infrastructure"
    CONFIGURATION = "configuration"
    OTHER = "other"


class LLMProviderError(CoreError):
    """`category` (see LLMErrorCategory) defaults to OTHER — the safe,
    non-failover-eligible default — so a raise site that doesn't set one
    explicitly (any exception type classify_ollama_error/
    _classify_openai_compatible_error don't specifically recognize) never
    silently becomes failover-eligible by omission."""

    def __init__(self, message: str, *, category: LLMErrorCategory | None = None) -> None:
        super().__init__(message)
        self.category: LLMErrorCategory = category or LLMErrorCategory.OTHER


class VisionErrorCategory(StrEnum):
    """Mirrors the task's required error classes (see
    app/services/vision_service.py and app/core/ollama_errors.py). A plain
    str subclass (StrEnum) rather than a bare Enum so it serializes to a
    plain string automatically wherever it's logged or placed on
    ChatErrorEvent.error_category (app/schemas/chat.py) without an extra
    `.value` at every call site."""

    PREPROCESSING_FAILURE = "preprocessing_failure"
    REQUEST_TOO_LARGE = "request_too_large"
    TOO_MANY_PAGES = "too_many_pages"
    MODEL_LOAD_OR_PROMPT_EVAL_TIMEOUT = "model_load_or_prompt_eval_timeout"
    GENERATION_TIMEOUT = "generation_timeout"
    OLLAMA_UNAVAILABLE = "ollama_unavailable"
    OTHER = "other"


class VisionServiceError(CoreError):
    """Carries an optional `category` (see VisionErrorCategory) so callers
    — app/api/routes_conversations.py's vision route and structured logs —
    can react to *why* a vision call failed without parsing the message
    text. `category` defaults to OTHER: every raise site that has a more
    specific category available passes it explicitly (see
    app/services/vision_service.py); a raise site that doesn't set one
    (e.g. an unexpected exception type) still produces a valid, gradeable
    error rather than one with no category at all."""

    def __init__(self, message: str, *, category: VisionErrorCategory | None = None) -> None:
        super().__init__(message)
        self.category: VisionErrorCategory = category or VisionErrorCategory.OTHER


class ImageGenerationError(CoreError):
    pass


class AttachmentValidationError(CoreError):
    pass
