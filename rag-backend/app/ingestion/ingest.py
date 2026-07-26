import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Protocol
from uuid import uuid4

from pydantic import BaseModel

from app.ingestion.errors import DuplicateDocumentError
from app.ingestion.hashing import compute_sha256
from app.ingestion.loaders.base import PageContent
from app.ingestion.loaders.dispatch import load_document
from app.ingestion.metadata_extraction import clean_filename_as_title
from app.ingestion.metadata_schema import DocumentMetadata, DocumentType, JournalQuartile


class DuplicateChecker(Protocol):
    """Satisfied by app.db.documents_repository.DocumentsRepository — kept
    as its own narrow Protocol here since ingest_document() only ever needs
    this one capability, not the repository's full read/write surface."""

    def contains_sha256(self, user_id: uuid.UUID, sha256: str) -> bool: ...


class IngestionResult(BaseModel):
    metadata: DocumentMetadata
    pages: list[PageContent]

    @property
    def full_text(self) -> str:
        return "\n\n".join(page.text for page in self.pages)


def ingest_document(
    file_path: Path,
    *,
    document_type: DocumentType,
    duplicate_checker: DuplicateChecker,
    user_id: uuid.UUID,
    journal_quartile: JournalQuartile = None,
    title: str | None = None,
    authors: list[str] | None = None,
    publication_year: int | None = None,
    source_venue: str | None = None,
    doi: str | None = None,
    source_url: str | None = None,
    original_filename: str | None = None,
) -> IngestionResult:
    """Extracts text and builds metadata, rejecting duplicates already
    ingested *by this same user* — two different users uploading
    byte-identical files are independent owners, not a collision.

    `original_filename` matters when `file_path` is a temp file (e.g.
    POST /documents writes the upload to a randomly-named temp path before
    calling this) — it becomes `metadata.source_filename` instead of the
    temp name, and is also what the lowest-priority title fallback (a
    cleaned-up version of the filename) is derived from. Omit it when
    `file_path` already *is* the real source file (the CLI's `reingest`,
    which operates on a real file on disk).

    Every metadata field follows the same priority order: an explicit
    argument here (the user's own input) always wins; otherwise whatever
    load_document() resolved (embedded file metadata, then a
    structured-text fallback — see loaders/dispatch.py) is used; for
    title specifically, if neither produced anything, a cleaned-up
    version of the filename is used as a last resort (see
    metadata_extraction.clean_filename_as_title) rather than leaving the
    document titleless. Never fabricates authors, a year, a venue, or a
    DOI this way — those simply stay None/empty if nothing found them.

    Does NOT register the document — that is the caller's responsibility, to
    be done only once the full pipeline (chunking, embedding, vector store
    upsert) has actually succeeded. Registering here, before those later
    stages run, would mark a document as "already ingested" even if it was
    never actually stored anywhere, permanently blocking retries after a
    transient failure (e.g. an embedding provider being temporarily
    unreachable)."""
    if not file_path.is_file():
        raise FileNotFoundError(f"No such file: {file_path}")

    sha256 = compute_sha256(file_path)
    if duplicate_checker.contains_sha256(user_id, sha256):
        raise DuplicateDocumentError(
            f"'{file_path.name}' has already been ingested (sha256={sha256})."
        )

    loaded = load_document(file_path)
    resolved_filename = original_filename or file_path.name

    resolved_title = title or loaded.metadata.title or clean_filename_as_title(resolved_filename)

    document_id = str(uuid4())
    metadata = DocumentMetadata(
        document_id=document_id,
        source_filename=resolved_filename,
        file_format=loaded.file_format,
        sha256=sha256,
        file_size_bytes=file_path.stat().st_size,
        page_count=len(loaded.pages),
        document_type=document_type,
        journal_quartile=journal_quartile,
        title=resolved_title,
        authors=authors if authors is not None else loaded.metadata.authors,
        publication_year=(
            publication_year if publication_year is not None else loaded.metadata.publication_year
        ),
        source_venue=source_venue or loaded.metadata.source_venue,
        doi=doi or loaded.metadata.doi,
        source_url=source_url or loaded.metadata.source_url,
        ingested_at=datetime.now(UTC),
    )

    return IngestionResult(metadata=metadata, pages=loaded.pages)
