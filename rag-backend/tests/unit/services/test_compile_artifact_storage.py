"""SyncTeX implementation — CompileArtifactStorage's new sibling
`.synctex.gz` handling. Same "server-minted-id-keyed paths, never
caller-supplied names" convention already established for the PDF half
of this class (see the module's own docstring) — this file only covers
what's new: the SyncTeX bytes ride the exact same storage_key/TTL/
cleanup lifecycle as the PDF, with no new DB column (see
_synctex_storage_key's own docstring for why the sibling path is always
a pure derivation, never independently minted)."""

from __future__ import annotations

import tempfile
import uuid

import pytest

from app.services.compile_artifact_storage import CompileArtifactStorage


@pytest.fixture
def storage() -> CompileArtifactStorage:
    return CompileArtifactStorage(root_dir=tempfile.mkdtemp())


def test_save_without_synctex_bytes_is_unchanged(storage: CompileArtifactStorage) -> None:
    user_id, compile_id = uuid.uuid4(), uuid.uuid4()
    storage_key = storage.save(user_id=user_id, compile_id=compile_id, pdf_bytes=b"%PDF-fake")
    assert storage.read(storage_key) == b"%PDF-fake"
    with pytest.raises(OSError):
        storage.read_synctex(storage_key)


def test_save_with_synctex_bytes_persists_both_as_siblings(storage: CompileArtifactStorage) -> None:
    user_id, compile_id = uuid.uuid4(), uuid.uuid4()
    storage_key = storage.save(
        user_id=user_id,
        compile_id=compile_id,
        pdf_bytes=b"%PDF-fake",
        synctex_bytes=b"fake-synctex-bytes",
    )
    assert storage.read(storage_key) == b"%PDF-fake"
    assert storage.read_synctex(storage_key) == b"fake-synctex-bytes"
    assert storage_key.endswith(".pdf")


def test_delete_removes_both_pdf_and_synctex(storage: CompileArtifactStorage) -> None:
    user_id, compile_id = uuid.uuid4(), uuid.uuid4()
    storage_key = storage.save(
        user_id=user_id,
        compile_id=compile_id,
        pdf_bytes=b"%PDF-fake",
        synctex_bytes=b"fake-synctex-bytes",
    )
    storage.delete(storage_key)
    with pytest.raises(OSError):
        storage.read(storage_key)
    with pytest.raises(OSError):
        storage.read_synctex(storage_key)


def test_delete_is_best_effort_when_synctex_never_existed(storage: CompileArtifactStorage) -> None:
    user_id, compile_id = uuid.uuid4(), uuid.uuid4()
    storage_key = storage.save(user_id=user_id, compile_id=compile_id, pdf_bytes=b"%PDF-fake")
    # Never raises just because the sibling SyncTeX file was never
    # written in the first place — matches delete()'s own established
    # "missing file is already success" convention.
    storage.delete(storage_key)


def test_read_synctex_raises_for_a_guessed_storage_key_outside_root(
    storage: CompileArtifactStorage,
) -> None:
    from app.services.compile_artifact_storage import CompileArtifactStorageError

    with pytest.raises(CompileArtifactStorageError):
        storage.read_synctex("../../etc/passwd.pdf")
