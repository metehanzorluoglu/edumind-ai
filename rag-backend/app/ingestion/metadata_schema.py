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

    ingested_at: datetime
