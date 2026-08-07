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
    # Additive, optional (None everywhere except the batched-PDF pipeline —
    # see app/services/vision_batch_orchestrator.py and
    # app/core/generation_manager.py's GenerationState.progress): a
    # complete, presentable status line for when `stage` alone ("generating")
    # can't say anything more specific truthfully, e.g. "Analyzing pages
    # 9-16 of 47…" or "Combining findings…". A client that only reads
    # `stage` (every consumer as of this field's addition) is entirely
    # unaffected by its presence, same convention as ChatErrorEvent's
    # `error_category`.
    detail: str | None = None


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
    # Backend-only error classification (see app/core/errors.py's
    # VisionErrorCategory) — only ever populated for a vision-routed
    # failure today; None for every other error path (including every
    # text-chat error), and always None-safe for any existing consumer:
    # this is a new, additive field on an existing event type, not a
    # change to `message` or the event's `type`, so a client that only
    # ever reads `message` (every consumer as of this field's addition)
    # is entirely unaffected by its presence.
    error_category: str | None = None


ChatEvent = ChatProgressEvent | ChatTokenEvent | ChatSourcesEvent | ChatDoneEvent | ChatErrorEvent
