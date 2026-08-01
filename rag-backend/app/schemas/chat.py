from typing import Literal

from pydantic import BaseModel, Field

from app.core.citation import Citation
from app.core.retrieval_schemas import RetrievalFilters, RetrievedChunk


class ChatRequest(BaseModel):
    query: str = Field(min_length=1, max_length=2000)
    top_k: int = Field(default=8, ge=1, le=20)
    filters: RetrievalFilters | None = None


ChatStage = Literal["connected", "retrieving", "loading_model", "processing_context", "generating"]


class ChatProgressEvent(BaseModel):
    """Sent zero or more times *before* the first ChatTokenEvent, never
    after — see app/api/routes_conversations.py's event_stream(). Exists
    because a CPU-only Ollama host can take tens of seconds to cold-load a
    model and well over a minute to evaluate a long prompt, with nothing
    else happening on the wire in the meantime; without these, a client
    has no way to distinguish "still working" from "hung" during that
    window. Purely advisory UI state — no field here is ever required for
    correctness, and a client that doesn't recognize `type: "progress"`
    can ignore it entirely (see the SDK's parseChatEvent, which already
    skips unknown event types by design) without losing any information
    the token/sources/done events don't already carry."""

    type: Literal["progress"] = "progress"
    stage: ChatStage


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
    # Optional JSON debug output (see app/core/request_timing.py):
    # stage name -> duration_ms, plus "total_ms". Only populated when
    # PERFORMANCE_PROFILING=true; null/absent otherwise, so existing
    # clients that don't know this field see nothing new. Sent here,
    # rather than as a separate SSE message, because it's the only stage
    # group (llm_generation/streaming/total) that isn't known until the
    # stream is about to end, and ChatDoneEvent is already the one event
    # guaranteed to be emitted exactly once at that point.
    debug_timings: dict[str, float] | None = None


class ChatErrorEvent(BaseModel):
    type: Literal["error"] = "error"
    message: str


ChatEvent = ChatProgressEvent | ChatTokenEvent | ChatSourcesEvent | ChatDoneEvent | ChatErrorEvent
