"""Milestone 5.4 (LaTeX Templates & Project Import) Part 15 — RELEASE
CRITICAL: the single, shared atomic-creation path both a curated
template ("Use template") and a confirmed ZIP import ("Create project")
funnel through.

Either the entire project — its row, every file/folder row, and every
binary asset's bytes on disk — is created, or NOTHING is: no half
project, no partial file rows, no orphan binaries, no dangling storage
keys.

Deliberately does NOT reuse WritingProjectsRepository.create()'s own
two-separate-commits pattern (that method's own docstring explains why
it commits the project row before the file row: "in case this app ever
ran against a database that DOES enforce FKs at insert time"). This
function makes a different, explicit tradeoff for the SAME reason that
one made its own: FK enforcement is never turned on for SQLite in this
app (confirmed there), so every row here — project, folders, files, in
any order — is `db.add()`ed and `db.flush()`ed (never committed) until
the very last line, which commits ONCE. A crash or exception at any
point before that single commit leaves the DB session unflushed to
disk; SQLAlchemy's own rollback (in the `except` block) undoes anything
already flushed within the transaction, and this function separately
tracks and deletes any binary bytes it already wrote to disk (disk
writes are never transactional, unlike the DB rows), so a failure here
can never leave orphaned bytes behind either.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime, timezone

from sqlalchemy.orm import Session

from app.db.models_writing import WritingProject, WritingProjectFile
from app.services.writing_project_file_storage import WritingProjectFileStorage


class ProjectCreationError(Exception):
    """Raised for anything that must abort project creation — the
    caller's `except` block is responsible for calling
    `files_storage.delete_project()` as a final best-effort sweep (see
    routes_writing_templates.py / routes_writing_import.py)."""


@dataclass(frozen=True)
class ManifestFile:
    """One file this creation call will materialize. `path` uses '/' as
    its separator regardless of platform; every segment has ALREADY been
    validated by the caller (writing_project_import.py's inspection
    pipeline, or a template manifest.json — both are trusted inputs by
    the time they reach here, this function does not re-validate names,
    it only rejects a structurally impossible input, e.g. a file
    claiming to be its own ancestor)."""

    path: str
    kind: str  # "text" | "binary"
    content_text: str | None = None
    raw_bytes: bytes | None = None
    mime_type: str | None = None  # binary only


def create_project_from_manifest(
    db: Session,
    files_storage: WritingProjectFileStorage,
    *,
    user_id: uuid.UUID,
    title: str,
    description: str | None,
    files: list[ManifestFile],
    root_path: str | None,
) -> WritingProject:
    """Creates one new WritingProject with a full file tree from a flat
    list of (path, kind, content) entries. `root_path` selects which
    `.tex` file becomes the project's root; if None or not found among
    `files`, the project is created with no root set (Part 12: "allow
    import but require explicit root selection before compile" — the
    exact same state a normal WritingProject can already be in, per
    WritingProject.root_file_id's own nullable column)."""
    written_storage_keys: list[str] = []
    try:
        project_id = uuid.uuid4()
        project = WritingProject(
            id=project_id,
            user_id=user_id,
            title=title,
            description=description,
            main_tex_content="",
        )
        db.add(project)
        db.flush()

        # Parents-before-children: walk each file's own path, creating
        # any missing ancestor folder row on the fly and memoizing
        # "folder path so far" -> its own file_id, mirroring
        # WritingProjectFilesRepository.duplicate_all_for_project's own
        # "insert parents before children" discipline (see that
        # method's docstring) — just driven from a flat path list
        # instead of another project's existing rows.
        folder_ids: dict[str, uuid.UUID] = {}

        def ensure_folder(folder_path: str) -> uuid.UUID | None:
            if folder_path == "":
                return None
            if folder_path in folder_ids:
                return folder_ids[folder_path]
            parent_path, _, name = folder_path.rpartition("/")
            parent_id = ensure_folder(parent_path)
            folder_id = uuid.uuid4()
            db.add(
                WritingProjectFile(
                    id=folder_id,
                    writing_project_id=project_id,
                    parent_id=parent_id,
                    kind="folder",
                    name=name,
                    size_bytes=0,
                )
            )
            db.flush()
            folder_ids[folder_path] = folder_id
            return folder_id

        path_to_file_id: dict[str, uuid.UUID] = {}
        root_file_id: uuid.UUID | None = None
        root_content: str = ""

        for entry in files:
            parent_path, _, name = entry.path.rpartition("/")
            parent_id = ensure_folder(parent_path)
            file_id = uuid.uuid4()

            if entry.kind == "text":
                content = entry.content_text or ""
                db.add(
                    WritingProjectFile(
                        id=file_id,
                        writing_project_id=project_id,
                        parent_id=parent_id,
                        kind="text",
                        name=name,
                        content_text=content,
                        size_bytes=len(content.encode("utf-8")),
                    )
                )
            elif entry.kind == "binary":
                if entry.raw_bytes is None or not entry.mime_type:
                    raise ProjectCreationError(f"Binary entry {entry.path!r} is missing bytes or mime_type")
                storage_key = files_storage.save(
                    user_id=user_id,
                    project_id=project_id,
                    file_id=file_id,
                    mime_type=entry.mime_type,
                    data=entry.raw_bytes,
                )
                written_storage_keys.append(storage_key)
                db.add(
                    WritingProjectFile(
                        id=file_id,
                        writing_project_id=project_id,
                        parent_id=parent_id,
                        kind="binary",
                        name=name,
                        mime_type=entry.mime_type,
                        size_bytes=len(entry.raw_bytes),
                        storage_key=storage_key,
                    )
                )
            else:
                raise ProjectCreationError(f"Unknown file kind {entry.kind!r} for {entry.path!r}")

            db.flush()
            path_to_file_id[entry.path] = file_id
            if root_path is not None and entry.path == root_path:
                root_file_id = file_id
                root_content = entry.content_text or ""

        project.root_file_id = root_file_id
        project.main_tex_content = root_content
        project.updated_at = datetime.now(timezone.utc)
        db.commit()
        db.refresh(project)
        return project
    except Exception:
        db.rollback()
        # Disk writes are not transactional — undo every byte this
        # attempt already wrote before re-raising, then sweep the whole
        # (now-guaranteed-nonexistent-in-the-DB) project's storage
        # subtree as a final backstop in case any write landed outside
        # the per-file keys tracked above.
        for key in written_storage_keys:
            files_storage.delete(key)
        files_storage.delete_project(user_id=user_id, project_id=project_id)
        raise
