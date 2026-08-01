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
    )

    document_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
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
