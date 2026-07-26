import re
from pathlib import Path

import pymupdf

from app.ingestion.errors import DocumentExtractionError
from app.ingestion.loaders.base import (
    ExtractedMetadata,
    ExtractionSource,
    LoadedDocument,
    PageContent,
)
from app.ingestion.metadata_extraction import is_plausible_title, split_author_string

_KEYWORD_SPLIT_PATTERN = re.compile(r"[;,]")


def load(path: Path) -> LoadedDocument:
    try:
        with pymupdf.open(path) as document:  # type: ignore[no-untyped-call]
            pages = [
                PageContent(page_number=index + 1, text=page.get_text().strip())
                for index, page in enumerate(document)
            ]
            raw_metadata = document.metadata or {}
    except pymupdf.FileDataError as exc:
        raise DocumentExtractionError(f"Could not read PDF file: {path.name}") from exc

    if not pages:
        raise DocumentExtractionError(f"No pages found in PDF: {path.name}")

    # Some PDF exporters (notably "Print to PDF" from Word) leave the
    # source filename, "Untitled", or a running-header-like string as the
    # embedded title — is_plausible_title() rejects those the same way it
    # would reject a bad structured-text candidate, falling through to the
    # structured-text pass (see loaders/dispatch.py) instead of keeping a
    # useless embedded value just because *a* value was present.
    raw_title = (raw_metadata.get("title") or "").strip()
    title = raw_title if raw_title and is_plausible_title(raw_title) else None

    author_raw = (raw_metadata.get("author") or "").strip()
    authors = split_author_string(author_raw) if author_raw else []

    keywords_raw = (raw_metadata.get("keywords") or "").strip()
    keywords = (
        [k.strip() for k in _KEYWORD_SPLIT_PATTERN.split(keywords_raw) if k.strip()]
        if keywords_raw
        else []
    )

    sources: dict[str, ExtractionSource] = {}
    if title:
        sources["title"] = ExtractionSource.EMBEDDED_METADATA
    if authors:
        sources["authors"] = ExtractionSource.EMBEDDED_METADATA

    metadata = ExtractedMetadata(title=title, authors=authors, keywords=keywords, sources=sources)

    return LoadedDocument(file_format="pdf", pages=pages, metadata=metadata)
