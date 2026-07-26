import time
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Protocol

from pydantic import BaseModel, Field

from app.core.citation import Citation, build_citations
from app.core.citation_validation import validate_citations
from app.core.context_preparation import (
    DEFAULT_MAX_CHUNKS_PER_DOCUMENT,
    DEFAULT_MAX_TOTAL_CONTEXT_CHARS,
    DEFAULT_SIMILARITY_THRESHOLD,
    prepare_context,
)
from app.core.llm_provider import LLMProvider
from app.core.prompt_builder import NO_EVIDENCE_ANSWER, build_chat_prompt
from app.core.retrieval_schemas import RetrievalFilters, RetrievedChunk
from app.core.scoped_retrieval import execute_scope_plan, resolve_scope_plan

DEFAULT_TOP_K = 8
# Per-tier budgets for scope-aware retrieval (contextual research scopes) —
# mirrored from Settings.retrieval_chat_scope_top_k/retrieval_project_scope_top_k
# so a caller that constructs a RagService/calls retrieve_and_cite directly
# (e.g. a test) gets a sensible default without needing Settings at hand.
DEFAULT_CHAT_SCOPE_TOP_K = 5
DEFAULT_PROJECT_SCOPE_TOP_K = 5


class RetrieverLike(Protocol):
    def retrieve(
        self,
        query: str,
        *,
        user_id: str,
        top_k: int = ...,
        filters: RetrievalFilters | None = None,
        conversation_id: str | None = None,
        project_id: str | None = None,
    ) -> list[RetrievedChunk]: ...


@dataclass
class CorpusEvidence:
    sources: list[RetrievedChunk]
    citations: list[Citation]


def retrieve_and_cite(
    retriever: RetrieverLike,
    query: str,
    *,
    user_id: str,
    top_k: int,
    filters: RetrievalFilters | None,
    max_chunks_per_document: int,
    max_total_context_chars: int,
    dedup_similarity_threshold: float,
    conversation_id: str | None = None,
    project_ids: tuple[str, ...] = (),
    chat_scope_top_k: int = DEFAULT_CHAT_SCOPE_TOP_K,
    project_scope_top_k: int = DEFAULT_PROJECT_SCOPE_TOP_K,
    include_chat: bool = True,
    include_project: bool = True,
    include_general: bool = True,
) -> CorpusEvidence:
    """Retrieval -> context-prep -> citation-building, shared by
    RagService.prepare() (text-only chat) below and
    app/api/routes_conversations.py's vision+corpus chat handler
    (milestone V3) — the only two callers, so retrieval/dedup/citation
    logic can never drift between the text and vision-with-corpus
    pipelines.

    Retrieval itself is a blended, priority-ordered multi-tier plan (Chat >
    Project > General — see app/core/scoped_retrieval.py) rather than a
    single retriever.retrieve() call: with `conversation_id=None` (the
    default) and `project_ids=()` (the default), resolve_scope_plan
    produces exactly one "general" tier at `top_k`, so a caller that
    doesn't pass scope info gets byte-for-byte today's original single-
    retrieve behavior. `include_chat`/`include_project`/`include_general`
    (research workspace milestone) let a caller omit a tier entirely
    regardless of what conversation_id/project_ids would otherwise
    produce — the per-conversation scope toggle bar's effect on
    retrieval."""
    plan = resolve_scope_plan(
        conversation_id=conversation_id,
        project_ids=list(project_ids),
        chat_top_k=chat_scope_top_k,
        project_top_k=project_scope_top_k,
        general_top_k=top_k,
        include_chat=include_chat,
        include_project=include_project,
        include_general=include_general,
    )
    raw_sources = execute_scope_plan(retriever, query, plan, user_id=user_id, filters=filters)[
        :top_k
    ]
    prepared_sources = prepare_context(
        raw_sources,
        max_per_document=max_chunks_per_document,
        max_total_chars=max_total_context_chars,
        similarity_threshold=dedup_similarity_threshold,
    )
    citations = build_citations(prepared_sources)
    return CorpusEvidence(sources=prepared_sources, citations=citations)


@dataclass
class PreparedChat:
    system_prompt: str
    user_prompt: str
    retrieved_sources: list[RetrievedChunk]
    citations: list[Citation]
    insufficient_evidence: bool


class ChatPipelineResult(BaseModel):
    answer: str
    citations: list[Citation]
    retrieved_sources: list[RetrievedChunk]
    insufficient_evidence: bool
    model: str
    latency_ms: float
    citation_warnings: list[str] = Field(default_factory=list)


class RagService:
    """Owns the retrieval -> context-prep -> citation-building -> prompting
    steps shared by both the streaming /chat route and the non-streaming
    run() entry point, so neither path re-implements this logic. Only the
    final token-delivery mechanism (yield vs. accumulate) differs between
    them, which is inherent to streaming vs. non-streaming and not
    duplicated business logic."""

    def __init__(
        self,
        *,
        retriever: RetrieverLike,
        llm_provider: LLMProvider,
        model_name: str,
        max_chunks_per_document: int = DEFAULT_MAX_CHUNKS_PER_DOCUMENT,
        max_total_context_chars: int = DEFAULT_MAX_TOTAL_CONTEXT_CHARS,
        dedup_similarity_threshold: float = DEFAULT_SIMILARITY_THRESHOLD,
        chat_scope_top_k: int = DEFAULT_CHAT_SCOPE_TOP_K,
        project_scope_top_k: int = DEFAULT_PROJECT_SCOPE_TOP_K,
    ) -> None:
        self._retriever = retriever
        self._llm_provider = llm_provider
        self._model_name = model_name
        self._max_chunks_per_document = max_chunks_per_document
        self._max_total_context_chars = max_total_context_chars
        self._dedup_similarity_threshold = dedup_similarity_threshold
        self._chat_scope_top_k = chat_scope_top_k
        self._project_scope_top_k = project_scope_top_k

    def prepare(
        self,
        query: str,
        *,
        user_id: str,
        top_k: int = DEFAULT_TOP_K,
        filters: RetrievalFilters | None = None,
        conversation_id: str | None = None,
        project_ids: tuple[str, ...] = (),
        project_context: str | None = None,
        include_chat: bool = True,
        include_project: bool = True,
        include_general: bool = True,
    ) -> PreparedChat:
        evidence = retrieve_and_cite(
            self._retriever,
            query,
            user_id=user_id,
            top_k=top_k,
            filters=filters,
            max_chunks_per_document=self._max_chunks_per_document,
            max_total_context_chars=self._max_total_context_chars,
            dedup_similarity_threshold=self._dedup_similarity_threshold,
            conversation_id=conversation_id,
            project_ids=project_ids,
            chat_scope_top_k=self._chat_scope_top_k,
            project_scope_top_k=self._project_scope_top_k,
            include_chat=include_chat,
            include_project=include_project,
            include_general=include_general,
        )
        insufficient_evidence = len(evidence.sources) == 0
        system_prompt, user_prompt = build_chat_prompt(
            query, evidence.sources, project_context=project_context
        )

        return PreparedChat(
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            retrieved_sources=evidence.sources,
            citations=evidence.citations,
            insufficient_evidence=insufficient_evidence,
        )

    def stream_answer(self, prepared: PreparedChat) -> Iterator[str]:
        yield from self._llm_provider.stream_chat(
            system_prompt=prepared.system_prompt, user_prompt=prepared.user_prompt
        )

    def run(
        self,
        query: str,
        *,
        user_id: str,
        top_k: int = DEFAULT_TOP_K,
        filters: RetrievalFilters | None = None,
        conversation_id: str | None = None,
        project_ids: tuple[str, ...] = (),
        project_context: str | None = None,
        include_chat: bool = True,
        include_project: bool = True,
        include_general: bool = True,
    ) -> ChatPipelineResult:
        start = time.monotonic()
        prepared = self.prepare(
            query,
            user_id=user_id,
            top_k=top_k,
            filters=filters,
            conversation_id=conversation_id,
            project_ids=project_ids,
            project_context=project_context,
            include_chat=include_chat,
            include_project=include_project,
            include_general=include_general,
        )

        if prepared.insufficient_evidence:
            answer = NO_EVIDENCE_ANSWER
            warnings: list[str] = []
        else:
            answer = "".join(self.stream_answer(prepared))
            warnings = validate_citations(answer, prepared.citations).warnings

        latency_ms = (time.monotonic() - start) * 1000

        return ChatPipelineResult(
            answer=answer,
            citations=prepared.citations,
            retrieved_sources=prepared.retrieved_sources,
            insufficient_evidence=prepared.insufficient_evidence,
            model=self._model_name,
            latency_ms=latency_ms,
            citation_warnings=warnings,
        )
