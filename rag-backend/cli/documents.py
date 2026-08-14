"""Document-management CLI for the indexed corpus.

Usage:
    python -m cli.documents list --user-id <uuid> [--limit N] [--offset N]
    python -m cli.documents inspect --user-id <uuid> <document-id>
    python -m cli.documents remove --user-id <uuid> <document-id> [--yes]
    python -m cli.documents reingest --user-id <uuid> <document-id> --path <file-or-dir> [--yes]
    python -m cli.documents refresh-metadata --user-id <uuid> <document-id> --path <file-or-dir> \
        [--overwrite] [--yes]
    python -m cli.documents stats --user-id <uuid>
    python -m cli.documents adopt-legacy --user-id <uuid> [--yes]

Every command (except adopt-legacy, see its own help) is scoped to one
--user-id, exactly like the API is scoped to the authenticated caller —
this CLI has no session of its own, so the operator supplies the user
explicitly.

`inspect` never prints chunk text, only metadata and counts.
"""

from __future__ import annotations

import argparse
import hashlib
import sys
import uuid
from collections import Counter
from collections.abc import Callable
from pathlib import Path

from app.config import get_settings
from app.core.document_deletion import delete_document_by_id
from app.core.errors import EmbeddingProviderError
from app.db.document_highlights_repository import DocumentHighlightsRepository
from app.db.documents_repository import DocumentRecord, DocumentsRepository
from app.db.scopes_repository import ScopesRepository
from app.db.session import get_session_factory
from app.deps import get_document_file_storage, get_embedding_provider, get_vector_store
from app.ingestion.chunker import chunk_pages
from app.ingestion.errors import (
    DocumentExtractionError,
    DuplicateDocumentError,
    UnsupportedFileTypeError,
)
from app.ingestion.ingest import ingest_document
from app.ingestion.loaders.dispatch import load_document
from app.ingestion.metadata_schema import DocumentMetadata
from app.vectorstore.errors import VectorStoreError

_STATS_SCAN_LIMIT = 10_000
_REFRESH_FIELDS = ("title", "authors", "publication_year", "source_venue", "doi", "source_url")


def _confirm(prompt: str, *, assume_yes: bool) -> bool:
    if assume_yes:
        return True
    answer = input(f"{prompt} [y/N] ").strip().lower()
    return answer in {"y", "yes"}


def _print_document(record: DocumentRecord) -> None:
    print(f"document_id:      {record.document_id}")
    print(f"source_filename:  {record.source_filename}")
    print(f"document_type:    {record.document_type}")
    print(f"journal_quartile: {record.journal_quartile or '(none)'}")
    print(f"title:            {record.title or '(none)'}")
    print(f"authors:          {', '.join(record.authors) if record.authors else '(none)'}")
    publication_year = record.publication_year if record.publication_year is not None else "(none)"
    print(f"publication_year: {publication_year}")
    print(f"source_venue:     {record.source_venue or '(none)'}")
    print(f"doi:              {record.doi or '(none)'}")
    print(f"source_url:       {record.source_url or '(none)'}")
    print(f"ingested_at:      {record.ingested_at.isoformat()}")
    print(f"chunk_count:      {record.chunk_count}")


def cmd_list(args: argparse.Namespace) -> int:
    with get_session_factory()() as db:
        repository = DocumentsRepository(db)
        records, total = repository.list_for_user(
            args.user_id, limit=args.limit, offset=args.offset
        )

    print(f"Showing {len(records)} of {total} document(s):\n")
    for record in records:
        print(
            f"{record.document_id}  {record.document_type:<22} "
            f"{(record.journal_quartile or '-'):<3}  {record.chunk_count:>3} chunk(s)  "
            f"{record.source_filename}"
        )
    return 0


def cmd_inspect(args: argparse.Namespace) -> int:
    with get_session_factory()() as db:
        repository = DocumentsRepository(db)
        record = repository.get(args.user_id, args.document_id)
    if record is None:
        print(f"No document found with document_id '{args.document_id}'.", file=sys.stderr)
        return 1

    _print_document(record)
    return 0


def cmd_remove(args: argparse.Namespace) -> int:
    vector_store = get_vector_store()

    with get_session_factory()() as db:
        repository = DocumentsRepository(db)
        record = repository.get(args.user_id, args.document_id)
        if record is None:
            print(f"No document found with document_id '{args.document_id}'.", file=sys.stderr)
            return 1

        print(f"About to remove '{record.source_filename}' ({record.chunk_count} chunk(s)).")
        if not _confirm("Proceed?", assume_yes=args.yes):
            print("Aborted.")
            return 1

        # Shared with DELETE /documents/{id} (see app/core/document_deletion.py)
        # — one deletion implementation for both the CLI and the API.
        result = delete_document_by_id(
            args.document_id,
            user_id=args.user_id,
            vector_store=vector_store,
            documents_repository=repository,
            scopes_repository=ScopesRepository(db),
            document_highlights_repository=DocumentHighlightsRepository(db),
            document_file_storage=get_document_file_storage(),
        )
    if result is None:
        # Can only happen if the document was deleted by something else
        # between the get() check above and now.
        print(f"No document found with document_id '{args.document_id}'.", file=sys.stderr)
        return 1

    print(f"Removed {result.deleted_chunks} chunk(s) for document_id '{args.document_id}'.")
    return 0


def cmd_reingest(args: argparse.Namespace) -> int:
    """Re-runs extraction, chunking, embedding, and storage for a document
    already in the index, using its EXISTING metadata (document_type,
    journal_quartile, title, authors, etc.) — this is for redoing the
    pipeline against the same source file (e.g. after a chunking or
    embedding-model change), not for correcting metadata. To fix metadata,
    remove the document and re-run `cli.ingest` with a corrected CSV row.

    Note: since this backend does not persist raw file bytes anywhere,
    reingest requires the original file to still exist on disk, located by
    filename under --path. It also assigns a NEW document_id (content is
    fully rebuilt from source) — this is safe and repeatable, but the old
    document_id will no longer resolve after reingest succeeds.
    """
    vector_store = get_vector_store()

    with get_session_factory()() as db:
        repository = DocumentsRepository(db)
        record = repository.get(args.user_id, args.document_id)
        if record is None:
            print(f"No document found with document_id '{args.document_id}'.", file=sys.stderr)
            return 1

        search_path = Path(args.path)
        if search_path.is_file():
            candidate = search_path
        elif search_path.is_dir():
            matches = sorted(search_path.rglob(record.source_filename))
            if not matches:
                print(
                    f"No file named '{record.source_filename}' found under {search_path}.",
                    file=sys.stderr,
                )
                return 1
            candidate = matches[0]
        else:
            print(f"--path '{search_path}' does not exist.", file=sys.stderr)
            return 1

        print(f"About to reingest '{record.source_filename}' from {candidate}.")
        print("This assigns a new document_id; the current one will stop resolving.")
        if not _confirm("Proceed?", assume_yes=args.yes):
            print("Aborted.")
            return 1

        delete_document_by_id(
            args.document_id,
            user_id=args.user_id,
            vector_store=vector_store,
            documents_repository=repository,
            scopes_repository=ScopesRepository(db),
            document_highlights_repository=DocumentHighlightsRepository(db),
            document_file_storage=get_document_file_storage(),
        )

        try:
            ingestion_result = ingest_document(
                candidate,
                document_type=record.document_type,  # type: ignore[arg-type]
                duplicate_checker=repository,
                user_id=args.user_id,
                journal_quartile=record.journal_quartile,  # type: ignore[arg-type]
                title=record.title,
                authors=record.authors or None,
                publication_year=record.publication_year,
                source_venue=record.source_venue,
                doi=record.doi,
                source_url=record.source_url,
            )
        except (DuplicateDocumentError, UnsupportedFileTypeError, DocumentExtractionError) as exc:
            print(f"Reingest failed during extraction: {exc}", file=sys.stderr)
            return 1

        metadata = ingestion_result.metadata
        chunks = chunk_pages(ingestion_result.pages)

        try:
            embeddings = get_embedding_provider().embed_batch([chunk.text for chunk in chunks])
            vector_store.upsert_chunks(metadata, chunks, embeddings, user_id=str(args.user_id))
        except (EmbeddingProviderError, VectorStoreError) as exc:
            print(f"Reingest failed during embedding/storage: {exc}", file=sys.stderr)
            return 1

        repository.create(user_id=args.user_id, metadata=metadata, chunk_count=len(chunks))

    print(f"Reingested as new document_id '{metadata.document_id}' ({len(chunks)} chunk(s)).")
    return 0


def _is_present(value: object) -> bool:
    """A field counts as "present" when it isn't None and, for str/list
    fields, isn't empty either — an int (publication_year) only needs to
    be non-None. Used by cmd_refresh_metadata to decide whether a value is
    worth keeping/overwriting, since an empty string or [] is exactly as
    "nothing extracted" as None is for those field types."""
    if value is None:
        return False
    if isinstance(value, str | list):
        return bool(value)
    return True


def cmd_refresh_metadata(args: argparse.Namespace) -> int:
    """Re-extracts metadata (embedded file metadata plus the
    structured-text fallback — see app/ingestion/loaders/dispatch.py) from
    the ORIGINAL source file and applies any improvements to an
    already-indexed document's SQL row and Qdrant chunk payloads only —
    never re-chunks, re-embeds, or creates new points/rows, so this is
    always safe to re-run and never produces duplicate chunks.

    By default, an existing non-empty field is left untouched (it may have
    been user-edited at upload time, and this command has no way to tell
    a user-edited value from an auto-extracted one after the fact); pass
    --overwrite to let freshly extracted values replace them instead. A
    freshly extracted None/empty value never overwrites an existing value
    either way — this command only ever adds information, never removes
    it.

    Note: since this backend does not persist raw file bytes anywhere,
    this requires the original file to still exist on disk, located by
    filename under --path (same file-location rule as `reingest`).
    """
    vector_store = get_vector_store()

    with get_session_factory()() as db:
        repository = DocumentsRepository(db)
        record = repository.get(args.user_id, args.document_id)
        if record is None:
            print(f"No document found with document_id '{args.document_id}'.", file=sys.stderr)
            return 1

        search_path = Path(args.path)
        if search_path.is_file():
            candidate = search_path
        elif search_path.is_dir():
            matches = sorted(search_path.rglob(record.source_filename))
            if not matches:
                print(
                    f"No file named '{record.source_filename}' found under {search_path}.",
                    file=sys.stderr,
                )
                return 1
            candidate = matches[0]
        else:
            print(f"--path '{search_path}' does not exist.", file=sys.stderr)
            return 1

        try:
            loaded = load_document(candidate)
        except (UnsupportedFileTypeError, DocumentExtractionError) as exc:
            print(f"Refresh failed during extraction: {exc}", file=sys.stderr)
            return 1

        current_values: dict[str, object] = {
            "title": record.title,
            "authors": record.authors,
            "publication_year": record.publication_year,
            "source_venue": record.source_venue,
            "doi": record.doi,
            "source_url": record.source_url,
        }
        fresh_values: dict[str, object] = {
            "title": loaded.metadata.title,
            "authors": loaded.metadata.authors,
            "publication_year": loaded.metadata.publication_year,
            "source_venue": loaded.metadata.source_venue,
            "doi": loaded.metadata.doi,
            "source_url": loaded.metadata.source_url,
        }

        updates: dict[str, object] = {}
        for field in _REFRESH_FIELDS:
            current = current_values[field]
            fresh = fresh_values[field]
            fresh_should_win = _is_present(fresh) and (args.overwrite or not _is_present(current))
            candidate_value = fresh if fresh_should_win else current
            if candidate_value != current:
                updates[field] = candidate_value

        if not updates:
            print("No metadata changes to apply.")
            return 0

        print(f"About to update metadata for '{record.source_filename}':")
        for field, new_value in updates.items():
            print(f"  {field}: {current_values[field]!r} -> {new_value!r}")
        if not _confirm("Proceed?", assume_yes=args.yes):
            print("Aborted.")
            return 1

        repository.update_metadata(args.user_id, args.document_id, updates)
        vector_store.update_chunk_metadata(
            args.document_id, user_id=str(args.user_id), updates=updates
        )

    print(f"Updated {len(updates)} field(s) for document_id '{args.document_id}'.")
    return 0


def cmd_stats(args: argparse.Namespace) -> int:
    with get_session_factory()() as db:
        repository = DocumentsRepository(db)
        records, total = repository.list_for_user(args.user_id, limit=_STATS_SCAN_LIMIT, offset=0)

    total_chunks = sum(record.chunk_count for record in records)
    by_type = Counter(record.document_type for record in records)
    by_quartile = Counter(record.journal_quartile or "(none)" for record in records)

    years = [record.publication_year for record in records if record.publication_year is not None]

    def completeness(predicate: Callable[[DocumentRecord], bool]) -> str:
        if not records:
            return "n/a"
        present = sum(1 for record in records if predicate(record))
        return f"{present}/{len(records)} ({present / len(records):.0%})"

    print(f"Total documents: {total}")
    print(f"Total chunks:    {total_chunks}")
    print("\nBy document_type:")
    for doc_type, count in sorted(by_type.items()):
        print(f"  {doc_type:<22} {count}")
    print("\nBy journal_quartile:")
    for quartile, count in sorted(by_quartile.items()):
        print(f"  {quartile:<22} {count}")
    if years:
        print(f"\nPublication year range: {min(years)}-{max(years)}")
    else:
        print("\nPublication year range: n/a (no documents have a publication_year)")

    print("\nMetadata completeness:")
    print(f"  title:            {completeness(lambda r: bool(r.title))}")
    print(f"  authors:          {completeness(lambda r: bool(r.authors))}")
    print(f"  publication_year: {completeness(lambda r: r.publication_year is not None)}")
    print(f"  source_venue:     {completeness(lambda r: bool(r.source_venue))}")
    print(f"  doi:              {completeness(lambda r: bool(r.doi))}")
    print(f"  source_url:       {completeness(lambda r: bool(r.source_url))}")
    print(f"  journal_quartile: {completeness(lambda r: bool(r.journal_quartile))}")

    return 0


def cmd_adopt_legacy(args: argparse.Namespace) -> int:
    """Backfills `user_id` onto Qdrant points written before per-user
    ownership existed, and creates a matching `documents` table row for
    each so they show up in that user's `list`/GET /documents. Since these
    predate this backend's sha256 tracking, adopted rows get a synthetic
    sha256 (a hash of the document_id, clearly not a real content hash) —
    duplicate-detection for genuinely re-uploading that same file going
    forward may not catch it, which is a one-time, known limitation of
    adopting pre-existing data, not an ongoing behavior.

    Never touches a point that already has a user_id — this can be re-run
    safely and will only ever pick up newly-appeared legacy data.
    """
    vector_store = get_vector_store()

    legacy_points_by_document: dict[str, list[str]] = {}
    sample_payload_by_document: dict[str, dict[str, object]] = {}
    for point_id, payload in vector_store.scroll_all_points_raw():
        if payload.get("user_id"):
            continue
        document_id = payload.get("document_id")
        if not isinstance(document_id, str):
            continue
        legacy_points_by_document.setdefault(document_id, []).append(point_id)
        sample_payload_by_document.setdefault(document_id, payload)

    if not legacy_points_by_document:
        print("No legacy (unowned) documents found.")
        return 0

    print(f"Found {len(legacy_points_by_document)} legacy document(s):")
    for document_id, point_ids in legacy_points_by_document.items():
        filename = sample_payload_by_document[document_id].get("source_filename", "(unknown)")
        print(f"  {document_id}  {len(point_ids)} chunk(s)  {filename}")

    if not _confirm(f"Adopt all of these for user {args.user_id}?", assume_yes=args.yes):
        print("Aborted.")
        return 1

    with get_session_factory()() as db:
        repository = DocumentsRepository(db)
        adopted = 0
        for document_id, point_ids in legacy_points_by_document.items():
            if repository.get(args.user_id, document_id) is not None:
                continue  # already adopted by this user in a previous run

            payload = sample_payload_by_document[document_id]
            vector_store.backfill_user_id(point_ids, user_id=str(args.user_id))

            synthetic_sha256 = hashlib.sha256(document_id.encode("utf-8")).hexdigest()
            metadata = DocumentMetadata(
                document_id=document_id,
                source_filename=str(payload.get("source_filename", "(unknown)")),
                file_format="txt",  # unknown for legacy data; not load-bearing post-ingestion
                sha256=synthetic_sha256,
                file_size_bytes=0,
                page_count=1,
                document_type=payload.get("document_type", "report"),  # type: ignore[arg-type]
                journal_quartile=payload.get("journal_quartile"),  # type: ignore[arg-type]
                title=payload.get("title"),  # type: ignore[arg-type]
                authors=payload.get("authors") or [],  # type: ignore[arg-type]
                publication_year=payload.get("publication_year"),  # type: ignore[arg-type]
                source_venue=payload.get("source_venue"),  # type: ignore[arg-type]
                doi=payload.get("doi"),  # type: ignore[arg-type]
                source_url=payload.get("source_url"),  # type: ignore[arg-type]
                ingested_at=payload.get("ingested_at"),  # type: ignore[arg-type]
            )
            repository.create(user_id=args.user_id, metadata=metadata, chunk_count=len(point_ids))
            adopted += 1

    print(f"Adopted {adopted} document(s) for user {args.user_id}.")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m cli.documents", description="Manage the indexed document corpus."
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    def add_user_id_arg(subparser: argparse.ArgumentParser) -> None:
        subparser.add_argument(
            "--user-id", required=True, type=uuid.UUID, help="Scope this command to one user."
        )

    list_parser = subparsers.add_parser("list", help="List one user's indexed documents.")
    add_user_id_arg(list_parser)
    list_parser.add_argument("--limit", type=int, default=20)
    list_parser.add_argument("--offset", type=int, default=0)
    list_parser.set_defaults(func=cmd_list)

    inspect_parser = subparsers.add_parser("inspect", help="Show one document's metadata.")
    add_user_id_arg(inspect_parser)
    inspect_parser.add_argument("document_id")
    inspect_parser.set_defaults(func=cmd_inspect)

    remove_parser = subparsers.add_parser("remove", help="Delete a document and all its chunks.")
    add_user_id_arg(remove_parser)
    remove_parser.add_argument("document_id")
    remove_parser.add_argument("--yes", action="store_true", help="Skip the confirmation prompt.")
    remove_parser.set_defaults(func=cmd_remove)

    reingest_parser = subparsers.add_parser(
        "reingest", help="Re-run extraction/chunking/embedding for an existing document."
    )
    add_user_id_arg(reingest_parser)
    reingest_parser.add_argument("document_id")
    reingest_parser.add_argument(
        "--path", required=True, help="File or directory containing the original source file."
    )
    reingest_parser.add_argument("--yes", action="store_true", help="Skip the confirmation prompt.")
    reingest_parser.set_defaults(func=cmd_reingest)

    refresh_metadata_parser = subparsers.add_parser(
        "refresh-metadata",
        help="Re-extract and apply metadata improvements without re-chunking/re-embedding.",
    )
    add_user_id_arg(refresh_metadata_parser)
    refresh_metadata_parser.add_argument("document_id")
    refresh_metadata_parser.add_argument(
        "--path", required=True, help="File or directory containing the original source file."
    )
    refresh_metadata_parser.add_argument(
        "--overwrite",
        action="store_true",
        help="Let freshly extracted values replace existing non-empty fields.",
    )
    refresh_metadata_parser.add_argument(
        "--yes", action="store_true", help="Skip the confirmation prompt."
    )
    refresh_metadata_parser.set_defaults(func=cmd_refresh_metadata)

    stats_parser = subparsers.add_parser("stats", help="Show one user's corpus statistics.")
    add_user_id_arg(stats_parser)
    stats_parser.set_defaults(func=cmd_stats)

    adopt_legacy_parser = subparsers.add_parser(
        "adopt-legacy",
        help="Assign pre-existing, unowned Qdrant documents to one user.",
    )
    add_user_id_arg(adopt_legacy_parser)
    adopt_legacy_parser.add_argument(
        "--yes", action="store_true", help="Skip the confirmation prompt."
    )
    adopt_legacy_parser.set_defaults(func=cmd_adopt_legacy)

    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    get_settings()  # fail fast if the environment is misconfigured
    result: int = args.func(args)
    return result


if __name__ == "__main__":
    sys.exit(main())
