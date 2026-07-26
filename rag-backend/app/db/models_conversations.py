import uuid
from datetime import datetime

from sqlalchemy import (
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    Uuid,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.types import JSON

from app.db.base import Base

_DEFAULT_TITLE = "New conversation"


class Conversation(Base):
    """One chat thread, owned by exactly one user. Hard-deleting a
    conversation cascades to its messages and message sources (see Message,
    MessageSource below) — it never cascades to `documents`; a conversation
    referencing a document says nothing about whether that document should
    still exist independently.
    """

    __tablename__ = "conversations"
    __table_args__ = (Index("ix_conversations_user_id_updated_at", "user_id", "updated_at"),)

    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    title: Mapped[str] = mapped_column(String(120), nullable=False, default=_DEFAULT_TITLE)
    # False until a caller explicitly renames the conversation (PATCH
    # /conversations/{id}) — while False, the auto-title generator is free
    # to keep overwriting `title` from the first message; once True, it
    # never touches `title` again.
    title_is_custom: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )


class Message(Base):
    """One turn (user question or assistant answer) within a conversation.
    Each turn is generated independently by the stateless RAG pipeline (see
    app/core/rag_service.py) — prior turns are persisted for redisplay only,
    never fed back into a later turn's prompt as conversation context."""

    __tablename__ = "messages"
    __table_args__ = (
        Index("ix_messages_conversation_id_created_at", "conversation_id", "created_at"),
        # Enforces first-message (and general send) idempotency: a retry that
        # replays the same client-generated id for the same conversation must
        # never insert a second row — see
        # ConversationsRepository.add_user_message. SQLite/Postgres both treat
        # multiple NULLs as distinct, so conversations that never send a
        # client_message_id are unaffected.
        Index(
            "ux_messages_conversation_id_client_message_id",
            "conversation_id",
            "client_message_id",
            unique=True,
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    conversation_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("conversations.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    role: Mapped[str] = mapped_column(String(16), nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    # Client-generated idempotency key (e.g. a UUID minted once per logical
    # submission attempt and reused across retries of that same attempt) —
    # null for messages sent before this existed, or generated server-side.
    client_message_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    # Denormalized citation metadata (assistant messages only) — mirrors
    # app.core.citation.Citation / the ChatDoneEvent SSE payload, stored as
    # JSON rather than a joined table since it is always read/written whole,
    # never queried by field.
    citations: Mapped[list[object]] = mapped_column(JSON, nullable=False, default=list)
    citation_warnings: Mapped[list[str]] = mapped_column(JSON, nullable=False, default=list)
    insufficient_evidence: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    # Answer transparency (research workspace milestone, assistant messages
    # only): a snapshot of {"retrieval_scope": {...}, "documents_used": [...],
    # "project_summaries_used": [...], "profile_fields_used": [...]} — see
    # app/core/answer_transparency.py. A snapshot, not a live pointer: a
    # reopened past message must keep showing what was actually active
    # *when it was generated*, even if the conversation's scope toggles or
    # a project's approved summaries have changed since.
    transparency: Mapped[dict[str, object]] = mapped_column(JSON, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class MessageAttachment(Base):
    """One file (image or PDF) a user attached to a chat message — never
    chunked, embedded, or made searchable *by default* (that is what
    POST /documents is for; see app/api/routes_documents.py). The one
    exception is explicit promotion (see app/core/attachment_promotion.py,
    POST /attachments/{id}/promote): a PDF attachment can be ingested into a
    real searchable Document, at which point `promoted_document_id` records
    which one — always null for images (no OCR loader exists, see
    app/ingestion/loaders/dispatch.py) or for an attachment never promoted.
    The actual file bytes live on disk under settings.chat_attachments_dir,
    one subdirectory per owning user (see app/services/attachment_storage.py)
    — `storage_key` here is only the internal path fragment used to find
    them again; it is never returned by any API response (see
    MessageAttachmentResponse in app/schemas/conversations.py), matching
    this system's "never expose filesystem paths" rule.

    `user_id` is stored redundantly alongside `message_id` (rather than
    joining through messages -> conversations -> user for every check) so
    ownership can be verified, and the on-disk directory partitioned, with
    a single indexed column.

    ondelete=CASCADE on message_id means a hard-deleted message's
    attachment rows disappear as part of that same delete — but per this
    app's established convention (see ProjectsRepository.delete's
    docstring), SQLite does not enforce declared FK actions unless
    "PRAGMA foreign_keys=ON" has been set, which this app does not do,
    so ConversationsRepository.delete() removes these rows AND their
    on-disk files explicitly rather than relying on that cascade to fire.
    Deleting a project that references the parent conversation (see
    ProjectConversation) never touches this table at all — a project only
    ever holds an association to a conversation, never the conversation's
    own content.
    """

    __tablename__ = "message_attachments"

    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    message_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("messages.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # Sniffed from the file's actual content, never the client-declared
    # Content-Type (see app/services/attachment_storage.py's sniff_mime) —
    # a canonical value like "image/png"/"application/pdf", not whatever a
    # caller's multipart part happened to claim.
    mime: Mapped[str] = mapped_column(String(100), nullable=False)
    original_filename: Mapped[str] = mapped_column(String(512), nullable=False)
    size_bytes: Mapped[int] = mapped_column(Integer, nullable=False)
    # Populated for PDFs, null for images.
    page_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # An optional caller-selected subrange of a PDF attachment's pages
    # (1-indexed, inclusive) — purely descriptive metadata in this
    # milestone; nothing renders or reads these pages yet.
    page_range_start: Mapped[int | None] = mapped_column(Integer, nullable=True)
    page_range_end: Mapped[int | None] = mapped_column(Integer, nullable=True)
    storage_key: Mapped[str] = mapped_column(String(255), nullable=False)
    # Set only once this attachment has been promoted (see
    # app/core/attachment_promotion.py) — the Document it was ingested
    # into. ondelete=SET NULL: deleting that document un-promotes the
    # attachment rather than leaving a dangling reference, though (per this
    # app's SQLite convention) that's only actually enforced by
    # ScopesRepository.delete_associations_for_document, not by the DB.
    promoted_document_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("documents.document_id", ondelete="SET NULL"), nullable=True
    )
    # --- Image generation (Ollama x/flux2-klein by default — see
    # app/core/image_generation_service.py). A generated image is stored as
    # an ordinary MessageAttachment (source="generated") so it reuses every
    # existing attachment-serving/-deletion code path unchanged; every field
    # below is null for an ordinary uploaded attachment (source="upload",
    # the default).
    source: Mapped[str] = mapped_column(String(20), nullable=False, default="upload")
    generation_prompt: Mapped[str | None] = mapped_column(Text, nullable=True)
    generation_negative_prompt: Mapped[str | None] = mapped_column(Text, nullable=True)
    generation_seed: Mapped[int | None] = mapped_column(Integer, nullable=True)
    generation_model: Mapped[str | None] = mapped_column(String(100), nullable=True)
    generation_width: Mapped[int | None] = mapped_column(Integer, nullable=True)
    generation_height: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # Set only when a user explicitly saves this generated image to one of
    # their Projects (a simple gallery bookmark) — deliberately NOT the same
    # mechanism as ProjectAttachment/attachment_promotion.py (that machinery
    # ingests a PDF into a real searchable Document; a generated image has
    # no OCR/ingestion path and is never meant to become retrievable RAG
    # evidence). ondelete=SET NULL: deleting the project un-saves the image
    # rather than leaving a dangling reference, though (per this app's
    # SQLite convention) that's only actually enforced by
    # ProjectsRepository.delete, not by the DB.
    saved_project_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("projects.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class MessageSource(Base):
    """One retrieved-chunk source cited by an assistant message. Fields
    below are deliberately denormalized copies of RetrievedChunk (see
    app/core/retrieval_schemas.py) rather than a foreign key alone into
    `documents` — chat history must keep rendering identically even after
    the source document is later deleted or edited; `document_id` is kept
    too (SET NULL on delete) only as a best-effort "jump to document" link,
    never as the source of truth for what to display.
    """

    __tablename__ = "message_sources"
    __table_args__ = (Index("ix_message_sources_message_id_rank", "message_id", "rank"),)

    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    message_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("messages.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    rank: Mapped[int] = mapped_column(Integer, nullable=False)
    document_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("documents.document_id", ondelete="SET NULL"), nullable=True
    )
    chunk_id: Mapped[str] = mapped_column(String(64), nullable=False)
    chunk_index: Mapped[int] = mapped_column(Integer, nullable=False)
    page_number: Mapped[int] = mapped_column(Integer, nullable=False)
    score: Mapped[float] = mapped_column(Float, nullable=False)
    snippet_text: Mapped[str] = mapped_column(Text, nullable=False)
    title: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    authors: Mapped[list[str]] = mapped_column(JSON, nullable=False, default=list)
    publication_year: Mapped[int | None] = mapped_column(Integer, nullable=True)
    source_venue: Mapped[str | None] = mapped_column(String(512), nullable=True)
    document_type: Mapped[str] = mapped_column(String(40), nullable=False)
    journal_quartile: Mapped[str | None] = mapped_column(String(2), nullable=True)
    doi: Mapped[str | None] = mapped_column(String(255), nullable=True)
    source_url: Mapped[str | None] = mapped_column(String(2048), nullable=True)
    source_filename: Mapped[str] = mapped_column(String(512), nullable=False)
    # Which retrieval tier actually found this chunk ("chat"/"project"/
    # "general" — see app/core/scoped_retrieval.py) — drives the frontend's
    # "Current Chat"/"Current Project"/"General Corpus" source-card label
    # (see research workspace transparency milestone). Defaults to
    # "general" for the small number of rows persisted before this column
    # existed, since general was always the implicit tier back then.
    scope: Mapped[str] = mapped_column(String(16), nullable=False, default="general")
