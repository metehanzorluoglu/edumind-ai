from collections.abc import Sequence
from typing import Protocol

import ollama

from app.core.errors import EmbeddingProviderError

MXBAI_EMBED_LARGE_DIMENSIONS = 1024

_DEFAULT_BATCH_SIZE = 32


class EmbeddingProvider(Protocol):
    @property
    def dimensions(self) -> int: ...

    def embed_batch(self, texts: list[str]) -> list[list[float]]: ...


class _EmbedResponseLike(Protocol):
    @property
    def embeddings(self) -> Sequence[Sequence[float]]: ...


class _EmbedCapableClient(Protocol):
    def embed(self, *, model: str, input: list[str]) -> _EmbedResponseLike: ...


class OllamaEmbeddingProvider:
    def __init__(
        self,
        *,
        model: str,
        dimensions: int,
        base_url: str = "http://localhost:11434",
        client: _EmbedCapableClient | None = None,
        batch_size: int = _DEFAULT_BATCH_SIZE,
    ) -> None:
        self._model = model
        self._dimensions = dimensions
        self._client: _EmbedCapableClient = (
            client if client is not None else ollama.Client(host=base_url)
        )
        self._batch_size = batch_size

    @property
    def dimensions(self) -> int:
        return self._dimensions

    def embed_batch(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []

        embeddings: list[list[float]] = []
        for start in range(0, len(texts), self._batch_size):
            batch = texts[start : start + self._batch_size]
            embeddings.extend(self._embed_single_batch(batch))
        return embeddings

    def _embed_single_batch(self, batch: list[str]) -> list[list[float]]:
        try:
            response = self._client.embed(model=self._model, input=batch)
        except Exception as exc:
            raise EmbeddingProviderError(
                f"Failed to embed {len(batch)} text(s) with model '{self._model}': {exc}"
            ) from exc

        raw_embeddings = response.embeddings

        if len(raw_embeddings) != len(batch):
            raise EmbeddingProviderError(
                f"Expected {len(batch)} embeddings from '{self._model}', got {len(raw_embeddings)}"
            )

        embeddings: list[list[float]] = []
        for raw_embedding in raw_embeddings:
            embedding = [float(value) for value in raw_embedding]
            if len(embedding) != self._dimensions:
                raise EmbeddingProviderError(
                    f"Expected {self._dimensions}-dimensional embeddings from '{self._model}', "
                    f"got {len(embedding)}"
                )
            embeddings.append(embedding)
        return embeddings
