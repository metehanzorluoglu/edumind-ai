"""SQL-backed store for background document-ingestion jobs (see
app/core/document_ingestion_jobs.py). POST /documents creates a row here as
soon as parsing/chunking finishes, then returns immediately — embedding,
Qdrant indexing, and the eventual `documents` row all happen later, off the
request thread, and this table is what GET /documents/jobs/{job_id} polls.
"""

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy.orm import Session

from app.db.models_documents import DocumentJob


@dataclass(frozen=True)
class DocumentJobRecord:
    """Read-shape returned to callers — a plain dataclass, not the ORM
    entity itself, mirroring DocumentsRepository's DocumentRecord."""

    job_id: str
    user_id: uuid.UUID
    source_filename: str
    status: str
    stage: str
    total_chunks: int
    embedded_chunks: int
    document_id: str | None
    error_message: str | None
    created_at: datetime
    updated_at: datetime


def _to_record(row: DocumentJob) -> DocumentJobRecord:
    return DocumentJobRecord(
        job_id=row.job_id,
        user_id=row.user_id,
        source_filename=row.source_filename,
        status=row.status,
        stage=row.stage,
        total_chunks=row.total_chunks,
        embedded_chunks=row.embedded_chunks,
        document_id=row.document_id,
        error_message=row.error_message,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


class DocumentJobsRepository:
    def __init__(self, db: Session) -> None:
        self._db = db

    def create(
        self, *, job_id: str, user_id: uuid.UUID, source_filename: str, total_chunks: int
    ) -> DocumentJobRecord:
        now = datetime.now(UTC)
        row = DocumentJob(
            job_id=job_id,
            user_id=user_id,
            source_filename=source_filename,
            status="processing",
            stage="embedding",
            total_chunks=total_chunks,
            embedded_chunks=0,
            document_id=None,
            error_message=None,
            created_at=now,
            updated_at=now,
        )
        self._db.add(row)
        self._db.commit()
        return _to_record(row)

    def get(self, user_id: uuid.UUID, job_id: str) -> DocumentJobRecord | None:
        """Returns None for a job that doesn't exist *or* belongs to a
        different user — deliberately indistinguishable, same as
        DocumentsRepository.get(), so GET /documents/jobs/{id} can 404
        without confirming or denying another user's job exists."""
        row = self._db.get(DocumentJob, job_id)
        if row is None or row.user_id != user_id:
            return None
        return _to_record(row)

    def update_progress(self, job_id: str, *, stage: str, embedded_chunks: int) -> None:
        row = self._db.get(DocumentJob, job_id)
        if row is None:
            return
        row.stage = stage
        row.embedded_chunks = embedded_chunks
        row.updated_at = datetime.now(UTC)
        self._db.commit()

    def mark_completed(self, job_id: str, *, document_id: str) -> None:
        row = self._db.get(DocumentJob, job_id)
        if row is None:
            return
        row.status = "completed"
        row.stage = "persisting"
        row.document_id = document_id
        row.embedded_chunks = row.total_chunks
        row.updated_at = datetime.now(UTC)
        self._db.commit()

    def mark_failed(self, job_id: str, *, error_message: str) -> None:
        row = self._db.get(DocumentJob, job_id)
        if row is None:
            return
        row.status = "failed"
        row.error_message = error_message
        row.updated_at = datetime.now(UTC)
        self._db.commit()
