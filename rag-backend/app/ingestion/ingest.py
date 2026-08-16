import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Protocol
from uuid import uuid4

from pydantic import BaseModel

from app.ingestion.errors import DuplicateDocumentError
from app.ingestion.hashing import compute_sha256
from app.ingestion.loaders.base import ExtractionSource, PageContent
from app.ingestion.loaders.dispatch import load_document
from app.ingestion.metadata_extraction import clean_filename_as_title, normalize_doi
from app.ingestion.metadata_schema import DocumentMetadata, DocumentType, JournalQuartile


class DuplicateChecker(Protocol):
    """Satisfied by app.db.documents_repository.DocumentsRepository — kept
    as its own narrow Protocol here since ingest_document() only ever needs
    this one capability, not the repository's full read/write surface."""

    def contains_sha256(self, user_id: uuid.UUID, sha256: str) -> bool: ...


class IngestionResult(BaseModel):
    metadata: DocumentMetadata
    pages: list[PageContent]

    @property
    def full_text(self) -> str:
        return "\n\n".join(page.text for page in self.pages)


def _is_present(value: object) -> bool:
    """"Has a real value" for the purposes of provenance/merge decisions —
    None, "", and [] all count as "nothing here", matching the falsy checks
    every field-priority rule in this module already used before Milestone
    4 (e.g. `source_venue or loaded.metadata.source_venue`)."""
    return value not in (None, "", [])


def _provenance(
    *,
    explicit_given: bool,
    extracted_value: object,
    field: str,
    loaded_sources: dict[str, ExtractionSource],
    default_extracted_source: ExtractionSource = ExtractionSource.STRUCTURED_TEXT,
) -> ExtractionSource | None:
    """Milestone 4: which of USER / EMBEDDED_METADATA / STRUCTURED_TEXT
    produced a field's final value — None (absent from the resulting dict
    entirely) when the field has no value at all, since a field nobody
    supplied has no provenance to report, not a fabricated one.

    `explicit_given` is a caller-computed bool, not inferred here from
    truthiness — it must use the EXACT SAME "was this actually provided"
    test the field's own resolution logic above already uses (`is not
    None` for `authors`/`publication_year`, since an explicitly-cleared
    `authors=[]` is still a real user choice; plain truthiness for the
    string fields, matching their own `x or fallback` resolution). Using a
    mismatched test here would let a field's provenance label disagree
    with which value actually won — e.g. labeling a user's explicit
    `authors=[]` as "structured_text" just because `[]` is falsy.

    `default_extracted_source` covers the fields extract_from_pages()
    populates (abstract/language/keywords/volume/page_start/page_end) but
    never labels in its own `sources` dict (see that function's docstring:
    it only ever produces STRUCTURED_TEXT-sourced fields, so the label is
    always correct even without an explicit entry) — everything else
    (title/authors/publication_year/source_venue/doi/source_url) goes
    through loaders/dispatch.py's embedded-vs-structured-text merge and
    always has a real entry in `loaded_sources` whenever it has a value."""
    if explicit_given:
        return ExtractionSource.USER
    if _is_present(extracted_value):
        return loaded_sources.get(field, default_extracted_source)
    return None


def ingest_document(
    file_path: Path,
    *,
    document_type: DocumentType,
    duplicate_checker: DuplicateChecker,
    user_id: uuid.UUID,
    journal_quartile: JournalQuartile = None,
    title: str | None = None,
    authors: list[str] | None = None,
    publication_year: int | None = None,
    source_venue: str | None = None,
    doi: str | None = None,
    source_url: str | None = None,
    original_filename: str | None = None,
) -> IngestionResult:
    """Extracts text and builds metadata, rejecting duplicates already
    ingested *by this same user* — two different users uploading
    byte-identical files are independent owners, not a collision.

    `original_filename` matters when `file_path` is a temp file (e.g.
    POST /documents writes the upload to a randomly-named temp path before
    calling this) — it becomes `metadata.source_filename` instead of the
    temp name, and is also what the lowest-priority title fallback (a
    cleaned-up version of the filename) is derived from. Omit it when
    `file_path` already *is* the real source file (the CLI's `reingest`,
    which operates on a real file on disk).

    Every metadata field follows the same priority order: an explicit
    argument here (the user's own input) always wins; otherwise whatever
    load_document() resolved (embedded file metadata, then a
    structured-text fallback — see loaders/dispatch.py) is used; for
    title specifically, if neither produced anything, a cleaned-up
    version of the filename is used as a last resort (see
    metadata_extraction.clean_filename_as_title) rather than leaving the
    document titleless. Never fabricates authors, a year, a venue, or a
    DOI this way — those simply stay None/empty if nothing found them.

    Milestone 4: also carries through the extraction-only fields
    (abstract/language/keywords/volume/page_start/page_end) that used to
    be discarded after the metadata-preview response, plus a
    `metadata_sources` provenance map recording, per populated field,
    which of USER/EMBEDDED_METADATA/STRUCTURED_TEXT/FILENAME produced it
    — see DocumentMetadata.metadata_sources and _provenance() above.
    `source_venue` folds in `journal_title` (a decomposed detail of the
    same "where was this published" fact — see ExtractedMetadata's
    docstring) as a same-priority-tier fallback rather than adding a
    second, redundant venue column; `issue`/`publisher` have no extraction
    heuristic anywhere in this codebase today and are always None at
    ingest time — they only ever get a value (and USER provenance) via a
    later metadata edit.

    Does NOT register the document — that is the caller's responsibility, to
    be done only once the full pipeline (chunking, embedding, vector store
    upsert) has actually succeeded. Registering here, before those later
    stages run, would mark a document as "already ingested" even if it was
    never actually stored anywhere, permanently blocking retries after a
    transient failure (e.g. an embedding provider being temporarily
    unreachable)."""
    if not file_path.is_file():
        raise FileNotFoundError(f"No such file: {file_path}")

    sha256 = compute_sha256(file_path)
    if duplicate_checker.contains_sha256(user_id, sha256):
        raise DuplicateDocumentError(
            f"'{file_path.name}' has already been ingested (sha256={sha256})."
        )

    loaded = load_document(file_path)
    resolved_filename = original_filename or file_path.name
    extracted = loaded.metadata

    # Milestone 4 Section 15: normalize an explicitly user-supplied DOI the
    # same way extract_doi() already normalizes one found in the document
    # itself (strips a "doi:" prefix / doi.org URL wrapper and trailing
    # punctuation) — so a user pasting "https://doi.org/10.1234/abcd" or
    # "doi:10.1234/abcd" gets the same canonical "10.1234/abcd" a real
    # duplicate-detection feature could someday compare reliably, not two
    # differently-formatted strings for the same identifier. Falls back to
    # the raw input unchanged (never silently dropped) if it doesn't
    # resolve to a valid DOI shape, so DocumentMetadata's own pattern
    # validation still reports a genuine "this isn't a DOI" error rather
    # than accepting anything.
    if doi:
        doi = normalize_doi(doi) or doi

    resolved_title = title or extracted.title or clean_filename_as_title(resolved_filename)
    resolved_authors = authors if authors is not None else extracted.authors
    resolved_publication_year = (
        publication_year if publication_year is not None else extracted.publication_year
    )
    extracted_venue = extracted.source_venue or extracted.journal_title
    resolved_source_venue = source_venue or extracted_venue
    resolved_doi = doi or extracted.doi
    resolved_source_url = source_url or extracted.source_url

    sources: dict[str, str] = {}
    if title or extracted.title:
        sources["title"] = (
            ExtractionSource.USER
            if title
            else extracted.sources.get("title", ExtractionSource.STRUCTURED_TEXT)
        ).value
    elif resolved_title:
        # Neither an explicit title nor any extraction pass produced one —
        # resolved_title can only be the filename-derived fallback here.
        sources["title"] = ExtractionSource.FILENAME.value
    for field, explicit_given, extracted_value in (
        # authors/publication_year: "given" means "is not None" — matches
        # their own resolution above exactly, so an explicit authors=[]
        # still gets USER provenance rather than being mistaken for "not
        # provided" just because an empty list is falsy.
        ("authors", authors is not None, extracted.authors),
        ("publication_year", publication_year is not None, extracted.publication_year),
        ("source_venue", bool(source_venue), extracted_venue),
        ("doi", bool(doi), extracted.doi),
        ("source_url", bool(source_url), extracted.source_url),
        ("abstract", False, extracted.abstract),
        ("language", False, extracted.language),
        ("keywords", False, extracted.keywords),
        ("volume", False, extracted.volume),
        ("page_start", False, extracted.page_start),
        ("page_end", False, extracted.page_end),
    ):
        resolved_source = _provenance(
            explicit_given=explicit_given,
            extracted_value=extracted_value,
            field=field,
            loaded_sources=extracted.sources,
        )
        if resolved_source is not None:
            sources[field] = resolved_source.value

    document_id = str(uuid4())
    metadata = DocumentMetadata(
        document_id=document_id,
        source_filename=resolved_filename,
        file_format=loaded.file_format,
        sha256=sha256,
        file_size_bytes=file_path.stat().st_size,
        page_count=len(loaded.pages),
        document_type=document_type,
        journal_quartile=journal_quartile,
        title=resolved_title,
        authors=resolved_authors,
        publication_year=resolved_publication_year,
        source_venue=resolved_source_venue,
        doi=resolved_doi,
        source_url=resolved_source_url,
        abstract=extracted.abstract,
        language=extracted.language,
        keywords=extracted.keywords,
        volume=extracted.volume,
        page_start=extracted.page_start,
        page_end=extracted.page_end,
        metadata_sources=sources,
        ingested_at=datetime.now(UTC),
    )

    return IngestionResult(metadata=metadata, pages=loaded.pages)
