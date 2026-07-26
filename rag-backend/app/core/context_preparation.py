from difflib import SequenceMatcher

from app.core.retrieval_schemas import RetrievedChunk

DEFAULT_MAX_CHUNKS_PER_DOCUMENT = 3
DEFAULT_MAX_TOTAL_CONTEXT_CHARS = 8000
DEFAULT_SIMILARITY_THRESHOLD = 0.92


def prepare_context(
    chunks: list[RetrievedChunk],
    *,
    max_per_document: int = DEFAULT_MAX_CHUNKS_PER_DOCUMENT,
    max_total_chars: int = DEFAULT_MAX_TOTAL_CONTEXT_CHARS,
    similarity_threshold: float = DEFAULT_SIMILARITY_THRESHOLD,
) -> list[RetrievedChunk]:
    """Prepares retrieved chunks for prompting: drops empty text, collapses
    near-duplicate chunks, caps how many chunks any single document can
    contribute (source diversity), and enforces a total context budget.
    Input order (already ranked by the retriever) is preserved throughout,
    so the final list's order is deterministic and rank-stable."""
    non_empty = [chunk for chunk in chunks if chunk.text.strip()]
    deduplicated = _deduplicate_near_identical(non_empty, similarity_threshold)
    diverse = _cap_per_document(deduplicated, max_per_document)
    return _enforce_max_total_chars(diverse, max_total_chars)


def _normalize(text: str) -> str:
    return " ".join(text.split()).lower()


def _deduplicate_near_identical(
    chunks: list[RetrievedChunk], similarity_threshold: float
) -> list[RetrievedChunk]:
    kept: list[RetrievedChunk] = []
    kept_normalized: list[str] = []

    for chunk in chunks:
        normalized = _normalize(chunk.text)
        is_duplicate = any(
            SequenceMatcher(None, normalized, existing).ratio() >= similarity_threshold
            for existing in kept_normalized
        )
        if not is_duplicate:
            kept.append(chunk)
            kept_normalized.append(normalized)

    return kept


def _cap_per_document(chunks: list[RetrievedChunk], max_per_document: int) -> list[RetrievedChunk]:
    counts: dict[str, int] = {}
    kept: list[RetrievedChunk] = []

    for chunk in chunks:
        count = counts.get(chunk.document_id, 0)
        if count >= max_per_document:
            continue
        counts[chunk.document_id] = count + 1
        kept.append(chunk)

    return kept


def _enforce_max_total_chars(
    chunks: list[RetrievedChunk], max_total_chars: int
) -> list[RetrievedChunk]:
    kept: list[RetrievedChunk] = []
    total_chars = 0

    for chunk in chunks:
        chunk_len = len(chunk.text)
        # Always keep at least one source even if it alone exceeds the budget —
        # a single over-budget source is better than returning no context at all.
        if kept and total_chars + chunk_len > max_total_chars:
            break
        kept.append(chunk)
        total_chars += chunk_len

    return kept
