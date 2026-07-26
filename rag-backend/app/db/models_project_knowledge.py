import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Index, String, Text, Uuid, func
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.types import JSON

from app.db.base import Base

_DEFAULT_STATUS = "draft"


class ProjectKnowledgeItem(Base):
    """Project Memory (see app/core/conversation_summarization.py): a
    structured, LLM-generated summary of one conversation, scoped to a
    project — never the raw chat transcript itself. `status` starts at
    "draft" and only becomes "approved" through an explicit user action
    (PATCH .../conversation-summary/{id} with status="approved") —
    nothing else ever flips it, and only "approved" items are ever
    surfaced to retrieval (see app/core/project_context.py).

    Deliberately NOT primary evidence: a knowledge item is never chunked,
    embedded, stored in Qdrant, or given a citation id — it reaches a chat
    prompt (if approved) as a separate, explicitly-labeled "Project
    Context" block that the system prompt instructs the model never to
    cite as a numbered source (see app/core/prompt_builder.py). This is
    enforced structurally: nothing in this table ever enters the
    RetrievedChunk/Citation pipeline at all.

    `conversation_id` is nullable with ondelete=SET NULL (not CASCADE):
    the whole point of Project Memory is that the distilled summary
    outlives the raw conversation it was generated from — deleting the
    conversation must never delete the knowledge item derived from it
    (see ConversationsRepository.delete(), which explicitly nulls this
    column rather than relying on the declared FK action, per this app's
    established SQLite convention).

    `referenced_documents` is never LLM-generated — it is computed
    deterministically from the source conversation's actual message
    citations at generation time (see
    conversation_summarization.py's _referenced_documents), stored as
    `[{"document_id": ..., "source_filename": ...}, ...]` so it keeps
    displaying correctly even if a referenced document is later deleted.
    """

    __tablename__ = "project_knowledge_items"
    __table_args__ = (
        Index("ix_project_knowledge_items_project_id_status", "project_id", "status"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    conversation_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("conversations.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # "draft" | "approved" — a plain string column (not a DB-level CHECK
    # constraint or enum type) so it stays trivial to inspect/migrate,
    # matching this app's existing convention for small closed string sets
    # (e.g. Message.role, Document.document_type).
    status: Mapped[str] = mapped_column(String(16), nullable=False, default=_DEFAULT_STATUS)

    research_topic: Mapped[str] = mapped_column(Text, nullable=False, default="")
    research_question: Mapped[str] = mapped_column(Text, nullable=False, default="")
    key_concepts: Mapped[list[str]] = mapped_column(JSON, nullable=False, default=list)
    methodology: Mapped[str] = mapped_column(Text, nullable=False, default="")
    frameworks: Mapped[list[str]] = mapped_column(JSON, nullable=False, default=list)
    analysis_techniques: Mapped[list[str]] = mapped_column(JSON, nullable=False, default=list)
    decisions: Mapped[list[str]] = mapped_column(JSON, nullable=False, default=list)
    open_questions: Mapped[list[str]] = mapped_column(JSON, nullable=False, default=list)
    keywords: Mapped[list[str]] = mapped_column(JSON, nullable=False, default=list)
    referenced_documents: Mapped[list[object]] = mapped_column(JSON, nullable=False, default=list)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
