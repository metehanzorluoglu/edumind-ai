from collections.abc import AsyncIterator
from functools import lru_cache
from typing import Annotated, Literal

from fastapi import Depends, Request
from sqlalchemy.orm import Session, sessionmaker

from app.config import Settings, get_settings
from app.core.bibliographic_enrichment import CrossrefProvider
from app.core.email_provider import ConsoleEmailProvider, EmailProvider, SmtpEmailProvider
from app.core.embedding_provider import (
    MXBAI_EMBED_LARGE_DIMENSIONS,
    EmbeddingProvider,
    OllamaEmbeddingProvider,
)
from app.core.evidence_client import EvidenceClient
from app.core.image_generation_service import ImageGenerationService
from app.core.latex_compiler_client import LatexCompilerClient
from app.core.llm_provider import (
    FailoverLLMProvider,
    LLMProvider,
    OllamaLLMProvider,
    OpenAICompatibleLLMProvider,
)
from app.core.rag_service import RagService
from app.core.rate_limiter import RateLimiter
from app.core.request_timing import DISABLED_TIMER, RequestTimer, bind_timer, unbind_timer
from app.core.retriever import Retriever
from app.db.compile_artifacts_repository import CompileArtifactsRepository
from app.db.conversation_scope_repository import ConversationScopeRepository
from app.db.conversations_repository import ConversationsRepository
from app.db.document_highlights_repository import DocumentHighlightsRepository
from app.db.document_jobs_repository import DocumentJobsRepository
from app.db.documents_repository import DocumentsRepository
from app.db.folders_repository import FoldersRepository
from app.db.notebooks_repository import NotebooksRepository
from app.db.project_knowledge_repository import ProjectKnowledgeRepository
from app.db.project_profile_repository import ProjectProfileRepository
from app.db.projects_repository import ProjectsRepository
from app.db.research_preference_repository import ResearchPreferenceRepository
from app.db.scopes_repository import ScopesRepository
from app.db.session import get_db, get_session_factory
from app.db.writing_import_sessions_repository import WritingImportSessionsRepository
from app.db.writing_project_files_repository import WritingProjectFilesRepository
from app.db.writing_projects_repository import WritingProjectsRepository
from app.services.attachment_storage import AttachmentStorage
from app.services.compile_artifact_storage import CompileArtifactStorage
from app.services.document_file_storage import DocumentFileStorage
from app.services.vision_service import VisionService
from app.services.writing_import_storage import WritingImportStorage
from app.services.writing_project_file_storage import WritingProjectFileStorage
from app.vectorstore.qdrant_client import QdrantVectorStore

SettingsDep = Annotated[Settings, Depends(get_settings)]
DBSessionDep = Annotated[Session, Depends(get_db)]


def get_session_factory_dep() -> "sessionmaker[Session]":
    """A real FastAPI dependency (unlike calling app.db.session.
    get_session_factory() directly) wrapping the same session factory —
    exists so code that must open its *own* database session independent
    of the current request (app/core/generation_manager.py's detached
    background workers, app/api/routes_auth.py's verification-email
    background task) can still be pointed at a test's isolated engine via
    `app.dependency_overrides[get_session_factory_dep]`, the same
    mechanism every other DB-touching dependency in this file already
    supports through `get_db`. Calling get_session_factory() directly
    from those call sites would silently reach for the real, global
    Settings().database_url even inside a test that overrides `get_db`
    for every ordinary request-scoped repository."""
    return get_session_factory()


SessionFactoryDep = Annotated["sessionmaker[Session]", Depends(get_session_factory_dep)]


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


def _build_llm_provider(
    settings: Settings, kind: Literal["ollama", "openai_compatible"]
) -> LLMProvider:
    """Constructs a single concrete LLMProvider for whichever `kind` is
    asked for — shared by get_llm_provider's plain single-provider modes
    and its "failover" mode below, so the two roles a FailoverLLMProvider
    wraps are built via the exact same logic as a standalone
    LLM_PROVIDER=ollama / LLM_PROVIDER=openai_compatible deployment would
    use, never a second, potentially-drifting construction path."""
    if kind == "openai_compatible":
        return OpenAICompatibleLLMProvider(
            model=settings.llm_model,
            base_url=settings.llm_base_url,
            api_key=settings.llm_api_key.get_secret_value(),
            timeout_seconds=settings.llm_request_timeout_seconds,
            options={"num_predict": settings.ollama_num_predict},
        )
    return OllamaLLMProvider(
        model=settings.ollama_llm_model,
        base_url=settings.ollama_base_url,
        think=settings.ollama_thinking_enabled,
        options={"num_predict": settings.ollama_num_predict},
    )


@lru_cache
def get_llm_provider() -> LLMProvider:
    """Settings.llm_provider (env var LLM_PROVIDER, default "ollama")
    selects which LLMProvider implementation ordinary text chat uses — see
    app/core/llm_provider.py. Every other provider singleton in this file
    (embeddings, vision, image generation) is unaffected: they always
    construct their own Ollama-backed instance regardless of this
    setting, since only chat generation is part of the MS-S1 vLLM
    migration.

    "failover" (MS-S1 automatic-failover resilience work) wraps a primary
    and a fallback instance — both built via _build_llm_provider above,
    named by Settings.llm_primary_provider/llm_fallback_provider — in a
    FailoverLLMProvider, so RagService/generation_manager still see one
    ordinary LLMProvider and need no changes at all."""
    settings = get_settings()
    if settings.llm_provider == "failover":
        return FailoverLLMProvider(
            primary=_build_llm_provider(settings, settings.llm_primary_provider),
            fallback=_build_llm_provider(settings, settings.llm_fallback_provider),
            primary_label=settings.llm_primary_provider,
            fallback_label=settings.llm_fallback_provider,
            cooldown_seconds=settings.llm_failover_cooldown_seconds,
        )
    return _build_llm_provider(settings, settings.llm_provider)


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
def get_document_file_storage() -> DocumentFileStorage:
    # Frontend Milestone 3.1 — see app/services/document_file_storage.py's
    # module docstring for why this is a separate instance/directory from
    # get_attachment_storage() above.
    settings = get_settings()
    return DocumentFileStorage(root_dir=settings.document_storage_dir)


DocumentFileStorageDep = Annotated[DocumentFileStorage, Depends(get_document_file_storage)]


@lru_cache
def get_writing_project_file_storage() -> WritingProjectFileStorage:
    # Milestone 5.3 — see app/services/writing_project_file_storage.py's
    # module docstring for why this is a separate instance/directory
    # from get_document_file_storage() above (a Writing Project's own
    # figure/asset uploads are never RAG-corpus Documents).
    settings = get_settings()
    return WritingProjectFileStorage(root_dir=settings.writing_project_files_dir)


WritingProjectFileStorageDep = Annotated[
    WritingProjectFileStorage, Depends(get_writing_project_file_storage)
]


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
        model_name=settings.effective_llm_model,
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
def get_evidence_client() -> EvidenceClient:
    """Milestone 11 §13. Constructed unconditionally (like every other
    provider singleton in this file) even when
    Settings.evidence_analysis_enabled is false — building an httpx.Client
    does not itself open any connection, so this is as cheap as every
    other @lru_cache singleton here, and it means the eligibility gate
    (app/core/evidence_eligibility.py) is the ONE place that decides
    whether this client is ever actually called, not a second
    conditional-construction path here that would need to stay in sync
    with it."""
    settings = get_settings()
    return EvidenceClient(
        base_url=settings.evidence_service_url,
        timeout_seconds=settings.evidence_service_timeout_ms / 1000,
    )


EvidenceClientDep = Annotated[EvidenceClient, Depends(get_evidence_client)]


@lru_cache
def get_bibliographic_provider() -> CrossrefProvider:
    """Milestone 4.1 §2/§4. Constructed unconditionally, same reasoning as
    get_evidence_client() above: Settings.bibliographic_enrichment_enabled
    is the ONE place that decides whether this is ever actually called
    (see app/core/bibliographic_enrichment_service.py's eligibility
    check), not a second conditional-construction path here."""
    settings = get_settings()
    return CrossrefProvider(
        base_url=settings.bibliographic_provider_base_url,
        contact_email=settings.bibliographic_provider_contact_email,
        timeout_seconds=settings.bibliographic_provider_timeout_seconds,
    )


BibliographicProviderDep = Annotated[CrossrefProvider, Depends(get_bibliographic_provider)]


@lru_cache
def get_chat_rate_limiter() -> RateLimiter:
    settings = get_settings()
    return RateLimiter(
        max_requests=settings.chat_rate_limit_max_requests,
        window_seconds=settings.chat_rate_limit_window_seconds,
    )


ChatRateLimiterDep = Annotated[RateLimiter, Depends(get_chat_rate_limiter)]


@lru_cache
def get_latex_compiler_client() -> LatexCompilerClient:
    """Milestone 5.1 Part 14 — constructed unconditionally, same
    reasoning as get_evidence_client() above. Building an httpx.Client
    opens no connection; POST /writing-projects/{id}/compile is the one
    call site."""
    settings = get_settings()
    return LatexCompilerClient(
        base_url=settings.latex_compiler_url,
        timeout_seconds=settings.latex_compiler_timeout_seconds,
    )


LatexCompilerClientDep = Annotated[LatexCompilerClient, Depends(get_latex_compiler_client)]


def get_compile_artifacts_repository(db: DBSessionDep) -> CompileArtifactsRepository:
    # Same reasoning as get_documents_repository below: fresh per-request,
    # never cached across requests.
    return CompileArtifactsRepository(db)


CompileArtifactsRepositoryDep = Annotated[
    CompileArtifactsRepository, Depends(get_compile_artifacts_repository)
]


@lru_cache
def get_compile_artifact_storage() -> CompileArtifactStorage:
    # Milestone 5.5 Part 22 — replaces get_compile_artifact_cache()'s old
    # in-process dict (app/core/compile_artifact_cache.py, now retired):
    # the actual PDF bytes live on the shared `/data`-mounted volume, the
    # DB row (CompileArtifactsRepository) is the cross-worker-visible
    # source of truth for existence/ownership/TTL.
    settings = get_settings()
    return CompileArtifactStorage(root_dir=settings.compile_artifact_dir)


CompileArtifactStorageDep = Annotated[CompileArtifactStorage, Depends(get_compile_artifact_storage)]


def get_documents_repository(db: DBSessionDep) -> DocumentsRepository:
    # Deliberately NOT @lru_cache'd, unlike the singletons above — this
    # must be a fresh instance bound to the current request's DB session,
    # never reused across requests.
    return DocumentsRepository(db)


DocumentsRepositoryDep = Annotated[DocumentsRepository, Depends(get_documents_repository)]


def get_document_highlights_repository(db: DBSessionDep) -> DocumentHighlightsRepository:
    # Same reasoning as get_documents_repository above: fresh per-request,
    # never cached across requests.
    return DocumentHighlightsRepository(db)


DocumentHighlightsRepositoryDep = Annotated[
    DocumentHighlightsRepository, Depends(get_document_highlights_repository)
]


def get_folders_repository(db: DBSessionDep) -> FoldersRepository:
    # Same reasoning as get_documents_repository above: fresh per-request,
    # never cached across requests.
    return FoldersRepository(db)


FoldersRepositoryDep = Annotated[FoldersRepository, Depends(get_folders_repository)]


def get_document_jobs_repository(db: DBSessionDep) -> DocumentJobsRepository:
    # Same reasoning as get_documents_repository above: fresh per-request,
    # never cached across requests. The background job itself (see
    # app/core/document_ingestion_jobs.py) does NOT use this dependency —
    # it opens its own session directly via get_session_factory(), since it
    # runs after the request (and this session) has already closed.
    return DocumentJobsRepository(db)


DocumentJobsRepositoryDep = Annotated[DocumentJobsRepository, Depends(get_document_jobs_repository)]


def get_notebooks_repository(db: DBSessionDep) -> NotebooksRepository:
    # Same reasoning as get_documents_repository above: fresh per-request,
    # never cached across requests.
    return NotebooksRepository(db)


NotebooksRepositoryDep = Annotated[NotebooksRepository, Depends(get_notebooks_repository)]


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


def get_writing_projects_repository(db: DBSessionDep) -> WritingProjectsRepository:
    # Same reasoning as get_documents_repository above: fresh per-request,
    # never cached across requests.
    return WritingProjectsRepository(db)


WritingProjectsRepositoryDep = Annotated[
    WritingProjectsRepository, Depends(get_writing_projects_repository)
]


def get_writing_project_files_repository(db: DBSessionDep) -> WritingProjectFilesRepository:
    # Same reasoning as get_documents_repository above: fresh per-request,
    # never cached across requests.
    return WritingProjectFilesRepository(db)


WritingProjectFilesRepositoryDep = Annotated[
    WritingProjectFilesRepository, Depends(get_writing_project_files_repository)
]


def get_writing_import_sessions_repository(db: DBSessionDep) -> WritingImportSessionsRepository:
    # Same reasoning as get_documents_repository above: fresh per-request,
    # never cached across requests.
    return WritingImportSessionsRepository(db)


WritingImportSessionsRepositoryDep = Annotated[
    WritingImportSessionsRepository, Depends(get_writing_import_sessions_repository)
]


@lru_cache
def get_writing_import_storage() -> WritingImportStorage:
    # Milestone 5.4 — see app/services/writing_import_storage.py's
    # module docstring for why this is a separate instance/directory
    # from get_writing_project_file_storage() above (staged ZIP bytes
    # are TEMPORARY, unlike a project's own confirmed asset files).
    settings = get_settings()
    return WritingImportStorage(root_dir=settings.writing_import_staging_dir)


WritingImportStorageDep = Annotated[WritingImportStorage, Depends(get_writing_import_storage)]


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
