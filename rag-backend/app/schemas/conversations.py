from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

from app.core.citation import Citation
from app.core.retrieval_schemas import RetrievalFilters, ScopeTierName
from app.ingestion.metadata_schema import DocumentType, JournalQuartile
from app.schemas.chat import TransparencyResponse


class ConversationSummaryResponse(BaseModel):
    id: str
    title: str
    created_at: datetime
    updated_at: datetime
    message_count: int
    last_message_preview: str | None = None


class ConversationListResponse(BaseModel):
    conversations: list[ConversationSummaryResponse]
    total: int


class MessageSourceResponse(BaseModel):
    rank: int
    document_id: str | None = None
    chunk_id: str
    chunk_index: int
    page_number: int
    score: float
    snippet_text: str
    title: str | None = None
    authors: list[str] = Field(default_factory=list)
    publication_year: int | None = None
    source_venue: str | None = None
    document_type: DocumentType
    journal_quartile: JournalQuartile = None
    doi: str | None = None
    source_url: str | None = None
    source_filename: str
    scope: ScopeTierName = "general"


class MessageAttachmentResponse(BaseModel):
    """Never includes a filesystem path or storage key — only metadata a
    frontend needs to render an attachment chip (see
    app/db/models_conversations.py's MessageAttachment for what is
    deliberately withheld)."""

    id: str
    mime: str
    filename: str
    size_bytes: int
    page_count: int | None = None
    page_range_start: int | None = None
    page_range_end: int | None = None
    created_at: datetime
    # "reference" = a user-supplied reference image persisted alongside a
    # generated batch so Regenerate can reuse it (see GenerateImagesRequest.
    # reference_images). The DB column is a plain String(20) — no migration.
    source: Literal["upload", "generated", "reference"] = "upload"
    generation_prompt: str | None = None
    generation_negative_prompt: str | None = None
    generation_seed: int | None = None
    generation_model: str | None = None
    generation_width: int | None = None
    generation_height: int | None = None
    saved_project_id: str | None = None


class MessageResponse(BaseModel):
    id: str
    role: Literal["user", "assistant"]
    content: str
    citations: list[Citation] = Field(default_factory=list)
    citation_warnings: list[str] = Field(default_factory=list)
    insufficient_evidence: bool = False
    created_at: datetime
    sources: list[MessageSourceResponse] = Field(default_factory=list)
    attachments: list[MessageAttachmentResponse] = Field(default_factory=list)
    transparency: TransparencyResponse | None = None
    # Stream-disconnect recovery (see app/core/generation_manager.py):
    # 'generating' while a background worker is still producing this
    # reply, 'complete' once persisted, or 'error'/'cancelled'/
    # 'interrupted' — always 'complete' for a user message and for every
    # assistant message persisted before this field existed.
    status: Literal["generating", "complete", "error", "cancelled", "interrupted"] = "complete"
    error_message: str | None = None


class ConversationDetailResponse(BaseModel):
    id: str
    title: str
    title_is_custom: bool
    created_at: datetime
    updated_at: datetime
    messages: list[MessageResponse]


class RenameConversationRequest(BaseModel):
    # Cap chosen to match the `conversations.title` column (String(120)) —
    # sanitization (control-character stripping, whitespace collapse) happens
    # in app/api/routes_conversations.py before this ever reaches storage or
    # a response; the frontend must still render titles as plain text, never
    # raw HTML, regardless of what's sanitized here.
    title: str = Field(min_length=1, max_length=120)


class AddConversationDocumentRequest(BaseModel):
    """Associates an already-ingested document (see POST /documents) with
    this conversation as chat-scope retrieval evidence — never uploads or
    re-embeds anything; document_id must already belong to the caller."""

    document_id: str


class ConversationDocumentResponse(BaseModel):
    document_id: str
    source_filename: str
    document_type: DocumentType
    added_at: datetime


class ConversationScopeResponse(BaseModel):
    """The research workspace's per-conversation "active scope" toggle bar
    (see app/db/models_conversation_scope.py)."""

    chat_enabled: bool
    project_enabled: bool
    general_enabled: bool
    include_other_project_summaries: bool


class UpdateConversationScopeRequest(BaseModel):
    """Partial update — same `model_fields_set`-driven convention as every
    other PATCH in this app."""

    chat_enabled: bool | None = None
    project_enabled: bool | None = None
    general_enabled: bool | None = None
    include_other_project_summaries: bool | None = None


class PostConversationMessageRequest(BaseModel):
    query: str = Field(min_length=1, max_length=2000)
    top_k: int = Field(default=8, ge=1, le=20)
    filters: RetrievalFilters | None = None
    # Client-generated idempotency key: a caller retrying the same logical
    # submission (double-click, network interruption, explicit Retry after a
    # generation failure) reuses this value so the retry can't insert a
    # second copy of the user's message — see
    # ConversationsRepository.add_user_message.
    client_message_id: str | None = Field(default=None, max_length=64)
    # The "Also use my research corpus" toggle (milestone V3) — only ever
    # consulted when this message has at least one attachment (see
    # app/core/model_routing.py's choose_model): a text-only message
    # always retrieves regardless of this flag, exactly as it always has.
    use_corpus: bool = False
