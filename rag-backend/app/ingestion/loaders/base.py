from datetime import date
from enum import StrEnum

from pydantic import BaseModel, Field

from app.ingestion.metadata_schema import FileFormat


class PageContent(BaseModel):
    page_number: int = Field(ge=1)
    text: str


class ExtractionSource(StrEnum):
    """Where one field's value came from — surfaced to the frontend via
    POST /documents/metadata-preview's `extraction_sources` (see
    app/schemas/documents.py), and persisted per-field on `Document.
    metadata_sources` (Milestone 4) so a reviewing user always knows how
    much to trust each field, both before and after upload.

    Precedence, most trustworthy first (Milestone 4.1 Section 7):
    USER > AUTHORITATIVE > EMBEDDED_METADATA > STRUCTURED_TEXT > FILENAME.
    See app/core/bibliographic_enrichment.py's merge_authoritative_metadata
    for the one place this ordering is enforced.
    """

    USER = "user"
    # Milestone 4.1: an identifier-backed scholarly metadata service
    # (Crossref) — "authoritative" means the value came from a DOI lookup
    # against the work's own registered record, NOT that it is guaranteed
    # correct (a provider can itself have bad data) — see
    # bibliographic_enrichment.py's module docstring.
    AUTHORITATIVE = "authoritative"
    EMBEDDED_METADATA = "embedded_metadata"
    STRUCTURED_TEXT = "structured_text"
    FILENAME = "filename"


class ExtractedMetadata(BaseModel):
    """Bibliographic fields a loader (embedded file metadata) and/or the
    shared structured-text pass (app/ingestion/metadata_extraction.py)
    could infer from the document itself — never from the user, and never
    a fabricated guess: a field this system couldn't support with
    reasonable confidence stays None/empty rather than being invented.

    `sources` tracks, per populated field name, which of those two passes
    actually produced it (see ExtractionSource) — app/ingestion/loaders/dispatch.py
    is the only place that merges an embedded pass with the structured-text
    fallback, and it is careful to only ever let the fallback fill a gap,
    never overwrite what embedded metadata already found.
    """

    title: str | None = None
    authors: list[str] = Field(default_factory=list)
    publication_year: int | None = None
    source_venue: str | None = None
    doi: str | None = None
    source_url: str | None = None
    # Extracted for the metadata-preview response only (see
    # DocumentMetadataPreviewResponse) — never persisted to the `documents`
    # table or a Qdrant chunk payload, since nothing in the ingested-document
    # contract (SQL row / API responses / source cards) calls for them today.
    abstract: str | None = None
    language: str | None = None
    keywords: list[str] = Field(default_factory=list)
    # Decomposed pieces of a recognized "Journal Name (YYYY) Vol:Start-End"
    # citation banner (see metadata_extraction.parse_journal_citation) —
    # `source_venue` itself always keeps the full citation string verbatim;
    # these are additional, optional detail for a consumer that wants the
    # journal name or page range on their own, never persisted to the
    # `documents` table or a Qdrant chunk payload today.
    journal_title: str | None = None
    volume: str | None = None
    page_start: int | None = None
    page_end: int | None = None
    # A journal's "published online" date can predate its issue/volume
    # publication year (see extract_publication_year's docstring on why
    # `publication_year` itself always prefers the issue year) — these
    # preserve the online-first date and the accepted date as extraction
    # detail rather than discarding them, never persisted to the `documents`
    # table or a Qdrant chunk payload today.
    online_publication_year: int | None = None
    accepted_date: date | None = None
    sources: dict[str, ExtractionSource] = Field(default_factory=dict)


class LoadedDocument(BaseModel):
    file_format: FileFormat
    pages: list[PageContent]
    metadata: ExtractedMetadata = Field(default_factory=ExtractedMetadata)
