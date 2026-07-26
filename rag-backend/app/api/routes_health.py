import logging
from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel

from app import __version__
from app.core.readiness import check_readiness
from app.deps import SettingsDep, get_vector_store

router = APIRouter(tags=["health"])

logger = logging.getLogger(__name__)


class HealthResponse(BaseModel):
    status: str
    app_env: str
    version: str


class ReadinessResponse(BaseModel):
    status: Literal["ready", "not_ready"]
    ollama_reachable: bool
    qdrant_reachable: bool
    models_available: dict[str, bool]
    # Named, unambiguous booleans alongside the generic `models_available`
    # dict above (which is keyed by model name, e.g. "qwen3:8b") — a
    # frontend/dev-screen consumer shouldn't have to know which
    # model name corresponds to "the text model" vs "the vision model" just
    # to render three readiness rows. `vision_model_available` is null
    # (not false) when VISION_ENABLED=false: vision being disabled is not
    # the same fact as the vision model being unavailable.
    text_model_available: bool
    vision_model_available: bool | None
    embedding_model_available: bool
    # Milestone V4 (Settings/Developer page): round-trip time of the one
    # Ollama call this check makes (a model list request) — None when
    # Ollama wasn't reachable at all, since a failed/timed-out attempt has
    # no meaningful "how long did it take" answer. Not per-model: Ollama
    # has no cheaper way to check one specific model's own latency
    # without actually running a generation against it, which this
    # lightweight readiness check deliberately never does.
    ollama_latency_ms: float | None
    qdrant_latency_ms: float | None


@router.get("/health", response_model=HealthResponse)
async def get_health(settings: SettingsDep) -> HealthResponse:
    return HealthResponse(status="ok", app_env=settings.app_env, version=__version__)


@router.get("/health/ready", response_model=ReadinessResponse)
def get_readiness(settings: SettingsDep) -> ReadinessResponse:
    # Reuses the app's own VectorStoreDep singleton (get_vector_store()) instead
    # of constructing a throwaway store here. In local/embedded qdrant_mode, a
    # second QdrantVectorStore against the same on-disk path is rejected by
    # qdrant-client with a RuntimeError ("already accessed by another
    # instance") — a real 500 in this backend's own default configuration,
    # not a hypothetical. Sharing the singleton means there is only ever one
    # client open against that path, so that failure mode cannot occur for
    # this app's own requests; it's still possible for the *first* caller to
    # observe the singleton's own construction failing (e.g. an external
    # process already holds the path lock, or a "server"-mode Qdrant is
    # unreachable), which is caught here and reported as "not ready" rather
    # than surfacing as an unhandled 500.
    try:
        store = get_vector_store()
    except Exception as exc:
        logger.warning("Qdrant readiness check failed: %s", exc)
        store = None

    required_models = [settings.ollama_llm_model, settings.ollama_embed_model]
    if settings.vision_enabled:
        required_models.append(settings.ollama_vision_model)

    readiness = check_readiness(
        ollama_base_url=settings.ollama_base_url,
        required_models=required_models,
        vector_store=store,
    )
    vision_model_available = (
        readiness.models_available[settings.ollama_vision_model]
        if settings.vision_enabled
        else None
    )
    return ReadinessResponse(
        status="ready" if readiness.is_ready else "not_ready",
        ollama_reachable=readiness.ollama_reachable,
        qdrant_reachable=readiness.qdrant_reachable,
        models_available=readiness.models_available,
        text_model_available=readiness.models_available[settings.ollama_llm_model],
        vision_model_available=vision_model_available,
        embedding_model_available=readiness.models_available[settings.ollama_embed_model],
        ollama_latency_ms=readiness.ollama_latency_ms,
        qdrant_latency_ms=readiness.qdrant_latency_ms,
    )
