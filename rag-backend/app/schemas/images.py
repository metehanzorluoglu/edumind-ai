import base64
from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator

from app.schemas.conversations import MessageAttachmentResponse

# Reference-image caps — mirrored on the frontend (lib/referenceImages.ts) so a
# bad reference is rejected client-side too. Kept modest: a reference is an
# inline base64 data URL in a plain-JSON body (see GenerateImagesRequest's
# docstring), so each one costs request bytes directly.
REFERENCE_IMAGE_MIME_TYPES = ("image/png", "image/jpeg", "image/webp")
REFERENCE_IMAGE_MAX_BYTES = 10 * 1024 * 1024
REFERENCE_IMAGE_MAX_COUNT = 4


def decode_reference_data_url(data_url: str) -> tuple[str, bytes]:
    """Parse a RFC-2397 `data:<mime>;base64,<payload>` URL into
    `(declared_mime, decoded_bytes)`. Raises ValueError on anything
    malformed — used both by ReferenceImageInput validation (so a bad or
    oversized reference 422s *before* any generation starts) and by the
    route (so the bytes aren't decoded a third time when persisting)."""
    if not data_url.startswith("data:"):
        raise ValueError("reference image must be a data: URL")
    header, sep, payload = data_url[len("data:") :].partition(",")
    if not sep:
        raise ValueError("reference image data URL is missing its payload")
    if not header.endswith(";base64"):
        raise ValueError("reference image data URL must be base64-encoded")
    declared_mime = header[: -len(";base64")].strip().lower()
    try:
        data = base64.b64decode(payload, validate=True)
    except Exception as exc:
        raise ValueError(f"reference image base64 payload is invalid: {exc}") from exc
    return declared_mime, data


class ReferenceImageInput(BaseModel):
    """One reference image (object reference, or character/style reference),
    inlined as a base64 data URL so the request stays plain JSON. The image
    model receives the decoded bytes via Ollama's `images` field (a no-op for
    the current text-to-image model x/flux2-klein, functional the instant a
    reference-capable model is configured — see image_generation_service.py),
    and the bytes are also persisted as a `source="reference"` attachment on
    the generated message so Regenerate can reuse them."""

    data_url: str = Field(min_length=1)
    mime: str

    @field_validator("mime")
    @classmethod
    def _mime_allowed(cls, value: str) -> str:
        if value not in REFERENCE_IMAGE_MIME_TYPES:
            raise ValueError(
                f"reference image mime {value!r} is not allowed "
                f"(use one of {', '.join(REFERENCE_IMAGE_MIME_TYPES)})"
            )
        return value

    @model_validator(mode="after")
    def _decode_size_and_mime(self) -> "ReferenceImageInput":
        declared_mime, data = decode_reference_data_url(self.data_url)
        if declared_mime and declared_mime != self.mime.lower():
            raise ValueError(
                f"reference image mime {self.mime!r} does not match its "
                f"data URL header {declared_mime!r}"
            )
        if len(data) > REFERENCE_IMAGE_MAX_BYTES:
            raise ValueError(
                f"reference image exceeds the {REFERENCE_IMAGE_MAX_BYTES}-byte limit"
            )
        return self


class GenerateImagesRequest(BaseModel):
    """POST /images/generate's request body. `conversation_id` is not part
    of the originally-specified field list but is structurally required:
    requirement 5 ("save generated images in the conversation") means this
    endpoint must know which conversation to persist the result into —
    there is no other way for the backend to learn that. `save_to_project_id`
    is likewise additive: optional, and only ever used when the caller
    explicitly wants this generation saved as a project asset (see
    MessageAttachment.saved_project_id's docs) — omitted or null does
    nothing. `reference_images` is additive too: optional, validated eagerly
    (each data URL is decoded + size/mime-checked here, so a bad reference
    422s before streaming starts), and persisted alongside the generated
    images so Regenerate reuses them."""

    prompt: str = Field(min_length=1, max_length=2000)
    negative_prompt: str | None = Field(default=None, max_length=2000)
    width: int = Field(ge=64, le=2048)
    height: int = Field(ge=64, le=2048)
    seed: int | None = Field(default=None, ge=0, le=2**32 - 1)
    num_images: int = Field(default=1, ge=1, le=10)
    conversation_id: str
    save_to_project_id: str | None = None
    reference_images: list[ReferenceImageInput] | None = Field(
        default=None, max_length=REFERENCE_IMAGE_MAX_COUNT
    )


class ImageGenerationProgressEvent(BaseModel):
    """One per completed image (never a faked fraction for a single
    image — see ImageGenerationModal.tsx's "no fake 1/4, 2/4 for one
    image" requirement). `completed` is 1-indexed and monotonically
    increasing; a frontend showing "Generating image N of total" derives
    N as `min(completed + 1, total)` (the image *currently* in flight),
    not `completed` itself."""

    type: Literal["progress"] = "progress"
    completed: int
    total: int


class ImageGenerationDoneEvent(BaseModel):
    type: Literal["done"] = "done"
    message_id: str
    conversation_id: str
    images: list[MessageAttachmentResponse]


class ImageGenerationErrorEvent(BaseModel):
    type: Literal["error"] = "error"
    message: str


ImageGenerationEvent = (
    ImageGenerationProgressEvent | ImageGenerationDoneEvent | ImageGenerationErrorEvent
)
