"""Covers app/core/document_ingestion_jobs.py::_run's embedding batch-size
wiring (Settings.embedding_batch_size, env EMBEDDING_BATCH_SIZE, default
32) — proves chunks are grouped into embedding_provider.embed_batch() calls
of exactly the configured size, using fakes for every dependency so no real
Ollama server, Qdrant, or database is required.
"""

import uuid
from datetime import UTC, datetime

from app.config import get_settings
from app.core.document_ingestion_jobs import _run
from app.core.request_timing import RequestTimer
from app.ingestion.chunker import Chunk
from app.ingestion.metadata_schema import DocumentMetadata

_JWT_SECRET = "x" * 32  # Settings.jwt_secret is required (min_length=16); irrelevant here.


def _make_metadata(document_id: str) -> DocumentMetadata:
    return DocumentMetadata(
        document_id=document_id,
        source_filename="test.pdf",
        file_format="pdf",
        sha256="0" * 64,
        file_size_bytes=1234,
        page_count=1,
        document_type="report",
        ingested_at=datetime.now(UTC),
    )


def _make_chunks(n: int) -> list[Chunk]:
    return [Chunk(chunk_index=i, page_number=1, text=f"chunk {i}") for i in range(n)]


class _RecordingEmbeddingProvider:
    """Fake EmbeddingProvider that records the size of every embed_batch()
    call instead of actually embedding anything."""

    def __init__(self) -> None:
        self.batch_sizes: list[int] = []

    @property
    def dimensions(self) -> int:
        return 4

    def embed_batch(self, texts: list[str]) -> list[list[float]]:
        self.batch_sizes.append(len(texts))
        return [[0.0, 0.0, 0.0, 0.0] for _ in texts]


class _FakeVectorStore:
    def upsert_chunks(self, metadata, chunks, embeddings, *, user_id):
        pass


class _FakeJobsRepository:
    def update_progress(self, job_id, *, stage, embedded_chunks):
        pass

    def mark_completed(self, job_id, *, document_id):
        pass

    def mark_failed(self, job_id, *, error_message):
        pass

    def set_timings(self, job_id, *, timings_json):
        pass


class _FakeDocumentsRepository:
    def create(self, *, user_id, metadata, chunk_count):
        pass


def _run_ingestion(embedding_provider: _RecordingEmbeddingProvider, n_chunks: int) -> None:
    _run(
        job_id="job-1",
        user_id=uuid.uuid4(),
        metadata=_make_metadata("doc-1"),
        chunks=_make_chunks(n_chunks),
        embedding_provider=embedding_provider,
        vector_store=_FakeVectorStore(),
        jobs_repository=_FakeJobsRepository(),
        documents_repository=_FakeDocumentsRepository(),
        timer=RequestTimer(enabled=False),
    )


def test_embedding_batches_default_to_32(monkeypatch) -> None:
    monkeypatch.setenv("JWT_SECRET", _JWT_SECRET)
    monkeypatch.delenv("EMBEDDING_BATCH_SIZE", raising=False)
    get_settings.cache_clear()

    try:
        embedding_provider = _RecordingEmbeddingProvider()
        _run_ingestion(embedding_provider, n_chunks=70)

        assert embedding_provider.batch_sizes == [32, 32, 6]
    finally:
        get_settings.cache_clear()


def test_embedding_batches_use_configured_size(monkeypatch) -> None:
    """The actual mechanism this task adds: EMBEDDING_BATCH_SIZE controls
    the real grouping used for embedding_provider.embed_batch() calls
    during ingestion — this is what raising it from 8 to 32 means in
    practice."""
    monkeypatch.setenv("JWT_SECRET", _JWT_SECRET)
    monkeypatch.setenv("EMBEDDING_BATCH_SIZE", "8")
    get_settings.cache_clear()

    try:
        embedding_provider = _RecordingEmbeddingProvider()
        _run_ingestion(embedding_provider, n_chunks=20)

        assert embedding_provider.batch_sizes == [8, 8, 4]
    finally:
        get_settings.cache_clear()


def test_embedding_batches_never_exceed_configured_size_for_small_documents(monkeypatch) -> None:
    monkeypatch.setenv("JWT_SECRET", _JWT_SECRET)
    monkeypatch.setenv("EMBEDDING_BATCH_SIZE", "32")
    get_settings.cache_clear()

    try:
        embedding_provider = _RecordingEmbeddingProvider()
        _run_ingestion(embedding_provider, n_chunks=10)

        assert embedding_provider.batch_sizes == [10]  # one call, under the cap
    finally:
        get_settings.cache_clear()
