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

SyncTeX implementation — a compile's `.synctex.gz` (see
latex_compiler_client.py's own `synctex_bytes`) rides the EXACT SAME
`compile_id`/ownership/TTL/sweep lifecycle as its PDF, deliberately with
NO new DB column: the sibling file's own path is always deterministic
(`storage_key` with `.pdf` replaced by `.synctex.gz`), so "does this
compile have SyncTeX data" is answered by trying to read it and treating
a missing file as "no" — the same honest-404-on-missing-file convention
`read()` (and routes_writing.py's own `get_compiled_pdf`) already uses
for a PDF whose on-disk file vanished out from under a surviving DB row.
"""

from __future__ import annotations

import uuid
from pathlib import Path


class CompileArtifactStorageError(Exception):
    """Raised when a storage_key fails the containment check — defense
    in depth only, mirroring WritingImportStorageError; every real caller
    in this codebase only ever passes back a key this class itself
    minted."""


def _synctex_storage_key(pdf_storage_key: str) -> str:
    """Derives the sibling SyncTeX storage key from the PDF's own
    (already-persisted, DB-of-record) storage_key — e.g.
    "{user_id}/{compile_id}.pdf" -> "{user_id}/{compile_id}.synctex.gz".
    A pure string transform, never independently minted, so the two
    files can never drift apart under different naming rules."""
    return pdf_storage_key.removesuffix(".pdf") + ".synctex.gz"


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

    def save(
        self,
        *,
        user_id: uuid.UUID,
        compile_id: uuid.UUID,
        pdf_bytes: bytes,
        synctex_bytes: bytes | None = None,
    ) -> str:
        # Partitioned by user_id — a leaked/guessed compile_id alone still
        # resolves under that same user's own subtree; ownership is
        # enforced at the DB-row layer (CompileArtifact.user_id), this
        # partitioning is defense in depth, matching every other storage
        # class in this codebase.
        storage_key = f"{user_id}/{compile_id}.pdf"
        dest = self._resolve_within_root(storage_key)
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(pdf_bytes)
        if synctex_bytes is not None:
            synctex_dest = self._resolve_within_root(_synctex_storage_key(storage_key))
            synctex_dest.write_bytes(synctex_bytes)
        return storage_key

    def read(self, storage_key: str) -> bytes:
        return self._resolve_within_root(storage_key).read_bytes()

    def read_synctex(self, pdf_storage_key: str) -> bytes:
        """Raises OSError (same as `read()`'s own contract) when this
        compile has no SyncTeX data — either it predates this feature,
        or the compile genuinely produced none (see CompileOutcome.
        synctex_bytes's own docstring in latex-compiler/app/compiler.py)
        — the caller (routes_writing.py) treats that identically to a
        missing PDF file: an honest "unavailable," never a 500."""
        return self._resolve_within_root(_synctex_storage_key(pdf_storage_key)).read_bytes()

    def delete(self, storage_key: str) -> None:
        """Best-effort — a missing file is already success, matching
        every other storage class's delete() convention. Deletes the
        sibling SyncTeX file too, if any (same best-effort posture —
        never raises just because it was already absent)."""
        try:
            path = self._resolve_within_root(storage_key)
            synctex_path = self._resolve_within_root(_synctex_storage_key(storage_key))
        except CompileArtifactStorageError:
            return
        path.unlink(missing_ok=True)
        synctex_path.unlink(missing_ok=True)
