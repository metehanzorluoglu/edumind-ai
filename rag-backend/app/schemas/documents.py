from datetime import datetime

from pydantic import BaseModel, Field

from app.ingestion.loaders.base import ExtractionSource
from app.ingestion.metadata_schema import DocumentType, JournalQuartile


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
