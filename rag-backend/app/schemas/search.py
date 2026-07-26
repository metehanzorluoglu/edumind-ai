from pydantic import BaseModel, Field

from app.core.retrieval_schemas import RetrievalFilters, RetrievedChunk


class SearchRequest(BaseModel):
    query: str = Field(min_length=1, max_length=2000)
    top_k: int = Field(default=8, ge=1, le=20)
    filters: RetrievalFilters | None = None


class SearchResponse(BaseModel):
    results: list[RetrievedChunk]
