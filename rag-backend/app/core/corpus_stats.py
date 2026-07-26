from collections import Counter
from dataclasses import dataclass
from datetime import datetime

from app.vectorstore.qdrant_client import QdrantVectorStore

_SCAN_LIMIT = 10_000


@dataclass
class CorpusStats:
    document_count: int
    chunk_count: int
    document_type_counts: dict[str, int]
    last_ingested_at: datetime | None


def compute_corpus_stats(vector_store: QdrantVectorStore, *, user_id: str) -> CorpusStats:
    """Shared by `GET /status` and `python -m cli.documents stats` so the two
    never drift out of sync. Scoped to one user — a dev status screen must
    never reveal how many documents/chunks *other* users have. Bounded by
    _SCAN_LIMIT, same as QdrantVectorStore.list_documents() itself — fine at
    this system's personal-corpus scale (see that method's own docstring)."""
    records, total = vector_store.list_documents(user_id=user_id, limit=_SCAN_LIMIT, offset=0)

    chunk_count = sum(record.chunk_count for record in records)
    type_counter = Counter(record.document_type for record in records)
    document_type_counts: dict[str, int] = {
        str(document_type): count for document_type, count in type_counter.items()
    }
    last_ingested_at = max((record.ingested_at for record in records), default=None)

    return CorpusStats(
        document_count=total,
        chunk_count=chunk_count,
        document_type_counts=document_type_counts,
        last_ingested_at=last_ingested_at,
    )
