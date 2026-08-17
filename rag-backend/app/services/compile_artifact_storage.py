"""Milestone 5.5 Part 22 — on-disk staging for a successfully compiled
PDF's bytes, replacing app/core/compile_artifact_cache.py's in-process
dict.

Deliberately mirrors app/services/writing_import_storage.py's shape
exactly (server-minted-id-keyed paths, never caller-supplied names, a
containment check on every read/delete) rather than introducing a
fourth, subtly-different storage convention. Every write here is paired
with a CompileArtifact DB row carrying an `expires_at`, and
`sweep_expired()` (CompileArtifactsRepository) is called at the top of
both the compile POST and PDF GET routes to delete anything past its
TTL, so staged PDFs never accumulate unboundedly regardless of how many
compiles run.
"""

from __future__ import annotations

import uuid
from pathlib import Path


class CompileArtifactStorageError(Exception):
    """Raised when a storage_key fails the containment check — defense
    in depth only, mirroring WritingImportStorageError; every real caller
    in this codebase only ever passes back a key this class itself
    minted."""


class CompileArtifactStorage:
    def __init__(self, root_dir: str) -> None:
        self._root = Path(root_dir).resolve()
        self._root.mkdir(parents=True, exist_ok=True)

    def _resolve_within_root(self, storage_key: str) -> Path:
        candidate = (self._root / storage_key).resolve()
        try:
            candidate.relative_to(self._root)
        except ValueError as exc:
            raise CompileArtifactStorageError(
                f"storage_key {storage_key!r} resolves outside the storage root"
            ) from exc
        return candidate

    def save(self, *, user_id: uuid.UUID, compile_id: uuid.UUID, pdf_bytes: bytes) -> str:
        # Partitioned by user_id — a leaked/guessed compile_id alone still
        # resolves under that same user's own subtree; ownership is
        # enforced at the DB-row layer (CompileArtifact.user_id), this
        # partitioning is defense in depth, matching every other storage
        # class in this codebase.
        storage_key = f"{user_id}/{compile_id}.pdf"
        dest = self._resolve_within_root(storage_key)
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(pdf_bytes)
        return storage_key

    def read(self, storage_key: str) -> bytes:
        return self._resolve_within_root(storage_key).read_bytes()

    def delete(self, storage_key: str) -> None:
        """Best-effort — a missing file is already success, matching
        every other storage class's delete() convention."""
        try:
            path = self._resolve_within_root(storage_key)
        except CompileArtifactStorageError:
            return
        path.unlink(missing_ok=True)
