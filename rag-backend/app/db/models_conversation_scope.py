import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Uuid, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class ConversationScopeSettings(Base):
    """The research workspace's "active scope" toggle bar, persisted per
    conversation (see CHAT UI: "Show active scope above the composer...
    Allow toggling"). Lazily created on first read/write with every tier
    on except pooling other projects' summaries (see
    ConversationScopeRepository.get_or_create) — there is no explicit
    "create settings" step, since every conversation has exactly one,
    always.

    `chat_enabled`/`project_enabled`/`general_enabled` gate whether that
    named retrieval tier (see app/core/scoped_retrieval.py) is included in
    the blended plan at all for this conversation's next turn.
    `include_other_project_summaries` is independent of `project_enabled`:
    the latter controls *this* conversation's own project's approved
    summaries/profile (bundled into the "Project" toggle), the former
    controls whether *other* projects' approved summaries are additionally
    pooled in as background context (see app/core/project_context.py) —
    off by default, since pooling across unrelated projects is an
    explicit opt-in, not a default behavior.

    `zoom_in_mode` (Milestone 4: Zoom-In / strict selected-source mode) is
    a distinct, explicit override on top of the three tier toggles above,
    not a fourth independent toggle: when True, retrieval draws ONLY from
    this conversation's explicitly selected chat-scope documents (see
    conversation_documents / app/core/scoped_retrieval.py) — the project
    and general tiers are never queried at all for this conversation's next
    turn, regardless of what `project_enabled`/`general_enabled` say, and
    the chat tier is treated as active regardless of `chat_enabled` (see
    app/api/routes_conversations.py's `_effective_scope_flags`). False by
    default (added by migration 0019 with `server_default=false`), so
    every pre-existing conversation keeps behaving exactly as it did before
    this field existed."""

    __tablename__ = "conversation_scope_settings"

    conversation_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("conversations.id", ondelete="CASCADE"), primary_key=True
    )
    chat_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    project_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    general_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    include_other_project_summaries: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False
    )
    zoom_in_mode: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )
