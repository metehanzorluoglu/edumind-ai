import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Index, String, Text, Uuid, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class ConversationDocument(Base):
    """Chat-scope: one (conversation, document) association — mirrors
    ProjectConversation's shape exactly (composite PK, no `user_id` of its
    own; ownership is re-verified independently against both
    `conversations.user_id` and `documents.user_id` at the repository
    layer — see ScopesRepository.add_conversation_document). Deliberately
    does not duplicate the document's vectors: this row, plus a Qdrant
    payload resync (see app/core/document_scoping.py), are the only state
    a "chat scope" association ever creates.

    ondelete=CASCADE on both foreign keys: deleting a conversation removes
    its own association rows only (never the document); deleting a
    document removes its own association rows only (never the
    conversation) — but see ConversationsRepository.delete()'s docstring
    for why the conversation side is *also* deleted explicitly rather than
    relying on this declared cascade (SQLite does not enforce it)."""

    __tablename__ = "conversation_documents"
    __table_args__ = (Index("ix_conversation_documents_document_id", "document_id"),)

    conversation_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("conversations.id", ondelete="CASCADE"), primary_key=True
    )
    document_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("documents.document_id", ondelete="CASCADE"), primary_key=True
    )
    added_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class ProjectDocument(Base):
    """Project-scope: one (project, document) association — same shape and
    reasoning as ConversationDocument above, scoped to a project instead of
    a conversation."""

    __tablename__ = "project_documents"
    __table_args__ = (Index("ix_project_documents_document_id", "document_id"),)

    project_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True
    )
    document_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("documents.document_id", ondelete="CASCADE"), primary_key=True
    )
    added_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class ProjectAttachment(Base):
    """One (project, message_attachment) "promotion" association — a
    project-scope pointer to a chat attachment (see MessageAttachment in
    models_conversations.py) that has been promoted into a real searchable
    Document (see app/core/attachment_promotion.py). `document_id` is the
    resulting document — set whenever this row exists (promotion is a
    prerequisite of ever creating one), nullable only so the column can be
    added without a backfill; ScopesRepository.list_project_ids_for_document
    reads it directly (unioned with ProjectDocument matches) so promoted
    attachments are retrievable at project scope with no separate
    ProjectDocument row. ondelete=CASCADE on document_id: deleting the
    underlying document removes this promotion row too (see
    ScopesRepository.delete_associations_for_document for the SQLite-side
    enforcement, since the DB itself doesn't enforce it)."""

    __tablename__ = "project_attachments"
    __table_args__ = (
        Index("ix_project_attachments_message_attachment_id", "message_attachment_id"),
        Index("ix_project_attachments_document_id", "document_id"),
    )

    project_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True
    )
    message_attachment_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("message_attachments.id", ondelete="CASCADE"),
        primary_key=True,
    )
    document_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("documents.document_id", ondelete="CASCADE"), nullable=True
    )
    added_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class ConversationNote(Base):
    """Foundation only (contextual-research-scopes milestone): a
    user-authored note scoped to one conversation. Unlike the association
    tables above, a note IS content (not a pointer to something else), so
    it gets its own surrogate `id` rather than a composite PK. `user_id`
    is stored redundantly alongside `conversation_id` — same reasoning as
    MessageAttachment's own docstring: ownership can be verified with one
    indexed column rather than joining through conversations for every
    check. No route reads or writes this table yet."""

    __tablename__ = "conversation_notes"

    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    conversation_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("conversations.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    content: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )


class ProjectNote(Base):
    """Same shape and reasoning as ConversationNote above, scoped to a
    project instead of a conversation. Real CRUD (see
    GET/POST/DELETE /projects/{id}/notes in app/api/routes_projects.py) —
    plain stored text, not chunked/embedded/searchable this round."""

    __tablename__ = "project_notes"

    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    content: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )
