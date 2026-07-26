class CoreError(Exception):
    pass


class EmbeddingProviderError(CoreError):
    pass


class LLMProviderError(CoreError):
    pass


class VisionServiceError(CoreError):
    pass


class ImageGenerationError(CoreError):
    pass


class AttachmentValidationError(CoreError):
    pass
