"""Covers app/core/context_preparation.py's prepare_context — in
particular the `source_order` parameter added by the Oracle CPU-host
prompt-prefill investigation (see that module's docstring): "stable"
ordering must never change *which* chunks survive dedup/diversity/budget
selection, only the order they're returned in.
"""

from app.core.context_preparation import prepare_context
from app.core.retrieval_schemas import RetrievedChunk


def _chunk(
    *, text: str, document_id: str = "doc-1", chunk_index: int = 0, chunk_id: str | None = None
) -> RetrievedChunk:
    return RetrievedChunk(
        score=0.9,
        text=text,
        document_id=document_id,
        chunk_id=chunk_id or f"{document_id}-{chunk_index}",
        document_type="journal_article",
        source_filename="doc.pdf",
        chunk_index=chunk_index,
        page_number=1,
    )


class TestSourceOrderDefault:
    def test_relevance_is_the_default_and_preserves_input_order(self) -> None:
        chunks = [
            _chunk(text="third best", document_id="doc-c"),
            _chunk(text="best", document_id="doc-a"),
            _chunk(text="second best", document_id="doc-b"),
        ]
        result = prepare_context(chunks)
        assert [c.document_id for c in result] == ["doc-c", "doc-a", "doc-b"]


class TestSourceOrderStable:
    def test_sorts_by_document_id_then_chunk_index(self) -> None:
        chunks = [
            _chunk(text="c", document_id="doc-b", chunk_index=0),
            _chunk(text="a", document_id="doc-a", chunk_index=1),
            _chunk(text="b", document_id="doc-a", chunk_index=0),
        ]
        result = prepare_context(chunks, source_order="stable")
        assert [(c.document_id, c.chunk_index) for c in result] == [
            ("doc-a", 0),
            ("doc-a", 1),
            ("doc-b", 0),
        ]

    def test_never_changes_which_chunks_are_selected_vs_relevance_order(self) -> None:
        # A char budget that only fits 2 of 3 chunks — *which* two survive
        # must be governed by relevance rank (input order) regardless of
        # source_order; only their final presentation order may differ.
        chunks = [
            _chunk(text="a" * 100, document_id="doc-a"),
            _chunk(text="b" * 100, document_id="doc-b"),
            _chunk(text="c" * 100, document_id="doc-c"),
        ]
        relevance_result = prepare_context(chunks, max_total_chars=250, source_order="relevance")
        stable_result = prepare_context(chunks, max_total_chars=250, source_order="stable")
        assert {c.document_id for c in relevance_result} == {c.document_id for c in stable_result}
        assert len(relevance_result) == 2

    def test_stable_order_is_deterministic_across_different_input_orders(self) -> None:
        a = _chunk(text="a", document_id="doc-a", chunk_index=0)
        b = _chunk(text="b", document_id="doc-b", chunk_index=0)
        result_1 = prepare_context([a, b], source_order="stable")
        result_2 = prepare_context([b, a], source_order="stable")
        assert [c.document_id for c in result_1] == [c.document_id for c in result_2]

    def test_dedup_and_diversity_still_apply_before_stable_sort(self) -> None:
        chunks = [
            _chunk(text="same text here", document_id="doc-a", chunk_index=0),
            _chunk(text="same text here", document_id="doc-a", chunk_index=1),  # near-duplicate
        ]
        result = prepare_context(chunks, source_order="stable", similarity_threshold=0.9)
        assert len(result) == 1
