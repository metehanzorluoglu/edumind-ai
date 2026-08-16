from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

DocumentType = Literal[
    "journal_article",
    "practitioner_article",
    "policy_document",
    "report",
    "review_article",
    "curriculum_document",
    # Milestone 4 (Reference Library & Bibliographic Metadata Foundation):
    # rounds out the reference-type taxonomy to cover the common
    # bibliographic categories a research library needs beyond the
    # original six (see the milestone's Section 3) — additive only, same
    # reasoning as "unknown" below: every existing RAG filter / citation
    # label / corpus-stats grouping already treats document_type as an
    # opaque string key, so no other code path needed to change to accept
    # these (see _DOCUMENT_TYPE_LABELS in prompt_builder.py for the one
    # place that DOES need a matching entry, since it's a dict keyed by
    # this Literal).
    "book",
    "book_chapter",
    "thesis_dissertation",
    "conference_paper",
    "other",
    # Frontend/Platform Milestone 3.2.1 Part C: the normal upload UI no
    # longer asks the user to classify a document before uploading (the
    # milestone's own "do not fabricate" instruction rules out silently
    # defaulting to one of the concrete categories above, e.g. "report" —
    # that would assert something never confirmed). This is the genuine,
    # honest value for "not classified" — POST /documents falls back to
    # it when the client omits document_type entirely (see
    # routes_documents.py). Every existing RAG filter / citation label /
    # corpus-stats grouping already treats document_type as an opaque
    # string key, so adding this is additive only — no other code path
    # needed to change to accept it (see _DOCUMENT_TYPE_LABELS in
    # prompt_builder.py for the one place that DOES need a matching
    # entry, since it's a dict keyed by this Literal).
    "unknown",
]

JournalQuartile = Literal["Q1", "Q2"] | None

FileFormat = Literal["pdf", "docx", "txt", "html", "markdown"]


class DocumentMetadata(BaseModel):
    document_id: str
    source_filename: str
    file_format: FileFormat
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    file_size_bytes: int = Field(ge=0)
    page_count: int = Field(ge=1)

    document_type: DocumentType
    journal_quartile: JournalQuartile = None

    title: str | None = None
    authors: list[str] = Field(default_factory=list)
    publication_year: int | None = Field(default=None, ge=1500, le=2100)
    source_venue: str | None = None
    doi: str | None = Field(default=None, pattern=r"^10\.\d{4,9}/\S+$")
    source_url: str | None = None

    # Milestone 4: canonical bibliographic detail beyond the six fields
    # above. `volume`/`page_start`/`page_end` and `abstract`/`language`/
    # `keywords` all come from real extraction (see
    # app/ingestion/metadata_extraction.py's extract_from_pages) when
    # present — never fabricated. `issue`/`publisher` have no extraction
    # heuristic anywhere in this codebase; they stay None until a user
    # supplies them via a metadata edit (see routes_documents.py's edit
    # endpoint). "Unknown means unknown": every field here defaults to
    # None/empty rather than a guessed value.
    volume: str | None = None
    issue: str | None = None
    page_start: int | None = None
    page_end: int | None = None
    publisher: str | None = None
    abstract: str | None = None
    keywords: list[str] = Field(default_factory=list)
    language: str | None = None
    # Per-field provenance: field name -> one of ExtractionSource's values
    # ("user"/"embedded_metadata"/"structured_text"/"filename") for every
    # field above that actually has a value; a field with no entry has no
    # known provenance (either it's empty, or it predates this milestone —
    # see Document.metadata_sources' own docstring). Built by
    # app/ingestion/ingest.py; a plain dict[str, str] rather than
    # dict[str, ExtractionSource] here so this schema module — which
    # nothing in app/ingestion/loaders depends on — doesn't need to import
    # ExtractionSource from there just to describe its own JSON shape.
    metadata_sources: dict[str, str] = Field(default_factory=dict)

    ingested_at: datetime
