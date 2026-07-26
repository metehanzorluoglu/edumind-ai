import logging
import time
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Protocol

import ollama

from app.vectorstore.qdrant_client import QdrantVectorStore

logger = logging.getLogger(__name__)


class _ModelLike(Protocol):
    @property
    def model(self) -> str | None: ...


class _ListResponseLike(Protocol):
    @property
    def models(self) -> Sequence[_ModelLike]: ...


class _ListableClient(Protocol):
    def list(self) -> _ListResponseLike: ...


@dataclass
class ReadinessStatus:
    ollama_reachable: bool
    qdrant_reachable: bool
    models_available: dict[str, bool]
    # None when the corresponding service wasn't reachable at all
    # (milestone V4 — a Settings/Developer page metric): a failed or
    # timed-out call has no meaningful "how long did it take" answer, so
    # this is never populated with a failed attempt's elapsed time.
    ollama_latency_ms: float | None = None
    qdrant_latency_ms: float | None = None

    @property
    def is_ready(self) -> bool:
        return (
            self.ollama_reachable and self.qdrant_reachable and all(self.models_available.values())
        )


def _model_installed(required: str, installed_names: set[str]) -> bool:
    return any(name == required or name.startswith(f"{required}:") for name in installed_names)


def check_readiness(
    *,
    ollama_base_url: str,
    required_models: list[str],
    vector_store: QdrantVectorStore | None,
    ollama_client: _ListableClient | None = None,
) -> ReadinessStatus:
    ollama_reachable = False
    ollama_latency_ms: float | None = None
    models_available = dict.fromkeys(required_models, False)

    try:
        client = ollama_client if ollama_client is not None else ollama.Client(host=ollama_base_url)
        started_at = time.monotonic()
        response = client.list()
        ollama_latency_ms = (time.monotonic() - started_at) * 1000
        installed_names = {model.model for model in response.models if model.model}
        ollama_reachable = True
        models_available = {
            required: _model_installed(required, installed_names) for required in required_models
        }
    except Exception:
        ollama_latency_ms = None

    # vector_store is None when even constructing the store failed (e.g. a
    # local/embedded store whose on-disk path is already locked open by
    # this same process's own singleton) — that failure means Qdrant is
    # not usably reachable, same as a ping() failure below.
    qdrant_reachable = False
    qdrant_latency_ms: float | None = None
    if vector_store is not None:
        try:
            started_at = time.monotonic()
            vector_store.ping()
            qdrant_latency_ms = (time.monotonic() - started_at) * 1000
            qdrant_reachable = True
        except Exception as exc:
            logger.warning("Qdrant ping failed during readiness check: %s", exc)
            qdrant_reachable = False
            qdrant_latency_ms = None

    return ReadinessStatus(
        ollama_reachable=ollama_reachable,
        qdrant_reachable=qdrant_reachable,
        models_available=models_available,
        ollama_latency_ms=ollama_latency_ms,
        qdrant_latency_ms=qdrant_latency_ms,
    )
