from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

from app.ingestion.loaders.base import ExtractionSource
from app.ingestion.metadata_schema import DocumentType, JournalQuartile

DocumentJobStatus = Literal["processing", "completed", "failed"]
DocumentJobStage = Literal["embedding", "indexing", "persisting"]


class DocumentUploadResponse(BaseModel):
    document_id: str
    source_filename: str
    file_format: str
    document_type: DocumentType
    journal_quartile: JournalQuartile = None
    title: str | None = None
    authors: list[str] = Field(default_factory=list)
    publication_year: int | None = None
    source_venue: str | None = None
    doi: str | None = None
    source_url: str | None = None
    page_count: int
    chunk_count: int
    ingested_at: datetime


class DocumentUploadAcceptedResponse(BaseModel):
    """POST /documents' response: returned as soon as the fast, synchronous
    part (duplicate check, parsing, chunking — sub-second even for large
    files) is done. Embedding + Qdrant indexing + the final `documents` row
    happen afterward in a background job — poll GET /documents/jobs/{job_id}
    (see DocumentJobResponse) for progress and the eventual result."""

    job_id: str
    status: DocumentJobStatus
    source_filename: str
    document_type: DocumentType
    journal_quartile: JournalQuartile = None
    title: str | None = None
    authors: list[str] = Field(default_factory=list)
    publication_year: int | None = None
    source_venue: str | None = None
    doi: str | None = None
    source_url: str | None = None
    page_count: int
    total_chunks: int


class DocumentJobResponse(BaseModel):
    """GET /documents/jobs/{job_id} — polled by the client until `status` is
    "completed" (`document` is then populated) or "failed" (`error` is then
    populated)."""

    job_id: str
    status: DocumentJobStatus
    stage: DocumentJobStage
    total_chunks: int
    embedded_chunks: int
    document: DocumentUploadResponse | None = None
    error: str | None = None


class DocumentSummary(BaseModel):
    document_id: str
    source_filename: str
    document_type: DocumentType
    journal_quartile: JournalQuartile = None
    title: str | None = None
    authors: list[str] = Field(default_factory=list)
    publication_year: int | None = None
    source_venue: str | None = None
    doi: str | None = None
    source_url: str | None = None
    chunk_count: int
    ingested_at: datetime


class DocumentListResponse(BaseModel):
    documents: list[DocumentSummary]
    total: int


class DocumentDeleteResponse(BaseModel):
    deleted: bool
    document_id: str
    deleted_chunks: int


class DocumentMetadataPreviewResponse(BaseModel):
    """POST /documents/metadata-preview — extraction only, no chunking,
    embedding, or Qdrant/SQL writes (see routes_documents.py), so a user
    can review/edit detected fields before anything is actually indexed,
    without ever risking a document being embedded twice.

    `extraction_sources`/`extraction_confidence` are keyed by field name
    (e.g. "title", "authors") and only ever include fields that actually
    got a non-empty value — they exist purely to inform the review UI,
    and are never persisted anywhere past this response.
    """

    title: str | None = None
    authors: list[str] = Field(default_factory=list)
    publication_year: int | None = None
    source_venue: str | None = None
    doi: str | None = None
    source_url: str | None = None
    page_count: int
    file_format: str
    extraction_sources: dict[str, ExtractionSource] = Field(default_factory=dict)
    extraction_confidence: dict[str, str] = Field(default_factory=dict)
