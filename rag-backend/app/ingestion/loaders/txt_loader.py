from pathlib import Path

from app.ingestion.errors import DocumentExtractionError
from app.ingestion.loaders.base import LoadedDocument, PageContent


def load(path: Path) -> LoadedDocument:
    try:
        raw_text = path.read_text(encoding="utf-8")
    except UnicodeDecodeError as exc:
        raise DocumentExtractionError(f"'{path.name}' is not valid UTF-8 text") from exc

    # Plain text has no native page concept; a form-feed (\f) is a common
    # convention for encoding page breaks in exported/printed text, so it's
    # honored when present, falling back to a single page otherwise.
    segments = [segment.strip() for segment in raw_text.split("\f")]
    segments = [segment for segment in segments if segment]

    if not segments:
        raise DocumentExtractionError(f"No extractable text found in TXT: {path.name}")

    pages = [
        PageContent(page_number=index + 1, text=segment) for index, segment in enumerate(segments)
    ]

    return LoadedDocument(file_format="txt", pages=pages)
