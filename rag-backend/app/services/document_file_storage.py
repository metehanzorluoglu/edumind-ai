"""Original-file storage for RAG documents (Frontend Milestone 3.1: Original
Document Reader & Native Annotation Layer).

Deliberately a SEPARATE class from app/services/attachment_storage.py (chat
attachments — re-encodes PNG/JPEG, strips EXIF, a different MIME set scoped
to what a chat message may attach) and from app/ingestion/* (which parses
uploaded bytes into text/metadata and has never retained the bytes
themselves — see app/ingestion/ingest.py). This class exists for exactly one
purpose: let the Document Reader show the actual original file (real PDF
pages/typography, or the original DOCX/TXT/HTML/Markdown bytes) instead of
only extracted text — while mirroring AttachmentStorage's safety pattern:
server-generated-id-keyed paths, never the caller's filename, and a
containment check on every read/delete so a corrupted or hand-edited
storage_key can never escape the storage root.

Storage layout: `{root_dir}/{user_id}/{document_id}{extension}` — extension
is derived from the already-validated, server-determined `file_format`
(app/ingestion/metadata_schema.py's FileFormat), never from the raw
uploaded filename (see _EXTENSION_BY_FORMAT), matching the same convention
app/ingestion/loaders/dispatch.py already uses to pick a loader. No
re-encoding: unlike AttachmentStorage, every format here is stored
byte-for-byte — fidelity to "the original" is the entire point of this
milestone (re-encoding a PDF is not an option).

A document that predates this milestone (or was ingested through a path
that doesn't call this class — see document_ingestion_jobs.py's module
docstring for the current scope) simply has no file here: its
`documents.storage_key` column is NULL, and the Reader falls back to the
extracted-text view. This class never tries to reconstruct or guess at a
missing original — that would risk fabricating a "PDF" that was never
actually uploaded (explicitly forbidden by the milestone spec).
"""

from __future__ import annotations

import shutil
import uuid
from pathlib import Path

_EXTENSION_BY_FORMAT: dict[str, str] = {
    "pdf": ".pdf",
    "docx": ".docx",
    "txt": ".txt",
    "html": ".html",
    "markdown": ".md",
}

_MIME_BY_FORMAT: dict[str, str] = {
    "pdf": "application/pdf",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "txt": "text/plain; charset=utf-8",
    "html": "text/html; charset=utf-8",
    "markdown": "text/markdown; charset=utf-8",
}


def mime_type_for_format(file_format: str) -> str:
    """The server-determined Content-Type for GET /documents/{id}/file —
    never trusts a client-supplied Content-Type, matching this codebase's
    existing "format is decided server-side" convention."""
    return _MIME_BY_FORMAT.get(file_format, "application/octet-stream")


def extension_for_format(file_format: str) -> str:
    return _EXTENSION_BY_FORMAT.get(file_format, "")


class DocumentFileStorageError(Exception):
    """Raised when a storage_key fails the containment check, or points at
    something that isn't a regular file — defense-in-depth only (every real
    caller in this codebase only ever passes back a key this class itself
    minted), mirroring AttachmentStorage's own _resolve_within_root."""


class DocumentFileStorage:
    def __init__(self, root_dir: str) -> None:
        self._root = Path(root_dir).resolve()
        self._root.mkdir(parents=True, exist_ok=True)

    def _key_for(self, user_id: uuid.UUID, document_id: str, file_format: str) -> str:
        # document_id is already a server-minted UUID-shaped string (see
        # app/ingestion/ingest.py) — never derived from the caller's
        # filename, so no sanitization/traversal concern exists for it
        # either, but we still resolve the final path through
        # _resolve_within_root below as defense-in-depth.
        return f"{user_id}/{document_id}{extension_for_format(file_format)}"

    def _resolve_within_root(self, storage_key: str) -> Path:
        candidate = (self._root / storage_key).resolve()
        try:
            candidate.relative_to(self._root)
        except ValueError as exc:
            raise DocumentFileStorageError(
                f"storage_key {storage_key!r} resolves outside the storage root"
            ) from exc
        return candidate

    def move_into_storage(
        self,
        *,
        user_id: uuid.UUID,
        document_id: str,
        file_format: str,
        tmp_path: Path,
    ) -> str:
        """Moves an already-parsed temp file into permanent, per-user
        storage and returns the relative storage_key to persist on the
        Document row.

        A move (not a copy-then-unlink-elsewhere), so there is never a
        window where the same bytes exist in two places under this class's
        control. Callers (see app/core/document_ingestion_jobs.py) are
        responsible for the surrounding transaction-safety decision — this
        method only knows how to place bytes at rest; it has no view of
        whether the SQL row or embeddings ultimately succeed.
        """
        storage_key = self._key_for(user_id, document_id, file_format)
        dest = self._resolve_within_root(storage_key)
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(tmp_path), str(dest))
        return storage_key

    def exists(self, storage_key: str) -> bool:
        """True if the storage_key's file is physically present right now.
        Frontend/Platform Milestone 3.2.1 — a document's DB row (and its
        `storage_key` column specifically) can outlive the physical file
        if the storage root was ever misconfigured onto non-persistent
        storage (see this milestone's report): `storage_key is not None`
        alone is NOT sufficient to promise the Reader a working original,
        which is exactly what caused "Couldn't load the original PDF" in
        production. Callers building `original_file_available` for a
        response MUST use this (or read_path, if they need the path too),
        never the bare presence of storage_key. Cheap: a local filesystem
        stat, not a network call — and only ever invoked for a document
        that already claims to have a stored file (the common case, no
        storage_key at all, never reaches here)."""
        try:
            path = self._resolve_within_root(storage_key)
        except DocumentFileStorageError:
            return False
        return path.is_file()

    def read_path(self, storage_key: str) -> Path:
        """Resolves a stored key back to a real filesystem path for
        FileResponse to stream (with Range support) — raises
        DocumentFileStorageError rather than silently returning a
        nonexistent/foreign path."""
        path = self._resolve_within_root(storage_key)
        if not path.is_file():
            raise DocumentFileStorageError(f"storage_key {storage_key!r} is not a file")
        return path

    def delete(self, storage_key: str) -> None:
        """Best-effort delete — used both by document-delete cleanup and by
        orphaned-file cleanup when a background ingestion job fails after
        the file was already moved into storage. Never raises for a
        missing file (already-gone is success, not an error)."""
        try:
            path = self._resolve_within_root(storage_key)
        except DocumentFileStorageError:
            return
        path.unlink(missing_ok=True)
