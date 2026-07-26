from typing import Literal

from pydantic import BaseModel, Field

from app.ingestion.metadata_schema import DocumentType, JournalQuartile

ScopeTierName = Literal["chat", "project", "general"]


class RetrievalFilters(BaseModel):
    document_type: DocumentType | None = None
    journal_quartile: JournalQuartile = None
    publication_year_from: int | None = None
    publication_year_to: int | None = None
    author: str | None = None
    source_venue: str | None = None


class RetrievedChunk(BaseModel):
    score: float
    text: str
    document_id: str
    chunk_id: str
    document_type: DocumentType
    journal_quartile: JournalQuartile = None
    title: str | None = None
    authors: list[str] = Field(default_factory=list)
    publication_year: int | None = None
    source_venue: str | None = None
    doi: str | None = None
    source_url: str | None = None
    source_filename: str
    chunk_index: int = Field(ge=0)
    page_number: int = Field(ge=1)
    # Which retrieval tier actually found this chunk (see
    # app/core/scoped_retrieval.py) — stamped by execute_scope_plan,
    # carried through prepare_context/build_citations/MessageSource so the
    # frontend can render "Current Chat"/"Current Project"/"General
    # Corpus" per source. Defaults to "general" so every pre-existing
    # test-double construction of this model stays valid unchanged.
    scope: ScopeTierName = "general"
