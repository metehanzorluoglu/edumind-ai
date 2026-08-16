"""Milestone 5.3 (LaTeX Project Workspace & File Management) — on-disk
storage for a Writing Project's BINARY assets (figures: PNG/JPEG/PDF).

Deliberately mirrors app/services/document_file_storage.py's shape
exactly (server-minted-id-keyed paths, never the caller's filename, a
containment check on every read/delete) rather than introducing a third,
subtly-different storage convention — see that module's docstring for
the general reasoning this repeats. The one structural difference: a
Writing Project file's real, user-meaningful name/path lives in the
`writing_project_files` DB row (WritingProjectFile.name + parent_id),
never here — this class only ever sees an opaque `file_id` (a UUID this
milestone's repository mints), so a crafted or duplicate logical
filename can never influence where bytes land on disk or collide with
another file's bytes.

Text files (.tex/.cls/.sty/.txt) never reach this class at all — their
content lives directly in WritingProjectFile.content_text (Part 1: "do
NOT store large binary blobs directly in SQLite" only applies to
binary kind; a bounded LaTeX source file is exactly the kind of text
content this codebase already stores as a Text column elsewhere, e.g.
WritingProject.main_tex_content itself).
"""

from __future__ import annotations

import shutil
import uuid
from pathlib import Path

_EXTENSION_BY_MIME: dict[str, str] = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "application/pdf": ".pdf",
}


def extension_for_mime(mime_type: str) -> str:
    return _EXTENSION_BY_MIME.get(mime_type, "")


class WritingProjectFileStorageError(Exception):
    """Raised when a storage_key fails the containment check — defense
    in depth only, mirroring DocumentFileStorageError; every real caller
    in this codebase only ever passes back a key this class itself
    minted."""


class WritingProjectFileStorage:
    def __init__(self, root_dir: str) -> None:
        self._root = Path(root_dir).resolve()
        self._root.mkdir(parents=True, exist_ok=True)

    def _key_for(
        self, *, user_id: uuid.UUID, project_id: uuid.UUID, file_id: uuid.UUID, mime_type: str
    ) -> str:
        # Partitioned by user_id then project_id — a leaked/guessed
        # file_id alone can never be used to locate another user's
        # asset, and deleting a whole project's assets never requires
        # scanning every file this user has ever uploaded (see delete()
        # counterpart in WritingProjectFilesRepository / the project-
        # delete route, which removes the whole `{user_id}/{project_id}`
        # subtree in one shutil.rmtree, not a per-file loop).
        return f"{user_id}/{project_id}/{file_id}{extension_for_mime(mime_type)}"

    def _resolve_within_root(self, storage_key: str) -> Path:
        candidate = (self._root / storage_key).resolve()
        try:
            candidate.relative_to(self._root)
        except ValueError as exc:
            raise WritingProjectFileStorageError(
                f"storage_key {storage_key!r} resolves outside the storage root"
            ) from exc
        return candidate

    def save(
        self,
        *,
        user_id: uuid.UUID,
        project_id: uuid.UUID,
        file_id: uuid.UUID,
        mime_type: str,
        data: bytes,
    ) -> str:
        storage_key = self._key_for(
            user_id=user_id, project_id=project_id, file_id=file_id, mime_type=mime_type
        )
        dest = self._resolve_within_root(storage_key)
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(data)
        return storage_key

    def read(self, storage_key: str) -> bytes:
        return self._resolve_within_root(storage_key).read_bytes()

    def delete(self, storage_key: str) -> None:
        """Best-effort — a missing file is already success, matching
        DocumentFileStorage.delete's own convention."""
        try:
            path = self._resolve_within_root(storage_key)
        except WritingProjectFileStorageError:
            return
        path.unlink(missing_ok=True)

    def delete_project(self, *, user_id: uuid.UUID, project_id: uuid.UUID) -> None:
        """Removes the ENTIRE `{user_id}/{project_id}` subtree in one
        call — used by the Writing Project delete route (Part 35: "must
        NOT delete Documents/references/highlights/Notes", which this
        never touches — this only ever removes bytes under this
        project's own storage subtree) and by the duplicate-project
        rollback path if a copy fails partway through."""
        try:
            path = self._resolve_within_root(f"{user_id}/{project_id}")
        except WritingProjectFileStorageError:
            return
        shutil.rmtree(path, ignore_errors=True)
