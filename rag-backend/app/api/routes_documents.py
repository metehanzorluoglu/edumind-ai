import tempfile
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, Form, HTTPException, UploadFile, status

from app.core.document_deletion import delete_document_by_id
from app.core.security import CurrentUserDep, get_current_user
from app.deps import (
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
    DocumentListResponse,
    DocumentMetadataPreviewResponse,
    DocumentSummary,
    DocumentUploadResponse,
)

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
    "/documents", response_model=DocumentUploadResponse, status_code=status.HTTP_201_CREATED
)
def post_document(
    user: CurrentUserDep,
    documents_repository: DocumentsRepositoryDep,
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
) -> DocumentUploadResponse:
    author_list = [name.strip() for name in authors.split(",") if name.strip()] if authors else None
    tmp_path = _read_upload_to_tempfile(file)

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
        metadata = result.metadata

        chunks = chunk_pages(result.pages)
        embeddings = embedding_provider.embed_batch([chunk.text for chunk in chunks])
        vector_store.upsert_chunks(metadata, chunks, embeddings, user_id=str(user.id))
        # Only mark the document as ingested once every stage has actually
        # succeeded — registering earlier would permanently block retries if
        # embedding or storage failed after extraction.
        documents_repository.create(user_id=user.id, metadata=metadata, chunk_count=len(chunks))
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

    return DocumentUploadResponse(
        document_id=metadata.document_id,
        source_filename=metadata.source_filename,
        file_format=metadata.file_format,
        document_type=metadata.document_type,
        journal_quartile=metadata.journal_quartile,
        title=metadata.title,
        authors=metadata.authors,
        publication_year=metadata.publication_year,
        source_venue=metadata.source_venue,
        doi=metadata.doi,
        source_url=metadata.source_url,
        page_count=metadata.page_count,
        chunk_count=len(chunks),
        ingested_at=metadata.ingested_at,
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
