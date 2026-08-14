import json
import logging
import tempfile
import time
import uuid
from pathlib import Path
from typing import Annotated

from fastapi import (
    APIRouter,
    BackgroundTasks,
    Depends,
    Form,
    HTTPException,
    Response,
    UploadFile,
    status,
)
from fastapi.responses import FileResponse

from app.core.document_deletion import delete_document_by_id
from app.core.document_ingestion_jobs import run_ingestion_job
from app.core.security import CurrentUserDep, get_current_user
from app.db.document_highlights_repository import DocumentHighlightRecord
from app.db.documents_repository import DocumentRecord
from app.deps import (
    DocumentFileStorageDep,
    DocumentHighlightsRepositoryDep,
    DocumentJobsRepositoryDep,
    DocumentsRepositoryDep,
    EmbeddingProviderDep,
    FoldersRepositoryDep,
    RequestTimerDep,
    ScopesRepositoryDep,
    SettingsDep,
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
    CreateDocumentHighlightRequest,
    DocumentContentChunk,
    DocumentContentResponse,
    DocumentDeleteResponse,
    DocumentHighlightListResponse,
    DocumentHighlightResponse,
    DocumentJobResponse,
    DocumentListResponse,
    DocumentMetadataPreviewResponse,
    DocumentSummary,
    DocumentUploadAcceptedResponse,
    DocumentUploadResponse,
    HighlightVisualAnchor,
    MoveDocumentRequest,
    UpdateDocumentHighlightRequest,
)
from app.services.document_file_storage import (
    DocumentFileStorage,
    DocumentFileStorageError,
    mime_type_for_format,
)

logger = logging.getLogger(__name__)

router = APIRouter(tags=["documents"], dependencies=[Depends(get_current_user)])


def _original_file_available(
    record: DocumentRecord, document_file_storage: DocumentFileStorage
) -> bool:
    """Frontend/Platform Milestone 3.2.1: the Reader's real "show Original"
    signal for every response that reports it. `record.original_file_
    available` (a property on DocumentRecord) only ever checks whether
    `storage_key` is set — true forever once set, even if the physical
    file was lost (e.g. stored on non-persistent storage — see this
    milestone's report). This wrapper adds the one check that actually
    matters: does the file exist RIGHT NOW. Every response-building call
    site in this router must call this, never read `record.
    original_file_available` directly, so a document whose file is
    genuinely gone reports `False` and the frontend never even attempts
    the broken Original path — it defaults straight to Text view."""
    return record.storage_key is not None and document_file_storage.exists(record.storage_key)


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
    response: Response,
    user: CurrentUserDep,
    settings: SettingsDep,
    documents_repository: DocumentsRepositoryDep,
    document_jobs_repository: DocumentJobsRepositoryDep,
    folders_repository: FoldersRepositoryDep,
    embedding_provider: EmbeddingProviderDep,
    vector_store: VectorStoreDep,
    request_timer: RequestTimerDep,
    document_file_storage: DocumentFileStorageDep,
    file: UploadFile,
    # Frontend/Platform Milestone 3.2.1 Part C: the normal upload UI no
    # longer collects this (no metadata questionnaire before upload — see
    # this milestone's report). Optional now, defaulting to "unknown"
    # (never fabricating a specific category — see DocumentType's
    # docstring) rather than staying a required Form field the client
    # must always supply something for.
    document_type: Annotated[DocumentType | None, Form()] = None,
    journal_quartile: Annotated[JournalQuartile, Form()] = None,
    title: Annotated[str | None, Form()] = None,
    authors: Annotated[str | None, Form(description="Comma-separated author names")] = None,
    publication_year: Annotated[int | None, Form()] = None,
    source_venue: Annotated[str | None, Form()] = None,
    doi: Annotated[str | None, Form()] = None,
    source_url: Annotated[str | None, Form()] = None,
    # Milestone 1 (Document Library / Folder Management): uploads directly
    # into the folder the user currently has open, so "upload while inside
    # Research / AI Education" doesn't require a separate move step
    # afterward. Resolved and ownership-checked here, synchronously, before
    # the slow background ingestion job (embedding) ever starts — a bad
    # folder_id fails fast with a 404 rather than after minutes of wasted
    # CPU work. Ignored (documents land at root, exactly as before this
    # milestone) when folder_library_enabled is False, so a stale client
    # can't smuggle folder placement past a disabled feature.
    folder_id: Annotated[str | None, Form()] = None,
) -> DocumentUploadAcceptedResponse:
    """Does the fast, synchronous part of ingestion only (duplicate check,
    parsing, chunking — measured under a second even for a 290-page PDF on
    this hardware) and returns as soon as that's done. Embedding + Qdrant
    indexing + the final `documents` row happen afterward in a background
    task (see app/core/document_ingestion_jobs.py) — embedding alone can
    take minutes on CPU-only hardware, and holding the HTTP request open for
    that is what caused the 30s client-side upload timeout this replaces.
    Poll GET /documents/jobs/{job_id} for progress and the eventual result.

    Timing instrumentation (see app/core/request_timing.py, no-op unless
    PERFORMANCE_PROFILING=true): `request_timer` covers file_save,
    pdf_parsing and chunking below, is reflected in this response's
    `Server-Timing` header and `timings` field, and is then handed to the
    background task as a plain object reference so it can keep recording
    embedding/qdrant_upload/database against the *same* timer once this
    function has already returned — total_ms() therefore measures true
    end-to-end "total upload" latency (file save through the background job
    finishing), not just this request/response cycle. See
    app/core/document_ingestion_jobs.py's module docstring for why that
    reference (not the ambient get_current_timer() this module's deeper
    dependencies use) is what makes that safe.
    """
    resolved_folder_id: uuid.UUID | None = None
    if folder_id and settings.folder_library_enabled:
        try:
            candidate = uuid.UUID(folder_id)
        except ValueError as exc:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Invalid folder_id"
            ) from exc
        if folders_repository.get(user.id, candidate) is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="Folder not found"
            )
        resolved_folder_id = candidate

    with request_timer.stage("file_save"):
        author_list = (
            [name.strip() for name in authors.split(",") if name.strip()] if authors else None
        )
        tmp_path = _read_upload_to_tempfile(file)

    parse_start = time.monotonic()
    try:
        with request_timer.stage("pdf_parsing"):
            result = ingest_document(
                tmp_path,
                document_type=document_type or "unknown",
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
        tmp_path.unlink(missing_ok=True)
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    except UnsupportedFileTypeError as exc:
        tmp_path.unlink(missing_ok=True)
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except DocumentExtractionError as exc:
        tmp_path.unlink(missing_ok=True)
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)
        ) from exc
    except Exception:
        tmp_path.unlink(missing_ok=True)
        raise

    # No OCR stage: this pipeline extracts text directly (PyMuPDF for PDFs —
    # see app/ingestion/loaders/pdf_loader.py — plus python-docx/BeautifulSoup
    # for the other formats app/ingestion/loaders/dispatch.py supports).
    # There is no image-to-text step anywhere in app/ingestion/, so a
    # scanned/image-only PDF yields empty page text today rather than being
    # OCR'd — confirmed by grepping the codebase for any OCR/tesseract
    # dependency (none exists), not assumed.

    metadata = result.metadata
    logger.info(
        "POST /documents: parsed %r in %.2fs (%d page(s))",
        metadata.source_filename,
        time.monotonic() - parse_start,
        metadata.page_count,
    )

    # Frontend Milestone 3.1 (Original Document Reader): tmp_path is
    # DELIBERATELY kept alive past this point (not unlinked above) once
    # parsing succeeds — it is handed to the background job below, which
    # moves it into permanent, per-user storage only once the document's
    # SQL row is about to be created (see app/core/document_ingestion_jobs.py
    # for the atomic-as-possible move+create+cleanup-on-failure sequence).
    # Everything from here to background_tasks.add_task() below must clean
    # up tmp_path on any failure, since ownership of deleting it has not yet
    # transferred to the background job.
    try:
        original_mime_type = mime_type_for_format(metadata.file_format)
        original_file_size_bytes = tmp_path.stat().st_size

        chunk_start = time.monotonic()
        with request_timer.stage("chunking"):
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
            timer=request_timer,
            folder_id=resolved_folder_id,
            original_tmp_path=tmp_path,
            original_mime_type=original_mime_type,
            original_file_size_bytes=original_file_size_bytes,
            document_file_storage=document_file_storage,
        )
    except Exception:
        tmp_path.unlink(missing_ok=True)
        raise

    request_timer.log_summary(note="sync phase (file_save/pdf_parsing/chunking) — "
                               "embedding/qdrant_upload/database continue in the background job")
    if request_timer.enabled:
        response.headers["Server-Timing"] = request_timer.server_timing_header()

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
        timings=request_timer.as_dict() or None,
    )


@router.get("/documents/jobs/{job_id}", response_model=DocumentJobResponse)
def get_document_job(
    job_id: str,
    user: CurrentUserDep,
    document_jobs_repository: DocumentJobsRepositoryDep,
    documents_repository: DocumentsRepositoryDep,
    document_file_storage: DocumentFileStorageDep,
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
                folder_id=str(record.folder_id) if record.folder_id else None,
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
                original_file_available=_original_file_available(record, document_file_storage),
            )

    return DocumentJobResponse(
        job_id=job.job_id,
        status=job.status,  # type: ignore[arg-type]
        stage=job.stage,  # type: ignore[arg-type]
        total_chunks=job.total_chunks,
        embedded_chunks=job.embedded_chunks,
        document=document_response,
        error=job.error_message,
        # Populated once the background job finishes (completed or failed)
        # if PERFORMANCE_PROFILING was on for the original upload — see
        # app/db/document_jobs_repository.py's timings_json column. None
        # while still processing, or if profiling was off.
        timings=json.loads(job.timings_json) if job.timings_json is not None else None,
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
    document_file_storage: DocumentFileStorageDep,
    limit: int = 20,
    offset: int = 0,
    # Frontend/Platform Milestone 3.2.1 Part D — optional LIBRARY search
    # (title/filename substring, across every folder), never semantic
    # corpus retrieval — see DocumentsRepository.search_for_user's
    # docstring for the distinction from GET /search. Omitted/blank
    # behaves exactly as before this milestone.
    q: str | None = None,
) -> DocumentListResponse:
    records, total = (
        documents_repository.search_for_user(user.id, q, limit=limit, offset=offset)
        if q and q.strip()
        else documents_repository.list_for_user(user.id, limit=limit, offset=offset)
    )
    return DocumentListResponse(
        documents=[
            DocumentSummary(
                document_id=record.document_id,
                source_filename=record.source_filename,
                folder_id=str(record.folder_id) if record.folder_id else None,
                folder_name=record.folder_name,
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
                original_file_available=_original_file_available(record, document_file_storage),
            )
            for record in records
        ],
        total=total,
    )


@router.patch("/documents/{document_id}", response_model=DocumentSummary)
def move_document_route(
    document_id: str,
    request: MoveDocumentRequest,
    user: CurrentUserDep,
    settings: SettingsDep,
    documents_repository: DocumentsRepositoryDep,
    folders_repository: FoldersRepositoryDep,
    document_file_storage: DocumentFileStorageDep,
) -> DocumentSummary:
    """Milestone 1 (Document Library / Folder Management): moves a document
    into a different folder, or to root (`folder_id: null`) — a single SQL
    column update (see DocumentsRepository.move_to_folder), never a
    re-parse/re-embed/Qdrant write. 404s while folder_library_enabled is
    False (see routes_folders.py's module docstring for why this endpoint,
    living on the always-mounted documents router, needs its own explicit
    gate rather than relying on a router simply not being included)."""
    if not settings.folder_library_enabled:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Folder library is disabled")

    target_folder_id: uuid.UUID | None = None
    if request.folder_id:
        try:
            target_folder_id = uuid.UUID(request.folder_id)
        except ValueError as exc:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Invalid folder_id"
            ) from exc
        if folders_repository.get(user.id, target_folder_id) is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Folder not found")

    record = documents_repository.move_to_folder(user.id, document_id, target_folder_id)
    if record is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Document not found")
    return DocumentSummary(
        document_id=record.document_id,
        source_filename=record.source_filename,
        folder_id=str(record.folder_id) if record.folder_id else None,
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
        original_file_available=_original_file_available(record, document_file_storage),
    )


@router.delete("/documents/{document_id}", response_model=DocumentDeleteResponse)
def delete_document_route(
    document_id: str,
    user: CurrentUserDep,
    documents_repository: DocumentsRepositoryDep,
    vector_store: VectorStoreDep,
    scopes_repository: ScopesRepositoryDep,
    document_highlights_repository: DocumentHighlightsRepositoryDep,
    document_file_storage: DocumentFileStorageDep,
) -> DocumentDeleteResponse:
    """Deletes a document and every chunk belonging to it, identified by its
    stable document_id (never by filename — see delete_document_by_id), and
    only if it belongs to the authenticated caller. Shared with
    `python -m cli.documents remove`. Also deletes the document's original
    stored file, if any (Frontend Milestone 3.1) — never its Notebook
    entries, which survive by design (see delete_document_by_id's
    docstring)."""
    result = delete_document_by_id(
        document_id,
        user_id=user.id,
        vector_store=vector_store,
        documents_repository=documents_repository,
        scopes_repository=scopes_repository,
        document_highlights_repository=document_highlights_repository,
        document_file_storage=document_file_storage,
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


# --- Frontend Milestone 3: Document Reader, Highlights & Ask-About-Selection ---


@router.get("/documents/{document_id}/file")
def get_document_file(
    document_id: str,
    user: CurrentUserDep,
    documents_repository: DocumentsRepositoryDep,
    document_file_storage: DocumentFileStorageDep,
) -> FileResponse:
    """Frontend Milestone 3.1 (Original Document Reader): streams the
    original uploaded file (real PDF bytes for a PDF — never a
    server-side screenshot, never OCR output) so the browser's PDF.js
    reader can render actual pages.

    Ownership-checked exactly like every other per-document endpoint —
    `documents_repository.get` returns None for a document that doesn't
    exist *or* belongs to a different user, both mapped to the same 404
    (never a 403 that would confirm the ID belongs to someone else, never
    a bare static-file mount that would make this URL guessable/public —
    this route requires the same auth dependency as the rest of this
    router). Also 404s (rather than 500ing) for a legacy document with no
    stored original — see Document.storage_key's docstring — so the
    frontend's fallback-to-extracted-text logic has a clean, unambiguous
    signal to act on; DocumentSummary/DocumentUploadResponse already tell
    the frontend `original_file_available` up front so this is normally
    only ever called when it's true.

    Content-Type is the server-determined MIME for the document's
    file_format (never a client-supplied value); Content-Disposition is
    `inline` (a PDF should render on the page, not force a download) with
    the real source filename for a save-as. Range requests (needed by
    PDF.js's incremental loading for large PDFs) are handled natively by
    Starlette's FileResponse.
    """
    record = documents_repository.get(user.id, document_id)
    if record is None or record.storage_key is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"No original file available for document_id '{document_id}'",
        )
    try:
        path = document_file_storage.read_path(record.storage_key)
    except DocumentFileStorageError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"No original file available for document_id '{document_id}'",
        ) from exc
    return FileResponse(
        path,
        media_type=record.original_mime_type or mime_type_for_format(record.file_format),
        filename=record.source_filename,
        content_disposition_type="inline",
    )


@router.get("/documents/{document_id}/content", response_model=DocumentContentResponse)
def get_document_content(
    document_id: str,
    user: CurrentUserDep,
    documents_repository: DocumentsRepositoryDep,
    vector_store: VectorStoreDep,
    document_file_storage: DocumentFileStorageDep,
) -> DocumentContentResponse:
    """The reader's extracted-text/citation read. Ownership is checked
    first against the SQL `documents` table (cheap, authoritative, no
    Qdrant round trip for a document that isn't the caller's) — only once
    that passes does this read the document's chunks back out of Qdrant
    for display. This is always EXTRACTED TEXT, used for RAG/citations/
    search and — as of Frontend Milestone 3.1 — for the legacy fallback
    reader and for best-effort PDF-selection-to-chunk mapping (see
    GET /documents/{id}/file for the original file itself, when
    `original_file_available` is true; a document from before that
    milestone has no original file, and this endpoint's chunks remain its
    ONLY renderable content — see Document.storage_key's docstring). Never
    queried directly by the frontend — Qdrant is not a frontend-reachable
    service in this system."""
    record = documents_repository.get(user.id, document_id)
    if record is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"No document found with document_id '{document_id}'",
        )
    chunks = vector_store.get_document_chunks(document_id, user_id=str(user.id))
    return DocumentContentResponse(
        document_id=record.document_id,
        title=record.title,
        source_filename=record.source_filename,
        file_format=record.file_format,
        page_count=record.page_count,
        chunks=[
            DocumentContentChunk(
                chunk_id=chunk.chunk_id,
                chunk_index=chunk.chunk_index,
                page_number=chunk.page_number,
                text=chunk.text,
            )
            for chunk in chunks
        ],
        original_file_available=_original_file_available(record, document_file_storage),
    )


def _highlight_response(record: DocumentHighlightRecord) -> DocumentHighlightResponse:
    return DocumentHighlightResponse(
        id=str(record.id),
        document_id=record.document_id,
        chunk_id=record.chunk_id,
        chunk_index=record.chunk_index,
        page_number=record.page_number,
        selected_text=record.selected_text,
        note_text=record.note_text,
        visual_anchor=(
            HighlightVisualAnchor.model_validate_json(record.visual_anchor_json)
            if record.visual_anchor_json is not None
            else None
        ),
        created_at=record.created_at,
        updated_at=record.updated_at,
    )


@router.get(
    "/documents/{document_id}/highlights", response_model=DocumentHighlightListResponse
)
def list_document_highlights(
    document_id: str,
    user: CurrentUserDep,
    documents_repository: DocumentsRepositoryDep,
    document_highlights_repository: DocumentHighlightsRepositoryDep,
) -> DocumentHighlightListResponse:
    if documents_repository.get(user.id, document_id) is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"No document found with document_id '{document_id}'",
        )
    records = document_highlights_repository.list_for_document(user.id, document_id)
    return DocumentHighlightListResponse(highlights=[_highlight_response(r) for r in records])


@router.post(
    "/documents/{document_id}/highlights",
    response_model=DocumentHighlightResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_document_highlight(
    document_id: str,
    request: CreateDocumentHighlightRequest,
    user: CurrentUserDep,
    documents_repository: DocumentsRepositoryDep,
    vector_store: VectorStoreDep,
    document_highlights_repository: DocumentHighlightsRepositoryDep,
) -> DocumentHighlightResponse:
    """The SEMANTIC anchor (`chunk_id`/`chunk_index`/`page_number`), when
    provided, is validated against the document's REAL current chunks —
    never trusted as an opaque client-supplied value, so a highlight can
    never be created pointing at a chunk that doesn't actually belong to
    this document (or a document the caller doesn't own). Frontend
    Milestone 3.1: `chunk_id`/`chunk_index` may instead be omitted for a
    highlight made directly on the original PDF's text layer whose
    selection could not be best-effort matched to any existing chunk —
    that highlight is still created (visual-only, `visual_anchor`
    required in that case — enforced by the request schema itself), never
    rejected or given a fabricated chunk match. `page_number` is always
    sanity-checked against the document's own page_count either way."""
    record_doc = documents_repository.get(user.id, document_id)
    if record_doc is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"No document found with document_id '{document_id}'",
        )
    if request.page_number > record_doc.page_count:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="page_number exceeds this document's page_count",
        )
    if request.chunk_id is not None:
        chunks = vector_store.get_document_chunks(document_id, user_id=str(user.id))
        matching_chunk = next((c for c in chunks if c.chunk_id == request.chunk_id), None)
        if (
            matching_chunk is None
            or matching_chunk.chunk_index != request.chunk_index
            or matching_chunk.page_number != request.page_number
        ):
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail=(
                    "chunk_id/chunk_index/page_number do not match a real chunk of this document"
                ),
            )
    record = document_highlights_repository.create(
        user_id=user.id,
        document_id=document_id,
        chunk_id=request.chunk_id,
        chunk_index=request.chunk_index,
        page_number=request.page_number,
        selected_text=request.selected_text,
        note_text=request.note_text,
        visual_anchor_json=(
            request.visual_anchor.model_dump_json() if request.visual_anchor is not None else None
        ),
    )
    return _highlight_response(record)


@router.patch(
    "/documents/{document_id}/highlights/{highlight_id}",
    response_model=DocumentHighlightResponse,
)
def update_document_highlight(
    document_id: str,
    highlight_id: uuid.UUID,
    request: UpdateDocumentHighlightRequest,
    user: CurrentUserDep,
    document_highlights_repository: DocumentHighlightsRepositoryDep,
) -> DocumentHighlightResponse:
    record = document_highlights_repository.update_note(
        user.id, document_id, highlight_id, note_text=request.note_text
    )
    if record is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Highlight not found"
        )
    return _highlight_response(record)


@router.delete(
    "/documents/{document_id}/highlights/{highlight_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def delete_document_highlight(
    document_id: str,
    highlight_id: uuid.UUID,
    user: CurrentUserDep,
    document_highlights_repository: DocumentHighlightsRepositoryDep,
) -> None:
    deleted = document_highlights_repository.delete(user.id, document_id, highlight_id)
    if not deleted:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Highlight not found"
        )
