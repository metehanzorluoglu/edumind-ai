"""Covers app/core/rag_service.py's RagService.prepare() additions from the
Oracle CPU-host prompt-prefill investigation: prompt_variant/source_order
wiring, and _record_prompt_metadata's safe (metadata-only, never content)
profiling output.
"""

from app.core.rag_service import RagService
from app.core.request_timing import RequestTimer, bind_timer, unbind_timer
from app.core.retrieval_schemas import RetrievedChunk


def _chunk(text: str, document_id: str = "doc-1", chunk_index: int = 0) -> RetrievedChunk:
    return RetrievedChunk(
        score=0.9,
        text=text,
        document_id=document_id,
        chunk_id=f"{document_id}-{chunk_index}",
        document_type="journal_article",
        source_filename="doc.pdf",
        chunk_index=chunk_index,
        page_number=1,
    )


class _FakeRetriever:
    def __init__(self, chunks: list[RetrievedChunk]) -> None:
        self._chunks = chunks

    def retrieve(
        self, query, *, user_id, top_k=8, filters=None, conversation_id=None, project_id=None
    ):
        return list(self._chunks)


class _FakeLLMProvider:
    def stream_chat(self, *, system_prompt, user_prompt, timer=None):
        yield "unused"


def _prepare_with_timer(rag_service: RagService, query: str, *, enabled: bool = True):
    timer = RequestTimer(enabled=enabled, label="test")
    token = bind_timer(timer)
    try:
        prepared = rag_service.prepare(query, user_id="user-1")
    finally:
        unbind_timer(token)
    return prepared, timer


class TestPromptVariantWiring:
    def test_default_prompt_variant_is_current(self) -> None:
        rag_service = RagService(
            retriever=_FakeRetriever([_chunk("some evidence")]),
            llm_provider=_FakeLLMProvider(),
            model_name="test-model",
        )
        prepared, _ = _prepare_with_timer(rag_service, "a question", enabled=False)
        assert "Project context rule:" in prepared.system_prompt

    def test_compact_prompt_variant_is_applied_when_configured(self) -> None:
        compact_service = RagService(
            retriever=_FakeRetriever([_chunk("some evidence")]),
            llm_provider=_FakeLLMProvider(),
            model_name="test-model",
            prompt_variant="compact",
        )
        current_service = RagService(
            retriever=_FakeRetriever([_chunk("some evidence")]),
            llm_provider=_FakeLLMProvider(),
            model_name="test-model",
            prompt_variant="current",
        )
        compact_prepared, _ = _prepare_with_timer(compact_service, "a question", enabled=False)
        current_prepared, _ = _prepare_with_timer(current_service, "a question", enabled=False)
        assert "Project context rule:" not in compact_prepared.system_prompt
        # Relative, not a fixed magic number: both variants grew when the
        # cross-source corroboration fix added source-identity rules to
        # each (see app/core/prompt_builder.py) — "compact" only promises
        # to stay meaningfully smaller than "current", not any fixed size.
        assert len(compact_prepared.system_prompt) < len(current_prepared.system_prompt) * 0.6


class TestSourceOrderWiring:
    def test_stable_source_order_is_applied_when_configured(self) -> None:
        chunks = [_chunk("b", document_id="doc-b"), _chunk("a", document_id="doc-a")]
        rag_service = RagService(
            retriever=_FakeRetriever(chunks),
            llm_provider=_FakeLLMProvider(),
            model_name="test-model",
            source_order="stable",
        )
        prepared, _ = _prepare_with_timer(rag_service, "a question", enabled=False)
        assert [c.document_id for c in prepared.retrieved_sources] == ["doc-a", "doc-b"]


class TestPromptMetadataProfiling:
    def test_records_lengths_for_every_prompt_component(self) -> None:
        chunks = [_chunk("x" * 100), _chunk("y" * 50, document_id="doc-2")]
        rag_service = RagService(
            retriever=_FakeRetriever(chunks), llm_provider=_FakeLLMProvider(), model_name="m"
        )
        _, timer = _prepare_with_timer(rag_service, "What is X?", enabled=True)
        metrics = timer.as_dict()

        assert metrics["system_prompt_characters"] > 0
        assert metrics["system_prompt_tokens_est"] > 0
        assert metrics["context_tokens_est"] > 0
        assert metrics["question_characters"] == len("What is X?")
        assert metrics["question_tokens_est"] > 0
        assert metrics["final_prompt_characters"] > 0
        assert metrics["chunk_1_characters"] == 100
        assert metrics["chunk_2_characters"] == 50
        assert metrics["chunk_1_tokens_est"] == 25
        # round(50 / 4) == round(12.5) == 12 — Python's round() uses
        # banker's rounding (round-half-to-even), matching the production
        # code's own round() call exactly (see _record_prompt_metadata).
        assert metrics["chunk_2_tokens_est"] == 12

    def test_records_nothing_when_profiling_disabled(self) -> None:
        rag_service = RagService(
            retriever=_FakeRetriever([_chunk("some evidence")]),
            llm_provider=_FakeLLMProvider(),
            model_name="m",
        )
        _, timer = _prepare_with_timer(rag_service, "a question", enabled=False)
        assert timer.as_dict() == {}

    def test_never_includes_chunk_text_system_prompt_text_or_question_text(self) -> None:
        # The actual "never log private document text" requirement: every
        # metric value must be a plain number, and none of the private
        # source text, the (fixed, non-secret) system prompt text, or the
        # user's own question text may appear as a *value* anywhere in the
        # recorded metrics dict.
        secret_chunk_text = "CONFIDENTIAL-STUDY-FINDING-42"
        secret_question = "What about CONFIDENTIAL-STUDY-FINDING-42?"
        rag_service = RagService(
            retriever=_FakeRetriever([_chunk(secret_chunk_text)]),
            llm_provider=_FakeLLMProvider(),
            model_name="m",
        )
        _, timer = _prepare_with_timer(rag_service, secret_question, enabled=True)
        metrics = timer.as_dict()

        assert all(isinstance(value, int | float) for value in metrics.values())
        serialized = str(metrics)
        assert secret_chunk_text not in serialized
        assert secret_question not in serialized
        assert "CONFIDENTIAL" not in serialized

    def test_handles_zero_retrieved_chunks(self) -> None:
        rag_service = RagService(
            retriever=_FakeRetriever([]), llm_provider=_FakeLLMProvider(), model_name="m"
        )
        prepared, timer = _prepare_with_timer(rag_service, "a question", enabled=True)
        assert prepared.insufficient_evidence is True
        metrics = timer.as_dict()
        assert metrics["context_tokens_est"] == 0
