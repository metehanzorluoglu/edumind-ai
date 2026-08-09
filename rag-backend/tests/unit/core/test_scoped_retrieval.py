"""Covers app/core/scoped_retrieval.py directly: the priority-ordered
(Chat > Project > General) tier plan resolve_scope_plan() builds, and
execute_scope_plan()'s blend/dedup/user-isolation guarantees — the core
mechanism Milestone 2 (conversation document scope) exposes to users via
POST/PUT/GET/DELETE /conversations/{id}/documents.
"""

from app.core.retrieval_schemas import RetrievedChunk
from app.core.scoped_retrieval import ScopePlan, ScopeTier, execute_scope_plan, resolve_scope_plan


def _chunk(chunk_id: str, document_id: str = "doc-1") -> RetrievedChunk:
    return RetrievedChunk(
        score=0.9,
        text=f"text for {chunk_id}",
        document_id=document_id,
        chunk_id=chunk_id,
        document_type="report",
        source_filename="doc.pdf",
        chunk_index=0,
        page_number=1,
    )


class TestResolveScopePlan:
    def test_no_conversation_no_projects_yields_only_general_tier(self) -> None:
        plan = resolve_scope_plan(
            conversation_id=None, project_ids=[], chat_top_k=5, project_top_k=5, general_top_k=8
        )
        assert [t.name for t in plan.tiers] == ["general"]

    def test_conversation_id_adds_a_chat_tier_first(self) -> None:
        plan = resolve_scope_plan(
            conversation_id="conv-1",
            project_ids=[],
            chat_top_k=5,
            project_top_k=5,
            general_top_k=8,
        )
        assert [t.name for t in plan.tiers] == ["chat", "general"]
        assert plan.tiers[0].conversation_id == "conv-1"

    def test_one_project_tier_per_project_id_between_chat_and_general(self) -> None:
        plan = resolve_scope_plan(
            conversation_id="conv-1",
            project_ids=["proj-a", "proj-b"],
            chat_top_k=5,
            project_top_k=5,
            general_top_k=8,
        )
        assert [t.name for t in plan.tiers] == ["chat", "project", "project", "general"]
        assert [t.project_id for t in plan.tiers if t.name == "project"] == ["proj-a", "proj-b"]

    def test_include_chat_false_omits_chat_tier_even_with_conversation_id(self) -> None:
        """The per-conversation scope toggle bar's effect (see
        app/db/models_conversation_scope.py) — Milestone 2 does not change
        this; conversation document scope only decides *which documents*
        the chat tier draws from once it's included."""
        plan = resolve_scope_plan(
            conversation_id="conv-1",
            project_ids=[],
            chat_top_k=5,
            project_top_k=5,
            general_top_k=8,
            include_chat=False,
        )
        assert [t.name for t in plan.tiers] == ["general"]

    def test_include_project_false_omits_every_project_tier(self) -> None:
        plan = resolve_scope_plan(
            conversation_id=None,
            project_ids=["proj-a", "proj-b"],
            chat_top_k=5,
            project_top_k=5,
            general_top_k=8,
            include_project=False,
        )
        assert [t.name for t in plan.tiers] == ["general"]

    def test_include_general_false_omits_general_tier(self) -> None:
        """General is otherwise ALWAYS present — this is the one way it's
        ever skipped, and it's an explicit per-conversation opt-out, never
        a side effect of narrowing conversation/project scope."""
        plan = resolve_scope_plan(
            conversation_id="conv-1",
            project_ids=[],
            chat_top_k=5,
            project_top_k=5,
            general_top_k=8,
            include_general=False,
        )
        assert [t.name for t in plan.tiers] == ["chat"]

    def test_empty_conversation_and_projects_with_all_tiers_disabled_yields_no_tiers(self) -> None:
        plan = resolve_scope_plan(
            conversation_id=None,
            project_ids=[],
            chat_top_k=5,
            project_top_k=5,
            general_top_k=8,
            include_chat=False,
            include_project=False,
            include_general=False,
        )
        assert plan.tiers == []


class _RecordingRetriever:
    """Fake retriever returning pre-scripted results per tier (by scope
    kwargs), and recording every call's kwargs — lets tests assert
    execute_scope_plan() queries every tier with the right scoping AND
    that user_id is passed on every single call unconditionally."""

    def __init__(self, by_tier: dict[tuple[str | None, str | None], list[RetrievedChunk]]) -> None:
        self._by_tier = by_tier
        self.calls: list[dict[str, object]] = []

    def retrieve(self, query, *, user_id, top_k=8, filters=None, conversation_id=None,
                 project_id=None):
        self.calls.append(
            {
                "user_id": user_id,
                "top_k": top_k,
                "conversation_id": conversation_id,
                "project_id": project_id,
            }
        )
        return list(self._by_tier.get((conversation_id, project_id), []))


class TestExecuteScopePlan:
    def test_user_id_is_passed_to_every_tier_call_unconditionally(self) -> None:
        """Security invariant (Milestone 2 §7): conversation/project scope
        filtering is always ADDITIVE to the user filter, never a
        replacement — proven here by asserting every tier call in a
        multi-tier plan carries the exact same user_id."""
        retriever = _RecordingRetriever({})
        plan = ScopePlan(
            tiers=[
                ScopeTier(name="chat", top_k=5, conversation_id="conv-1"),
                ScopeTier(name="project", top_k=5, project_id="proj-1"),
                ScopeTier(name="general", top_k=8),
            ]
        )

        execute_scope_plan(retriever, "query", plan, user_id="user-42", filters=None)

        assert len(retriever.calls) == 3
        assert all(call["user_id"] == "user-42" for call in retriever.calls)

    def test_chat_tier_only_returns_conversation_associated_chunks(self) -> None:
        """Direct proof of "scoped retrieval only considers
        conversation-associated docs at the conversation tier": the chat
        tier's own results come only from what the (fake, standing in for
        Qdrant's conversation_id-filtered) retriever returns for that
        conversation_id — general-tier chunks from unrelated documents
        never leak into the chat tier's contribution."""
        chat_chunk = _chunk("chat-chunk", document_id="scoped-doc")
        general_chunk = _chunk("general-chunk", document_id="unscoped-doc")
        retriever = _RecordingRetriever(
            {("conv-1", None): [chat_chunk], (None, None): [general_chunk]}
        )
        plan = resolve_scope_plan(
            conversation_id="conv-1", project_ids=[], chat_top_k=5, project_top_k=5,
            general_top_k=8,
        )

        merged = execute_scope_plan(retriever, "query", plan, user_id="user-1", filters=None)

        assert [c.chunk_id for c in merged] == ["chat-chunk", "general-chunk"]
        assert merged[0].scope == "chat"
        assert merged[1].scope == "general"

    def test_dedup_keeps_the_highest_priority_tiers_rank(self) -> None:
        """A chunk appearing in both the chat tier and the general tier
        (the same document is both conversation-scoped AND part of the
        general corpus, as every document always is) is kept once, tagged
        with the higher-priority tier's scope."""
        shared_chunk = _chunk("shared-chunk", document_id="doc-1")
        retriever = _RecordingRetriever(
            {("conv-1", None): [shared_chunk], (None, None): [shared_chunk]}
        )
        plan = resolve_scope_plan(
            conversation_id="conv-1", project_ids=[], chat_top_k=5, project_top_k=5,
            general_top_k=8,
        )

        merged = execute_scope_plan(retriever, "query", plan, user_id="user-1", filters=None)

        assert len(merged) == 1
        assert merged[0].scope == "chat"  # kept the higher-priority tier's tag

    def test_zero_conversation_associations_falls_back_to_general_only(self) -> None:
        """Milestone 2 §8 (empty scope behavior): a conversation with a
        chat tier active but zero associated documents contributes nothing
        from that tier — general retrieval still runs and is NOT starved.
        Byte-for-byte the documented "general is never skipped" contract."""
        general_chunk = _chunk("general-chunk")
        retriever = _RecordingRetriever({(None, None): [general_chunk]})
        plan = resolve_scope_plan(
            conversation_id="conv-1", project_ids=[], chat_top_k=5, project_top_k=5,
            general_top_k=8,
        )

        merged = execute_scope_plan(retriever, "query", plan, user_id="user-1", filters=None)

        assert [c.chunk_id for c in merged] == ["general-chunk"]
        assert merged[0].scope == "general"
