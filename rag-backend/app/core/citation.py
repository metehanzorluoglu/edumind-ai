from pydantic import BaseModel, Field

from app.core.retrieval_schemas import RetrievedChunk, ScopeTierName
from app.ingestion.metadata_schema import DocumentType, JournalQuartile


class Citation(BaseModel):
    source_id: str
    document_id: str
    chunk_id: str
    title: str | None = None
    authors: list[str] = Field(default_factory=list)
    publication_year: int | None = None
    source_venue: str | None = None
    document_type: DocumentType
    journal_quartile: JournalQuartile = None
    page_start: int | None = None
    page_end: int | None = None
    doi: str | None = None
    source_url: str | None = None
    score: float
    # Which retrieval tier found this chunk (see
    # app/core/scoped_retrieval.py) — carried straight from the source
    # RetrievedChunk so the frontend can render "Current Chat"/"Current
    # Project"/"General Corpus" per source card.
    scope: ScopeTierName = "general"


def build_citations(sources: list[RetrievedChunk]) -> list[Citation]:
    """Assigns deterministic S1, S2, ... IDs in the given (already-ranked) order.

    page_start/page_end are both set to the chunk's single page_number: chunks
    are built per-page (see app/ingestion/chunker.py) and never span multiple
    pages, so a single page number is the accurate range, not an approximation."""
    return [
        Citation(
            source_id=f"S{index}",
            document_id=chunk.document_id,
            chunk_id=chunk.chunk_id,
            title=chunk.title,
            authors=chunk.authors,
            publication_year=chunk.publication_year,
            source_venue=chunk.source_venue,
            document_type=chunk.document_type,
            journal_quartile=chunk.journal_quartile,
            page_start=chunk.page_number,
            page_end=chunk.page_number,
            doi=chunk.doi,
            source_url=chunk.source_url,
            score=chunk.score,
            scope=chunk.scope,
        )
        for index, chunk in enumerate(sources, start=1)
    ]
