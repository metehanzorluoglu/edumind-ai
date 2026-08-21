import logging

from fastapi import APIRouter, Depends

from app.core.corpus_stats import CorpusStats, compute_corpus_stats
from app.core.readiness import check_readiness
from app.core.security import CurrentUserDep, get_current_user
from app.deps import SettingsDep, get_vector_store
from app.schemas.status import StatusResponse

router = APIRouter(tags=["status"], dependencies=[Depends(get_current_user)])

logger = logging.getLogger(__name__)


@router.get("/status", response_model=StatusResponse)
def get_status(settings: SettingsDep, user: CurrentUserDep) -> StatusResponse:
    """Protected corpus/dependency status for the mobile app's dev-only
    Settings screen (milestone 9 §16). Reuses the app's own VectorStoreDep
    singleton — same reasoning as /health/ready (see routes_health.py): no
    second embedded-Qdrant client is ever constructed against the same path.

    Never returns raw document text, filesystem paths, API keys, private
    environment variables, or system prompts — only counts, model names,
    and reachability booleans.
    """
    try:
        store = get_vector_store()
    except Exception as exc:
        logger.warning("Qdrant status check failed: %s", exc)
        store = None

    # See routes_health.py's identical comment: the chat LLM's model name
    # only joins the Ollama-side required_models list when it actually
    # lives on the Ollama server.
    required_models = [settings.ollama_embed_model]
    if settings.vision_enabled:
        required_models.append(settings.ollama_vision_model)
    if settings.llm_provider == "ollama":
        required_models.append(settings.ollama_llm_model)

    # Automatic LLM failover (MS-S1 resilience work) — see routes_health.py's
    # identical comment for why each role's own model name is resolved here.
    llm_primary_provider = None
    llm_primary_model = None
    llm_fallback_model = None
    if settings.llm_provider == "failover":
        llm_primary_provider = settings.llm_primary_provider
        if llm_primary_provider == "openai_compatible":
            llm_primary_model = settings.llm_model
            llm_fallback_model = settings.ollama_llm_model
        else:
            llm_primary_model = settings.ollama_llm_model
            llm_fallback_model = settings.llm_model

    readiness = check_readiness(
        ollama_base_url=settings.ollama_base_url,
        required_models=required_models,
        vector_store=store,
        llm_provider=settings.llm_provider,
        llm_model=settings.effective_llm_model,
        llm_base_url=settings.llm_base_url,
        llm_api_key=settings.llm_api_key.get_secret_value(),
        llm_primary_provider=llm_primary_provider,
        llm_primary_model=llm_primary_model,
        llm_fallback_model=llm_fallback_model,
    )
    vision_model_available = (
        readiness.models_available[settings.ollama_vision_model]
        if settings.vision_enabled
        else None
    )

    stats = (
        compute_corpus_stats(store, user_id=str(user.id))
        if store is not None
        else CorpusStats(
            document_count=0, chunk_count=0, document_type_counts={}, last_ingested_at=None
        )
    )

    return StatusResponse(
        backend_reachable=True,
        ollama_reachable=readiness.ollama_reachable,
        qdrant_reachable=readiness.qdrant_reachable,
        generation_model=settings.effective_llm_model,
        embedding_model=settings.ollama_embed_model,
        document_count=stats.document_count,
        chunk_count=stats.chunk_count,
        document_type_counts=stats.document_type_counts,
        last_ingestion_at=stats.last_ingested_at,
        relevance_threshold_enabled=settings.retrieval_min_score is not None,
        vision_enabled=settings.vision_enabled,
        vision_model=settings.ollama_vision_model if settings.vision_enabled else None,
        vision_model_available=vision_model_available,
        image_generation_enabled=settings.image_generation_enabled,
        folder_library_enabled=settings.folder_library_enabled,
        conversation_scope_enabled=settings.conversation_scope_enabled,
        zoom_in_enabled=settings.zoom_in_enabled,
        latex_compilation_enabled=settings.latex_compilation_enabled,
        text_model_available=readiness.llm_model_available,
        embedding_model_available=readiness.models_available[settings.ollama_embed_model],
        ollama_latency_ms=readiness.ollama_latency_ms,
        qdrant_latency_ms=readiness.qdrant_latency_ms,
        llm_provider=readiness.llm_provider,
        llm_reachable=readiness.llm_reachable,
        llm_latency_ms=readiness.llm_latency_ms,
        llm_primary_provider=readiness.llm_primary_provider,
        llm_primary_reachable=readiness.llm_primary_reachable,
        llm_fallback_provider=readiness.llm_fallback_provider,
        llm_fallback_reachable=readiness.llm_fallback_reachable,
        llm_currently_preferred=readiness.llm_currently_preferred,
    )
