from collections.abc import AsyncIterator
from functools import lru_cache
from typing import Annotated

from fastapi import Depends, Request
from sqlalchemy.orm import Session

from app.config import Settings, get_settings
from app.core.email_provider import ConsoleEmailProvider, EmailProvider, SmtpEmailProvider
from app.core.embedding_provider import (
    MXBAI_EMBED_LARGE_DIMENSIONS,
    EmbeddingProvider,
    OllamaEmbeddingProvider,
)
from app.core.image_generation_service import ImageGenerationService
from app.core.llm_provider import LLMProvider, OllamaLLMProvider
from app.core.rag_service import RagService
from app.core.rate_limiter import RateLimiter
from app.core.request_timing import DISABLED_TIMER, RequestTimer, bind_timer, unbind_timer
from app.core.retriever import Retriever
from app.db.conversation_scope_repository import ConversationScopeRepository
from app.db.conversations_repository import ConversationsRepository
from app.db.document_jobs_repository import DocumentJobsRepository
from app.db.documents_repository import DocumentsRepository
from app.db.project_knowledge_repository import ProjectKnowledgeRepository
from app.db.project_profile_repository import ProjectProfileRepository
from app.db.projects_repository import ProjectsRepository
from app.db.research_preference_repository import ResearchPreferenceRepository
from app.db.scopes_repository import ScopesRepository
from app.db.session import get_db
from app.services.attachment_storage import AttachmentStorage
from app.services.vision_service import VisionService
from app.vectorstore.qdrant_client import QdrantVectorStore

SettingsDep = Annotated[Settings, Depends(get_settings)]
DBSessionDep = Annotated[Session, Depends(get_db)]


async def get_request_timer(request: Request) -> AsyncIterator[RequestTimer]:
    """Binds the ambient "current timer" (see app/core/request_timing.py)
    for the duration of dependency resolution + the route body — a plain
    generator dependency, so FastAPI closes it (and resets the contextvar)
    via the same AsyncExitStack every other yield-dependency in this app
    uses. A required sub-dependency of get_current_user
    (app/core/security.py), which is how every authenticated route ends up
    with one without declaring it directly.

    Deliberately `async def`, not `def`: FastAPI runs a *sync* generator
    dependency's __enter__ and __exit__ each via their own separate
    `anyio.to_thread.run_sync()` call, which copies the current contextvars
    Context fresh for each call — so the Token bind_timer() returns from
    __enter__'s copy is not valid for unbind_timer()'s reset() in
    __exit__'s (different) copy: contextvars raises
    `ValueError: token was created in a different Context`. An `async def`
    generator dependency instead runs entirely on the event loop, in the
    one Task/Context that already exists for this request, so bind and
    unbind happen in the same Context and the Token stays valid. The sync
    route body reached through this dependency (post_document,
    post_conversation_message's run_in_threadpool call) still sees the
    bound timer correctly: anyio copies whatever Context is current *at the
    moment a thread is dispatched*, which is after this dependency has
    already bound it.

    When PERFORMANCE_PROFILING is off this binds the shared DISABLED_TIMER
    singleton rather than constructing a per-request instance — safe
    because a disabled RequestTimer's stage()/record() never write
    anything, so there is no shared-mutable-state hazard across concurrent
    requests, and it means the disabled path allocates nothing at all."""
    settings = get_settings()
    timer = (
        RequestTimer(enabled=True, label=request.url.path)
        if settings.performance_profiling
        else DISABLED_TIMER
    )
    request.state.timings = timer
    token = bind_timer(timer)
    try:
        yield timer
    finally:
        unbind_timer(token)


RequestTimerDep = Annotated[RequestTimer, Depends(get_request_timer)]


@lru_cache
def get_embedding_provider() -> EmbeddingProvider:
    settings = get_settings()
    return OllamaEmbeddingProvider(
        model=settings.ollama_embed_model,
        dimensions=MXBAI_EMBED_LARGE_DIMENSIONS,
        base_url=settings.ollama_base_url,
    )


EmbeddingProviderDep = Annotated[EmbeddingProvider, Depends(get_embedding_provider)]


@lru_cache
def get_vector_store() -> QdrantVectorStore:
    settings = get_settings()
    store = QdrantVectorStore(
        collection_name=settings.qdrant_collection_name,
        vector_size=get_embedding_provider().dimensions,
        mode=settings.qdrant_mode,
        path=settings.qdrant_path,
        url=settings.qdrant_url,
    )
    store.ensure_collection()
    return store


VectorStoreDep = Annotated[QdrantVectorStore, Depends(get_vector_store)]


@lru_cache
def get_retriever() -> Retriever:
    settings = get_settings()
    return Retriever(
        embedding_provider=get_embedding_provider(),
        vector_store=get_vector_store(),
        relevance_weight=settings.retrieval_mmr_relevance_weight,
        fetch_k=settings.retrieval_fetch_k,
        min_score=settings.retrieval_min_score,
    )


RetrieverDep = Annotated[Retriever, Depends(get_retriever)]


@lru_cache
def get_llm_provider() -> LLMProvider:
    settings = get_settings()
    return OllamaLLMProvider(
        model=settings.ollama_llm_model,
        base_url=settings.ollama_base_url,
        think=settings.ollama_thinking_enabled,
        options={"num_predict": settings.ollama_num_predict},
    )


LLMProviderDep = Annotated[LLMProvider, Depends(get_llm_provider)]


@lru_cache
def get_vision_service() -> VisionService:
    settings = get_settings()
    return VisionService(
        model=settings.ollama_vision_model,
        base_url=settings.ollama_base_url,
        timeout_seconds=settings.vision_request_timeout_seconds,
        generation_timeout_seconds=settings.vision_generation_timeout_seconds,
        num_predict=settings.vision_num_predict,
    )


VisionServiceDep = Annotated[VisionService, Depends(get_vision_service)]


@lru_cache
def get_attachment_storage() -> AttachmentStorage:
    settings = get_settings()
    return AttachmentStorage(root_dir=settings.chat_attachments_dir)


AttachmentStorageDep = Annotated[AttachmentStorage, Depends(get_attachment_storage)]


@lru_cache
def get_image_generation_service() -> ImageGenerationService:
    settings = get_settings()
    return ImageGenerationService(
        model=settings.ollama_image_model,
        base_url=settings.ollama_base_url,
        timeout_seconds=settings.image_generation_request_timeout_seconds,
    )


ImageGenerationServiceDep = Annotated[ImageGenerationService, Depends(get_image_generation_service)]


@lru_cache
def get_email_provider() -> EmailProvider:
    settings = get_settings()
    if settings.email_provider == "smtp":
        return SmtpEmailProvider(
            host=settings.smtp_host,
            port=settings.smtp_port,
            username=settings.smtp_username,
            password=settings.smtp_password,
            use_tls=settings.smtp_use_tls,
            from_name=settings.email_from_name,
            from_address=settings.email_from_address,
        )
    return ConsoleEmailProvider()


EmailProviderDep = Annotated[EmailProvider, Depends(get_email_provider)]


@lru_cache
def get_rag_service() -> RagService:
    settings = get_settings()
    return RagService(
        retriever=get_retriever(),
        llm_provider=get_llm_provider(),
        model_name=settings.ollama_llm_model,
        max_chunks_per_document=settings.context_max_chunks_per_document,
        max_total_context_chars=settings.context_max_total_chars,
        dedup_similarity_threshold=settings.context_dedup_similarity_threshold,
        chat_scope_top_k=settings.retrieval_chat_scope_top_k,
        project_scope_top_k=settings.retrieval_project_scope_top_k,
        prompt_variant=settings.rag_prompt_variant,
        source_order=settings.rag_source_order,
    )


RagServiceDep = Annotated[RagService, Depends(get_rag_service)]


@lru_cache
def get_chat_rate_limiter() -> RateLimiter:
    settings = get_settings()
    return RateLimiter(
        max_requests=settings.chat_rate_limit_max_requests,
        window_seconds=settings.chat_rate_limit_window_seconds,
    )


ChatRateLimiterDep = Annotated[RateLimiter, Depends(get_chat_rate_limiter)]


def get_documents_repository(db: DBSessionDep) -> DocumentsRepository:
    # Deliberately NOT @lru_cache'd, unlike the singletons above — this
    # must be a fresh instance bound to the current request's DB session,
    # never reused across requests.
    return DocumentsRepository(db)


DocumentsRepositoryDep = Annotated[DocumentsRepository, Depends(get_documents_repository)]


def get_document_jobs_repository(db: DBSessionDep) -> DocumentJobsRepository:
    # Same reasoning as get_documents_repository above: fresh per-request,
    # never cached across requests. The background job itself (see
    # app/core/document_ingestion_jobs.py) does NOT use this dependency —
    # it opens its own session directly via get_session_factory(), since it
    # runs after the request (and this session) has already closed.
    return DocumentJobsRepository(db)


DocumentJobsRepositoryDep = Annotated[
    DocumentJobsRepository, Depends(get_document_jobs_repository)
]


def get_conversations_repository(db: DBSessionDep) -> ConversationsRepository:
    # Same reasoning as get_documents_repository above: fresh per-request,
    # never cached across requests. get_attachment_storage() IS cached
    # (it's stateless, just holds a root directory path), unlike this.
    return ConversationsRepository(db, get_attachment_storage())


ConversationsRepositoryDep = Annotated[
    ConversationsRepository, Depends(get_conversations_repository)
]


def get_projects_repository(db: DBSessionDep) -> ProjectsRepository:
    # Same reasoning as get_documents_repository above: fresh per-request,
    # never cached across requests.
    return ProjectsRepository(db)


ProjectsRepositoryDep = Annotated[ProjectsRepository, Depends(get_projects_repository)]


def get_scopes_repository(db: DBSessionDep) -> ScopesRepository:
    # Same reasoning as get_documents_repository above: fresh per-request,
    # never cached across requests.
    return ScopesRepository(db)


ScopesRepositoryDep = Annotated[ScopesRepository, Depends(get_scopes_repository)]


def get_project_knowledge_repository(db: DBSessionDep) -> ProjectKnowledgeRepository:
    # Same reasoning as get_documents_repository above: fresh per-request,
    # never cached across requests.
    return ProjectKnowledgeRepository(db)


ProjectKnowledgeRepositoryDep = Annotated[
    ProjectKnowledgeRepository, Depends(get_project_knowledge_repository)
]


def get_project_profile_repository(db: DBSessionDep) -> ProjectProfileRepository:
    # Same reasoning as get_documents_repository above: fresh per-request,
    # never cached across requests.
    return ProjectProfileRepository(db)


ProjectProfileRepositoryDep = Annotated[
    ProjectProfileRepository, Depends(get_project_profile_repository)
]


def get_research_preference_repository(
    db: DBSessionDep, project_profile_repository: ProjectProfileRepositoryDep
) -> ResearchPreferenceRepository:
    # Same reasoning as get_documents_repository above: fresh per-request,
    # never cached across requests.
    return ResearchPreferenceRepository(db, project_profile_repository)


ResearchPreferenceRepositoryDep = Annotated[
    ResearchPreferenceRepository, Depends(get_research_preference_repository)
]


def get_conversation_scope_repository(db: DBSessionDep) -> ConversationScopeRepository:
    # Same reasoning as get_documents_repository above: fresh per-request,
    # never cached across requests.
    return ConversationScopeRepository(db)


ConversationScopeRepositoryDep = Annotated[
    ConversationScopeRepository, Depends(get_conversation_scope_repository)
]
