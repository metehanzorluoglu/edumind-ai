import uuid
from datetime import datetime
from typing import Literal

from sqlalchemy import DateTime, ForeignKey, Index, Integer, String, Text, UniqueConstraint, Uuid, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base

#: A generous but bounded ceiling on manuscript size (Section 38: "define
#: reasonable limits... do not allow unbounded payloads"). ~2MB of LaTeX
#: source is already a very large paper/thesis chapter — comfortably above
#: any realistic academic manuscript, while still ruling out an
#: accidental or malicious multi-hundred-MB PATCH body.
MAX_MAIN_TEX_CONTENT_CHARS = 2_000_000


class WritingProject(Base):
    """Milestone 5 (Academic Writing & LaTeX Foundation) — one LaTeX
    writing project, owned by exactly one user.

    Deliberately a SEPARATE model from `Project` (app/db/models_projects.py)
    despite the name overlap — see this milestone's Architecture Audit.
    `Project` groups a user's CHAT CONVERSATIONS (a folder of chat
    threads); a WritingProject holds actual LaTeX manuscript source and
    associates with Documents for its bibliography — a fundamentally
    different shape and lifecycle. Reusing `Project` would conflate "chats
    grouped together" with "a paper being written," and would force every
    future writing-specific column (main_tex_content, compiler settings)
    onto a table that also serves chat-project grouping. `ProjectDocument`
    (app/db/models_scopes.py) was considered and rejected for the same
    reason: it associates documents with a chat project's RETRIEVAL SCOPE
    (what the chat's RAG can search), not a manuscript's citation list —
    conflating the two would mean adding a document to a bibliography
    could silently change what a chat can retrieve, or vice versa.

    `main_tex_content` is the ONLY LaTeX source stored — no multi-file
    project structure (Section 6: "do not build a full IDE"). Deliberately
    NOT storing `document_class`/`compiler`/`bibliography_style` yet
    (Section 2's own instruction: "only persist fields actually needed
    now... do not prematurely model every possible LaTeX configuration") —
    the one style EduM8 already produces bibliographies in is BibTeX (see
    app/core/bibtex.py), and the default template (see
    DEFAULT_MAIN_TEX_TEMPLATE) already declares \\documentclass{article}
    inline; there is nothing yet that reads a separate document_class
    column.
    """

    __tablename__ = "writing_projects"
    __table_args__ = (
        Index("ix_writing_projects_user_id_updated_at", "user_id", "updated_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Bounded by MAX_MAIN_TEX_CONTENT_CHARS at the schema-validation layer
    # (see app/schemas/writing.py) — Text here (not a length-capped
    # String) because SQLite/Postgres Text has no fixed max and the real
    # limit is enforced in application code, matching this codebase's
    # existing convention for abstract/note_text columns.
    main_tex_content: Mapped[str] = mapped_column(Text, nullable=False)
    # Milestone 5.3 Part 15/16 — the project's current root/main `.tex`
    # file. Nullable + `ondelete="SET NULL"` as pure defense-in-depth: the
    # API layer (routes_writing_files.py) refuses to delete a file that is
    # currently the root, or to move/rename it into an invalid state,
    # without an explicit reassignment first (Part 16) — this FK is never
    # expected to actually go NULL in normal operation, but if it somehow
    # did, `compile` must treat "no root file" as "compile disabled with a
    # clear message" (Part 16) rather than crash. A pre-M5.3 project has
    # NULL here only for the instant between the migration creating its
    # `main.tex` WritingProjectFile row and setting this column (see
    # 0026_writing_project_files.py) — by the time application code ever
    # reads a row, this is always populated.
    root_file_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("writing_project_files.id", ondelete="SET NULL"),
        nullable=True,
    )
    # Milestone 5.3 Part 30 — archived projects are hidden from the
    # default dashboard view but never hard-deleted (see
    # WritingProjectsRepository.archive/restore). NULL = active (the
    # overwhelmingly common case, and every pre-M5.3 project's state).
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class WritingProjectDocument(Base):
    """One (writing_project, document) reference association — a
    manuscript's bibliography membership, never a copy of bibliographic
    metadata (Section 3: "Do NOT copy bibliographic metadata into the
    project... always read current canonical Document metadata").

    `document_id` uses the SAME `ondelete=CASCADE` FK convention as the
    pre-existing `ProjectDocument`/`ConversationDocument` associations
    (app/db/models_scopes.py) — deleting a Document silently removes it
    from a writing project's reference list, exactly like every other
    document-association table in this codebase, and deliberately does
    NOT cascade further to delete the WritingProject itself (Section 29:
    "do not cascade-delete the Writing Project"). No bibliography
    snapshot is taken when this happens: if the deleted document's
    citation key is still present in `main_tex_content`, the EXISTING
    missing-citation-detection mechanism (Section 26 — comparing parsed
    \\cite{} keys against current references) already reports it as an
    unresolved citation, with no separate snapshot machinery and no
    second source of bibliographic truth to keep in sync. See this
    milestone's report ("Document Deletion Semantics") for the full
    reasoning.
    """

    __tablename__ = "writing_project_documents"
    __table_args__ = (Index("ix_writing_project_documents_document_id", "document_id"),)

    writing_project_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("writing_projects.id", ondelete="CASCADE"),
        primary_key=True,
    )
    document_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("documents.document_id", ondelete="CASCADE"), primary_key=True
    )
    added_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


#: Milestone 5.3 Part 1 — the three shapes a project entry can be. A
#: folder never carries content; a text file's bytes live directly in
#: `content_text` (small, versioned-by-overwrite, same convention as
#: `main_tex_content` — see WritingProjectFile's own docstring for why);
#: a binary file's bytes live on disk via WritingProjectFileStorage,
#: referenced by `storage_key`.
WritingProjectFileKind = Literal["folder", "text", "binary"]

#: Milestone 5.3 Part 5/10 — every extension this milestone allows a
#: project file to have, by kind. `.bst` is deliberately NOT included
#: (Part 45: "if custom style-file support materially weakens security,
#: restrict or defer it" — a `.bst` file is a small stack-based program
#: with its own `write$`/`format.name$` primitives; this milestone's
#: compiler-security review did not extend to auditing that surface, so
#: it stays out until a dedicated review, same posture as ZIP import
#: being deferred to M5.4 rather than rushed in).
TEXT_FILE_EXTENSIONS = frozenset({".tex", ".cls", ".sty", ".txt"})
BINARY_FILE_EXTENSIONS = frozenset({".png", ".jpg", ".jpeg", ".pdf"})
ALL_ALLOWED_EXTENSIONS = TEXT_FILE_EXTENSIONS | BINARY_FILE_EXTENSIONS

#: Milestone 5.3 Part 12 — reasonable, measured limits (see this
#: milestone's report's "Size Limits" section for the Oracle host disk
#: numbers these were chosen against: 117GB free at rollout time).
MAX_TEXT_FILE_CONTENT_CHARS = 500_000
MAX_BINARY_FILE_BYTES = 15_000_000
MAX_PROJECT_TOTAL_STORAGE_BYTES = 100_000_000
MAX_FILES_PER_PROJECT = 150
MAX_FOLDER_DEPTH = 12


class WritingProjectFile(Base):
    """Milestone 5.3 (LaTeX Project Workspace & File Management) — one
    file OR folder inside a Writing Project's file tree.

    Deliberately does NOT store a `path` column. `parent_id` (a self-FK,
    NULL for a root-level entry) is the single source of structural
    truth; a display/compile path like "sections/introduction.tex" is
    always COMPUTED by walking the parent chain (see
    WritingProjectFilesRepository.compute_path / list_tree), never
    persisted and kept in sync. This is a deliberate simplification over
    a stored-path design (Part 7/8's "rename/move must update project
    path references atomically"): with no stored path, a rename only
    ever touches this row's own `name`, and a move only ever touches this
    row's own `parent_id` — every descendant's effective path updates
    for free, with no batch rewrite, no risk of a half-updated subtree,
    and no possibility of a stale/duplicated path ever existing in the
    database. `(writing_project_id, parent_id, name)` is unique — the
    database itself refuses a duplicate name within one folder, the same
    invariant Part 5/6's "no duplicate path" validation asks for.

    `references.bib` is deliberately NEVER a row in this table (Part 3):
    it has no `parent_id`/`name`/`content_text` here at all — the file
    tree API synthesizes a read-only "references.bib" entry into every
    tree response from the EXACT SAME live-generated BibTeX text
    GET /writing-projects/{id}/bibliography already produces (see
    routes_writing_files.py), so there is only ever one bibliography
    source of truth, exactly as there was before this milestone.
    """

    __tablename__ = "writing_project_files"
    __table_args__ = (
        UniqueConstraint(
            "writing_project_id", "parent_id", "name", name="uq_writing_project_files_sibling_name"
        ),
        Index("ix_writing_project_files_project_id", "writing_project_id"),
        Index("ix_writing_project_files_parent_id", "parent_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    writing_project_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("writing_projects.id", ondelete="CASCADE"), nullable=False
    )
    parent_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("writing_project_files.id", ondelete="CASCADE"),
        nullable=True,
    )
    kind: Mapped[str] = mapped_column(String(10), nullable=False)  # WritingProjectFileKind
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    mime_type: Mapped[str | None] = mapped_column(String(100), nullable=True)
    size_bytes: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    # Text kind only (Part 1: "do NOT store large binary blobs directly
    # in SQLite" — this column is only ever populated for kind="text",
    # and even then bounded to MAX_TEXT_FILE_CONTENT_CHARS).
    content_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Binary kind only — resolved through WritingProjectFileStorage
    # (app/services/writing_project_file_storage.py), which mirrors
    # DocumentFileStorage's per-user-id-keyed, containment-checked
    # on-disk layout exactly.
    storage_key: Mapped[str | None] = mapped_column(String(300), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
