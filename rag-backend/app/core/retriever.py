from collections import OrderedDict

from app.core.embedding_provider import EmbeddingProvider
from app.core.mmr import select_mmr
from app.core.retrieval_schemas import RetrievalFilters, RetrievedChunk
from app.vectorstore.qdrant_client import QdrantVectorStore
from app.vectorstore.schemas import VectorSearchResult, VectorStoreFilter

_DEFAULT_TOP_K = 8
_DEFAULT_FETCH_K = 24
_DEFAULT_RELEVANCE_WEIGHT = 0.7
# Bounds the query-embedding cache below (research workspace performance
# pass) — a scope-aware chat turn calls retrieve() once per tier (chat,
# project(s), general — see app/core/scoped_retrieval.py) with the exact
# same query text every time, which used to re-embed it on every call. A
# small bounded LRU is enough to dedupe that intra-turn repetition (and
# incidentally repeated identical queries across turns/users) without
# growing unbounded on a long-lived, process-wide Retriever instance.
_DEFAULT_QUERY_EMBEDDING_CACHE_SIZE = 128


class _Unset:
    """Distinguishes 'caller didn't pass min_score' (use the instance
    default) from 'caller explicitly passed None' (force-disable for this
    call even if the instance has one configured) — plain None can't do
    both jobs at once. Used only by Retriever.retrieve()'s min_score
    parameter, e.g. by scripts/calibrate_threshold.py sweeping candidate
    thresholds against one long-lived Retriever instance."""


_UNSET = _Unset()


def _to_vector_store_filter(filters: RetrievalFilters | None) -> VectorStoreFilter | None:
    if filters is None:
        return None
    return VectorStoreFilter(
        document_type=filters.document_type,
        journal_quartile=filters.journal_quartile,
        publication_year_from=filters.publication_year_from,
        publication_year_to=filters.publication_year_to,
        author=filters.author,
        source_venue=filters.source_venue,
    )


def _to_retrieved_chunk(result: VectorSearchResult) -> RetrievedChunk:
    payload = result.payload
    return RetrievedChunk(
        score=result.score,
        text=payload.text,
        document_id=payload.document_id,
        chunk_id=result.id,
        document_type=payload.document_type,
        journal_quartile=payload.journal_quartile,
        title=payload.title,
        authors=payload.authors,
        publication_year=payload.publication_year,
        source_venue=payload.source_venue,
        doi=payload.doi,
        source_url=payload.source_url,
        source_filename=payload.source_filename,
        chunk_index=payload.chunk_index,
        page_number=payload.page_number,
    )


class Retriever:
    def __init__(
        self,
        *,
        embedding_provider: EmbeddingProvider,
        vector_store: QdrantVectorStore,
        relevance_weight: float = _DEFAULT_RELEVANCE_WEIGHT,
        fetch_k: int = _DEFAULT_FETCH_K,
        min_score: float | None = None,
        query_embedding_cache_size: int = _DEFAULT_QUERY_EMBEDDING_CACHE_SIZE,
    ) -> None:
        self._embedding_provider = embedding_provider
        self._vector_store = vector_store
        self._relevance_weight = relevance_weight
        self._fetch_k = fetch_k
        # Disabled (None) by default — see Settings.retrieval_min_score. When
        # set, candidates below this cosine-similarity score are dropped
        # *before* MMR selection, same as if retrieval never found them —
        # which can make insufficient_evidence true if it drops everything.
        self._min_score = min_score
        self._query_embedding_cache: OrderedDict[str, list[float]] = OrderedDict()
        self._query_embedding_cache_size = query_embedding_cache_size

    def _embed_query(self, query: str) -> list[float]:
        cached = self._query_embedding_cache.get(query)
        if cached is not None:
            self._query_embedding_cache.move_to_end(query)
            return cached

        vector = self._embedding_provider.embed_batch([query])[0]
        self._query_embedding_cache[query] = vector
        if len(self._query_embedding_cache) > self._query_embedding_cache_size:
            self._query_embedding_cache.popitem(last=False)
        return vector

    def retrieve(
        self,
        query: str,
        *,
        user_id: str,
        top_k: int = _DEFAULT_TOP_K,
        fetch_k: int | None = None,
        filters: RetrievalFilters | None = None,
        min_score: float | None | _Unset = _UNSET,
        conversation_id: str | None = None,
        project_id: str | None = None,
    ) -> list[RetrievedChunk]:
        if not query.strip():
            return []

        effective_fetch_k = fetch_k if fetch_k is not None else self._fetch_k
        effective_min_score = self._min_score if isinstance(min_score, _Unset) else min_score

        query_vector = self._embed_query(query)

        candidates = self._vector_store.search(
            query_vector,
            limit=max(top_k, effective_fetch_k),
            user_id=user_id,
            vector_filter=_to_vector_store_filter(filters),
            with_vectors=True,
            conversation_id=conversation_id,
            project_id=project_id,
        )

        if effective_min_score is not None:
            candidates = [c for c in candidates if c.score >= effective_min_score]

        mmr_input: list[tuple[VectorSearchResult, list[float], float]] = [
            (candidate, candidate.vector, candidate.score)
            for candidate in candidates
            if candidate.vector is not None
        ]

        selected = select_mmr(mmr_input, top_k=top_k, relevance_weight=self._relevance_weight)

        return [_to_retrieved_chunk(result) for result in selected]
