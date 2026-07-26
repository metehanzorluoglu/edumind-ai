"""Shared "ingest a file into a searchable Document, or reuse an existing
one with the same content" helper — the "do not duplicate uploads, reuse
existing document hashes" rule for the new scope-aware upload paths
(POST /projects/{id}/documents/upload, attachment promotion). Deliberately
separate from app.ingestion.ingest.ingest_document, whose hard
DuplicateDocumentError contract POST /documents still relies on unchanged.

Never duplicates a document's vectors: on a hash hit, the existing
DocumentRecord is returned as-is — no re-chunking, re-embedding, or second
`documents` row is ever created for the same (user, sha256) pair.
"""

import uuid
from pathlib import Path

from app.core.embedding_provider import EmbeddingProvider
from app.db.documents_repository import DocumentRecord, DocumentsRepository
from app.ingestion.chunker import chunk_pages
from app.ingestion.hashing import compute_sha256
from app.ingestion.ingest import ingest_document
from app.ingestion.metadata_schema import DocumentType, JournalQuartile
from app.vectorstore.qdrant_client import QdrantVectorStore


class _NeverDuplicateChecker:
    """The hash check already happened in ingest_or_reuse_document itself
    (see below) — this satisfies ingest_document's DuplicateChecker
    Protocol without ever raising, since a real duplicate is handled by
    reusing the existing record before ingest_document is ever called."""

    def contains_sha256(self, user_id: uuid.UUID, sha256: str) -> bool:
        return False


def ingest_or_reuse_document(
    file_path: Path,
    *,
    document_type: DocumentType,
    documents_repository: DocumentsRepository,
    embedding_provider: EmbeddingProvider,
    vector_store: QdrantVectorStore,
    user_id: uuid.UUID,
    journal_quartile: JournalQuartile = None,
    title: str | None = None,
    authors: list[str] | None = None,
    publication_year: int | None = None,
    source_venue: str | None = None,
    doi: str | None = None,
    source_url: str | None = None,
    original_filename: str | None = None,
) -> tuple[DocumentRecord, bool]:
    """Returns (record, reused). If this user has already ingested a file
    with this same sha256, that existing DocumentRecord is returned
    unchanged (reused=True) — no re-ingestion, no new chunks/vectors, no
    second `documents` row. Otherwise runs the full ingest -> chunk ->
    embed -> upsert -> register pipeline (the same steps as
    POST /documents, factored out so this and POST /documents never
    silently drift apart) and returns the freshly created record
    (reused=False)."""
    sha256 = compute_sha256(file_path)
    existing = documents_repository.get_by_sha256(user_id, sha256)
    if existing is not None:
        return existing, True

    result = ingest_document(
        file_path,
        document_type=document_type,
        duplicate_checker=_NeverDuplicateChecker(),
        user_id=user_id,
        journal_quartile=journal_quartile,
        title=title,
        authors=authors,
        publication_year=publication_year,
        source_venue=source_venue,
        doi=doi,
        source_url=source_url,
        original_filename=original_filename,
    )
    chunks = chunk_pages(result.pages)
    embeddings = embedding_provider.embed_batch([chunk.text for chunk in chunks])
    vector_store.upsert_chunks(result.metadata, chunks, embeddings, user_id=str(user_id))
    record = documents_repository.create(
        user_id=user_id, metadata=result.metadata, chunk_count=len(chunks)
    )
    return record, False
