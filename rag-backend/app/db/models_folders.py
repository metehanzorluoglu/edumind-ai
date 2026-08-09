import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Index, String, Uuid, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class Folder(Base):
    """A user-owned organizational container for `documents` (Milestone 1:
    Document Library / Folder Management) — purely organizational metadata,
    never a retrieval boundary and never physically involved in how a
    document is chunked/embedded/stored in Qdrant (see
    app/db/documents_repository.py's `folder_id` column docstring). A
    document keeps existing independently of any folder: deleting a folder
    never deletes the documents inside it (see FoldersRepository.delete).

    Self-referencing `parent_id` gives nested folders (folder -> folder ->
    ... -> root, where root is `parent_id IS NULL`) without a separate
    "depth" or "path" column — FoldersRepository.list_path walks this chain
    for breadcrumbs, and FoldersRepository's circular-reference guard walks
    it the other way (candidate-new-parent upward to root) before any move.

    Deliberately NO unique DB constraint on (user_id, parent_id, name):
    both SQLite and PostgreSQL treat NULL as pairwise-distinct in a unique
    constraint, so UNIQUE(user_id, parent_id, name) would silently fail to
    catch two same-named ROOT folders (parent_id IS NULL for both) even
    though it would correctly catch two same-named children of the same
    non-null parent — an inconsistent guarantee that depends on nesting
    depth. FoldersRepository enforces "no duplicate name among siblings"
    uniformly in application code instead (see create()/rename()/move()),
    which also allows a clean, specific 409 with the conflicting name
    rather than a raw IntegrityError.
    """

    __tablename__ = "folders"
    __table_args__ = (
        Index("ix_folders_user_id_parent_id", "user_id", "parent_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # NULL = root-level folder. ondelete="CASCADE" is declared for
    # PostgreSQL/dialect-portability correctness, but SQLite (this app's
    # default database) does not enforce declared FK ondelete actions
    # unless "PRAGMA foreign_keys=ON" is set on the connection, which this
    # app deliberately does not do (see ProjectsRepository.delete's
    # docstring) — FoldersRepository.delete therefore only ever allows
    # deleting an EMPTY folder (no child folders, no documents) or one
    # whose direct children have just been explicitly moved to root; a
    # folder with nested descendants several levels deep is never deleted
    # out from under them by any implicit cascade.
    parent_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("folders.id", ondelete="CASCADE"), nullable=True
    )
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )
