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

`timer` (see app/core/request_timing.py) is threaded through explicitly
rather than read via the ambient get_current_timer() accessor, because this
function runs as a FastAPI BackgroundTasks callable — which Starlette
invokes *after* the request's dependency AsyncExitStack has already closed
(and reset the contextvar the ambient accessor reads). The same RequestTimer
instance app/api/routes_documents.py::post_document already recorded
file_save/pdf_parsing/chunking on is passed straight through as a plain
object reference instead, which has no such lifecycle dependency — see
post_document's docstring for the full request/response-header side of this
split. This is also what makes timer.total_ms() meaningful as "total
upload": its clock starts when post_document created the timer (roughly
"file save") and this module is the last code to touch it, however much
later that runs.

The finished timing breakdown is written to the document_jobs row itself
(DocumentJobsRepository.set_timings, a JSON-encoded timings_json column —
see alembic/versions/0014_document_job_timings.py) rather than kept in an
in-process dict: this deployment runs uvicorn with multiple worker
processes (`--workers 2`, see deploy/oracle/docker-compose.oracle.yml), and
the request that later polls GET /documents/jobs/{job_id} can land on a
different worker process than the one that ran this background task — a
plain module-level dict would silently return nothing whenever that
happens (caught live: a first version of this feature did exactly that).
The database is the one thing every worker process already shares.
"""

from __future__ import annotations

import json
import logging
import time
import uuid
from pathlib import Path

from app.config import get_settings
from app.core.embedding_provider import EmbeddingProvider
from app.core.request_timing import RequestTimer
from app.db.document_jobs_repository import DocumentJobsRepository
from app.db.documents_repository import DocumentsRepository
from app.db.session import get_session_factory
from app.ingestion.chunker import Chunk
from app.ingestion.metadata_schema import DocumentMetadata
from app.services.document_file_storage import DocumentFileStorage
from app.vectorstore.qdrant_client import QdrantVectorStore

logger = logging.getLogger(__name__)


def run_ingestion_job(
    *,
    job_id: str,
    user_id: uuid.UUID,
    metadata: DocumentMetadata,
    chunks: list[Chunk],
    embedding_provider: EmbeddingProvider,
    vector_store: QdrantVectorStore,
    timer: RequestTimer,
    folder_id: uuid.UUID | None = None,
    # Frontend Milestone 3.1 (Original Document Reader) — all four optional
    # and default None/absent so any OTHER caller of this function (there
    # are none today, but this keeps the "original file" concern additive)
    # gets exactly the pre-3.1 behavior: no file persisted, storage_key
    # stays NULL, Reader falls back to extracted text for that document.
    original_tmp_path: Path | None = None,
    original_mime_type: str | None = None,
    original_file_size_bytes: int | None = None,
    document_file_storage: DocumentFileStorage | None = None,
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
            timer=timer,
            folder_id=folder_id,
            original_tmp_path=original_tmp_path,
            original_mime_type=original_mime_type,
            original_file_size_bytes=original_file_size_bytes,
            document_file_storage=document_file_storage,
        )
    except Exception as exc:
        logger.exception(
            "Ingestion job %s failed for document %r",
            job_id,
            metadata.source_filename,
        )
        jobs_repository.mark_failed(job_id, error_message=str(exc))
        timer.log_summary(note="failed")
        if timer.enabled:
            jobs_repository.set_timings(job_id, timings_json=json.dumps(timer.as_dict()))
    finally:
        # The temp file is only ever consumed by _run's own file_persist
        # step (moved into permanent storage, at which point it no longer
        # exists at this path) — if any stage failed before that move ran
        # (or the move itself never happened because no original file was
        # captured for this upload), this is the one guaranteed place left
        # to reclaim it. unlink(missing_ok=True) is a safe no-op once the
        # file has already been moved or was never created.
        if original_tmp_path is not None:
            original_tmp_path.unlink(missing_ok=True)
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
    timer: RequestTimer,
    folder_id: uuid.UUID | None = None,
    original_tmp_path: Path | None = None,
    original_mime_type: str | None = None,
    original_file_size_bytes: int | None = None,
    document_file_storage: DocumentFileStorage | None = None,
) -> None:
    total = len(chunks)
    logger.info(
        "Ingestion job %s: embedding %d chunk(s) for %r", job_id, total, metadata.source_filename
    )

    # How many chunks go into one embedding_provider.embed_batch() call —
    # see Settings.embedding_batch_size (env EMBEDDING_BATCH_SIZE, default
    # 32). This is also the progress-reporting granularity (one log line +
    # one jobs_repository.update_progress() per slice below), which is now
    # coarser than the old hardcoded 8 — an accepted tradeoff for matching
    # OllamaEmbeddingProvider's own internal batch ceiling exactly (see the
    # Settings field's docstring).
    batch_size = get_settings().embedding_batch_size

    embeddings: list[list[float]] = []
    embed_start = time.monotonic()
    with timer.stage("embedding"):
        for start in range(0, total, batch_size):
            slice_chunks = chunks[start : start + batch_size]
            slice_start = time.monotonic()
            embeddings.extend(
                embedding_provider.embed_batch([chunk.text for chunk in slice_chunks])
            )
            logger.info(
                "Ingestion job %s: embedded %d/%d chunks (+%.2fs, %.2fs elapsed)",
                job_id,
                len(embeddings),
                total,
                time.monotonic() - slice_start,
                time.monotonic() - embed_start,
            )
            jobs_repository.update_progress(
                job_id, stage="embedding", embedded_chunks=len(embeddings)
            )
    logger.info(
        "Ingestion job %s: embedding done in %.2fs", job_id, time.monotonic() - embed_start
    )

    jobs_repository.update_progress(job_id, stage="indexing", embedded_chunks=total)
    index_start = time.monotonic()
    with timer.stage("qdrant_upload"):
        vector_store.upsert_chunks(metadata, chunks, embeddings, user_id=str(user_id))
    logger.info(
        "Ingestion job %s: Qdrant upsert of %d chunk(s) done in %.2fs",
        job_id,
        total,
        time.monotonic() - index_start,
    )

    jobs_repository.update_progress(job_id, stage="persisting", embedded_chunks=total)
    persist_start = time.monotonic()
    # Frontend Milestone 3.1: the original file is moved into permanent
    # storage HERE — as late as possible, immediately before (and in the
    # same try/except as) the SQL `documents` row being created — rather
    # than earlier (e.g. before embedding). That keeps the window in which
    # a file could exist on disk with no corresponding DB row as small as
    # this codebase can make it: if either the move or documents_repository
    # .create() raises, the except below deletes whatever was already
    # moved and re-raises, so run_ingestion_job's outer handler still marks
    # the job failed exactly as before this milestone (no DB row this time
    # either, matching pre-3.1 behavior) and no orphaned file is left
    # behind. Embedding/Qdrant failing *before* this point never touches
    # storage at all — the temp file is reclaimed by run_ingestion_job's
    # finally block instead.
    storage_key: str | None = None
    try:
        if original_tmp_path is not None and document_file_storage is not None:
            with timer.stage("file_persist"):
                storage_key = document_file_storage.move_into_storage(
                    user_id=user_id,
                    document_id=metadata.document_id,
                    file_format=metadata.file_format,
                    tmp_path=original_tmp_path,
                )
        with timer.stage("database"):
            documents_repository.create(
                user_id=user_id,
                metadata=metadata,
                chunk_count=total,
                folder_id=folder_id,
                storage_key=storage_key,
                original_mime_type=original_mime_type,
                original_file_size_bytes=original_file_size_bytes,
            )
    except Exception:
        if storage_key is not None and document_file_storage is not None:
            document_file_storage.delete(storage_key)
        raise
    logger.info(
        "Ingestion job %s: metadata persisted in %.2fs", job_id, time.monotonic() - persist_start
    )

    jobs_repository.mark_completed(job_id, document_id=metadata.document_id)
    logger.info("Ingestion job %s: completed for document %s", job_id, metadata.document_id)
    timer.log_summary(note="completed")
    if timer.enabled:
        jobs_repository.set_timings(job_id, timings_json=json.dumps(timer.as_dict()))
