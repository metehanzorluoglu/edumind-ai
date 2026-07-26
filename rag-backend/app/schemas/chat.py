from typing import Literal

from pydantic import BaseModel, Field

from app.core.citation import Citation
from app.core.retrieval_schemas import RetrievalFilters, RetrievedChunk


class ChatRequest(BaseModel):
    query: str = Field(min_length=1, max_length=2000)
    top_k: int = Field(default=8, ge=1, le=20)
    filters: RetrievalFilters | None = None


class ChatTokenEvent(BaseModel):
    type: Literal["token"] = "token"
    content: str


class ChatSourcesEvent(BaseModel):
    type: Literal["sources"] = "sources"
    sources: list[RetrievedChunk]


class RetrievalScopeResponse(BaseModel):
    chat: bool
    project: bool
    general: bool
    other_projects: bool


class DocumentUsedResponse(BaseModel):
    document_id: str
    source_filename: str


class ProjectSummaryUsedResponse(BaseModel):
    id: str
    research_topic: str
    conversation_title: str | None = None


class TransparencyResponse(BaseModel):
    """Answer transparency ("How this answer was prepared" — research
    workspace milestone): documents_used/project_summaries_used are
    deliberately two separate lists — a project summary is never folded
    into documents_used or the citations list, so it can never be
    rendered as if it were primary evidence (see NEVER)."""

    retrieval_scope: RetrievalScopeResponse
    documents_used: list[DocumentUsedResponse] = Field(default_factory=list)
    project_summaries_used: list[ProjectSummaryUsedResponse] = Field(default_factory=list)
    profile_fields_used: list[str] = Field(default_factory=list)


class ChatDoneEvent(BaseModel):
    type: Literal["done"] = "done"
    citations: list[Citation] = Field(default_factory=list)
    citation_warnings: list[str] = Field(default_factory=list)
    insufficient_evidence: bool = False
    transparency: TransparencyResponse | None = None


class ChatErrorEvent(BaseModel):
    type: Literal["error"] = "error"
    message: str


ChatEvent = ChatTokenEvent | ChatSourcesEvent | ChatDoneEvent | ChatErrorEvent
