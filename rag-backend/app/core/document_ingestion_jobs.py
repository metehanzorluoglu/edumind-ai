"""Runs the slow half of document ingestion (embed -> index -> persist) as a
FastAPI background task, off the request thread — see
app/api/routes_documents.py's post_document, which does the fast half
(duplicate check, parse, chunk — all sub-second even for large files)
synchronously and returns before this ever runs.

Embedding generation dominates ingestion time on CPU-only hardware (a Pi 5
measured at ~2s/chunk for mxbai-embed-large — see the timing investigation
this module was added for) and doesn't parallelize across a batch, so a
document with more than a handful of chunks would hold an HTTP request open
for minutes if run synchronously. This function is called via
BackgroundTasks.add_task() *after* POST /documents has already responded,
so it must open its own DB session (the request's session is closed by
then) — the same get_session_factory() pattern cli/ingest.py already uses
outside a request.
"""

from __future__ import annotations

import logging
import time
import uuid

from app.core.embedding_provider import EmbeddingProvider
from app.db.document_jobs_repository import DocumentJobsRepository
from app.db.documents_repository import DocumentsRepository
from app.db.session import get_session_factory
from app.ingestion.chunker import Chunk
from app.ingestion.metadata_schema import DocumentMetadata
from app.vectorstore.qdrant_client import QdrantVectorStore

logger = logging.getLogger(__name__)

# Progress-reporting granularity, independent of EmbeddingProvider's own
# internal batching — smaller means more frequent progress updates for the
# UI to poll, not faster embedding (Ollama's cost is per-text either way).
_PROGRESS_SLICE_SIZE = 8


def run_ingestion_job(
    *,
    job_id: str,
    user_id: uuid.UUID,
    metadata: DocumentMetadata,
    chunks: list[Chunk],
    embedding_provider: EmbeddingProvider,
    vector_store: QdrantVectorStore,
) -> None:
    session = get_session_factory()()
    jobs_repository = DocumentJobsRepository(session)
    try:
        _run(
            job_id=job_id,
            user_id=user_id,
            metadata=metadata,
            chunks=chunks,
            embedding_provider=embedding_provider,
            vector_store=vector_store,
            jobs_repository=jobs_repository,
            documents_repository=DocumentsRepository(session),
        )
    except Exception as exc:  # noqa: BLE001 - must never crash the background task silently
        logger.exception("Ingestion job %s failed for document %r", job_id, metadata.source_filename)
        jobs_repository.mark_failed(job_id, error_message=str(exc))
    finally:
        session.close()


def _run(
    *,
    job_id: str,
    user_id: uuid.UUID,
    metadata: DocumentMetadata,
    chunks: list[Chunk],
    embedding_provider: EmbeddingProvider,
    vector_store: QdrantVectorStore,
    jobs_repository: DocumentJobsRepository,
    documents_repository: DocumentsRepository,
) -> None:
    total = len(chunks)
    logger.info(
        "Ingestion job %s: embedding %d chunk(s) for %r", job_id, total, metadata.source_filename
    )

    embeddings: list[list[float]] = []
    embed_start = time.monotonic()
    for start in range(0, total, _PROGRESS_SLICE_SIZE):
        slice_chunks = chunks[start : start + _PROGRESS_SLICE_SIZE]
        slice_start = time.monotonic()
        embeddings.extend(embedding_provider.embed_batch([chunk.text for chunk in slice_chunks]))
        logger.info(
            "Ingestion job %s: embedded %d/%d chunks (+%.2fs, %.2fs elapsed)",
            job_id,
            len(embeddings),
            total,
            time.monotonic() - slice_start,
            time.monotonic() - embed_start,
        )
        jobs_repository.update_progress(job_id, stage="embedding", embedded_chunks=len(embeddings))
    logger.info(
        "Ingestion job %s: embedding done in %.2fs", job_id, time.monotonic() - embed_start
    )

    jobs_repository.update_progress(job_id, stage="indexing", embedded_chunks=total)
    index_start = time.monotonic()
    vector_store.upsert_chunks(metadata, chunks, embeddings, user_id=str(user_id))
    logger.info(
        "Ingestion job %s: Qdrant upsert of %d chunk(s) done in %.2fs",
        job_id,
        total,
        time.monotonic() - index_start,
    )

    jobs_repository.update_progress(job_id, stage="persisting", embedded_chunks=total)
    persist_start = time.monotonic()
    documents_repository.create(user_id=user_id, metadata=metadata, chunk_count=total)
    logger.info(
        "Ingestion job %s: metadata persisted in %.2fs", job_id, time.monotonic() - persist_start
    )

    jobs_repository.mark_completed(job_id, document_id=metadata.document_id)
    logger.info("Ingestion job %s: completed for document %s", job_id, metadata.document_id)
