"""SQL-backed, per-user document metadata store — see app/db/models_documents.py
for why this fully replaces the old JSON duplicate registry rather than
sitting alongside it. Used by the API (app/api/routes_documents.py), the CLI
(cli/documents.py), and app/core/document_deletion.py; nothing else should
read or write the `documents` table directly.
"""

import uuid
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.db.models_documents import Document
from app.db.models_folders import Folder
from app.ingestion.metadata_schema import DocumentMetadata


@dataclass(frozen=True)
class DocumentRecord:
    """Read-shape returned to callers — a plain dataclass, not the ORM
    entity itself, so callers never accidentally mutate/flush a row through
    an object they only asked to read."""

    document_id: str
    user_id: uuid.UUID
    folder_id: uuid.UUID | None
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
    storage_key: str | None
    original_mime_type: str | None
    original_file_size_bytes: int | None
    # Frontend/Platform Milestone 3.2.1 Part D — populated only by
    # search_for_user() below (a LEFT JOIN against folders), None
    # everywhere else. Optional/defaulted so every existing caller of
    # _to_record()/list_for_user()/list_in_folder() is unaffected.
    folder_name: str | None = None

    @property
    def original_file_available(self) -> bool:
        """Frontend/Platform Milestone 3.2.1: DELIBERATELY NOT what
        response-building code should use anymore — this only reflects
        whether `storage_key` was ever set, not whether the physical file
        still exists (see this milestone's report: a misconfigured
        storage root can leave `storage_key` set forever while the bytes
        it points at are gone). Kept for cheap non-response-facing checks
        that only care "did this document ever get a stored original"
        (there are none in this codebase today). Every route that reports
        `original_file_available` in an API response MUST instead call
        routes_documents.py's `_original_file_available(record,
        document_file_storage)`, which adds the real existence check."""
        return self.storage_key is not None


def _to_record(row: Document, *, folder_name: str | None = None) -> DocumentRecord:
    return DocumentRecord(
        document_id=row.document_id,
        user_id=row.user_id,
        folder_id=row.folder_id,
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
        storage_key=row.storage_key,
        original_mime_type=row.original_mime_type,
        original_file_size_bytes=row.original_file_size_bytes,
        folder_name=folder_name,
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
        self,
        *,
        user_id: uuid.UUID,
        metadata: DocumentMetadata,
        chunk_count: int,
        folder_id: uuid.UUID | None = None,
        storage_key: str | None = None,
        original_mime_type: str | None = None,
        original_file_size_bytes: int | None = None,
    ) -> DocumentRecord:
        # folder_id is deliberately not part of DocumentMetadata (see
        # app/ingestion/metadata_schema.py) — it's Milestone 1's
        # organizational placement, computed and validated by the caller
        # (see app/api/routes_documents.py's post_document, which resolves
        # and ownership-checks it BEFORE the slow background ingestion job
        # even starts), not something the ingestion/parsing pipeline itself
        # knows or cares about. Every pre-existing call site (CLI ingest,
        # ingest_or_reuse_document for project uploads) omits it and gets
        # the same "unfiled/root" placement documents have always had.
        row = Document(
            document_id=metadata.document_id,
            user_id=user_id,
            folder_id=folder_id,
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
            storage_key=storage_key,
            original_mime_type=original_mime_type,
            original_file_size_bytes=original_file_size_bytes,
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

    def list_in_folder(
        self,
        user_id: uuid.UUID,
        folder_id: uuid.UUID | None,
        *,
        limit: int = 20,
        offset: int = 0,
    ) -> tuple[list[DocumentRecord], int]:
        """Same shape as list_for_user, filtered to one folder instead of
        the whole corpus — `folder_id=None` means root/unfiled (backs GET
        /folders/contents' "what's directly in this folder" listing, see
        app/api/routes_folders.py). SQLAlchemy compiles
        `Document.folder_id == None` to `IS NULL`, so root-level documents
        are matched correctly rather than being excluded the way a naive
        `= NULL` SQL comparison would."""
        conditions = (Document.user_id == user_id, Document.folder_id == folder_id)
        total = self._db.execute(
            select(func.count()).select_from(Document).where(*conditions)
        ).scalar_one()

        rows = (
            self._db.execute(
                select(Document)
                .where(*conditions)
                .order_by(Document.ingested_at.desc())
                .limit(limit)
                .offset(offset)
            )
            .scalars()
            .all()
        )
        return [_to_record(row) for row in rows], total

    def search_for_user(
        self, user_id: uuid.UUID, q: str, *, limit: int = 20, offset: int = 0
    ) -> tuple[list[DocumentRecord], int]:
        """Frontend/Platform Milestone 3.2.1 Part D — LIBRARY search, not
        semantic corpus retrieval: a plain case-insensitive substring match
        against `title`/`source_filename`, across every folder (never
        scoped to "whichever folder happens to be open" — see this
        milestone's report on why "search my whole library" is the
        expected mental model here). Deliberately does NOT touch Qdrant/
        embeddings/chunks — that's GET /search's job (app/api/
        routes_search.py), a fundamentally different feature this one is
        not a replacement for.

        LEFT JOINs folders once, server-side, so each result can show
        where it lives (`folder_name`, None for root) without the caller
        making a second round trip per result — see DocumentRecord.
        folder_name's own docstring for why that field defaults to None
        everywhere else."""
        needle = f"%{q.strip()}%"
        conditions = (
            Document.user_id == user_id,
            or_(Document.title.ilike(needle), Document.source_filename.ilike(needle)),
        )
        total = self._db.execute(
            select(func.count()).select_from(Document).where(*conditions)
        ).scalar_one()

        rows = (
            self._db.execute(
                select(Document, Folder.name)
                .outerjoin(Folder, Document.folder_id == Folder.id)
                .where(*conditions)
                .order_by(Document.ingested_at.desc())
                .limit(limit)
                .offset(offset)
            )
            .all()
        )
        return [_to_record(row[0], folder_name=row[1]) for row in rows], total

    def move_to_folder(
        self, user_id: uuid.UUID, document_id: str, folder_id: uuid.UUID | None
    ) -> DocumentRecord | None:
        """Reassigns which folder a document is filed under (None = move to
        root) — a single-column SQL UPDATE, never touching Qdrant: see
        app/db/models_documents.py's `folder_id` docstring for why this is
        deliberately safe (no re-parse, no re-embed, no chunk/vector
        rewrite). Caller (see app/api/routes_documents.py) is responsible
        for verifying `folder_id` belongs to this same user before calling
        this — this method itself only re-verifies the *document's*
        ownership, matching update_metadata()'s existing contract."""
        row = self._db.get(Document, document_id)
        if row is None or row.user_id != user_id:
            return None
        row.folder_id = folder_id
        self._db.commit()
        self._db.refresh(row)
        return _to_record(row)

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
