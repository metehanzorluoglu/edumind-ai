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
