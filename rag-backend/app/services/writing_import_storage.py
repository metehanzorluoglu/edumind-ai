"""Milestone 5.4 (LaTeX Templates & Project Import) — on-disk staging
for an uploaded-but-not-yet-confirmed project ZIP.

Deliberately mirrors app/services/writing_project_file_storage.py's
shape exactly (server-minted-id-keyed paths, never the caller's
filename, a containment check on every read/delete) rather than
introducing a fourth, subtly-different storage convention. The one
structural difference: this storage is TEMPORARY (Part 32) — every
write here is paired with a `WritingImportSession` DB row carrying an
`expires_at`, and `sweep_expired()` is called at the top of both the
inspect and confirm routes to delete anything past its TTL, so staged
bytes never accumulate unboundedly regardless of how many uploads are
started and abandoned.
"""

from __future__ import annotations

import shutil
import uuid
from pathlib import Path


class WritingImportStorageError(Exception):
    """Raised when a storage_key fails the containment check — defense
    in depth only, mirroring WritingProjectFileStorageError; every real
    caller in this codebase only ever passes back a key this class
    itself minted."""


class WritingImportStorage:
    def __init__(self, root_dir: str) -> None:
        self._root = Path(root_dir).resolve()
        self._root.mkdir(parents=True, exist_ok=True)

    def _resolve_within_root(self, storage_key: str) -> Path:
        candidate = (self._root / storage_key).resolve()
        try:
            candidate.relative_to(self._root)
        except ValueError as exc:
            raise WritingImportStorageError(
                f"storage_key {storage_key!r} resolves outside the storage root"
            ) from exc
        return candidate

    def save(self, *, user_id: uuid.UUID, session_id: uuid.UUID, data: bytes) -> str:
        # Partitioned by user_id — a leaked/guessed session_id alone
        # still resolves under that same user's own subtree; ownership
        # is enforced at the DB-row layer (WritingImportSession.user_id),
        # this partitioning is defense in depth, matching every other
        # storage class in this codebase.
        storage_key = f"{user_id}/{session_id}.zip"
        dest = self._resolve_within_root(storage_key)
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(data)
        return storage_key

    def read(self, storage_key: str) -> bytes:
        return self._resolve_within_root(storage_key).read_bytes()

    def delete(self, storage_key: str) -> None:
        """Best-effort — a missing file is already success, matching
        every other storage class's delete() convention."""
        try:
            path = self._resolve_within_root(storage_key)
        except WritingImportStorageError:
            return
        path.unlink(missing_ok=True)

    def delete_user_subtree(self, *, user_id: uuid.UUID) -> None:
        """Not currently called by any route — reserved for a future
        account-deletion cleanup pass, mirroring
        WritingProjectFileStorage.delete_project's identical shape so
        the two storage classes stay structurally interchangeable."""
        try:
            path = self._resolve_within_root(str(user_id))
        except WritingImportStorageError:
            return
        shutil.rmtree(path, ignore_errors=True)
