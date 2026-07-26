from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

from app.ingestion.metadata_schema import DocumentMetadata, DocumentType, JournalQuartile

ScopeType = Literal["general", "chat", "project"]


def _default_scope_type() -> list[ScopeType]:
    return ["general"]


class ChunkPayload(BaseModel):
    # Required, no default: ownership must never be forgotten at the call
    # site. See QdrantVectorStore — every read/write method takes a
    # required `user_id` argument for the same reason (a distinct
    # parameter, not folded into VectorStoreFilter, so mypy --strict flags
    # any call site that forgets to scope a query).
    user_id: str
    document_id: str
    document_type: DocumentType
    journal_quartile: JournalQuartile = None
    title: str | None = None
    authors: list[str] = Field(default_factory=list)
    publication_year: int | None = None
    source_venue: str | None = None
    doi: str | None = None
    source_url: str | None = None
    source_filename: str
    ingested_at: datetime
    chunk_index: int = Field(ge=0)
    page_number: int = Field(ge=1)
    text: str
    # --- contextual research scopes ---
    # A chunk that predates this field simply lacks the key in its stored
    # payload dict entirely (not an explicit null) — Pydantic applies the
    # default_factory below for any missing key, so an old point reads back
    # as "in zero conversations/projects, general scope only", which is
    # exactly the correct semantic (it never was associated with anything)
    # and needs no separate backfill migration. Never set directly by a
    # caller of upsert_chunks/from_metadata — see
    # QdrantVectorStore.update_scope_associations, the only place these are
    # ever written after initial ingestion, which always recomputes the
    # full current set from the SQL association tables (the source of
    # truth), never incrementally.
    conversation_ids: list[str] = Field(default_factory=list)
    project_ids: list[str] = Field(default_factory=list)
    # Derived, never independently caller-set: "general" is always present
    # (every document a user owns is always part of their general corpus),
    # gaining "chat"/"project" only once conversation_ids/project_ids are
    # non-empty. See QdrantVectorStore's _derive_scope_type.
    scope_type: list[ScopeType] = Field(default_factory=_default_scope_type)

    @classmethod
    def from_metadata(
        cls,
        metadata: DocumentMetadata,
        *,
        user_id: str,
        chunk_index: int,
        page_number: int,
        text: str,
    ) -> "ChunkPayload":
        return cls(
            user_id=user_id,
            document_id=metadata.document_id,
            document_type=metadata.document_type,
            journal_quartile=metadata.journal_quartile,
            title=metadata.title,
            authors=metadata.authors,
            publication_year=metadata.publication_year,
            source_venue=metadata.source_venue,
            doi=metadata.doi,
            source_url=metadata.source_url,
            source_filename=metadata.source_filename,
            ingested_at=metadata.ingested_at,
            chunk_index=chunk_index,
            page_number=page_number,
            text=text,
        )


class DocumentRecord(BaseModel):
    document_id: str
    document_type: DocumentType
    journal_quartile: JournalQuartile = None
    title: str | None = None
    authors: list[str] = Field(default_factory=list)
    publication_year: int | None = None
    source_venue: str | None = None
    doi: str | None = None
    source_url: str | None = None
    source_filename: str
    ingested_at: datetime
    chunk_count: int = Field(ge=1)


class VectorStoreFilter(BaseModel):
    document_type: DocumentType | None = None
    journal_quartile: JournalQuartile = None
    publication_year_from: int | None = None
    publication_year_to: int | None = None
    author: str | None = None
    source_venue: str | None = None


class VectorSearchResult(BaseModel):
    id: str
    payload: ChunkPayload
    score: float
    vector: list[float] | None = None
