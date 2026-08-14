from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, model_validator

from app.ingestion.loaders.base import ExtractionSource
from app.ingestion.metadata_schema import DocumentType, JournalQuartile

DocumentJobStatus = Literal["processing", "completed", "failed"]
DocumentJobStage = Literal["embedding", "indexing", "persisting"]


class DocumentUploadResponse(BaseModel):
    document_id: str
    source_filename: str
    file_format: str
    # Milestone 1 (Document Library / Folder Management): None = root/
    # unfiled. See app/db/models_documents.py's `folder_id` docstring.
    folder_id: str | None = None
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
    # Frontend Milestone 3.1 (Original Document Reader): the ONE signal the
    # frontend uses to decide "render the real original file" vs "fall back
    # to the extracted-text reader" — see Document.storage_key's docstring.
    # False for every document ingested before this milestone.
    original_file_available: bool = False


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
    # Optional JSON debug output (see app/core/request_timing.py): the
    # synchronous phase's stages only (file_save, pdf_parsing, chunking) —
    # embedding/qdrant_upload/database happen later in the background job,
    # see DocumentJobResponse.timings below. Null unless
    # PERFORMANCE_PROFILING=true.
    timings: dict[str, float] | None = None


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
    # Optional JSON debug output: the full pipeline breakdown (file_save
    # through database, plus total_ms covering the whole upload from
    # POST /documents to this job completing) — populated once the job
    # reaches "completed" or "failed", only when the original upload ran
    # with PERFORMANCE_PROFILING=true (see
    # app/core/document_ingestion_jobs.py's in-process _JOB_TIMINGS).
    timings: dict[str, float] | None = None


class DocumentSummary(BaseModel):
    document_id: str
    source_filename: str
    folder_id: str | None = None
    # Frontend/Platform Milestone 3.2.1 Part D — populated only by GET
    # /documents?q=... (library search results, across every folder);
    # None for the ordinary unfiltered list. See DocumentsRepository.
    # search_for_user's docstring for why this is a server-side JOIN
    # rather than a second per-result frontend request.
    folder_name: str | None = None
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
    original_file_available: bool = False


class DocumentListResponse(BaseModel):
    documents: list[DocumentSummary]
    total: int


class DocumentDeleteResponse(BaseModel):
    deleted: bool
    document_id: str
    deleted_chunks: int


class MoveDocumentRequest(BaseModel):
    """PATCH /documents/{id} — moves a document into a different folder
    (or to root, when `folder_id` is null). Purely organizational: never
    touches chunks, embeddings, or Qdrant (see
    DocumentsRepository.move_to_folder)."""

    folder_id: str | None = None


class DocumentContentChunk(BaseModel):
    """Frontend Milestone 3 (Document Reader): one chunk of a document's
    extracted text, in reading order. `chunk_id` is the same deterministic
    id citations already carry (MessageSourceResponse.chunk_id) — the
    anchor a highlight or a "go to source" link keys off."""

    chunk_id: str
    chunk_index: int
    page_number: int
    text: str


class DocumentContentResponse(BaseModel):
    """GET /documents/{id}/content — Frontend Milestone 3 (Document
    Reader). This is EXTRACTED TEXT, not the original file: no original
    upload is retained anywhere in this system (see
    app/core/document_ingestion.py's docstring / cli/documents.py's
    reingest command, both explicit about this), so the reader renders the
    same chunk text retrieval already uses — grouped by page_number on the
    frontend — rather than a PDF/DOCX page image. `chunks` is ordered by
    chunk_index (reading order); a page may span more than one chunk for
    unusually long pages (see app/ingestion/chunker.py's per-page
    chunk_size), so the frontend groups consecutive chunks sharing a
    page_number into one page section rather than assuming one chunk per
    page."""

    document_id: str
    title: str | None = None
    source_filename: str
    file_format: str
    page_count: int
    chunks: list[DocumentContentChunk]
    # Frontend Milestone 3.1: also surfaced here (not only on
    # DocumentSummary/DocumentUploadResponse) so a Reader screen that loads
    # content directly still gets the fallback signal without a second
    # round trip.
    original_file_available: bool = False


class HighlightVisualAnchor(BaseModel):
    """Frontend Milestone 3.1: the VISUAL half of a highlight's dual anchor
    — one rectangle per visual line-fragment of the original PDF text
    selection, in PDF user-space points (PDF.js's
    viewport.convertToPdfPoint output), NOT CSS pixels — so the frontend
    can redraw the exact same highlight correctly at any zoom level via
    viewport.convertToViewportPoint. Each rect is `[x0, y0, x1, y1]`.
    Opaque to the backend: stored as-is, never interpreted or validated
    beyond shape, and only ever produced/consumed by the PDF reader."""

    rects: list[list[float]] = Field(min_length=1)

    @model_validator(mode="after")
    def _rects_are_quads(self) -> "HighlightVisualAnchor":
        for rect in self.rects:
            if len(rect) != 4:
                raise ValueError(
                    "each visual_anchor rect must have exactly 4 numbers [x0,y0,x1,y1]"
                )
        return self


class DocumentHighlightResponse(BaseModel):
    """One saved highlight (optionally with a note) — see
    app/db/models_documents.py's DocumentHighlight docstring for the dual
    anchor design. `chunk_id`/`chunk_index` (the SEMANTIC anchor) are null
    for a PDF highlight whose selection could not be mapped to any real
    chunk — "semantic anchor unavailable," never a fabricated match.
    `visual_anchor` (the VISUAL anchor) is null for a highlight made in the
    extracted-text reader, which has no PDF geometry."""

    id: str
    document_id: str
    chunk_id: str | None = None
    chunk_index: int | None = None
    page_number: int
    selected_text: str
    note_text: str | None = None
    visual_anchor: HighlightVisualAnchor | None = None
    created_at: datetime
    updated_at: datetime


class DocumentHighlightListResponse(BaseModel):
    highlights: list[DocumentHighlightResponse]


_MAX_SELECTED_TEXT_CHARS = 4000
_MAX_NOTE_TEXT_CHARS = 4000


class CreateDocumentHighlightRequest(BaseModel):
    """POST /documents/{id}/highlights. When `chunk_id`/`chunk_index` ARE
    given, they must describe a chunk that genuinely belongs to this
    document — validated against the document's own real content (see
    routes_documents.py's create_document_highlight), never trusted as
    opaque client-supplied values. Frontend Milestone 3.1: both are now
    OPTIONAL (must be given together, or omitted together) — a highlight
    made directly on the original PDF's text layer may have no
    best-effort match against any existing chunk, and is still saved as a
    visual-only highlight rather than rejected (see
    HighlightVisualAnchor's docstring for the visual half of the anchor,
    which is required whenever chunk_id is omitted — a highlight needs at
    least one real anchor). `selected_text` is capped generously (not the
    whole document) — a highlight is a passage, not a bulk copy-paste of
    everything."""

    chunk_id: str | None = Field(default=None, min_length=1)
    chunk_index: int | None = Field(default=None, ge=0)
    page_number: int = Field(ge=1)
    selected_text: str = Field(min_length=1, max_length=_MAX_SELECTED_TEXT_CHARS)
    note_text: str | None = Field(default=None, max_length=_MAX_NOTE_TEXT_CHARS)
    visual_anchor: HighlightVisualAnchor | None = None

    @model_validator(mode="after")
    def _chunk_anchor_all_or_nothing(self) -> "CreateDocumentHighlightRequest":
        if (self.chunk_id is None) != (self.chunk_index is None):
            raise ValueError("chunk_id and chunk_index must both be provided or both omitted")
        if self.chunk_id is None and self.visual_anchor is None:
            raise ValueError(
                "a highlight needs at least one anchor: chunk_id/chunk_index (semantic) "
                "or visual_anchor (visual)"
            )
        return self


class UpdateDocumentHighlightRequest(BaseModel):
    """PATCH /documents/{id}/highlights/{highlight_id} — the note is the
    only mutable field; the anchor and selected-text snapshot never
    change after creation (that would silently move the highlight)."""

    note_text: str | None = Field(default=None, max_length=_MAX_NOTE_TEXT_CHARS)


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
