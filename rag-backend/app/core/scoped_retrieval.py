"""Resolves and executes the blended, priority-ordered multi-tier scope
retrieval plan (Chat > Project > General) — see retrieve_and_cite in
app/core/rag_service.py, its only caller. Mirrors app/core/model_routing.py's
style: a tiny module, a pure resolution function, a frozen dataclass result.

"Blended & ordered": every tier is always queried — General is never
skipped, even when Chat/Project tiers exist — and results are concatenated
chat-tier-then-project-tier(s)-then-general-tier, with a chunk that already
appeared at a higher-priority tier dropped at any lower-priority tier (see
execute_scope_plan). This is exactly what makes a conversation with zero
chat/project document associations produce a byte-for-byte identical merged
list to calling Retriever.retrieve() once directly: the chat tier simply
contributes nothing, and (with no project associations) no project tier
exists at all, leaving only the general tier's own results, in the general
tier's own order.
"""

from dataclasses import dataclass, field
from typing import Literal, Protocol

from app.core.retrieval_schemas import RetrievalFilters, RetrievedChunk


class ScopedRetrieverLike(Protocol):
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


@dataclass(frozen=True)
class ScopeTier:
    name: Literal["chat", "project", "general"]
    top_k: int
    conversation_id: str | None = None
    project_id: str | None = None


@dataclass(frozen=True)
class ScopePlan:
    tiers: list[ScopeTier] = field(default_factory=list)


def resolve_scope_plan(
    *,
    conversation_id: str | None,
    project_ids: list[str],
    chat_top_k: int,
    project_top_k: int,
    general_top_k: int,
    include_chat: bool = True,
    include_project: bool = True,
    include_general: bool = True,
) -> ScopePlan:
    """Builds the ordered tier list for one retrieval: a chat tier only if
    `conversation_id` is given, one project tier per id in `project_ids`
    (a conversation may belong to more than one project — see
    ProjectsRepository.get_project_ids_for_conversation), and a general
    tier always last. `include_chat`/`include_project`/`include_general`
    (research workspace milestone — see
    app/db/models_conversation_scope.py's per-conversation toggle bar) omit
    that tier entirely when False; all default True, so a caller that
    never passes them (none exist outside that feature) gets byte-for-byte
    today's "general is never skipped" behavior unchanged."""
    tiers: list[ScopeTier] = []
    if include_chat and conversation_id is not None:
        tiers.append(ScopeTier(name="chat", top_k=chat_top_k, conversation_id=conversation_id))
    if include_project:
        for project_id in project_ids:
            tiers.append(ScopeTier(name="project", top_k=project_top_k, project_id=project_id))
    if include_general:
        tiers.append(ScopeTier(name="general", top_k=general_top_k))
    return ScopePlan(tiers=tiers)


def execute_scope_plan(
    retriever: ScopedRetrieverLike,
    query: str,
    plan: ScopePlan,
    *,
    user_id: str,
    filters: RetrievalFilters | None,
) -> list[RetrievedChunk]:
    """Queries every tier in plan.tiers (already priority-ordered) and
    returns the concatenated, deduplicated (by chunk_id — the Qdrant point
    id, deterministic per document_id+chunk_index, see
    app/vectorstore/qdrant_client.py's _point_id) result list, unranked by
    any second global pass — a chunk keeps whatever rank it earned at the
    highest-priority tier it appeared in. Each chunk is stamped with
    `scope=tier.name` (research workspace milestone — this is the one
    place tier identity is known and would otherwise be discarded once
    tiers are merged) before being added. Does not truncate to an overall
    top_k; the caller (retrieve_and_cite) does that. `user_id` is passed to
    every tier's retrieve() call unconditionally — cross-user isolation is
    never scope-dependent."""
    merged: list[RetrievedChunk] = []
    seen_chunk_ids: set[str] = set()
    for tier in plan.tiers:
        for chunk in retriever.retrieve(
            query,
            user_id=user_id,
            top_k=tier.top_k,
            filters=filters,
            conversation_id=tier.conversation_id,
            project_id=tier.project_id,
        ):
            if chunk.chunk_id in seen_chunk_ids:
                continue
            seen_chunk_ids.add(chunk.chunk_id)
            merged.append(chunk.model_copy(update={"scope": tier.name}))
    return merged
