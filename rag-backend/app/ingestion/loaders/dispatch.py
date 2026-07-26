from pathlib import Path

from app.ingestion.errors import UnsupportedFileTypeError
from app.ingestion.loaders import docx_loader, html_loader, markdown_loader, pdf_loader, txt_loader
from app.ingestion.loaders.base import LoadedDocument
from app.ingestion.metadata_extraction import extract_from_pages, merge_extracted_metadata

_EXTENSION_LOADERS = {
    ".pdf": pdf_loader.load,
    ".docx": docx_loader.load,
    ".txt": txt_loader.load,
    ".html": html_loader.load,
    ".htm": html_loader.load,
    ".md": markdown_loader.load,
    ".markdown": markdown_loader.load,
}


def load_document(path: Path) -> LoadedDocument:
    loader = _EXTENSION_LOADERS.get(path.suffix.lower())
    if loader is None:
        supported = ", ".join(sorted(_EXTENSION_LOADERS))
        raise UnsupportedFileTypeError(
            f"Unsupported file type '{path.suffix}' for '{path.name}'. Supported: {supported}"
        )
    loaded = loader(path)

    # The one place every format's embedded-metadata pass (pdf_loader's PDF
    # properties, docx_loader's core properties, html_loader's meta tags,
    # ...) gets merged with the shared structured-text fallback
    # (app/ingestion/metadata_extraction.py) — structured text only ever
    # fills a gap the embedded pass left empty, never overwrites it (see
    # merge_extracted_metadata's docstring). Applied uniformly rather than
    # per-loader so every format benefits from the same fallback without
    # each loader needing its own copy of these heuristics.
    structured = extract_from_pages(loaded.pages)
    merged_metadata = merge_extracted_metadata(loaded.metadata, structured)
    return loaded.model_copy(update={"metadata": merged_metadata})
