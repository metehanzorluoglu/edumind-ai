"""Real-corpus ingestion CLI.

Usage:
    python -m cli.ingest --user-id <uuid> --path ./data/raw --recursive \
        --metadata ./data/metadata.csv
    python -m cli.ingest --user-id <uuid> --path ./data/raw --recursive \
        --metadata ./data/metadata.csv --dry-run
    python -m cli.ingest --user-id <uuid> --path ./data/raw --recursive \
        --metadata ./data/metadata.csv --continue-on-error
    python -m cli.ingest --user-id <uuid> --path ./data/raw/one_file.pdf --document-type report

Every ingested document is owned by --user-id, exactly like a document
uploaded through the API is owned by whichever user authenticated the
request — this CLI has no session of its own, so the operator supplies the
owner explicitly.

See data/metadata-template.csv for the metadata CSV format and the valid
document_type/journal_quartile enum values (mirrored from
app/ingestion/metadata_schema.py — never invented here).

Resumability: a document is only recorded in the `documents` table (see
app/db/documents_repository.py) once chunking, embedding, and Qdrant upsert
have ALL succeeded (see app/ingestion/ingest.py's docstring). That means
simply re-running this exact command over the same --path is always safe
and resumable: previously-successful documents report as "duplicate" and
are skipped; previously-failed documents were never recorded, so they are
retried automatically. --retry-from additionally lets you restrict a run
to just the files that failed in a specific earlier report.

Never infers journal quartile (or any other metadata) from article text —
values come only from --metadata rows or the --document-type fallback.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import uuid
from pathlib import Path

from app.config import get_settings
from app.core.errors import EmbeddingProviderError
from app.db.documents_repository import DocumentsRepository
from app.db.session import get_session_factory
from app.deps import get_embedding_provider, get_vector_store
from app.ingestion.chunker import chunk_pages
from app.ingestion.errors import (
    DocumentExtractionError,
    DuplicateDocumentError,
    UnsupportedFileTypeError,
)
from app.ingestion.hashing import compute_sha256
from app.ingestion.ingest import ingest_document
from app.vectorstore.errors import VectorStoreError
from cli.metadata_csv import (
    VALID_DOCUMENT_TYPES,
    MetadataRow,
    cross_check_metadata,
    load_metadata_csv,
)
from cli.reporting import DocumentReport, IngestionSummary, utcnow, write_reports

SUPPORTED_EXTENSIONS = frozenset({".pdf", ".docx", ".txt", ".html", ".htm", ".md", ".markdown"})


def discover_files(path: Path, *, recursive: bool) -> list[Path]:
    if path.is_file():
        return [path]
    if not path.is_dir():
        raise FileNotFoundError(f"No such file or directory: {path}")

    pattern = "**/*" if recursive else "*"
    return sorted(p for p in path.glob(pattern) if p.is_file() and not p.name.startswith("."))


def _resolve_row(
    filename: str, metadata_rows: dict[str, MetadataRow], fallback_document_type: str | None
) -> tuple[MetadataRow | None, str | None]:
    """Returns (row_or_None, error_message_or_None)."""
    row = metadata_rows.get(filename)
    if row is not None:
        return row, None
    if fallback_document_type is not None:
        return (
            MetadataRow(row_number=-1, filename=filename, document_type=fallback_document_type),
            None,
        )
    return None, (
        f"No metadata row for '{filename}' and no --document-type fallback given. "
        "Add a row to the metadata CSV or pass --document-type."
    )


def _previously_failed_filenames(report_path: Path) -> set[str]:
    data = json.loads(report_path.read_text(encoding="utf-8"))
    return {
        doc["filename"]
        for doc in data.get("documents", [])
        if str(doc.get("result", "")).startswith("failed_")
    }


def _ingest_one(
    file_path: Path,
    row: MetadataRow,
    *,
    dry_run: bool,
    user_id: uuid.UUID,
    repository: DocumentsRepository,
) -> DocumentReport:
    start = time.monotonic()

    if file_path.suffix.lower() not in SUPPORTED_EXTENSIONS:
        return DocumentReport(
            filename=file_path.name,
            result="failed_validation",
            duration_seconds=time.monotonic() - start,
            detail=(
                f"Unsupported file extension '{file_path.suffix}'. "
                f"Supported: {sorted(SUPPORTED_EXTENSIONS)}"
            ),
        )

    checksum = compute_sha256(file_path)
    if repository.contains_sha256(user_id, checksum):
        return DocumentReport(
            filename=file_path.name,
            result="duplicate",
            duration_seconds=time.monotonic() - start,
            checksum=checksum,
            detail="Already ingested by this user (sha256 match).",
        )

    try:
        ingestion_result = ingest_document(
            file_path,
            document_type=row.document_type,  # type: ignore[arg-type]
            duplicate_checker=repository,
            user_id=user_id,
            journal_quartile=row.journal_quartile,  # type: ignore[arg-type]
            title=row.title,
            authors=row.authors or None,
            publication_year=row.publication_year,
            source_venue=row.source_venue,
            doi=row.doi,
            source_url=row.source_url,
        )
    except DuplicateDocumentError:
        return DocumentReport(
            filename=file_path.name,
            result="duplicate",
            duration_seconds=time.monotonic() - start,
            checksum=checksum,
        )
    except UnsupportedFileTypeError as exc:
        return DocumentReport(
            filename=file_path.name,
            result="failed_validation",
            duration_seconds=time.monotonic() - start,
            checksum=checksum,
            detail=str(exc),
        )
    except DocumentExtractionError as exc:
        return DocumentReport(
            filename=file_path.name,
            result="failed_extraction",
            duration_seconds=time.monotonic() - start,
            checksum=checksum,
            detail=str(exc),
        )

    metadata = ingestion_result.metadata
    chunks = chunk_pages(ingestion_result.pages)
    character_count = len(ingestion_result.full_text)
    page_count = metadata.page_count

    if dry_run:
        return DocumentReport(
            filename=file_path.name,
            result="skipped",
            duration_seconds=time.monotonic() - start,
            checksum=checksum,
            file_type=metadata.file_format,
            character_count=character_count,
            page_count=page_count,
            chunk_count=len(chunks),
            embedding_status="not_attempted (dry run)",
            upsert_status="not_attempted (dry run)",
            document_id=metadata.document_id,
            detail="Dry run: extraction succeeded; would ingest.",
        )

    embedding_provider = get_embedding_provider()
    try:
        embeddings = embedding_provider.embed_batch([chunk.text for chunk in chunks])
    except EmbeddingProviderError as exc:
        return DocumentReport(
            filename=file_path.name,
            result="failed_embedding",
            duration_seconds=time.monotonic() - start,
            checksum=checksum,
            file_type=metadata.file_format,
            character_count=character_count,
            page_count=page_count,
            chunk_count=len(chunks),
            embedding_status="failed",
            detail=str(exc),
        )

    vector_store = get_vector_store()
    try:
        vector_store.upsert_chunks(metadata, chunks, embeddings, user_id=str(user_id))
    except VectorStoreError as exc:
        return DocumentReport(
            filename=file_path.name,
            result="failed_storage",
            duration_seconds=time.monotonic() - start,
            checksum=checksum,
            file_type=metadata.file_format,
            character_count=character_count,
            page_count=page_count,
            chunk_count=len(chunks),
            embedding_status="succeeded",
            upsert_status="failed",
            detail=str(exc),
        )

    repository.create(user_id=user_id, metadata=metadata, chunk_count=len(chunks))

    return DocumentReport(
        filename=file_path.name,
        result="ingested",
        duration_seconds=time.monotonic() - start,
        checksum=checksum,
        file_type=metadata.file_format,
        character_count=character_count,
        page_count=page_count,
        chunk_count=len(chunks),
        embedding_status="succeeded",
        upsert_status="succeeded",
        document_id=metadata.document_id,
    )


def run(args: argparse.Namespace) -> IngestionSummary:
    started_at = utcnow()
    path = Path(args.path)
    files = discover_files(path, recursive=args.recursive)

    metadata_rows: dict[str, MetadataRow] = {}
    if args.metadata:
        metadata_path = Path(args.metadata)
        csv_result = load_metadata_csv(metadata_path)

        if csv_result.errors:
            print(f"Metadata CSV has {len(csv_result.errors)} error(s):", file=sys.stderr)
            for csv_error in csv_result.errors:
                print(f"  - {csv_error}", file=sys.stderr)
        if csv_result.duplicate_filenames:
            print("Metadata CSV has duplicate filenames:", file=sys.stderr)
            for name, row_numbers in csv_result.duplicate_filenames.items():
                print(f"  - '{name}' appears in rows {row_numbers}", file=sys.stderr)
        if csv_result.unknown_columns:
            print(
                "Note: metadata CSV has unrecognized column(s), ignored: "
                f"{csv_result.unknown_columns}",
                file=sys.stderr,
            )

        if not csv_result.is_valid and not args.continue_on_error:
            print(
                "Aborting: metadata CSV is invalid. Fix the errors above, or pass "
                "--continue-on-error to skip only the broken rows.",
                file=sys.stderr,
            )
            sys.exit(1)

        metadata_rows = csv_result.rows_by_filename()

        cross_check = cross_check_metadata(csv_result.rows, files)
        if cross_check.missing_files:
            print(
                f"Note: {len(cross_check.missing_files)} metadata row(s) reference file(s) not "
                f"found under {path}: {cross_check.missing_files}",
                file=sys.stderr,
            )
        if cross_check.undocumented_files:
            qualifier = (
                "will use --document-type fallback"
                if args.document_type
                else "will fail validation"
            )
            print(
                f"Note: {len(cross_check.undocumented_files)} file(s) under {path} have no "
                f"metadata row ({qualifier}): {cross_check.undocumented_files}",
                file=sys.stderr,
            )

    if args.retry_from:
        retry_filenames = _previously_failed_filenames(Path(args.retry_from))
        files = [f for f in files if f.name in retry_filenames]
        print(
            f"--retry-from: restricting to {len(files)} previously-failed file(s).", file=sys.stderr
        )

    summary = IngestionSummary(
        started_at=started_at,
        finished_at=started_at,
        dry_run=args.dry_run,
        source_path=str(path),
    )

    with get_session_factory()() as db:
        repository = DocumentsRepository(db)

        for index, file_path in enumerate(files, start=1):
            resolved_row, resolve_error = _resolve_row(
                file_path.name, metadata_rows, args.document_type
            )
            if resolve_error is not None or resolved_row is None:
                report = DocumentReport(
                    filename=file_path.name,
                    result="failed_validation",
                    duration_seconds=0.0,
                    detail=resolve_error,
                )
            elif resolved_row.document_type not in VALID_DOCUMENT_TYPES:
                report = DocumentReport(
                    filename=file_path.name,
                    result="failed_validation",
                    duration_seconds=0.0,
                    detail=(
                        f"'{resolved_row.document_type}' is not a valid document_type: "
                        f"{sorted(VALID_DOCUMENT_TYPES)}"
                    ),
                )
            else:
                report = _ingest_one(
                    file_path,
                    resolved_row,
                    dry_run=args.dry_run,
                    user_id=args.user_id,
                    repository=repository,
                )

            summary.documents.append(report)
            print(
                f"[{index}/{len(files)}] {file_path.name} ... "
                f"{report.result} ({report.duration_seconds:.2f}s)"
            )
            if report.detail and report.is_failure:
                print(f"    {report.detail}", file=sys.stderr)

            if report.is_failure and not args.continue_on_error:
                print(
                    "Stopping after first failure (pass --continue-on-error to keep going).",
                    file=sys.stderr,
                )
                break

    summary.finished_at = utcnow()
    return summary


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m cli.ingest", description="Ingest real documents into the RAG corpus."
    )
    parser.add_argument(
        "--user-id",
        required=True,
        type=uuid.UUID,
        help="Owner to assign every ingested document to.",
    )
    parser.add_argument("--path", required=True, help="A single file or a directory of documents.")
    parser.add_argument(
        "--recursive", action="store_true", help="Recurse into subdirectories of --path."
    )
    parser.add_argument(
        "--metadata", help="Path to a metadata CSV (see data/metadata-template.csv)."
    )
    parser.add_argument(
        "--document-type",
        choices=sorted(VALID_DOCUMENT_TYPES),
        help="Fallback document_type for files with no metadata CSV row.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Validate and extract, but do not embed, store, or register anything.",
    )
    parser.add_argument(
        "--continue-on-error",
        action="store_true",
        help="Keep processing remaining files after a failure instead of stopping immediately.",
    )
    parser.add_argument(
        "--retry-from",
        help="Path to a previous ingestion-*.json report; restrict this run to files that failed.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    get_settings()  # fail fast if the environment is misconfigured (e.g. missing JWT_SECRET)

    summary = run(args)

    reports_dir = Path("data/reports")
    json_path, md_path = write_reports(summary, reports_dir)
    print(f"\nReports written: {json_path}, {md_path}")

    print("\nSummary:")
    for result, count in sorted(summary.counts.items()):
        print(f"  {result}: {count}")

    return 1 if any(doc.is_failure for doc in summary.documents) else 0


if __name__ == "__main__":
    sys.exit(main())
