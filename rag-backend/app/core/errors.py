from enum import StrEnum


class CoreError(Exception):
    pass


class EmbeddingProviderError(CoreError):
    pass


class LLMProviderError(CoreError):
    pass


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
