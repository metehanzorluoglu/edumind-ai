from pydantic import BaseModel, Field

from app.ingestion.loaders.base import PageContent

DEFAULT_CHUNK_SIZE_CHARS = 3000
DEFAULT_CHUNK_OVERLAP_CHARS = 450

_SPLIT_SEPARATORS = ["\n\n", "\n", ". ", " ", ""]


class Chunk(BaseModel):
    chunk_index: int = Field(ge=0)
    page_number: int = Field(ge=1)
    text: str


def _merge_splits(
    splits: list[str], separator: str, chunk_size: int, chunk_overlap: int
) -> list[str]:
    chunks: list[str] = []
    current: list[str] = []
    current_len = 0

    for split in splits:
        added_len = len(split) + (len(separator) if current else 0)

        if current and current_len + added_len > chunk_size:
            chunks.append(separator.join(current))

            while current and current_len > chunk_overlap:
                removed = current.pop(0)
                current_len -= len(removed) + (len(separator) if current else 0)

        current.append(split)
        current_len += len(split) + (len(separator) if len(current) > 1 else 0)

    if current:
        chunks.append(separator.join(current))

    return [chunk for chunk in chunks if chunk.strip()]


def _split_recursive(
    text: str, separators: list[str], chunk_size: int, chunk_overlap: int
) -> list[str]:
    if len(text) <= chunk_size:
        return [text] if text.strip() else []

    separator, *remaining_separators = separators
    splits = text.split(separator) if separator else list(text)

    good_splits: list[str] = []
    final_chunks: list[str] = []

    for split in splits:
        if len(split) < chunk_size:
            good_splits.append(split)
            continue

        if good_splits:
            final_chunks.extend(_merge_splits(good_splits, separator, chunk_size, chunk_overlap))
            good_splits = []

        if remaining_separators:
            final_chunks.extend(
                _split_recursive(split, remaining_separators, chunk_size, chunk_overlap)
            )
        else:
            final_chunks.extend(_merge_splits(list(split), "", chunk_size, chunk_overlap))

    if good_splits:
        final_chunks.extend(_merge_splits(good_splits, separator, chunk_size, chunk_overlap))

    return final_chunks


def chunk_text(
    text: str,
    *,
    chunk_size: int = DEFAULT_CHUNK_SIZE_CHARS,
    chunk_overlap: int = DEFAULT_CHUNK_OVERLAP_CHARS,
) -> list[str]:
    stripped = text.strip()
    if not stripped:
        return []
    return [
        chunk.strip()
        for chunk in _split_recursive(stripped, _SPLIT_SEPARATORS, chunk_size, chunk_overlap)
        if chunk.strip()
    ]


def chunk_pages(
    pages: list[PageContent],
    *,
    chunk_size: int = DEFAULT_CHUNK_SIZE_CHARS,
    chunk_overlap: int = DEFAULT_CHUNK_OVERLAP_CHARS,
) -> list[Chunk]:
    chunks: list[Chunk] = []
    chunk_index = 0

    for page in pages:
        for text in chunk_text(page.text, chunk_size=chunk_size, chunk_overlap=chunk_overlap):
            chunks.append(Chunk(chunk_index=chunk_index, page_number=page.page_number, text=text))
            chunk_index += 1

    return chunks
