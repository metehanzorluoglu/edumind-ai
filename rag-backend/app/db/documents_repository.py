"""SQL-backed, per-user document metadata store — see app/db/models_documents.py
for why this fully replaces the old JSON duplicate registry rather than
sitting alongside it. Used by the API (app/api/routes_documents.py), the CLI
(cli/documents.py), and app/core/document_deletion.py; nothing else should
read or write the `documents` table directly.
"""

import uuid
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db.models_documents import Document
from app.ingestion.metadata_schema import DocumentMetadata


@dataclass(frozen=True)
class DocumentRecord:
    """Read-shape returned to callers — a plain dataclass, not the ORM
    entity itself, so callers never accidentally mutate/flush a row through
    an object they only asked to read."""

    document_id: str
    user_id: uuid.UUID
    sha256: str
    source_filename: str
    title: str | None
    authors: list[str]
    publication_year: int | None
    source_venue: str | None
    doi: str | None
    source_url: str | None
    document_type: str
    journal_quartile: str | None
    chunk_count: int
    page_count: int
    file_format: str
    ingested_at: datetime


def _to_record(row: Document) -> DocumentRecord:
    return DocumentRecord(
        document_id=row.document_id,
        user_id=row.user_id,
        sha256=row.sha256,
        source_filename=row.source_filename,
        title=row.title,
        authors=list(row.authors),
        publication_year=row.publication_year,
        source_venue=row.source_venue,
        doi=row.doi,
        source_url=row.source_url,
        document_type=row.document_type,
        journal_quartile=row.journal_quartile,
        chunk_count=row.chunk_count,
        page_count=row.page_count,
        file_format=row.file_format,
        ingested_at=row.ingested_at,
    )


class DocumentsRepository:
    def __init__(self, db: Session) -> None:
        self._db = db

    def contains_sha256(self, user_id: uuid.UUID, sha256: str) -> bool:
        """Duplicate check — scoped per-user: two different users uploading
        byte-identical files are independent owners, not a collision."""
        stmt = select(Document.document_id).where(
            Document.user_id == user_id, Document.sha256 == sha256
        )
        return self._db.execute(stmt).first() is not None

    def get_by_sha256(self, user_id: uuid.UUID, sha256: str) -> DocumentRecord | None:
        """Same lookup as contains_sha256, but returns the full existing
        record — used by app/core/document_ingestion.py's
        ingest_or_reuse_document to reuse an already-ingested document
        instead of erroring (the "do not duplicate uploads" rule for the
        new scope-aware upload paths). POST /documents' own duplicate
        check keeps using contains_sha256 + a hard 409; this method is
        additive, not a replacement."""
        row = self._db.execute(
            select(Document).where(Document.user_id == user_id, Document.sha256 == sha256)
        ).scalar_one_or_none()
        return _to_record(row) if row is not None else None

    def create(
        self, *, user_id: uuid.UUID, metadata: DocumentMetadata, chunk_count: int
    ) -> DocumentRecord:
        row = Document(
            document_id=metadata.document_id,
            user_id=user_id,
            sha256=metadata.sha256,
            source_filename=metadata.source_filename,
            title=metadata.title,
            authors=metadata.authors,
            publication_year=metadata.publication_year,
            source_venue=metadata.source_venue,
            doi=metadata.doi,
            source_url=metadata.source_url,
            document_type=metadata.document_type,
            journal_quartile=metadata.journal_quartile,
            chunk_count=chunk_count,
            page_count=metadata.page_count,
            file_format=metadata.file_format,
            ingested_at=metadata.ingested_at,
        )
        self._db.add(row)
        self._db.commit()
        return _to_record(row)

    def get(self, user_id: uuid.UUID, document_id: str) -> DocumentRecord | None:
        """Returns None for a document that doesn't exist *or* belongs to a
        different user — deliberately indistinguishable, so callers (see
        DELETE /documents/{id}) can 404 without ever confirming or denying
        that a given ID belongs to someone else."""
        row = self._db.get(Document, document_id)
        if row is None or row.user_id != user_id:
            return None
        return _to_record(row)

    def list_for_user(
        self, user_id: uuid.UUID, *, limit: int = 20, offset: int = 0
    ) -> tuple[list[DocumentRecord], int]:
        total = self._db.execute(
            select(func.count()).select_from(Document).where(Document.user_id == user_id)
        ).scalar_one()

        rows = (
            self._db.execute(
                select(Document)
                .where(Document.user_id == user_id)
                .order_by(Document.ingested_at.desc())
                .limit(limit)
                .offset(offset)
            )
            .scalars()
            .all()
        )
        return [_to_record(row) for row in rows], total

    def update_metadata(
        self, user_id: uuid.UUID, document_id: str, updates: dict[str, object]
    ) -> DocumentRecord | None:
        """Payload-only field update for `python -m cli.documents
        refresh-metadata` — only ever touches the bibliographic columns
        named in `updates` (title, authors, publication_year, source_venue,
        doi, source_url; never sha256/chunk_count/document_type/ingested_at).
        Returns None if no row belonging to this user exists with this
        document_id (see get()'s docstring on why that's indistinguishable
        from 'exists but owned by someone else')."""
        row = self._db.get(Document, document_id)
        if row is None or row.user_id != user_id:
            return None
        for field, value in updates.items():
            setattr(row, field, value)
        self._db.commit()
        self._db.refresh(row)
        return _to_record(row)

    def delete(self, user_id: uuid.UUID, document_id: str) -> bool:
        """Returns True if a row belonging to this user was actually
        deleted. Never deletes (or reveals the existence of) another user's
        row with the same document_id — see get()'s docstring."""
        row = self._db.get(Document, document_id)
        if row is None or row.user_id != user_id:
            return False
        self._db.delete(row)
        self._db.commit()
        return True
