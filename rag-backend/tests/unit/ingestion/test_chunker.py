"""Covers the chunk_overlap default change (450 -> 200 chars) and guards
chunk_size (3000, unchanged by this task) as a regression check — see
app/ingestion/chunker.py's module docstring for why overlap moved and
chunk_size didn't."""

from app.ingestion.chunker import (
    DEFAULT_CHUNK_OVERLAP_CHARS,
    DEFAULT_CHUNK_SIZE_CHARS,
    chunk_text,
)


def test_default_chunk_overlap_is_200_chars() -> None:
    assert DEFAULT_CHUNK_OVERLAP_CHARS == 200


def test_default_chunk_size_is_unchanged_at_3000_chars() -> None:
    assert DEFAULT_CHUNK_SIZE_CHARS == 3000


def test_chunk_text_uses_the_new_overlap_default() -> None:
    # Uniquely-numbered sentences (not a repeated phrase) so any shared
    # suffix/prefix found at a chunk boundary is unambiguous proof of real
    # overlap, not an accident of repeated identical content.
    text = " ".join(f"This is unique sentence number {i} in the document." for i in range(400))

    chunks = chunk_text(text)

    assert len(chunks) > 1
    # The end of chunk 1 and the start of chunk 2 share the overlap region.
    boundary_overlap = _shared_suffix_prefix_len(chunks[0], chunks[1])
    assert 0 < boundary_overlap <= DEFAULT_CHUNK_OVERLAP_CHARS


def _shared_suffix_prefix_len(first: str, second: str) -> int:
    max_check = min(len(first), len(second), 500)
    for length in range(max_check, 0, -1):
        if first[-length:] == second[:length]:
            return length
    return 0
