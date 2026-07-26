"""Image generation via a dedicated Ollama image-output model (x/flux2-klein
by default — see app/config.py's IMAGE_GENERATION_ENABLED/OLLAMA_IMAGE_MODEL).

Deliberately separate from app/services/vision_service.py: vision_service
*reads* images (qwen2.5vl understands an uploaded image); this module
*writes* images (a flux2-klein-shaped model produces new ones from a text
prompt). The two are never routed through the same client, model, or
config flag — mirroring app/core/model_routing.py's existing text/vision
split, just one level further out (image input vs. image output).

The `ollama` Python package's typed client models a text `response` field
only (see vision_service.py/llm_provider.py's `ollama.Client.chat(...,
stream=True)`) — it has no typed shape for an image-generation model's
output. This module therefore calls Ollama's raw HTTP `/api/generate`
endpoint directly via httpx.

Wire format verified against a real local Ollama server running
`x/flux2-klein` (not guessed): `width`/`height`/`seed`/`negative_prompt`
must be **top-level** request fields, not nested under `options` — nesting
them under `options` silently succeeds but the model ignores them
entirely and falls back to its own default size (confirmed by requesting
512x512 and getting back a 1024x1024 image). The response body contains a
single `image` field (one base64-encoded PNG string), not an `images`
list — there is no way to request more than one image per call, which is
why `generate()` below still issues one HTTP request per image in a
`num_images` batch.
"""

import base64
import uuid
from dataclasses import dataclass
from typing import Protocol

import httpx

from app.core.errors import ImageGenerationError
from app.core.ollama_errors import classify_ollama_error

_ACTION = "Image generation"


@dataclass(frozen=True)
class GeneratedImageResult:
    id: uuid.UUID
    data: bytes
    seed: int | None


class _HttpPoster(Protocol):
    def post(self, url: str, *, json: dict[str, object]) -> httpx.Response: ...


def _extract_image(body: object) -> str | None:
    if not isinstance(body, dict):
        return None
    image = body.get("image")
    return image if isinstance(image, str) and image else None


class ImageGenerationService:
    """Generates one or more images from a text prompt. Mirrors
    app/services/vision_service.py's VisionService shape (injectable
    client for testing, same wrap-every-failure-into-one-error-type
    convention via classify_ollama_error) but calls raw HTTP rather than
    the `ollama` package — see this module's docstring for why."""

    def __init__(
        self,
        *,
        model: str,
        base_url: str = "http://localhost:11434",
        timeout_seconds: float = 120.0,
        client: _HttpPoster | None = None,
    ) -> None:
        self._model = model
        self._base_url = base_url.rstrip("/")
        self._client: _HttpPoster = (
            client if client is not None else httpx.Client(timeout=timeout_seconds)
        )

    def generate_one(
        self,
        *,
        prompt: str,
        negative_prompt: str | None = None,
        width: int,
        height: int,
        seed: int | None = None,
        reference_images: list[bytes] | None = None,
    ) -> GeneratedImageResult:
        """Generates exactly one image — the primitive `generate()` below
        loops over for a batch, and the same one a streaming caller (see
        routes_images.py) calls directly between each SSE progress event,
        since Ollama's own API has no way to request more than one image
        per call (see this module's docstring).

        `reference_images` (optional) are forwarded to Ollama's `/api/generate`
        `images` field as base64 strings — the same convention vision_service
        uses for image *input*. For a multimodal/reference-capable model this
        conditions the output on the references; for the current text-to-image
        model (x/flux2-klein) the field is a silent no-op (it has no image
        encoder). It is only added to the body when non-empty, so the
        text-only path is byte-for-byte unchanged."""
        if not prompt.strip():
            raise ImageGenerationError("prompt must not be empty")

        request_body: dict[str, object] = {
            "model": self._model,
            "prompt": prompt,
            "stream": False,
            "width": width,
            "height": height,
        }
        if seed is not None:
            request_body["seed"] = seed
        if negative_prompt:
            request_body["negative_prompt"] = negative_prompt
        if reference_images:
            request_body["images"] = [
                base64.b64encode(image).decode("ascii") for image in reference_images
            ]

        try:
            response = self._client.post(f"{self._base_url}/api/generate", json=request_body)
            response.raise_for_status()
            body = response.json()
        except ImageGenerationError:
            raise
        except Exception as exc:
            raise ImageGenerationError(
                classify_ollama_error(exc, model=self._model, action=_ACTION)
            ) from exc

        image = _extract_image(body)
        if image is None:
            raise ImageGenerationError(
                f"Model '{self._model}' returned no image data for this prompt."
            )
        try:
            data = base64.b64decode(image, validate=True)
        except Exception as exc:
            raise ImageGenerationError(
                f"Model '{self._model}' returned malformed image data: {exc}"
            ) from exc
        if not data:
            raise ImageGenerationError(
                f"Model '{self._model}' returned empty image data for this prompt."
            )

        return GeneratedImageResult(id=uuid.uuid4(), data=data, seed=seed)

    def generate(
        self,
        *,
        prompt: str,
        negative_prompt: str | None = None,
        width: int,
        height: int,
        seed: int | None = None,
        num_images: int = 1,
        reference_images: list[bytes] | None = None,
    ) -> list[GeneratedImageResult]:
        if num_images < 1:
            raise ImageGenerationError("num_images must be at least 1")

        results: list[GeneratedImageResult] = []
        for index in range(num_images):
            # Each image in a batch gets its own deterministic-but-distinct
            # seed (when the caller supplied one at all) — reusing the same
            # seed num_images times would otherwise produce num_images
            # identical images, defeating the point of asking for more than
            # one.
            image_seed = seed + index if seed is not None else None
            results.append(
                self.generate_one(
                    prompt=prompt,
                    negative_prompt=negative_prompt,
                    width=width,
                    height=height,
                    seed=image_seed,
                    reference_images=reference_images,
                )
            )

        return results
