from functools import lru_cache
from typing import Annotated

from fastapi import Depends
from sqlalchemy.orm import Session

from app.config import Settings, get_settings
from app.core.embedding_provider import (
    MXBAI_EMBED_LARGE_DIMENSIONS,
    EmbeddingProvider,
    OllamaEmbeddingProvider,
)
from app.core.image_generation_service import ImageGenerationService
from app.core.llm_provider import LLMProvider, OllamaLLMProvider
from app.core.rag_service import RagService
from app.core.rate_limiter import RateLimiter
from app.core.retriever import Retriever
from app.db.conversation_scope_repository import ConversationScopeRepository
from app.db.conversations_repository import ConversationsRepository
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
    return OllamaLLMProvider(model=settings.ollama_llm_model, base_url=settings.ollama_base_url)


LLMProviderDep = Annotated[LLMProvider, Depends(get_llm_provider)]


@lru_cache
def get_vision_service() -> VisionService:
    settings = get_settings()
    return VisionService(
        model=settings.ollama_vision_model,
        base_url=settings.ollama_base_url,
        timeout_seconds=settings.vision_request_timeout_seconds,
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
