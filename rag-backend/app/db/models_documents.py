import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Index, Integer, String, Text, UniqueConstraint, Uuid
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.types import JSON

from app.db.base import Base


class Document(Base):
    """One uploaded document's metadata, owned by exactly one user.

    Fully replaces the old flat-JSON duplicate registry (see
    app/ingestion/duplicate_registry.py, retired alongside this table) —
    that registry only ever mapped sha256 -> document_id for a single
    global namespace; per-user ownership needs richer, queryable state
    than a JSON file can reasonably provide, and this table now doubles as
    GET /documents' listing source (replacing
    QdrantVectorStore.list_documents()'s full-collection scroll-and-group,
    which was never meant to scale and had no natural place to filter by
    owner). Qdrant remains the source of truth only for chunk-level
    vectors/search — this table is the source of truth for "what documents
    does this user have."

    `document_id` (not a surrogate id) is the primary key: it's already a
    stable, globally-unique identifier minted at ingestion time (see
    app/ingestion/ingest.py) and is what Qdrant payloads and the frontend
    already key everything off — introducing a second id here would only
    invite the two getting out of sync.
    """

    __tablename__ = "documents"
    __table_args__ = (
        UniqueConstraint("user_id", "sha256", name="uq_documents_user_sha256"),
        Index("ix_documents_user_id_ingested_at", "user_id", "ingested_at"),
        # Backs GET /folders/contents' per-folder document listing (Milestone
        # 1) — filters on (user_id, folder_id) exactly the same shape as the
        # existing (user_id, ingested_at) index above, just for "documents in
        # this folder" instead of "documents for this user" ordered by time.
        Index("ix_documents_user_id_folder_id", "user_id", "folder_id"),
    )

    document_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # Milestone 1 (Document Library / Folder Management): purely
    # organizational placement in the caller's folder tree (see
    # app/db/models_folders.py) — NULL means "root" (unfiled), matching
    # this system's existing "flat by default" behavior for every document
    # ingested before folders existed. Deliberately NOT part of retrieval,
    # chunking, or the Qdrant payload: moving a document between folders is
    # a single SQL UPDATE of this column (see
    # DocumentsRepository.move_to_folder) and never touches embeddings,
    # chunks, or vector storage — see FoldersRepository/routes_folders.py's
    # module docstrings for the full "why folders never reparent evidence"
    # reasoning behind the future Zoom-In/Scope retrieval boundary, which
    # stays keyed on document_id (and conversation/project associations),
    # never on folder_id.
    folder_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("folders.id", ondelete="SET NULL"), nullable=True
    )
    sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    source_filename: Mapped[str] = mapped_column(String(512), nullable=False)
    title: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    source_venue: Mapped[str | None] = mapped_column(String(512), nullable=True)
    doi: Mapped[str | None] = mapped_column(String(255), nullable=True)
    source_url: Mapped[str | None] = mapped_column(String(2048), nullable=True)
    authors: Mapped[list[str]] = mapped_column(JSON, nullable=False, default=list)
    document_type: Mapped[str] = mapped_column(String(40), nullable=False)
    journal_quartile: Mapped[str | None] = mapped_column(String(2), nullable=True)
    publication_year: Mapped[int | None] = mapped_column(Integer, nullable=True)
    chunk_count: Mapped[int] = mapped_column(Integer, nullable=False)
    page_count: Mapped[int] = mapped_column(Integer, nullable=False)
    file_format: Mapped[str] = mapped_column(String(20), nullable=False)
    ingested_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)

    # --- Frontend Milestone 3.1 (Original Document Reader): the original
    # uploaded file's bytes, kept alongside (never instead of) the chunks
    # this row already indexed — see app/services/document_file_storage.py.
    # `storage_key` is NULL for every document ingested before this
    # milestone (and for any future ingestion path that doesn't opt in —
    # see app/core/document_ingestion_jobs.py's module docstring) — that is
    # the one, sole signal the Reader uses to decide "show the real PDF" vs
    # "fall back to extracted text," never a guess based on file_format
    # alone. Deliberately NOT a foreign key or a second document table
    # (explicit instruction: one document_id, one row) — just three nullable
    # columns describing a file that may or may not exist on disk.
    storage_key: Mapped[str | None] = mapped_column(String(600), nullable=True)
    original_mime_type: Mapped[str | None] = mapped_column(String(255), nullable=True)
    original_file_size_bytes: Mapped[int | None] = mapped_column(Integer, nullable=True)


class DocumentJob(Base):
    """Tracks one background ingestion run (embed -> index -> persist) so
    POST /documents can return as soon as the fast, synchronous part (parse,
    duplicate check, chunk — all sub-second, see app/core/document_ingestion_jobs.py)
    is done, instead of blocking the HTTP request for the minutes embedding
    can take on CPU-only hardware. `document_id` stays null until `status`
    is "completed" — the same "only register once every stage succeeded"
    rule the `documents` table itself already follows (see
    app/api/routes_documents.py)."""

    __tablename__ = "document_jobs"
    __table_args__ = (Index("ix_document_jobs_user_id_created_at", "user_id", "created_at"),)

    job_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    source_filename: Mapped[str] = mapped_column(String(512), nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="processing")
    stage: Mapped[str] = mapped_column(String(20), nullable=False, default="embedding")
    total_chunks: Mapped[int] = mapped_column(Integer, nullable=False)
    embedded_chunks: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    document_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("documents.document_id", ondelete="SET NULL"), nullable=True
    )
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Per-stage timing breakdown (see app/core/request_timing.py), stored as
    # a JSON object of stage name -> duration_ms plus "total_ms" — a column
    # rather than the in-process dict an earlier version of this feature
    # used, because uvicorn runs multiple worker processes (see
    # deploy/oracle/docker-compose.oracle.yml's `--workers 2`): the request
    # that polls GET /documents/jobs/{job_id} can land on a different
    # worker process than the one that ran this job's background task, so
    # only a DB column (or another cross-process store) is visible to both.
    # Null unless the upload ran with PERFORMANCE_PROFILING=true.
    timings_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class DocumentHighlight(Base):
    """Frontend Milestone 3 (Document Reader): one user-authored highlight
    (optionally with a note) anchored to a specific passage of a specific
    document — owned by exactly one user, never shared.

    Anchor design: the document's actual persisted content lives only as
    chunks in Qdrant (see app/vectorstore/qdrant_client.py — no original
    file or full parsed text is retained anywhere, see that module's own
    "content source" investigation notes in routes_documents.py's
    get_document_content). `chunk_id` is that same chunk's existing,
    already-deterministic Qdrant point id (`uuid5(document_id:chunk_index)`
    — see _point_id) — the exact same id citations already use
    (MessageSourceResponse.chunk_id), so a highlight's anchor and a
    citation's "go to source" link key off the identical value. Storing
    `chunk_index`/`page_number` alongside it (denormalized, not re-derived
    per read) means the highlights list/anchor-scroll never has to re-fetch
    Qdrant just to know where a highlight lives. `selected_text` is kept as
    a snapshot for display even if — in principle — chunk boundaries were
    ever re-chunked upstream (never happens today; documents are never
    re-ingested in place, but this keeps a highlight resilient rather than
    silently broken either way, per this milestone's "anchor must survive
    normal reopen" requirement).

    document_id has NO foreign key of its own to `documents.document_id`
    with ondelete=CASCADE — deleting a document must never leave orphaned
    highlights behind (see DocumentReader §23), and moving a document
    between folders never touches document_id, so a highlight's anchor
    survives that unchanged (§22).
    """

    __tablename__ = "document_highlights"
    __table_args__ = (
        Index("ix_document_highlights_user_id_document_id", "user_id", "document_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    document_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("documents.document_id", ondelete="CASCADE"), nullable=False
    )
    # --- Frontend Milestone 3.1: dual anchor model ---
    # `chunk_id`/`chunk_index` are now the SEMANTIC anchor and are nullable:
    # a highlight made directly on the original PDF's selectable text layer
    # is saved even when no existing chunk's text contains a matching
    # substring (best-effort mapping — see the frontend's chunk-matching
    # logic in ReaderScreen). A highlight created the old way (selecting
    # extracted text, or via long-press-on-chunk) always has both. Never
    # fabricate a chunk_id to fill this in — a highlight with chunk_id=None
    # is genuinely visual-only ("semantic anchor unavailable"), not a bug.
    chunk_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    chunk_index: Mapped[int | None] = mapped_column(Integer, nullable=True)
    page_number: Mapped[int] = mapped_column(Integer, nullable=False)
    selected_text: Mapped[str] = mapped_column(Text, nullable=False)
    note_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    # VISUAL anchor: JSON-encoded {"rects": [[x0,y0,x1,y1], ...]} in PDF user
    # -space points (PDF.js viewport.convertToPdfPoint output) — invariant to
    # zoom/CSS scale, so the highlight overlay re-projects correctly at any
    # zoom level via viewport.convertToViewportPoint. NULL for a highlight
    # made in the extracted-text reader (no PDF geometry exists for it) or
    # for any legacy highlight created before this milestone.
    visual_anchor_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class Notebook(Base):
    """Frontend Milestone 3.1 (Research Notes Workspace): a user-named
    collection of NotebookEntry rows — "Research Notes," not a chat/project
    note and not a folder. Deliberately its own table rather than reusing
    ConversationNote/ProjectNote (app/db/models_scopes.py): those are scoped
    to one conversation/project and cascade-delete with their parent: a
    Notebook is a standalone, cross-document research artifact the user
    curates directly and that must outlive any single conversation, project,
    or even the source documents its entries were drawn from (see
    NotebookEntry's docstring)."""

    __tablename__ = "notebooks"
    __table_args__ = (Index("ix_notebooks_user_id_created_at", "user_id", "created_at"),)

    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class NotebookEntry(Base):
    """One research artifact saved into a Notebook — either drawn from a
    Reader highlight (`entry_type="highlight"`) or written directly
    (`entry_type="manual"`).

    Deliberately SNAPSHOT, not live-referencing: `document_title_snapshot`,
    `excerpt_snapshot`, `page_number`, and the anchor fields are copied at
    add-time and never re-read from the source Highlight/Document again.
    This is the mandatory preservation semantics (M3.1 Notebook spec §4/§5):
    deleting the source DocumentHighlight (`highlight_id` carries NO
    ondelete=CASCADE — it is not even a declared FK, since a NotebookEntry
    must keep existing, unchanged, after the row it was copied from is
    gone) or deleting the source Document itself must never delete or
    corrupt a NotebookEntry. `document_id` likewise carries no FK: a
    NotebookEntry whose document has been deleted keeps its snapshot fields
    and simply shows "Source unavailable" (see the frontend's Notebook
    view), never a broken join. This is an intentional, explicit asymmetry
    from `document_highlights`, which DOES cascade-delete with its document
    (see DocumentHighlight's docstring / document_deletion.py) — Notebook
    entries are a deliberate research record, not a live view.
    """

    __tablename__ = "notebook_entries"
    __table_args__ = (
        Index("ix_notebook_entries_notebook_id_created_at", "notebook_id", "created_at"),
        # Backs the idempotent "add this highlight to this notebook" check
        # (NotebooksRepository.add_highlight_entry) — a highlight_id is only
        # ever non-null for entry_type="highlight" rows, so this index does
        # double duty without a partial-index dialect dependency.
        Index("ix_notebook_entries_notebook_id_highlight_id", "notebook_id", "highlight_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    notebook_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("notebooks.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    entry_type: Mapped[str] = mapped_column(String(20), nullable=False)  # "highlight" | "manual"

    # Present only for entry_type="highlight" — deliberately no FK (see
    # class docstring). Used only for the idempotent-add check; never
    # dereferenced to re-read the highlight's current state.
    highlight_id: Mapped[uuid.UUID | None] = mapped_column(Uuid(as_uuid=True), nullable=True)
    # Present only for entry_type="highlight" — no FK, same reasoning.
    # Retained (rather than only relying on the snapshot fields below) so
    # "Open source" can still navigate to /documents/{id} even though the
    # document row itself may since have been deleted (in which case the
    # Reader route 404s and the frontend shows "Source unavailable").
    document_id: Mapped[str | None] = mapped_column(String(36), nullable=True)

    document_title_snapshot: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    page_number: Mapped[int | None] = mapped_column(Integer, nullable=True)
    excerpt_snapshot: Mapped[str | None] = mapped_column(Text, nullable=True)
    note_text: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Semantic anchor snapshot (reused, not re-invented — M3.1 Notebook spec
    # §15): copied from the source highlight's own chunk_id/chunk_index at
    # add-time, so "Ask EduM8" can still cite a real chunk even if the live
    # highlight is later edited or removed.
    chunk_id_snapshot: Mapped[str | None] = mapped_column(String(36), nullable=True)
    chunk_index_snapshot: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # Visual anchor snapshot — same JSON shape as DocumentHighlight.visual_anchor_json.
    visual_anchor_snapshot_json: Mapped[str | None] = mapped_column(Text, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
