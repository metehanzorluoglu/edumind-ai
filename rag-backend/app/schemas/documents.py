from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator

from app.ingestion.loaders.base import ExtractionSource
from app.ingestion.metadata_extraction import normalize_doi
from app.ingestion.metadata_schema import DocumentType, JournalQuartile

DocumentJobStatus = Literal["processing", "completed", "failed"]
DocumentJobStage = Literal["embedding", "indexing", "persisting"]


class BibliographicMetadataFields(BaseModel):
    """Milestone 4 (Reference Library & Bibliographic Metadata Foundation):
    every canonical bibliographic field, shared across every response shape
    that describes a document (DocumentUploadResponse/
    DocumentUploadAcceptedResponse/DocumentSummary/DocumentContentResponse/
    DocumentMetadataResponse below) so they cannot drift out of sync on
    which fields exist — a real risk given how many response shapes this
    router already builds from the same DocumentRecord. "Unknown means
    unknown": every field defaults to None/empty exactly like Document's
    own columns (see app/db/models_documents.py), never a guessed value.

    `metadata_sources` is the per-field provenance map (field name -> one
    of "user"/"embedded_metadata"/"structured_text"/"filename" — see
    app/ingestion/loaders/base.py's ExtractionSource) — surfaced on every
    shape (not just a dedicated edit-review response) so a reviewing user
    always sees how much to trust what they're looking at, and so the
    Documents list/card view can show an "auto-detected" vs "confirmed"
    indicator without a second per-document request (Milestone 4 Section
    20's "no per-document metadata request explosion")."""

    document_type: DocumentType
    journal_quartile: JournalQuartile = None
    title: str | None = None
    authors: list[str] = Field(default_factory=list)
    publication_year: int | None = None
    source_venue: str | None = None
    doi: str | None = None
    source_url: str | None = None
    volume: str | None = None
    issue: str | None = None
    page_start: int | None = None
    page_end: int | None = None
    publisher: str | None = None
    abstract: str | None = None
    keywords: list[str] = Field(default_factory=list)
    language: str | None = None
    metadata_sources: dict[str, str] = Field(default_factory=dict)
    # Milestone 4.1 (Authoritative Metadata Enrichment & Duplicate
    # Awareness): the outcome of the most recent Crossref lookup attempt
    # for this document — see app/core/bibliographic_enrichment_service.py.
    # All three None for a document that has never been enriched (every
    # document ingested before this milestone, and any document without a
    # usable DOI), matching Document.last_enriched_at/enrichment_provider/
    # enrichment_status's own "never enriched" default. Surfaced on every
    # shape (same reasoning as metadata_sources above) so the "Refresh
    # metadata" action's enabled/disabled state and its last-known-outcome
    # copy never need a second per-document request.
    last_enriched_at: datetime | None = None
    enrichment_provider: str | None = None
    enrichment_status: str | None = None
    # Whether "Refresh metadata" should be offered at all (Section 11:
    # "Only show/enable when the document has a usable DOI") — computed
    # server-side (see bibliographic_enrichment_service.has_usable_doi)
    # rather than left to the frontend to re-derive from `doi`, since the
    # exact validation (DOI shape normalization) already lives in one
    # place on the backend.
    has_usable_doi: bool = False
    # Milestone 4.2 (Citation & BibTeX Foundation) Section 16/17 — the
    # deterministic, PERSISTED BibTeX/citation key (see
    # app/core/citation_key.py). None until a citation/BibTeX request has
    # ever been made for this document (see DocumentsRepository.
    # get_or_create_citation_key) — deliberately never generated just to
    # populate a listing response (Section 36: "generate on demand where
    # reasonable"), so browsing Documents never triggers a write per row.
    citation_key: str | None = None


class DocumentUploadResponse(BibliographicMetadataFields):
    document_id: str
    source_filename: str
    file_format: str
    # Milestone 1 (Document Library / Folder Management): None = root/
    # unfiled. See app/db/models_documents.py's `folder_id` docstring.
    folder_id: str | None = None
    page_count: int
    chunk_count: int
    ingested_at: datetime
    # Frontend Milestone 3.1 (Original Document Reader): the ONE signal the
    # frontend uses to decide "render the real original file" vs "fall back
    # to the extracted-text reader" — see Document.storage_key's docstring.
    # False for every document ingested before this milestone.
    original_file_available: bool = False


class DocumentUploadAcceptedResponse(BibliographicMetadataFields):
    """POST /documents' response: returned as soon as the fast, synchronous
    part (duplicate check, parsing, chunking — sub-second even for large
    files) is done. Embedding + Qdrant indexing + the final `documents` row
    happen afterward in a background job — poll GET /documents/jobs/{job_id}
    (see DocumentJobResponse) for progress and the eventual result."""

    job_id: str
    status: DocumentJobStatus
    source_filename: str
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


class DocumentSummary(BibliographicMetadataFields):
    document_id: str
    source_filename: str
    folder_id: str | None = None
    # Frontend/Platform Milestone 3.2.1 Part D — populated only by GET
    # /documents?q=... (library search results, across every folder);
    # None for the ordinary unfiltered list. See DocumentsRepository.
    # search_for_user's docstring for why this is a server-side JOIN
    # rather than a second per-result frontend request.
    folder_name: str | None = None
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


#: Milestone 4.1 §21 — mirrors app.core.bibliographic_enrichment_service.
#: EnrichmentRunStatus exactly (a Pydantic Literal can't reference that
#: type alias directly since it's built from a StrEnum-derived union, so
#: the values are spelled out here — kept in sync by hand, the same way
#: DocumentType/JournalQuartile already are between app.ingestion.
#: metadata_schema and this module).
EnrichmentRunStatusValue = Literal[
    "succeeded",
    "not_found",
    "timeout",
    "unavailable",
    "rate_limited",
    "malformed_response",
    "unknown_error",
    "no_doi",
    "disabled",
    "not_found_document",
]


class DocumentEnrichmentResponse(BaseModel):
    """POST /documents/{id}/enrich — Milestone 4.1's user-triggered
    "Refresh metadata" action (Section 11). Returns BOTH the outcome of
    this specific attempt (status/fields_updated/manual_fields_preserved)
    AND the document's current, post-attempt state in one response — the
    same "no per-document request explosion" reasoning
    BibliographicMetadataFields' own docstring already gives for bundling
    metadata_sources onto every document shape, applied here so the
    frontend never needs a second GET just to redraw the metadata panel
    after a refresh."""

    ok: bool
    status: EnrichmentRunStatusValue
    fields_updated: list[str] = Field(default_factory=list)
    manual_fields_preserved: int = 0
    qdrant_sync_failed: bool = False
    document: DocumentSummary


class MoveDocumentRequest(BaseModel):
    """PATCH /documents/{id} — moves a document into a different folder
    (or to root, when `folder_id` is null). Purely organizational: never
    touches chunks, embeddings, or Qdrant (see
    DocumentsRepository.move_to_folder)."""

    folder_id: str | None = None


_MAX_ABSTRACT_CHARS = 8000
_MAX_KEYWORDS = 50
_MAX_KEYWORD_CHARS = 100


class UpdateDocumentMetadataRequest(BaseModel):
    """PATCH /documents/{id}/metadata — Milestone 4's "Edit metadata"
    action. Every field is optional; only a field ACTUALLY PRESENT in the
    request body is touched (see `model_fields_set`, same partial-update
    convention as UpdateProjectRequest) — sending only `{"doi": "..."}`
    corrects the DOI without touching anything else, and a field can be
    explicitly cleared by sending it as `null`/`""`/`[]` rather than
    omitting it. `title` cannot be blanked to null (a document always
    needs some displayable identity — same rule POST /documents' title
    fallback already enforces via clean_filename_as_title), matching
    UpdateProjectRequest.name's own "name, when present, can never be
    blanked out" precedent; every other field can be cleared.

    Never includes `metadata_sources` — routes_documents.py's
    update_document_metadata computes that itself (every field present
    here always gets "user" provenance, per Milestone 4 Section 5's
    "USER/MANUAL correction > any future automatic extraction"
    guarantee), so a client could never spoof a field's provenance label
    even if it tried.

    This is a SQL-only metadata correction (Milestone 4 Section 9/13):
    never re-uploads, re-chunks, re-embeds, or writes to Qdrant — see
    DocumentsRepository.update_metadata / METADATA_FIELDS."""

    title: str | None = Field(default=None, min_length=1, max_length=1024)
    authors: list[str] | None = None
    publication_year: int | None = Field(default=None, ge=1500, le=2100)
    source_venue: str | None = Field(default=None, max_length=512)
    doi: str | None = Field(default=None, max_length=255, pattern=r"^10\.\d{4,9}/\S+$")
    source_url: str | None = Field(default=None, max_length=2048)
    document_type: DocumentType | None = None
    journal_quartile: JournalQuartile = None
    volume: str | None = Field(default=None, max_length=50)
    issue: str | None = Field(default=None, max_length=50)
    page_start: int | None = Field(default=None, ge=1)
    page_end: int | None = Field(default=None, ge=1)
    publisher: str | None = Field(default=None, max_length=512)
    abstract: str | None = Field(default=None, max_length=_MAX_ABSTRACT_CHARS)
    keywords: list[str] | None = Field(default=None, max_length=_MAX_KEYWORDS)
    language: str | None = Field(default=None, max_length=16)

    @field_validator("doi", mode="before")
    @classmethod
    def _normalize_doi(cls, value: object) -> object:
        """Milestone 4 Section 15: runs BEFORE the `pattern=` constraint
        above, so a user pasting "https://doi.org/10.1234/abcd" or
        "doi:10.1234/abcd" into the edit form is normalized to the same
        canonical "10.1234/abcd" shape extraction already produces (see
        metadata_extraction.normalize_doi) — one consistent DOI
        representation across every ingestion/edit path, the foundation a
        future duplicate-detection feature would need to compare DOIs
        reliably (never itself merging documents — that stays explicitly
        out of scope for this milestone). Non-string values pass through
        unchanged so Pydantic's own type-validation reports the real
        error; a string that still isn't DOI-shaped after normalization
        passes through unchanged too, so the `pattern=` constraint below
        reports an honest "this isn't a DOI" rather than silently
        swallowing it."""
        if not isinstance(value, str) or not value.strip():
            return value
        return normalize_doi(value) or value

    @model_validator(mode="after")
    def _keywords_not_absurdly_long(self) -> "UpdateDocumentMetadataRequest":
        if self.keywords is not None:
            for keyword in self.keywords:
                if len(keyword) > _MAX_KEYWORD_CHARS:
                    raise ValueError(f"each keyword must be at most {_MAX_KEYWORD_CHARS} chars")
        return self


class DocumentContentChunk(BaseModel):
    """Frontend Milestone 3 (Document Reader): one chunk of a document's
    extracted text, in reading order. `chunk_id` is the same deterministic
    id citations already carry (MessageSourceResponse.chunk_id) — the
    anchor a highlight or a "go to source" link keys off."""

    chunk_id: str
    chunk_index: int
    page_number: int
    text: str


class DocumentContentResponse(BibliographicMetadataFields):
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
    page.

    Milestone 4: also carries the full bibliographic field set (not just
    `title`) so the Reader header can show authors/year alongside the
    title without a second request (Section 10 — "header gets
    bibliographic identity access without cluttering the PDF canvas")."""

    document_id: str
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


class DuplicateDocumentCandidate(BaseModel):
    """Milestone 4.1 §23/§24/§27 — a non-destructive pointer at an
    ALREADY-OWNED document this one may duplicate. `match_type` is always
    "exact_doi" today (the only signal this milestone implements besides
    the pre-existing SHA-256 check, which stays a hard 409 at actual
    upload time rather than a preview-time candidate — see Section 25).
    High confidence by construction: an exact normalized-DOI match is
    Section 27's strongest signal short of a byte-identical file, so this
    never needs its own separate confidence field the way a (deferred)
    fuzzy match would."""

    document_id: str
    title: str | None = None
    authors: list[str] = Field(default_factory=list)
    publication_year: int | None = None
    source_filename: str
    folder_id: str | None = None
    folder_name: str | None = None
    match_type: Literal["exact_doi"] = "exact_doi"


class DocumentMetadataPreviewResponse(BaseModel):
    """POST /documents/metadata-preview — extraction only, no chunking,
    embedding, or Qdrant/SQL writes (see routes_documents.py), so a user
    can review/edit detected fields before anything is actually indexed,
    without ever risking a document being embedded twice.

    `extraction_sources`/`extraction_confidence` are keyed by field name
    (e.g. "title", "authors") and only ever include fields that actually
    got a non-empty value — they exist purely to inform the review UI,
    and are never persisted anywhere past this response.

    `duplicate_candidate` (Milestone 4.1): non-None only when the
    extracted DOI exactly matches another document this same user already
    owns — surfaced here, BEFORE the (potentially slow) upload even
    starts, so the frontend can offer "Open existing" / "Keep both"
    (Section 28) as part of the same pre-upload review step that already
    shows extracted title/authors/etc. Never blocks anything by itself:
    proceeding to POST /documents with "Keep both" uploads exactly as
    normal — this field is purely informational.
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
    duplicate_candidate: DuplicateDocumentCandidate | None = None


#: Milestone 4.2 (Citation & BibTeX Foundation) Section 5 — exactly the
#: two initial styles. Mirrors app.core.citation_formatting.CitationStyle;
#: spelled out again here (rather than imported) for the same reason
#: EnrichmentRunStatusValue above duplicates its backend Literal — a
#: Pydantic response schema can't reference a Literal defined in app.core
#: without pulling a citeproc-py-adjacent import chain into every module
#: that imports app.schemas.documents.
CitationStyleValue = Literal["apa7", "ieee"]


class DocumentCitationResponse(BaseModel):
    """GET /documents/{id}/citation?style=... — Milestone 4.2 Section 7.
    `formatted` is the complete, deterministic APA 7 / IEEE citation text,
    built fresh from the document's CURRENT canonical SQL metadata on
    every call (Section 28/30 — never a cached/stale value); degrades
    gracefully for missing fields (Section 8) rather than erroring."""

    style: CitationStyleValue
    formatted: str


class DocumentBibtexResponse(BaseModel):
    """GET /documents/{id}/bibtex — Milestone 4.2 Section 18/19. `bibtex`
    is one complete, valid entry; `citation_key` is the same PERSISTED,
    stable key now also exposed on BibliographicMetadataFields.citation_key
    (surfaced again here so a caller that only wants BibTeX never needs a
    second request just to learn the key it was assigned)."""

    citation_key: str
    bibtex: str


_MAX_BIBTEX_EXPORT_DOCUMENTS = 500


class BibtexExportRequest(BaseModel):
    """POST /documents/bibtex-export — Milestone 4.2 Section 20/21. Reuses
    Documents' existing multi-selection UI (no separate "Reference page" —
    Section 20); `document_ids` are ownership-checked individually by the
    route (Section 34), never trusted as already belonging to the caller."""

    document_ids: list[str] = Field(min_length=1, max_length=_MAX_BIBTEX_EXPORT_DOCUMENTS)


class BibtexExportResponse(BaseModel):
    """`bibtex` contains one valid entry per successfully resolved document,
    in deterministic citation_key order (Section 22). `skipped_document_ids`
    lists any requested id that doesn't exist or isn't the caller's own —
    reported honestly rather than silently dropped or failing the whole
    export (Section 34's ownership check skips, it never leaks whether a
    skipped id belongs to someone else)."""

    bibtex: str
    count: int
    skipped_document_ids: list[str] = Field(default_factory=list)
