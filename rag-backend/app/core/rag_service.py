import time
from collections.abc import Iterator, Mapping
from dataclasses import dataclass
from typing import Protocol

from pydantic import BaseModel, Field

from app.core.citation import Citation, build_citations
from app.core.citation_validation import validate_citations
from app.core.context_preparation import (
    DEFAULT_MAX_CHUNKS_PER_DOCUMENT,
    DEFAULT_MAX_TOTAL_CONTEXT_CHARS,
    DEFAULT_SIMILARITY_THRESHOLD,
    SourceOrder,
    prepare_context,
)
from app.core.llm_provider import LLMProvider
from app.core.prompt_builder import (
    NO_EVIDENCE_ANSWER,
    ZOOM_IN_NO_EVIDENCE_ANSWER,
    PromptVariant,
    build_chat_prompt,
)
from app.core.request_timing import RequestTimer, get_current_timer
from app.core.retrieval_schemas import RetrievalFilters, RetrievedChunk
from app.core.scoped_retrieval import execute_scope_plan, resolve_scope_plan


def _record_prompt_metadata(
    timer: RequestTimer,
    *,
    system_prompt: str,
    user_prompt: str,
    query: str,
    sources: list[RetrievedChunk],
) -> None:
    """Safe prompt-composition metadata (PERFORMANCE_PROFILING=true only —
    see app/core/request_timing.py) added to investigate prompt-prefill
    latency on the Oracle CPU host: character/token-estimate counts for
    every distinct part of the final prompt, plus a per-source breakdown,
    so a slow request's actual composition (a handful of long chunks? many
    short ones? an oversized question?) is visible without ever recording
    the prompt's own content.

    Deliberately records only lengths — never system_prompt, user_prompt,
    query, or any chunk's .text. Token counts here are the same chars/4
    heuristic used elsewhere in this codebase (see estimated_prompt_tokens
    in app/api/routes_conversations.py) — a rough estimate, not a real
    tokenizer call; Ollama's own authoritative prompt_eval_count is
    recorded separately once the LLM call finishes (see
    app/core/llm_provider.py's _record_ollama_metrics) and is the number
    to trust for actual prefill cost.

    retrieved_chunk_count/context_characters/estimated_prompt_tokens
    already exist as separate metrics recorded in
    app/api/routes_conversations.py (computed slightly later, from
    prepared.retrieved_sources) — not duplicated here to avoid two
    call sites computing the same value; this function only adds the
    fields neither of those cover."""
    if not timer.enabled:
        return
    context_chars = sum(len(chunk.text) for chunk in sources)
    timer.record_metric("system_prompt_characters", len(system_prompt))
    timer.record_metric("system_prompt_tokens_est", round(len(system_prompt) / 4))
    timer.record_metric("context_tokens_est", round(context_chars / 4))
    timer.record_metric("question_characters", len(query))
    timer.record_metric("question_tokens_est", round(len(query) / 4))
    timer.record_metric("final_prompt_characters", len(system_prompt) + len(user_prompt))
    for index, chunk in enumerate(sources, start=1):
        timer.record_metric(f"chunk_{index}_characters", len(chunk.text))
        timer.record_metric(f"chunk_{index}_tokens_est", round(len(chunk.text) / 4))


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
    source_order: SourceOrder = "relevance",
    retrieval_mode_label: str | None = None,
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
    retrieval.

    `retrieval_mode_label` (Milestone 4 — Zoom-In) overrides the
    observability tag recorded below with a caller-supplied string instead
    of the tier-derived one — used only to record the distinct "zoom_in"
    value (see RagService.prepare's `strict_mode`) so a Zoom-In turn's
    retrieval_mode is never confused with an ordinary conversation that
    merely happens to have every other tier toggled off, which would
    otherwise also derive to "chat" alone. None (the default) preserves
    today's tier-derived label unchanged for every other caller."""
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
    # Observability (Milestone 2: conversation document scope) — derived
    # from `plan.tiers` itself (the single authoritative source of "which
    # tiers this request actually queried"), never re-derived from
    # conversation_id/project_ids/include_* independently, so this can
    # never drift from what resolve_scope_plan() actually decided. "none"
    # only if every tier toggle is off (see ConversationScopeSettings) —
    # general is otherwise always present, so "none" is rare in practice.
    timer = get_current_timer()
    if timer.enabled:
        if retrieval_mode_label is not None:
            timer.record_tag("retrieval_mode", retrieval_mode_label)
        else:
            tier_names = list(dict.fromkeys(tier.name for tier in plan.tiers))
            timer.record_tag("retrieval_mode", "+".join(tier_names) if tier_names else "none")
        if conversation_id is not None:
            timer.record_tag("conversation_id", conversation_id)
    raw_sources = execute_scope_plan(retriever, query, plan, user_id=user_id, filters=filters)[
        :top_k
    ]
    # "prompt_construction" starts here (context dedup/trim + citation
    # building) and continues in RagService.prepare() below (the actual
    # system/user prompt strings) — both recorded under the same stage
    # name, summed together in RequestTimer.as_dict().
    with get_current_timer().stage("prompt_construction"):
        prepared_sources = prepare_context(
            raw_sources,
            max_per_document=max_chunks_per_document,
            max_total_chars=max_total_context_chars,
            similarity_threshold=dedup_similarity_threshold,
            source_order=source_order,
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
        prompt_variant: PromptVariant = "current",
        source_order: SourceOrder = "relevance",
    ) -> None:
        """`prompt_variant`/`source_order` (Settings.rag_prompt_variant /
        Settings.rag_source_order — see app/core/prompt_builder.py and
        app/core/context_preparation.py) both default to this class's
        original, unchanged behavior; a caller that doesn't pass them
        (every call site before this Oracle CPU-host prompt-prefill
        investigation) is unaffected."""
        self._retriever = retriever
        self._llm_provider = llm_provider
        self._model_name = model_name
        self._max_chunks_per_document = max_chunks_per_document
        self._max_total_context_chars = max_total_context_chars
        self._dedup_similarity_threshold = dedup_similarity_threshold
        self._chat_scope_top_k = chat_scope_top_k
        self._project_scope_top_k = project_scope_top_k
        self._prompt_variant = prompt_variant
        self._source_order = source_order

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
        writing_context: str | None = None,
        include_chat: bool = True,
        include_project: bool = True,
        include_general: bool = True,
        strict_mode: bool = False,
    ) -> PreparedChat:
        """`strict_mode` (Milestone 4 — Zoom-In) is purely additive
        observability/prompt wiring on top of the retrieval restriction a
        caller already expresses via include_project=False,
        include_general=False: it does not itself change which tiers are
        queried (the caller — see app/api/routes_conversations.py's
        `_effective_scope_flags` — decides that), it only (a) tags this
        retrieval's `retrieval_mode` as "zoom_in" instead of the
        tier-derived label, and (b) appends the small Zoom-In prompt
        addendum (see prompt_builder._ZOOM_IN_ADDENDUM). False by default —
        every existing caller is unaffected."""
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
            source_order=self._source_order,
            retrieval_mode_label="zoom_in" if strict_mode else None,
        )
        insufficient_evidence = len(evidence.sources) == 0
        with get_current_timer().stage("prompt_construction"):
            system_prompt, user_prompt = build_chat_prompt(
                query,
                evidence.sources,
                project_context=project_context,
                prompt_variant=self._prompt_variant,
                strict_mode=strict_mode,
                writing_context=writing_context,
            )
        _record_prompt_metadata(
            get_current_timer(),
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            query=query,
            sources=evidence.sources,
        )

        return PreparedChat(
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            retrieved_sources=evidence.sources,
            citations=evidence.citations,
            insufficient_evidence=insufficient_evidence,
        )

    def stream_answer(
        self,
        prepared: PreparedChat,
        *,
        timer: RequestTimer | None = None,
        options_override: Mapping[str, object] | None = None,
    ) -> Iterator[str]:
        yield from self._llm_provider.stream_chat(
            system_prompt=prepared.system_prompt,
            user_prompt=prepared.user_prompt,
            timer=timer,
            options_override=options_override,
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
        strict_mode: bool = False,
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
            strict_mode=strict_mode,
        )

        if prepared.insufficient_evidence:
            answer = ZOOM_IN_NO_EVIDENCE_ANSWER if strict_mode else NO_EVIDENCE_ANSWER
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
