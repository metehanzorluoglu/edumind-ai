"""Covers app/core/retriever.py's Milestone 2 (conversation document scope)
observability addition: retrieval_candidate_count, the pre-MMR-selection
candidate pool size, accumulated (not overwritten) across multiple
retrieve() calls within one request — see app/core/scoped_retrieval.py,
which calls Retriever.retrieve() once per scope tier (chat, project(s),
general).
"""

from datetime import UTC, datetime

from app.core.request_timing import RequestTimer, bind_timer, unbind_timer
from app.core.retriever import Retriever
from app.vectorstore.schemas import ChunkPayload, VectorSearchResult


def _search_result(document_id: str, chunk_index: int, *, score: float = 0.8) -> VectorSearchResult:
    return VectorSearchResult(
        id=f"{document_id}-{chunk_index}",
        score=score,
        vector=[0.1, 0.2, 0.3],
        payload=ChunkPayload(
            user_id="user-1",
            document_id=document_id,
            document_type="report",
            source_filename=f"{document_id}.pdf",
            ingested_at=datetime.now(UTC),
            chunk_index=chunk_index,
            page_number=1,
            text=f"chunk {chunk_index} of {document_id}",
        ),
    )


class _FakeEmbeddingProvider:
    def embed_batch(self, texts: list[str]) -> list[list[float]]:
        return [[0.1, 0.2, 0.3] for _ in texts]


class _FakeVectorStore:
    def __init__(self, results: list[VectorSearchResult]) -> None:
        self._results = results
        self.search_calls: list[dict[str, object]] = []

    def search(self, query_vector, *, limit, user_id, vector_filter=None, with_vectors=False,
               conversation_id=None, project_id=None):
        self.search_calls.append(
            {"user_id": user_id, "conversation_id": conversation_id, "project_id": project_id}
        )
        return list(self._results)[:limit]


def _with_timer(fn, *, enabled: bool = True):
    timer = RequestTimer(enabled=enabled, label="test")
    token = bind_timer(timer)
    try:
        fn()
    finally:
        unbind_timer(token)
    return timer


def test_retrieve_records_candidate_count_before_mmr_selection() -> None:
    """5 candidates fetched, but top_k=2 selected by MMR — the recorded
    candidate count must reflect the pre-selection pool (5), not the final
    returned count (2), since that's the whole point of this metric (see
    Milestone 2's benchmark: does narrowing scope shrink the candidate
    pool, independent of how many chunks ultimately get used)."""
    results = [_search_result("doc-1", i) for i in range(5)]
    retriever = Retriever(
        embedding_provider=_FakeEmbeddingProvider(), vector_store=_FakeVectorStore(results)
    )

    timer = _with_timer(lambda: retriever.retrieve("query", user_id="user-1", top_k=2))

    assert timer.as_dict()["retrieval_candidate_count"] == 5


def test_retrieve_accumulates_candidate_count_across_multiple_calls() -> None:
    """Simulates scoped_retrieval.py's multi-tier pattern: one Retriever
    instance, retrieve() called once per tier, all within one request/timer
    — the metric must be the SUM across tiers, not just the last tier's
    count."""
    chat_store = _FakeVectorStore([_search_result("doc-1", i) for i in range(2)])
    retriever = Retriever(embedding_provider=_FakeEmbeddingProvider(), vector_store=chat_store)

    def run_two_tiers() -> None:
        retriever.retrieve("query", user_id="user-1", top_k=2, conversation_id="conv-1")
        retriever.retrieve("query", user_id="user-1", top_k=2)

    timer = _with_timer(run_two_tiers)

    assert timer.as_dict()["retrieval_candidate_count"] == 4  # 2 + 2


def test_retrieve_with_disabled_timer_does_not_crash_and_records_nothing() -> None:
    results = [_search_result("doc-1", 0)]
    retriever = Retriever(
        embedding_provider=_FakeEmbeddingProvider(), vector_store=_FakeVectorStore(results)
    )

    timer = _with_timer(
        lambda: retriever.retrieve("query", user_id="user-1", top_k=1), enabled=False
    )

    assert timer.as_dict() == {}


def test_retrieve_passes_conversation_id_and_project_id_through_to_vector_store() -> None:
    """Regression: conversation/project scope filtering must actually reach
    the vector store's search() call — never silently dropped."""
    store = _FakeVectorStore([_search_result("doc-1", 0)])
    retriever = Retriever(embedding_provider=_FakeEmbeddingProvider(), vector_store=store)

    retriever.retrieve(
        "query", user_id="user-42", top_k=1, conversation_id="conv-7", project_id="proj-3"
    )

    assert store.search_calls == [
        {"user_id": "user-42", "conversation_id": "conv-7", "project_id": "proj-3"}
    ]
