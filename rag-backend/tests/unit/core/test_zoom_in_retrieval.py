"""Covers Milestone 4 (Zoom-In / strict selected-source mode) at the
retrieval/prompt level: no new retrieval code path exists for Zoom-In (see
app/api/routes_conversations.py's `_effective_scope_flags`) — it is
entirely `resolve_scope_plan(include_project=False, include_general=False)`
plus RagService.prepare's `strict_mode` flag, both pre-existing mechanisms
extended, not duplicated. This file proves:

1. Strictness/leakage: with a deliberately crafted two-document corpus (one
   in scope, one NOT — but highly "relevant" and returned instantly by the
   fake retriever if any excluded tier were ever queried), Zoom-In's merged
   result and citations contain ONLY the in-scope document, and the
   project/general tiers are proven to have never executed at all (zero
   recorded calls), not merely "returned nothing."
2. Observability: retrieval_mode is tagged the distinct "zoom_in" value,
   never merely "chat" (which is also reachable via the ordinary toggle
   bar with project/general off, and must stay distinguishable from it).
3. Prompt: the Zoom-In addendum is appended only when strict_mode=True,
   and every other call site's prompt is byte-for-byte unchanged.
4. Insufficient-evidence: RagService.run() selects the context-aware
   ZOOM_IN_NO_EVIDENCE_ANSWER (not the generic NO_EVIDENCE_ANSWER) when
   strict_mode is active and nothing was found.
"""

from app.core.prompt_builder import (
    NO_EVIDENCE_ANSWER,
    ZOOM_IN_NO_EVIDENCE_ANSWER,
    build_chat_prompt,
)
from app.core.rag_service import RagService
from app.core.request_timing import RequestTimer, bind_timer, unbind_timer
from app.core.retrieval_schemas import RetrievedChunk


def _chunk(chunk_id: str, document_id: str, text: str = "text") -> RetrievedChunk:
    return RetrievedChunk(
        score=0.9,
        text=text,
        document_id=document_id,
        chunk_id=chunk_id,
        document_type="report",
        source_filename=f"{document_id}.pdf",
        chunk_index=0,
        page_number=1,
    )


class _RecordingScopedRetriever:
    """Two-document corpus: `in_scope_chunk` (document A, associated with
    the conversation) and `out_of_scope_chunk` (document B, NOT associated
    — but the fake retriever would happily hand it back the instant the
    project or general tier is queried at all, exactly the leakage this
    test exists to rule out). Records every call's tier-identifying kwargs
    so "never queried" can be asserted directly, not just "returned
    nothing.\""""

    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []

    def retrieve(
        self, query, *, user_id, top_k=8, filters=None, conversation_id=None, project_id=None
    ):
        self.calls.append(
            {
                "user_id": user_id,
                "conversation_id": conversation_id,
                "project_id": project_id,
            }
        )
        if conversation_id == "conv-1":
            return [_chunk("chat-chunk", "doc-a", text="in-scope evidence")]
        # Both the project tier (project_id set) and the general tier
        # (neither set) would return the out-of-scope document — proving
        # Zoom-In's safety depends on these calls never happening, not on
        # this fake coincidentally filtering them out itself.
        return [_chunk("leak-chunk", "doc-b", text="out-of-scope evidence")]


class _FakeLLMProvider:
    def stream_chat(self, *, system_prompt, user_prompt, timer=None, options_override=None):
        yield "answer"


class TestZoomInStrictnessAndLeakage:
    def test_project_and_general_tiers_never_execute(self) -> None:
        retriever = _RecordingScopedRetriever()
        rag_service = RagService(
            retriever=retriever, llm_provider=_FakeLLMProvider(), model_name="m"
        )

        rag_service.prepare(
            "question",
            user_id="user-1",
            conversation_id="conv-1",
            project_ids=("proj-1",),  # a real project association exists...
            include_chat=True,
            include_project=False,  # ...but Zoom-In excludes it entirely
            include_general=False,
            strict_mode=True,
        )

        # Exactly one retrieve() call total — the chat tier — never three.
        assert len(retriever.calls) == 1
        assert retriever.calls[0]["conversation_id"] == "conv-1"
        assert retriever.calls[0]["project_id"] is None

    def test_out_of_scope_document_never_appears_in_sources_or_citations(self) -> None:
        retriever = _RecordingScopedRetriever()
        rag_service = RagService(
            retriever=retriever, llm_provider=_FakeLLMProvider(), model_name="m"
        )

        prepared = rag_service.prepare(
            "question",
            user_id="user-1",
            conversation_id="conv-1",
            project_ids=("proj-1",),
            include_chat=True,
            include_project=False,
            include_general=False,
            strict_mode=True,
        )

        document_ids = {s.document_id for s in prepared.retrieved_sources}
        assert document_ids == {"doc-a"}
        assert "doc-b" not in document_ids
        cited_document_ids = {c.document_id for c in prepared.citations}
        assert "doc-b" not in cited_document_ids

    def test_ordinary_prioritize_mode_still_blends_all_three_tiers(self) -> None:
        """Control case: with Zoom-In's include_* overrides NOT applied
        (i.e. today's Prioritize behavior), the general/project tiers DO
        execute and DO contribute — proving the leakage test above is
        actually exercising Zoom-In's restriction, not some accidental
        property of the fake retriever."""
        retriever = _RecordingScopedRetriever()
        rag_service = RagService(
            retriever=retriever, llm_provider=_FakeLLMProvider(), model_name="m"
        )

        prepared = rag_service.prepare(
            "question",
            user_id="user-1",
            conversation_id="conv-1",
            project_ids=("proj-1",),
            include_chat=True,
            include_project=True,
            include_general=True,
            strict_mode=False,
        )

        assert len(retriever.calls) == 3
        document_ids = {s.document_id for s in prepared.retrieved_sources}
        assert "doc-b" in document_ids  # the out-of-scope doc DOES leak in when not Zoom-In


class TestZoomInObservability:
    def test_retrieval_mode_is_tagged_zoom_in_not_chat(self) -> None:
        retriever = _RecordingScopedRetriever()
        rag_service = RagService(
            retriever=retriever, llm_provider=_FakeLLMProvider(), model_name="m"
        )
        timer = RequestTimer(enabled=True, label="test")
        token = bind_timer(timer)
        try:
            rag_service.prepare(
                "question",
                user_id="user-1",
                conversation_id="conv-1",
                include_chat=True,
                include_project=False,
                include_general=False,
                strict_mode=True,
            )
        finally:
            unbind_timer(token)

        assert timer.tags_dict()["retrieval_mode"] == "zoom_in"

    def test_ordinary_chat_only_toggle_bar_state_is_tagged_chat_not_zoom_in(self) -> None:
        """Distinguishes "the user's own toggle bar happens to have
        project/general off" from Zoom-In — same tier plan, different
        (and NOT confusable) retrieval_mode tag."""
        retriever = _RecordingScopedRetriever()
        rag_service = RagService(
            retriever=retriever, llm_provider=_FakeLLMProvider(), model_name="m"
        )
        timer = RequestTimer(enabled=True, label="test")
        token = bind_timer(timer)
        try:
            rag_service.prepare(
                "question",
                user_id="user-1",
                conversation_id="conv-1",
                include_chat=True,
                include_project=False,
                include_general=False,
                strict_mode=False,
            )
        finally:
            unbind_timer(token)

        assert timer.tags_dict()["retrieval_mode"] == "chat"


class TestZoomInPrompt:
    def test_strict_mode_appends_addendum(self) -> None:
        system_prompt, _ = build_chat_prompt("q", [_chunk("c1", "doc-a")], strict_mode=True)
        assert "Zoom-In mode:" in system_prompt

    def test_default_prompt_is_byte_identical_without_strict_mode(self) -> None:
        with_default = build_chat_prompt("q", [_chunk("c1", "doc-a")])
        without_flag = build_chat_prompt("q", [_chunk("c1", "doc-a")], strict_mode=False)
        assert with_default == without_flag
        assert "Zoom-In mode:" not in with_default[0]

    def test_strict_mode_addendum_applies_to_compact_variant_too(self) -> None:
        system_prompt, _ = build_chat_prompt(
            "q", [_chunk("c1", "doc-a")], prompt_variant="compact", strict_mode=True
        )
        assert "Zoom-In mode:" in system_prompt


class TestZoomInInsufficientEvidence:
    def test_run_uses_context_aware_message_when_strict_mode_and_no_sources(self) -> None:
        class _EmptyRetriever:
            def retrieve(self, *a, **kw):
                return []

        rag_service = RagService(
            retriever=_EmptyRetriever(), llm_provider=_FakeLLMProvider(), model_name="m"
        )

        result = rag_service.run("q", user_id="user-1", conversation_id="conv-1", strict_mode=True)

        assert result.insufficient_evidence is True
        assert result.answer == ZOOM_IN_NO_EVIDENCE_ANSWER
        assert result.answer != NO_EVIDENCE_ANSWER

    def test_run_uses_generic_message_when_not_strict_mode(self) -> None:
        class _EmptyRetriever:
            def retrieve(self, *a, **kw):
                return []

        rag_service = RagService(
            retriever=_EmptyRetriever(), llm_provider=_FakeLLMProvider(), model_name="m"
        )

        result = rag_service.run("q", user_id="user-1")

        assert result.answer == NO_EVIDENCE_ANSWER
