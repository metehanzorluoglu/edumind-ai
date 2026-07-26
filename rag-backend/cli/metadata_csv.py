"""Loads and validates the CSV metadata format described in
data/metadata-template.csv, used by `python -m cli.ingest --metadata`.

Never infers a value that is missing from the CSV — a blank cell stays
null. In particular, journal_quartile must come from this file (or an
explicit per-run --document-type/--journal-quartile fallback), never
guessed from article text. See AGENTS.md milestone 8 §2.

`language` and `notes` are accepted as bookkeeping columns for the person
managing the corpus (e.g. "why is this document included"), but are NOT
currently persisted anywhere in the backend — DocumentMetadata has no such
fields. They round-trip into the ingestion report so they aren't silently
dropped, but ingest_document() never receives them. This is a known,
documented limitation, not an oversight.
"""

from __future__ import annotations

import csv
import re
from dataclasses import dataclass, field
from pathlib import Path

VALID_DOCUMENT_TYPES = frozenset(
    {
        "journal_article",
        "practitioner_article",
        "policy_document",
        "report",
        "review_article",
        "curriculum_document",
    }
)
VALID_QUARTILES = frozenset({"Q1", "Q2"})

MIN_PUBLICATION_YEAR = 1500
MAX_PUBLICATION_YEAR = 2100

# Mirrors app.ingestion.metadata_schema.DocumentMetadata.doi exactly.
_DOI_PATTERN = re.compile(r"^10\.\d{4,9}/\S+$")
_URL_PATTERN = re.compile(r"^https?://\S+$")

REQUIRED_COLUMNS = frozenset({"filename", "document_type"})
KNOWN_COLUMNS = frozenset(
    {
        "filename",
        "title",
        "authors",
        "publication_year",
        "source_venue",
        "document_type",
        "journal_quartile",
        "doi",
        "source_url",
        "language",
        "notes",
    }
)


@dataclass(frozen=True)
class MetadataRowError:
    row_number: int
    filename: str
    field_name: str
    message: str

    def __str__(self) -> str:
        base = f"row {self.row_number}"
        location = f"{base} ({self.filename})" if self.filename else base
        return f"{location}: {self.field_name}: {self.message}"


@dataclass
class MetadataRow:
    row_number: int
    filename: str
    title: str | None = None
    authors: list[str] = field(default_factory=list)
    publication_year: int | None = None
    source_venue: str | None = None
    document_type: str | None = None
    journal_quartile: str | None = None
    doi: str | None = None
    source_url: str | None = None
    # Bookkeeping-only — see module docstring.
    language: str | None = None
    notes: str | None = None


@dataclass
class MetadataCsvResult:
    rows: list[MetadataRow]
    errors: list[MetadataRowError]
    duplicate_filenames: dict[str, list[int]]
    unknown_columns: list[str]

    @property
    def is_valid(self) -> bool:
        return not self.errors and not self.duplicate_filenames

    def rows_by_filename(self) -> dict[str, MetadataRow]:
        """Last row wins on an exact-duplicate filename; is_valid already
        flags duplicates as an error, so this is only used after a caller
        has decided to proceed despite them (e.g. --continue-on-error)."""
        return {row.filename: row for row in self.rows}


@dataclass
class CorpusCrossCheck:
    missing_files: list[str]
    undocumented_files: list[str]


def _clean(value: str | None) -> str | None:
    if value is None:
        return None
    stripped = value.strip()
    return stripped or None


def load_metadata_csv(path: Path) -> MetadataCsvResult:
    with path.open(newline="", encoding="utf-8-sig") as csv_file:
        reader = csv.DictReader(csv_file)
        if reader.fieldnames is None:
            raise ValueError(f"'{path}' has no header row")

        columns = set(reader.fieldnames)
        missing_columns = REQUIRED_COLUMNS - columns
        if missing_columns:
            raise ValueError(
                f"'{path}' is missing required column(s): {sorted(missing_columns)}. "
                f"Required: {sorted(REQUIRED_COLUMNS)}."
            )
        unknown_columns = sorted(columns - KNOWN_COLUMNS)

        rows: list[MetadataRow] = []
        errors: list[MetadataRowError] = []
        seen_filenames: dict[str, list[int]] = {}

        for row_number, raw_row in enumerate(reader, start=1):
            filename = _clean(raw_row.get("filename"))
            if not filename:
                errors.append(
                    MetadataRowError(
                        row_number, "", "filename", "filename is required and cannot be blank"
                    )
                )
                continue

            seen_filenames.setdefault(filename, []).append(row_number)

            row = MetadataRow(row_number=row_number, filename=filename)
            row.title = _clean(raw_row.get("title"))
            authors_raw = _clean(raw_row.get("authors"))
            if authors_raw:
                row.authors = [name.strip() for name in authors_raw.split(";") if name.strip()]
            row.source_venue = _clean(raw_row.get("source_venue"))
            row.document_type = _clean(raw_row.get("document_type"))
            row.journal_quartile = _clean(raw_row.get("journal_quartile"))
            row.doi = _clean(raw_row.get("doi"))
            row.source_url = _clean(raw_row.get("source_url"))
            row.language = _clean(raw_row.get("language"))
            row.notes = _clean(raw_row.get("notes"))

            year_raw = _clean(raw_row.get("publication_year"))
            if year_raw is not None:
                try:
                    row.publication_year = int(year_raw)
                except ValueError:
                    errors.append(
                        MetadataRowError(
                            row_number,
                            filename,
                            "publication_year",
                            f"'{year_raw}' is not an integer",
                        )
                    )

            if row.document_type is None:
                errors.append(
                    MetadataRowError(
                        row_number, filename, "document_type", "document_type is required"
                    )
                )
            elif row.document_type not in VALID_DOCUMENT_TYPES:
                errors.append(
                    MetadataRowError(
                        row_number,
                        filename,
                        "document_type",
                        f"'{row.document_type}' is not one of {sorted(VALID_DOCUMENT_TYPES)}",
                    )
                )

            if row.journal_quartile is not None and row.journal_quartile not in VALID_QUARTILES:
                errors.append(
                    MetadataRowError(
                        row_number,
                        filename,
                        "journal_quartile",
                        f"'{row.journal_quartile}' must be one of "
                        f"{sorted(VALID_QUARTILES)} or blank",
                    )
                )

            if row.publication_year is not None and not (
                MIN_PUBLICATION_YEAR <= row.publication_year <= MAX_PUBLICATION_YEAR
            ):
                errors.append(
                    MetadataRowError(
                        row_number,
                        filename,
                        "publication_year",
                        f"{row.publication_year} is out of range "
                        f"[{MIN_PUBLICATION_YEAR}, {MAX_PUBLICATION_YEAR}]",
                    )
                )

            if row.doi is not None and not _DOI_PATTERN.match(row.doi):
                errors.append(
                    MetadataRowError(
                        row_number,
                        filename,
                        "doi",
                        f"'{row.doi}' does not look like a valid DOI "
                        "(expected e.g. 10.1234/abcd.5678)",
                    )
                )

            if row.source_url is not None and not _URL_PATTERN.match(row.source_url):
                errors.append(
                    MetadataRowError(
                        row_number,
                        filename,
                        "source_url",
                        f"'{row.source_url}' must start with http:// or https://",
                    )
                )

            rows.append(row)

        duplicate_filenames = {name: nums for name, nums in seen_filenames.items() if len(nums) > 1}

        return MetadataCsvResult(
            rows=rows,
            errors=errors,
            duplicate_filenames=duplicate_filenames,
            unknown_columns=unknown_columns,
        )


def cross_check_metadata(rows: list[MetadataRow], discovered_files: list[Path]) -> CorpusCrossCheck:
    """Rows with no matching file, and files with no matching row. Neither
    is necessarily fatal on its own: an undocumented file can still be
    ingested via --document-type; a metadata row with no file is just
    inert until that file shows up under --path."""
    discovered_names = {discovered.name for discovered in discovered_files}
    csv_names = {row.filename for row in rows}
    missing_files = sorted(name for name in csv_names if name not in discovered_names)
    undocumented_files = sorted(name for name in discovered_names if name not in csv_names)
    return CorpusCrossCheck(missing_files=missing_files, undocumented_files=undocumented_files)
