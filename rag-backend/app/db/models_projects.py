import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Index, Integer, String, Text, Uuid, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base

_DEFAULT_NAME = "Untitled project"


class Project(Base):
    """A user-defined folder grouping any number of that same user's own
    conversations (see ProjectConversation) — owned by exactly one user,
    never shared. Deleting a project only ever removes the project row and
    its ProjectConversation association rows (ondelete=CASCADE on that
    table's project_id) — it never touches a conversation itself; a
    conversation grouped into a project says nothing about whether that
    conversation should still exist independently (same relationship
    Conversation already has with `documents`, see models_conversations.py).
    """

    __tablename__ = "projects"
    __table_args__ = (
        # Matches Conversation's own (user_id, updated_at) compound index
        # (see models_conversations.py) — GET /projects sorts "most
        # recently active project first" the exact same way GET
        # /conversations does, and this is what makes that ORDER BY
        # deterministic (not just fast) when two projects share the same
        # updated_at down to the second (SQLite's CURRENT_TIMESTAMP has no
        # sub-second resolution, so two projects created in the same
        # second — routine in a fast test, rare but not impossible in
        # production — would otherwise sort in undefined relative order).
        Index("ix_projects_user_id_updated_at", "user_id", "updated_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(80), nullable=False, default=_DEFAULT_NAME)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    # Indexed on its own (not just as part of a compound index): GET
    # /projects sorts "most recently active project first" the same way GET
    # /conversations does (see Conversation.user_id's compound index) — a
    # per-user project list is small enough that filtering by user_id then
    # sorting client-side of the index is fine without a compound index.
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
        index=True,
    )


class ProjectConversation(Base):
    """One (project, conversation) association — many-to-many: the same
    conversation may belong to several projects, and a project may hold
    several conversations. The composite primary key on
    (project_id, conversation_id) itself enforces "add is idempotent, never
    duplicated" (see ProjectsRepository.add_conversation) without a
    separate unique constraint.

    Deliberately has no `user_id` of its own — ownership is always checked
    at the repository/route layer against both `projects.user_id` and
    `conversations.user_id` before a row here is ever created (see
    ProjectsRepository.add_conversation), the same way this system checks
    ownership everywhere else (never via a redundant denormalized column
    that could itself drift out of sync with the two tables it points at).

    ondelete=CASCADE on both foreign keys matches the two different
    deletion requirements: deleting a project removes its association rows
    only (never the conversations); deleting a conversation removes ITS
    association rows only (never the project) — both are the association
    disappearing, never a cascade into the other side's own table.
    """

    __tablename__ = "project_conversations"
    __table_args__ = (Index("ix_project_conversations_conversation_id", "conversation_id"),)

    project_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True
    )
    conversation_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("conversations.id", ondelete="CASCADE"), primary_key=True
    )
    added_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    sort_order: Mapped[int | None] = mapped_column(Integer, nullable=True)
