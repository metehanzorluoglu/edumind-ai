import logging
import tempfile
import time
import uuid
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, BackgroundTasks, Depends, Form, HTTPException, UploadFile, status

from app.core.document_deletion import delete_document_by_id
from app.core.document_ingestion_jobs import run_ingestion_job
from app.core.security import CurrentUserDep, get_current_user
from app.deps import (
    DocumentJobsRepositoryDep,
    DocumentsRepositoryDep,
    EmbeddingProviderDep,
    ScopesRepositoryDep,
    VectorStoreDep,
)
from app.ingestion.chunker import chunk_pages
from app.ingestion.errors import (
    DocumentExtractionError,
    DuplicateDocumentError,
    UnsupportedFileTypeError,
)
from app.ingestion.ingest import ingest_document
from app.ingestion.loaders.dispatch import load_document
from app.ingestion.metadata_extraction import apply_filename_fallback, confidence_for_source
from app.ingestion.metadata_schema import DocumentType, JournalQuartile
from app.schemas.documents import (
    DocumentDeleteResponse,
    DocumentJobResponse,
    DocumentListResponse,
    DocumentMetadataPreviewResponse,
    DocumentSummary,
    DocumentUploadAcceptedResponse,
    DocumentUploadResponse,
)

logger = logging.getLogger(__name__)

router = APIRouter(tags=["documents"], dependencies=[Depends(get_current_user)])


def _read_upload_to_tempfile(file: UploadFile) -> Path:
    if not file.filename:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Uploaded file has no filename"
        )
    suffix = Path(file.filename).suffix
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp_file:
        tmp_file.write(file.file.read())
        return Path(tmp_file.name)


@router.post(
    "/documents",
    response_model=DocumentUploadAcceptedResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
def post_document(
    background_tasks: BackgroundTasks,
    user: CurrentUserDep,
    documents_repository: DocumentsRepositoryDep,
    document_jobs_repository: DocumentJobsRepositoryDep,
    embedding_provider: EmbeddingProviderDep,
    vector_store: VectorStoreDep,
    file: UploadFile,
    document_type: Annotated[DocumentType, Form()],
    journal_quartile: Annotated[JournalQuartile, Form()] = None,
    title: Annotated[str | None, Form()] = None,
    authors: Annotated[str | None, Form(description="Comma-separated author names")] = None,
    publication_year: Annotated[int | None, Form()] = None,
    source_venue: Annotated[str | None, Form()] = None,
    doi: Annotated[str | None, Form()] = None,
    source_url: Annotated[str | None, Form()] = None,
) -> DocumentUploadAcceptedResponse:
    """Does the fast, synchronous part of ingestion only (duplicate check,
    parsing, chunking — measured under a second even for a 290-page PDF on
    this hardware) and returns as soon as that's done. Embedding + Qdrant
    indexing + the final `documents` row happen afterward in a background
    task (see app/core/document_ingestion_jobs.py) — embedding alone can
    take minutes on CPU-only hardware, and holding the HTTP request open for
    that is what caused the 30s client-side upload timeout this replaces.
    Poll GET /documents/jobs/{job_id} for progress and the eventual result.
    """
    author_list = [name.strip() for name in authors.split(",") if name.strip()] if authors else None
    tmp_path = _read_upload_to_tempfile(file)

    parse_start = time.monotonic()
    try:
        result = ingest_document(
            tmp_path,
            document_type=document_type,
            duplicate_checker=documents_repository,
            user_id=user.id,
            journal_quartile=journal_quartile,
            title=title,
            authors=author_list,
            publication_year=publication_year,
            source_venue=source_venue,
            doi=doi,
            source_url=source_url,
            original_filename=file.filename,
        )
    except DuplicateDocumentError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    except UnsupportedFileTypeError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except DocumentExtractionError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)
        ) from exc
    finally:
        tmp_path.unlink(missing_ok=True)

    metadata = result.metadata
    logger.info(
        "POST /documents: parsed %r in %.2fs (%d page(s))",
        metadata.source_filename,
        time.monotonic() - parse_start,
        metadata.page_count,
    )

    chunk_start = time.monotonic()
    chunks = chunk_pages(result.pages)
    logger.info(
        "POST /documents: chunked %r into %d chunk(s) in %.3fs",
        metadata.source_filename,
        len(chunks),
        time.monotonic() - chunk_start,
    )

    job_id = str(uuid.uuid4())
    document_jobs_repository.create(
        job_id=job_id,
        user_id=user.id,
        source_filename=metadata.source_filename,
        total_chunks=len(chunks),
    )
    background_tasks.add_task(
        run_ingestion_job,
        job_id=job_id,
        user_id=user.id,
        metadata=metadata,
        chunks=chunks,
        embedding_provider=embedding_provider,
        vector_store=vector_store,
    )

    return DocumentUploadAcceptedResponse(
        job_id=job_id,
        status="processing",
        source_filename=metadata.source_filename,
        document_type=metadata.document_type,
        journal_quartile=metadata.journal_quartile,
        title=metadata.title,
        authors=metadata.authors,
        publication_year=metadata.publication_year,
        source_venue=metadata.source_venue,
        doi=metadata.doi,
        source_url=metadata.source_url,
        page_count=metadata.page_count,
        total_chunks=len(chunks),
    )


@router.get("/documents/jobs/{job_id}", response_model=DocumentJobResponse)
def get_document_job(
    job_id: str,
    user: CurrentUserDep,
    document_jobs_repository: DocumentJobsRepositoryDep,
    documents_repository: DocumentsRepositoryDep,
) -> DocumentJobResponse:
    """Polled by the client after POST /documents returns, until `status` is
    "completed" (`document` is then populated) or "failed" (`error` is then
    populated). Ownership-scoped like every other document endpoint — a job
    that doesn't exist *or* belongs to a different user is indistinguishable
    (see DocumentJobsRepository.get())."""
    job = document_jobs_repository.get(user.id, job_id)
    if job is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"No ingestion job found with job_id '{job_id}'",
        )

    document_response: DocumentUploadResponse | None = None
    if job.status == "completed" and job.document_id is not None:
        record = documents_repository.get(user.id, job.document_id)
        if record is not None:
            document_response = DocumentUploadResponse(
                document_id=record.document_id,
                source_filename=record.source_filename,
                file_format=record.file_format,
                document_type=record.document_type,  # type: ignore[arg-type]
                journal_quartile=record.journal_quartile,  # type: ignore[arg-type]
                title=record.title,
                authors=record.authors,
                publication_year=record.publication_year,
                source_venue=record.source_venue,
                doi=record.doi,
                source_url=record.source_url,
                page_count=record.page_count,
                chunk_count=record.chunk_count,
                ingested_at=record.ingested_at,
            )

    return DocumentJobResponse(
        job_id=job.job_id,
        status=job.status,  # type: ignore[arg-type]
        stage=job.stage,  # type: ignore[arg-type]
        total_chunks=job.total_chunks,
        embedded_chunks=job.embedded_chunks,
        document=document_response,
        error=job.error_message,
    )


@router.post("/documents/metadata-preview", response_model=DocumentMetadataPreviewResponse)
def post_metadata_preview(
    user: CurrentUserDep, file: UploadFile
) -> DocumentMetadataPreviewResponse:
    """Extraction only — deliberately does not chunk, embed, or write
    anything to Qdrant/SQL, so calling this (e.g. once per file the user
    picks, before they've even pressed "Upload") can never result in a
    document being embedded/indexed twice. Requires only authentication,
    not an ownership check: there is no existing document_id to own yet —
    this previews a file that hasn't been uploaded, for whichever user is
    currently authenticated (see the module-level `dependencies=` this
    router already carries).
    """
    tmp_path = _read_upload_to_tempfile(file)
    try:
        loaded = load_document(tmp_path)
    except UnsupportedFileTypeError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except DocumentExtractionError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)
        ) from exc
    finally:
        tmp_path.unlink(missing_ok=True)

    assert user
    metadata = apply_filename_fallback(loaded.metadata, filename=file.filename or "")

    return DocumentMetadataPreviewResponse(
        title=metadata.title,
        authors=metadata.authors,
        publication_year=metadata.publication_year,
        source_venue=metadata.source_venue,
        doi=metadata.doi,
        source_url=metadata.source_url,
        page_count=len(loaded.pages),
        file_format=loaded.file_format,
        extraction_sources=metadata.sources,
        extraction_confidence={
            field: confidence_for_source(source) for field, source in metadata.sources.items()
        },
    )


@router.get("/documents", response_model=DocumentListResponse)
def get_documents(
    user: CurrentUserDep,
    documents_repository: DocumentsRepositoryDep,
    limit: int = 20,
    offset: int = 0,
) -> DocumentListResponse:
    records, total = documents_repository.list_for_user(user.id, limit=limit, offset=offset)
    return DocumentListResponse(
        documents=[
            DocumentSummary(
                document_id=record.document_id,
                source_filename=record.source_filename,
                document_type=record.document_type,  # type: ignore[arg-type]
                journal_quartile=record.journal_quartile,  # type: ignore[arg-type]
                title=record.title,
                authors=record.authors,
                publication_year=record.publication_year,
                source_venue=record.source_venue,
                doi=record.doi,
                source_url=record.source_url,
                chunk_count=record.chunk_count,
                ingested_at=record.ingested_at,
            )
            for record in records
        ],
        total=total,
    )


@router.delete("/documents/{document_id}", response_model=DocumentDeleteResponse)
def delete_document_route(
    document_id: str,
    user: CurrentUserDep,
    documents_repository: DocumentsRepositoryDep,
    vector_store: VectorStoreDep,
    scopes_repository: ScopesRepositoryDep,
) -> DocumentDeleteResponse:
    """Deletes a document and every chunk belonging to it, identified by its
    stable document_id (never by filename — see delete_document_by_id), and
    only if it belongs to the authenticated caller. Shared with
    `python -m cli.documents remove`."""
    result = delete_document_by_id(
        document_id,
        user_id=user.id,
        vector_store=vector_store,
        documents_repository=documents_repository,
        scopes_repository=scopes_repository,
    )
    if result is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"No document found with document_id '{document_id}'",
        )
    return DocumentDeleteResponse(
        deleted=True,
        document_id=result.document_id,
        deleted_chunks=result.deleted_chunks,
    )
