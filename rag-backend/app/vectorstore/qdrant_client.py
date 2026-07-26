from typing import Literal
from uuid import NAMESPACE_URL, uuid5

from qdrant_client import QdrantClient, models

from app.ingestion.chunker import Chunk
from app.ingestion.metadata_schema import DocumentMetadata
from app.vectorstore.errors import VectorStoreError
from app.vectorstore.schemas import (
    ChunkPayload,
    DocumentRecord,
    VectorSearchResult,
    VectorStoreFilter,
)

QdrantMode = Literal["local", "server", "memory"]

_SCROLL_PAGE_SIZE = 250
_SCROLL_SAFETY_CAP = 10_000


def _point_id(document_id: str, chunk_index: int) -> str:
    return str(uuid5(NAMESPACE_URL, f"{document_id}:{chunk_index}"))


def _user_id_condition(user_id: str) -> models.FieldCondition:
    return models.FieldCondition(key="user_id", match=models.MatchValue(value=user_id))


def _derive_scope_type(conversation_ids: list[str], project_ids: list[str]) -> list[str]:
    """"general" is always present — every document a user owns is always
    part of their general corpus, regardless of any chat/project
    association (see ChunkPayload.scope_type's docstring: General is
    never excluded, only ranked last in retrieval priority)."""
    scope_type = ["general"]
    if conversation_ids:
        scope_type.append("chat")
    if project_ids:
        scope_type.append("project")
    return scope_type


def _build_filter(
    vector_filter: VectorStoreFilter | None,
    *,
    user_id: str,
    conversation_id: str | None = None,
    project_id: str | None = None,
) -> models.Filter:
    # user_id is unconditionally the first condition — every query this
    # store ever runs is scoped to exactly one owner, regardless of whether
    # the caller passed any other filter at all. A payload written before
    # this field existed (see app/db/models_documents.py's docstring on
    # legacy adoption) simply won't match any condition here, which is the
    # deliberate, free "hidden by default" behavior for pre-auth data.
    conditions: list[models.FieldCondition] = [_user_id_condition(user_id)]
    # Array-contains semantics (same mechanism already used for the
    # `authors` list field below): a chunk matches if its conversation_ids/
    # project_ids array contains this exact value. Still a pure `must` (AND)
    # condition — scope-aware retrieval's "query chat, then project, then
    # general" priority blend is achieved by issuing multiple search() calls
    # (see app/core/scoped_retrieval.py), never by an OR-filter in one call.
    if conversation_id is not None:
        conditions.append(
            models.FieldCondition(
                key="conversation_ids", match=models.MatchValue(value=conversation_id)
            )
        )
    if project_id is not None:
        conditions.append(
            models.FieldCondition(key="project_ids", match=models.MatchValue(value=project_id))
        )
    if vector_filter is None:
        return models.Filter(must=conditions)  # type: ignore[arg-type]

    if vector_filter.document_type is not None:
        conditions.append(
            models.FieldCondition(
                key="document_type", match=models.MatchValue(value=vector_filter.document_type)
            )
        )
    if vector_filter.journal_quartile is not None:
        conditions.append(
            models.FieldCondition(
                key="journal_quartile",
                match=models.MatchValue(value=vector_filter.journal_quartile),
            )
        )
    has_year_range = (
        vector_filter.publication_year_from is not None
        or vector_filter.publication_year_to is not None
    )
    if has_year_range:
        conditions.append(
            models.FieldCondition(
                key="publication_year",
                range=models.Range(
                    gte=vector_filter.publication_year_from,
                    lte=vector_filter.publication_year_to,
                ),
            )
        )
    if vector_filter.author is not None:
        conditions.append(
            models.FieldCondition(
                key="authors", match=models.MatchValue(value=vector_filter.author)
            )
        )
    if vector_filter.source_venue is not None:
        conditions.append(
            models.FieldCondition(
                key="source_venue", match=models.MatchValue(value=vector_filter.source_venue)
            )
        )

    return models.Filter(must=conditions)  # type: ignore[arg-type]


class QdrantVectorStore:
    def __init__(
        self,
        *,
        collection_name: str,
        vector_size: int,
        mode: QdrantMode = "local",
        path: str | None = None,
        url: str | None = None,
        client: QdrantClient | None = None,
    ) -> None:
        self._collection_name = collection_name
        self._vector_size = vector_size

        if client is not None:
            self._client = client
        elif mode == "memory":
            self._client = QdrantClient(location=":memory:")
        elif mode == "server":
            if not url:
                raise VectorStoreError("'url' is required when mode='server'")
            self._client = QdrantClient(url=url)
        elif mode == "local":
            if not path:
                raise VectorStoreError("'path' is required when mode='local'")
            self._client = QdrantClient(path=path)
        else:
            raise VectorStoreError(f"Unknown Qdrant mode: {mode!r}")

    def close(self) -> None:
        """Releases the underlying client (and, in local/embedded mode, the
        on-disk storage lock it holds) so another QdrantVectorStore can open
        the same path afterwards."""
        self._client.close()

    def ping(self) -> None:
        """Actively checks Qdrant reachability, independent of whether
        ensure_collection() has already succeeded and been cached by a
        caller — used by the readiness endpoint, which must reflect the
        server's current reachability, not a memoized past success."""
        try:
            self._client.collection_exists(self._collection_name)
        except Exception as exc:
            raise VectorStoreError(f"Could not reach Qdrant: {exc}") from exc

    def ensure_collection(self) -> None:
        try:
            if not self._client.collection_exists(self._collection_name):
                self._client.create_collection(
                    collection_name=self._collection_name,
                    vectors_config=models.VectorParams(
                        size=self._vector_size, distance=models.Distance.COSINE
                    ),
                )
            # Every query this store runs filters on user_id (see
            # _build_filter) — a keyword payload index turns that from a
            # full collection scan into an indexed lookup. Idempotent: a
            # second call (e.g. on every app restart) is a cheap no-op if
            # the index already exists.
            self._client.create_payload_index(
                collection_name=self._collection_name,
                field_name="user_id",
                field_schema=models.PayloadSchemaType.KEYWORD,
            )
            # Contextual research scopes: conversation_ids/project_ids are
            # list-of-string payload fields queried the same array-contains
            # way user_id is (see _build_filter) — same idempotent KEYWORD
            # index, just on an array field.
            self._client.create_payload_index(
                collection_name=self._collection_name,
                field_name="conversation_ids",
                field_schema=models.PayloadSchemaType.KEYWORD,
            )
            self._client.create_payload_index(
                collection_name=self._collection_name,
                field_name="project_ids",
                field_schema=models.PayloadSchemaType.KEYWORD,
            )
        except Exception as exc:
            raise VectorStoreError(f"Could not reach Qdrant to ensure collection: {exc}") from exc

    def upsert_chunks(
        self,
        metadata: DocumentMetadata,
        chunks: list[Chunk],
        embeddings: list[list[float]],
        *,
        user_id: str,
    ) -> None:
        if len(chunks) != len(embeddings):
            raise VectorStoreError(
                f"chunks count ({len(chunks)}) does not match embeddings count ({len(embeddings)})"
            )
        if not chunks:
            return

        points: list[models.PointStruct] = []
        for chunk, embedding in zip(chunks, embeddings, strict=True):
            if len(embedding) != self._vector_size:
                raise VectorStoreError(
                    f"Embedding has {len(embedding)} dimensions, "
                    f"expected {self._vector_size} for collection '{self._collection_name}'"
                )
            payload = ChunkPayload.from_metadata(
                metadata,
                user_id=user_id,
                chunk_index=chunk.chunk_index,
                page_number=chunk.page_number,
                text=chunk.text,
            )
            points.append(
                models.PointStruct(
                    id=_point_id(metadata.document_id, chunk.chunk_index),
                    vector=embedding,
                    payload=payload.model_dump(mode="json"),
                )
            )

        try:
            self._client.upsert(collection_name=self._collection_name, points=points)
        except Exception as exc:
            raise VectorStoreError(f"Could not reach Qdrant to upsert chunks: {exc}") from exc

    def search(
        self,
        query_vector: list[float],
        *,
        limit: int,
        user_id: str,
        vector_filter: VectorStoreFilter | None = None,
        with_vectors: bool = False,
        conversation_id: str | None = None,
        project_id: str | None = None,
    ) -> list[VectorSearchResult]:
        query_filter = _build_filter(
            vector_filter, user_id=user_id, conversation_id=conversation_id, project_id=project_id
        )

        try:
            response = self._client.query_points(
                collection_name=self._collection_name,
                query=query_vector,
                limit=limit,
                with_payload=True,
                with_vectors=with_vectors,
                query_filter=query_filter,
            )
        except Exception as exc:
            raise VectorStoreError(f"Could not reach Qdrant to search: {exc}") from exc

        results: list[VectorSearchResult] = []
        for point in response.points:
            vector: list[float] | None = None
            if with_vectors and isinstance(point.vector, list):
                # This store only ever writes single dense (unnamed) vectors, but
                # qdrant-client's type also covers multi-vector points generically.
                vector = [float(value) for value in point.vector]  # type: ignore[arg-type]
            results.append(
                VectorSearchResult(
                    id=str(point.id),
                    payload=ChunkPayload.model_validate(point.payload),
                    score=point.score,
                    vector=vector,
                )
            )
        return results

    def list_documents(
        self, *, user_id: str, limit: int = 20, offset: int = 0
    ) -> tuple[list[DocumentRecord], int]:
        """Groups chunks by document_id into one summary record per document,
        scoped to one owner. Retained for corpus_stats.py and the CLI's
        list/show/stats commands — GET /documents itself now reads from
        app/db/documents_repository.py's SQL-backed listing instead (see
        that module's docstring for why).

        Qdrant has no native "distinct document" query, so this scrolls every
        chunk payload (up to a safety cap) and groups client-side — acceptable
        for this system's personal-corpus scale, not for a large-scale index."""
        payloads: list[ChunkPayload] = []
        next_offset: models.ExtendedPointId | None = None
        scroll_filter = models.Filter(must=[_user_id_condition(user_id)])

        while len(payloads) < _SCROLL_SAFETY_CAP:
            try:
                records, next_offset = self._client.scroll(
                    collection_name=self._collection_name,
                    scroll_filter=scroll_filter,
                    limit=_SCROLL_PAGE_SIZE,
                    offset=next_offset,
                    with_payload=True,
                    with_vectors=False,
                )
            except Exception as exc:
                raise VectorStoreError(f"Could not reach Qdrant to list documents: {exc}") from exc
            payloads.extend(ChunkPayload.model_validate(record.payload) for record in records)
            if next_offset is None:
                break

        grouped: dict[str, list[ChunkPayload]] = {}
        for payload in payloads:
            grouped.setdefault(payload.document_id, []).append(payload)

        documents = [
            DocumentRecord(
                document_id=document_id,
                document_type=chunks[0].document_type,
                journal_quartile=chunks[0].journal_quartile,
                title=chunks[0].title,
                authors=chunks[0].authors,
                publication_year=chunks[0].publication_year,
                source_venue=chunks[0].source_venue,
                doi=chunks[0].doi,
                source_url=chunks[0].source_url,
                source_filename=chunks[0].source_filename,
                ingested_at=chunks[0].ingested_at,
                chunk_count=len(chunks),
            )
            for document_id, chunks in grouped.items()
        ]
        documents.sort(key=lambda record: record.ingested_at, reverse=True)

        total = len(documents)
        page = documents[offset : offset + limit]
        return page, total

    def _document_id_filter(self, document_id: str, *, user_id: str) -> models.Filter:
        return models.Filter(
            must=[
                _user_id_condition(user_id),
                models.FieldCondition(
                    key="document_id", match=models.MatchValue(value=document_id)
                ),
            ]
        )

    def get_document(self, document_id: str, *, user_id: str) -> DocumentRecord | None:
        """Single-document lookup, filtered server-side (by document_id AND
        owner — never by document_id alone) — unlike list_documents(), this
        does not scroll the whole collection."""
        try:
            records, _next_offset = self._client.scroll(
                collection_name=self._collection_name,
                scroll_filter=self._document_id_filter(document_id, user_id=user_id),
                limit=_SCROLL_SAFETY_CAP,
                with_payload=True,
                with_vectors=False,
            )
        except Exception as exc:
            raise VectorStoreError(f"Could not reach Qdrant to look up document: {exc}") from exc

        if not records:
            return None

        chunks = [ChunkPayload.model_validate(record.payload) for record in records]
        return DocumentRecord(
            document_id=document_id,
            document_type=chunks[0].document_type,
            journal_quartile=chunks[0].journal_quartile,
            title=chunks[0].title,
            authors=chunks[0].authors,
            publication_year=chunks[0].publication_year,
            source_venue=chunks[0].source_venue,
            doi=chunks[0].doi,
            source_url=chunks[0].source_url,
            source_filename=chunks[0].source_filename,
            ingested_at=chunks[0].ingested_at,
            chunk_count=len(chunks),
        )

    def delete_document(self, document_id: str, *, user_id: str) -> int:
        """Deletes every chunk belonging to document_id AND owned by
        user_id. Returns the number of chunks deleted (0 if the
        document_id didn't exist, or existed but belonged to a different
        user) so the caller can distinguish a real removal from a no-op."""
        document_filter = self._document_id_filter(document_id, user_id=user_id)
        try:
            count_result = self._client.count(
                collection_name=self._collection_name, count_filter=document_filter
            )
            if count_result.count > 0:
                self._client.delete(
                    collection_name=self._collection_name,
                    points_selector=models.FilterSelector(filter=document_filter),
                )
            return count_result.count
        except Exception as exc:
            raise VectorStoreError(f"Could not reach Qdrant to delete document: {exc}") from exc

    def scroll_all_points_raw(self) -> list[tuple[str, dict[str, object]]]:
        """Yields (point_id, raw_payload_dict) for every point in the
        collection, regardless of whether the payload validates against the
        current ChunkPayload schema. Used only by
        `python -m cli.documents adopt-legacy`, which must be able to find
        points written before `user_id` existed — every other method on
        this class validates payloads strictly and would simply reject
        those rows."""
        results: list[tuple[str, dict[str, object]]] = []
        next_offset: models.ExtendedPointId | None = None

        while len(results) < _SCROLL_SAFETY_CAP:
            try:
                records, next_offset = self._client.scroll(
                    collection_name=self._collection_name,
                    limit=_SCROLL_PAGE_SIZE,
                    offset=next_offset,
                    with_payload=True,
                    with_vectors=False,
                )
            except Exception as exc:
                raise VectorStoreError(f"Could not reach Qdrant to scroll points: {exc}") from exc
            results.extend((str(record.id), dict(record.payload or {})) for record in records)
            if next_offset is None:
                break
        return results

    def update_chunk_metadata(
        self, document_id: str, *, user_id: str, updates: dict[str, object]
    ) -> int:
        """Payload-only update (same `set_payload` mechanism as
        backfill_user_id, no re-embedding or vector rewrite) applied to
        every chunk belonging to document_id AND owned by user_id — the
        Qdrant half of `python -m cli.documents refresh-metadata`, so a
        metadata correction never requires re-chunking or re-embedding the
        document. Returns the number of chunk payloads updated (0 if the
        document doesn't exist, or exists but belongs to a different
        user)."""
        document_filter = self._document_id_filter(document_id, user_id=user_id)
        try:
            count_result = self._client.count(
                collection_name=self._collection_name, count_filter=document_filter
            )
            if count_result.count > 0:
                self._client.set_payload(
                    collection_name=self._collection_name,
                    payload=updates,
                    points=document_filter,
                )
            return count_result.count
        except Exception as exc:
            raise VectorStoreError(
                f"Could not reach Qdrant to update chunk metadata: {exc}"
            ) from exc

    def update_scope_associations(
        self, document_id: str, *, user_id: str, conversation_ids: list[str], project_ids: list[str]
    ) -> int:
        """Overwrites conversation_ids/project_ids/scope_type on every
        chunk belonging to document_id AND owned by user_id — same
        payload-only `set_payload` mechanism as update_chunk_metadata,
        never re-embeds or rewrites a vector. Callers (see
        app/core/document_scoping.py) always pass the FULL current set of
        ids, recomputed from the SQL association tables (the source of
        truth) — never a single id to append/remove — which avoids any
        Qdrant-side read-modify-write race and keeps this store a pure,
        stateless mirror of what SQL already knows. scope_type is derived
        here, never accepted as a parameter, so it can never drift out of
        sync with the arrays it summarizes. Returns the number of chunk
        payloads updated (0 if document_id doesn't exist for user_id)."""
        return self.update_chunk_metadata(
            document_id,
            user_id=user_id,
            updates={
                "conversation_ids": conversation_ids,
                "project_ids": project_ids,
                "scope_type": _derive_scope_type(conversation_ids, project_ids),
            },
        )

    def backfill_user_id(self, point_ids: list[str], *, user_id: str) -> None:
        """Payload-only update (no re-embedding, no vector rewrite) that
        stamps `user_id` onto points that predate it — the legacy-adoption
        counterpart to scroll_all_points_raw()."""
        if not point_ids:
            return
        try:
            self._client.set_payload(
                collection_name=self._collection_name,
                payload={"user_id": user_id},
                points=models.PointIdsList(points=list(point_ids)),
            )
        except Exception as exc:
            raise VectorStoreError(f"Could not reach Qdrant to backfill user_id: {exc}") from exc
