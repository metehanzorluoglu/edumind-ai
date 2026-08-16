"""Milestone 5.3 (LaTeX Project Workspace & File Management) — repository
for WritingProjectFile. Same "plain dataclass read-shape, Session-based,
ownership-checked-by-user_id-filter" convention as
writing_projects_repository.py (see that module's docstring).

Every mutation here identifies its target(s) by database ID
(`file_id`/`parent_id`), NEVER by a client-supplied path string (Part 38:
"Prefer IDs over raw path as mutation identity") — combined with
app/core/writing_file_validation.py rejecting any name containing a path
separator, there is no code path in this module that ever concatenates
untrusted input into a filesystem or logical path (Part 37, release
critical).
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Literal

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.writing_file_validation import (
    InvalidFileNameError,
    kind_for_extension,
    validate_depth,
    validate_entry_name,
)
from app.db.models_writing import (
    MAX_FILES_PER_PROJECT,
    MAX_PROJECT_TOTAL_STORAGE_BYTES,
    WritingProject,
    WritingProjectFile,
)

CreateOutcome = Literal[
    "ok",
    "project_not_found",
    "parent_not_found",
    "parent_not_a_folder",
    "duplicate_name",
    "invalid_name",
    "invalid_extension",
    "file_limit_reached",
    "depth_limit_reached",
]

MutateOutcome = Literal[
    "ok",
    "project_not_found",
    "file_not_found",
    "parent_not_found",
    "parent_not_a_folder",
    "duplicate_name",
    "invalid_name",
    "cannot_move_into_self_or_descendant",
    "cannot_delete_root_file",
    "cannot_delete_generated_reference",
    "not_a_text_file",
    "not_a_tex_file",
]


@dataclass(frozen=True)
class WritingProjectFileNode:
    """One tree entry — deliberately excludes `content_text` (Part 47:
    "Binary file list: metadata only" — the same applies to every text
    file's body too; opening one is a separate, explicit fetch via
    get_content below)."""

    id: uuid.UUID
    writing_project_id: uuid.UUID
    parent_id: uuid.UUID | None
    kind: str
    name: str
    path: str
    mime_type: str | None
    size_bytes: int
    is_root: bool
    created_at: datetime
    updated_at: datetime


@dataclass(frozen=True)
class WritingProjectFileContent:
    node: WritingProjectFileNode
    content_text: str | None
    storage_key: str | None


@dataclass(frozen=True)
class WritingProjectTree:
    nodes: list[WritingProjectFileNode]
    root_file_id: uuid.UUID | None
    total_size_bytes: int
    file_count: int


def _node_from_row(
    row: WritingProjectFile, *, path: str, is_root: bool
) -> WritingProjectFileNode:
    return WritingProjectFileNode(
        id=row.id,
        writing_project_id=row.writing_project_id,
        parent_id=row.parent_id,
        kind=row.kind,
        name=row.name,
        path=path,
        mime_type=row.mime_type,
        size_bytes=row.size_bytes,
        is_root=is_root,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


def _compute_paths(rows: list[WritingProjectFile]) -> dict[uuid.UUID, str]:
    """Walks every row's parent chain to build its display/compile path.
    O(n * depth) with depth bounded by MAX_FOLDER_DEPTH and n bounded by
    MAX_FILES_PER_PROJECT — trivially cheap at this scale (Part 41)."""
    by_id = {row.id: row for row in rows}
    memo: dict[uuid.UUID, str] = {}

    def resolve(row: WritingProjectFile) -> str:
        if row.id in memo:
            return memo[row.id]
        if row.parent_id is None:
            path = row.name
        else:
            parent = by_id.get(row.parent_id)
            # Orphaned row (parent deleted without cascade reaching here
            # somehow) — defensive only; ondelete=CASCADE on parent_id
            # means this should never actually happen.
            path = f"{resolve(parent)}/{row.name}" if parent is not None else row.name
        memo[row.id] = path
        return path

    for row in rows:
        resolve(row)
    return memo


class WritingProjectFilesRepository:
    def __init__(self, db: Session) -> None:
        self._db = db

    def _get_project(self, user_id: uuid.UUID, project_id: uuid.UUID) -> WritingProject | None:
        row = self._db.get(WritingProject, project_id)
        if row is None or row.user_id != user_id:
            return None
        return row

    def _all_rows(self, project_id: uuid.UUID) -> list[WritingProjectFile]:
        return list(
            self._db.execute(
                select(WritingProjectFile).where(
                    WritingProjectFile.writing_project_id == project_id
                )
            )
            .scalars()
            .all()
        )

    # ------------------------------------------------------------------
    # Reads
    # ------------------------------------------------------------------

    def list_tree(self, user_id: uuid.UUID, project_id: uuid.UUID) -> WritingProjectTree | None:
        project = self._get_project(user_id, project_id)
        if project is None:
            return None
        rows = self._all_rows(project_id)
        paths = _compute_paths(rows)
        total_size = sum(r.size_bytes for r in rows)
        nodes = [
            _node_from_row(r, path=paths[r.id], is_root=(r.id == project.root_file_id))
            for r in rows
        ]
        nodes.sort(key=lambda n: n.path)
        return WritingProjectTree(
            nodes=nodes,
            root_file_id=project.root_file_id,
            total_size_bytes=total_size,
            file_count=len(rows),
        )

    def get_node(
        self, user_id: uuid.UUID, project_id: uuid.UUID, file_id: uuid.UUID
    ) -> WritingProjectFileNode | None:
        project = self._get_project(user_id, project_id)
        if project is None:
            return None
        row = self._db.get(WritingProjectFile, file_id)
        if row is None or row.writing_project_id != project_id:
            return None
        rows = self._all_rows(project_id)
        paths = _compute_paths(rows)
        return _node_from_row(row, path=paths[row.id], is_root=(row.id == project.root_file_id))

    def get_content(
        self, user_id: uuid.UUID, project_id: uuid.UUID, file_id: uuid.UUID
    ) -> WritingProjectFileContent | None:
        node = self.get_node(user_id, project_id, file_id)
        if node is None or node.kind == "folder":
            return None
        row = self._db.get(WritingProjectFile, file_id)
        assert row is not None
        return WritingProjectFileContent(
            node=node, content_text=row.content_text, storage_key=row.storage_key
        )

    def get_all_content(
        self, user_id: uuid.UUID, project_id: uuid.UUID
    ) -> list[WritingProjectFileContent] | None:
        """Milestone 5.3 Part 17 — used ONLY by the compile/export
        snapshot builders (routes_writing.py's `_collect_extra_files`),
        which need every file's real content in one pass rather than N
        separate get_content() round trips. Returns None if the project
        doesn't exist / isn't the caller's."""
        project = self._get_project(user_id, project_id)
        if project is None:
            return None
        rows = self._all_rows(project_id)
        paths = _compute_paths(rows)
        return [
            WritingProjectFileContent(
                node=_node_from_row(r, path=paths[r.id], is_root=(r.id == project.root_file_id)),
                content_text=r.content_text,
                storage_key=r.storage_key,
            )
            for r in rows
            if r.kind != "folder"
        ]

    def total_project_bytes(self, project_id: uuid.UUID) -> int:
        return (
            self._db.execute(
                select(func.coalesce(func.sum(WritingProjectFile.size_bytes), 0)).where(
                    WritingProjectFile.writing_project_id == project_id
                )
            ).scalar_one()
            or 0
        )

    def file_count(self, project_id: uuid.UUID) -> int:
        return self._db.execute(
            select(func.count())
            .select_from(WritingProjectFile)
            .where(WritingProjectFile.writing_project_id == project_id)
        ).scalar_one()

    # ------------------------------------------------------------------
    # Structural validation shared by create/upload — checked BEFORE any
    # bytes are written to disk (Part 11: caller does the disk write only
    # after this returns "ok" — see routes_writing_files.py).
    # ------------------------------------------------------------------

    def precheck_create(
        self,
        user_id: uuid.UUID,
        project_id: uuid.UUID,
        *,
        parent_id: uuid.UUID | None,
        name: str,
    ) -> CreateOutcome:
        project = self._get_project(user_id, project_id)
        if project is None:
            return "project_not_found"
        try:
            validate_entry_name(name)
        except InvalidFileNameError:
            return "invalid_name"

        depth = 0
        if parent_id is not None:
            parent = self._db.get(WritingProjectFile, parent_id)
            if parent is None or parent.writing_project_id != project_id:
                return "parent_not_found"
            if parent.kind != "folder":
                return "parent_not_a_folder"
            # Walk parent's own ancestor chain to measure depth.
            rows_by_id = {r.id: r for r in self._all_rows(project_id)}
            cursor = parent
            while cursor.parent_id is not None:
                depth += 1
                cursor = rows_by_id[cursor.parent_id]
            depth += 1  # the new entry sits one level below `parent`
        try:
            validate_depth(depth)
        except InvalidFileNameError:
            return "depth_limit_reached"

        existing = self._db.execute(
            select(WritingProjectFile.id).where(
                WritingProjectFile.writing_project_id == project_id,
                WritingProjectFile.parent_id == parent_id,
                WritingProjectFile.name == name,
            )
        ).first()
        if existing is not None:
            return "duplicate_name"

        if self.file_count(project_id) >= MAX_FILES_PER_PROJECT:
            return "file_limit_reached"

        return "ok"

    # ------------------------------------------------------------------
    # Creates
    # ------------------------------------------------------------------

    def create_folder(
        self,
        user_id: uuid.UUID,
        project_id: uuid.UUID,
        *,
        parent_id: uuid.UUID | None,
        name: str,
    ) -> tuple[CreateOutcome, WritingProjectFileNode | None]:
        outcome = self.precheck_create(user_id, project_id, parent_id=parent_id, name=name)
        if outcome != "ok":
            return outcome, None
        row = WritingProjectFile(
            id=uuid.uuid4(),
            writing_project_id=project_id,
            parent_id=parent_id,
            kind="folder",
            name=name,
            size_bytes=0,
        )
        self._db.add(row)
        try:
            self._db.commit()
        except IntegrityError:
            self._db.rollback()
            return "duplicate_name", None
        self._db.refresh(row)
        return "ok", self.get_node(user_id, project_id, row.id)

    def create_text_file(
        self,
        user_id: uuid.UUID,
        project_id: uuid.UUID,
        *,
        parent_id: uuid.UUID | None,
        name: str,
        content_text: str = "",
    ) -> tuple[CreateOutcome, WritingProjectFileNode | None]:
        if kind_for_extension(name) != "text":
            return "invalid_extension", None
        outcome = self.precheck_create(user_id, project_id, parent_id=parent_id, name=name)
        if outcome != "ok":
            return outcome, None
        row = WritingProjectFile(
            id=uuid.uuid4(),
            writing_project_id=project_id,
            parent_id=parent_id,
            kind="text",
            name=name,
            content_text=content_text,
            size_bytes=len(content_text.encode("utf-8")),
        )
        self._db.add(row)
        try:
            self._db.commit()
        except IntegrityError:
            self._db.rollback()
            return "duplicate_name", None
        self._db.refresh(row)
        return "ok", self.get_node(user_id, project_id, row.id)

    def commit_create_binary_file(
        self,
        user_id: uuid.UUID,
        project_id: uuid.UUID,
        *,
        file_id: uuid.UUID,
        parent_id: uuid.UUID | None,
        name: str,
        mime_type: str,
        size_bytes: int,
        storage_key: str,
    ) -> tuple[CreateOutcome, WritingProjectFileNode | None]:
        """The second phase of a binary upload — called AFTER the caller
        has already validated bytes and written them to disk via
        WritingProjectFileStorage (see routes_writing_files.py). Re-runs
        precheck_create as its own transactional guard against a race
        between the caller's earlier precheck and this insert; the
        caller is responsible for deleting the now-orphaned disk object
        if this returns anything other than "ok"."""
        outcome = self.precheck_create(user_id, project_id, parent_id=parent_id, name=name)
        if outcome != "ok":
            return outcome, None
        row = WritingProjectFile(
            id=file_id,
            writing_project_id=project_id,
            parent_id=parent_id,
            kind="binary",
            name=name,
            mime_type=mime_type,
            size_bytes=size_bytes,
            storage_key=storage_key,
        )
        self._db.add(row)
        try:
            self._db.commit()
        except IntegrityError:
            self._db.rollback()
            return "duplicate_name", None
        self._db.refresh(row)
        return "ok", self.get_node(user_id, project_id, row.id)

    # ------------------------------------------------------------------
    # Update content (text files only — binary assets are immutable
    # once uploaded; re-upload as a new file to replace one, matching
    # this milestone's explicit "no silent overwrite" requirement, Part
    # 11)
    # ------------------------------------------------------------------

    def update_text_content(
        self, user_id: uuid.UUID, project_id: uuid.UUID, file_id: uuid.UUID, content_text: str
    ) -> MutateOutcome:
        project = self._get_project(user_id, project_id)
        if project is None:
            return "project_not_found"
        row = self._db.get(WritingProjectFile, file_id)
        if row is None or row.writing_project_id != project_id:
            return "file_not_found"
        if row.kind != "text":
            return "not_a_text_file"
        row.content_text = content_text
        row.size_bytes = len(content_text.encode("utf-8"))
        row.updated_at = datetime.now(row.created_at.tzinfo)
        # Part 2 — write-through: if this IS the project's current root
        # file, keep the legacy `main_tex_content` column in sync too, so
        # every pre-M5.3 code path that still reads it directly (there
        # are none left after this milestone's own routes were updated,
        # but this is a zero-cost safety net against ever silently
        # de-syncing the two in the future) always sees the same bytes.
        if project.root_file_id == file_id:
            project.main_tex_content = content_text
            project.updated_at = row.updated_at
        self._db.commit()
        return "ok"

    # ------------------------------------------------------------------
    # Rename / Move / Delete / Root
    # ------------------------------------------------------------------

    def rename(
        self, user_id: uuid.UUID, project_id: uuid.UUID, file_id: uuid.UUID, new_name: str
    ) -> MutateOutcome:
        project = self._get_project(user_id, project_id)
        if project is None:
            return "project_not_found"
        row = self._db.get(WritingProjectFile, file_id)
        if row is None or row.writing_project_id != project_id:
            return "file_not_found"
        try:
            validate_entry_name(new_name)
        except InvalidFileNameError:
            return "invalid_name"
        existing = self._db.execute(
            select(WritingProjectFile.id).where(
                WritingProjectFile.writing_project_id == project_id,
                WritingProjectFile.parent_id == row.parent_id,
                WritingProjectFile.name == new_name,
                WritingProjectFile.id != file_id,
            )
        ).first()
        if existing is not None:
            return "duplicate_name"
        row.name = new_name
        row.updated_at = datetime.now(row.created_at.tzinfo)
        try:
            self._db.commit()
        except IntegrityError:
            self._db.rollback()
            return "duplicate_name"
        return "ok"

    def _is_descendant(
        self, rows_by_id: dict[uuid.UUID, WritingProjectFile], ancestor_id: uuid.UUID, node_id: uuid.UUID
    ) -> bool:
        """True if `node_id` is `ancestor_id` itself, or lies anywhere
        below it in the tree — the two illegal move targets (Part 8:
        "Prevent folder into itself, folder into descendant")."""
        if node_id == ancestor_id:
            return True
        cursor = rows_by_id.get(node_id)
        while cursor is not None and cursor.parent_id is not None:
            if cursor.parent_id == ancestor_id:
                return True
            cursor = rows_by_id.get(cursor.parent_id)
        return False

    def move(
        self,
        user_id: uuid.UUID,
        project_id: uuid.UUID,
        file_id: uuid.UUID,
        *,
        new_parent_id: uuid.UUID | None,
    ) -> MutateOutcome:
        project = self._get_project(user_id, project_id)
        if project is None:
            return "project_not_found"
        row = self._db.get(WritingProjectFile, file_id)
        if row is None or row.writing_project_id != project_id:
            return "file_not_found"

        rows_by_id = {r.id: r for r in self._all_rows(project_id)}
        if new_parent_id is not None:
            new_parent = rows_by_id.get(new_parent_id)
            if new_parent is None:
                return "parent_not_found"
            if new_parent.kind != "folder":
                return "parent_not_a_folder"
            if row.kind == "folder" and self._is_descendant(rows_by_id, file_id, new_parent_id):
                return "cannot_move_into_self_or_descendant"

        existing = self._db.execute(
            select(WritingProjectFile.id).where(
                WritingProjectFile.writing_project_id == project_id,
                WritingProjectFile.parent_id == new_parent_id,
                WritingProjectFile.name == row.name,
                WritingProjectFile.id != file_id,
            )
        ).first()
        if existing is not None:
            return "duplicate_name"

        row.parent_id = new_parent_id
        row.updated_at = datetime.now(row.created_at.tzinfo)
        try:
            self._db.commit()
        except IntegrityError:
            self._db.rollback()
            return "duplicate_name"
        return "ok"

    def set_root(self, user_id: uuid.UUID, project_id: uuid.UUID, file_id: uuid.UUID) -> MutateOutcome:
        """Part 15 — the user chooses another `.tex` file as root. Only a
        TEXT file whose name ends in `.tex` is eligible (a `.cls`/`.sty`
        helper file, a folder, or a binary asset can never be compiled as
        the top-level document)."""
        project = self._get_project(user_id, project_id)
        if project is None:
            return "project_not_found"
        row = self._db.get(WritingProjectFile, file_id)
        if row is None or row.writing_project_id != project_id:
            return "file_not_found"
        if row.kind != "text" or not row.name.lower().endswith(".tex"):
            return "not_a_tex_file"
        project.root_file_id = file_id
        # Part 2's write-through, the other direction: compile (and
        # every other reader of the legacy `main_tex_content` column)
        # reads it directly rather than following `root_file_id` to the
        # file row — so REASSIGNING root must resync it to the NEWLY
        # chosen file's own content right here, or a compile immediately
        # after would silently keep compiling the OLD root's source.
        project.main_tex_content = row.content_text or ""
        project.updated_at = datetime.now(project.created_at.tzinfo)
        self._db.commit()
        return "ok"

    def delete(
        self, user_id: uuid.UUID, project_id: uuid.UUID, file_id: uuid.UUID
    ) -> tuple[MutateOutcome, list[str]]:
        """Deletes a file, or a folder AND everything under it (Part 9:
        "define recursive behavior clearly" — this codebase's choice is
        a full recursive delete, always, with a client-side confirmation
        step being the UI's own responsibility to ask for, exactly like
        Documents/Notebook deletes elsewhere in this app). Returns the
        list of BINARY storage_keys that now need deleting from disk —
        this repository never touches the filesystem itself (same
        separation-of-concerns as WritingProjectsRepository.delete not
        knowing about Qdrant); the caller (routes_writing_files.py) is
        responsible for calling WritingProjectFileStorage.delete() for
        each returned key, AFTER this commits successfully.

        Never deletes `references.bib` (Part 9) — impossible by
        construction, since that entry is never a real row (see
        WritingProjectFile's own docstring) and this method only ever
        operates on real rows looked up by `file_id`."""
        project = self._get_project(user_id, project_id)
        if project is None:
            return "project_not_found", []
        row = self._db.get(WritingProjectFile, file_id)
        if row is None or row.writing_project_id != project_id:
            return "file_not_found", []
        if project.root_file_id == file_id:
            return "cannot_delete_root_file", []

        rows_by_id = {r.id: r for r in self._all_rows(project_id)}
        to_delete: list[WritingProjectFile] = []

        def collect(node_id: uuid.UUID) -> None:
            node = rows_by_id[node_id]
            to_delete.append(node)
            for candidate in rows_by_id.values():
                if candidate.parent_id == node_id:
                    collect(candidate.id)

        collect(file_id)

        # A folder delete that would take the current root file down
        # with it is blocked too — Part 16: "cannot delete root file...
        # without explicit reassignment", which applies just as much
        # when the root is an indirect descendant of the folder being
        # deleted as when it's the direct target.
        if project.root_file_id is not None and any(
            r.id == project.root_file_id for r in to_delete
        ):
            return "cannot_delete_root_file", []

        storage_keys = [r.storage_key for r in to_delete if r.storage_key]
        for r in to_delete:
            self._db.delete(r)
        self._db.commit()
        return "ok", storage_keys

    # ------------------------------------------------------------------
    # Whole-project helpers (delete / duplicate)
    # ------------------------------------------------------------------

    def delete_all_for_project(self, project_id: uuid.UUID) -> list[str]:
        """Called by the Writing Project delete route, AFTER ownership
        has already been verified by WritingProjectsRepository.delete
        for the same project_id — returns every binary storage_key so
        the caller can clean up disk bytes (Part 35: only THIS project's
        own files, never Documents/highlights/Notes)."""
        rows = self._all_rows(project_id)
        storage_keys = [r.storage_key for r in rows if r.storage_key]
        for r in rows:
            self._db.delete(r)
        self._db.commit()
        return storage_keys

    def duplicate_all_for_project(
        self, source_project_id: uuid.UUID, dest_project_id: uuid.UUID
    ) -> tuple[dict[uuid.UUID, uuid.UUID], list[tuple[str, uuid.UUID, str]]]:
        """Part 29 — copies every file/folder row from `source_project_id`
        onto `dest_project_id`, preserving the tree structure exactly.
        Returns (old_id -> new_id mapping, [(old_storage_key, new_file_id,
        mime_type), ...]) — the second list is for the CALLER to physically
        copy binary bytes on disk (this repository never touches the
        filesystem); text content is copied here directly since it's
        already in the row. The destination project's `root_file_id` is
        NOT set here — the caller sets it using the returned id mapping
        once it knows the source's root_file_id (see routes_writing.py's
        duplicate endpoint)."""
        source_rows = self._all_rows(source_project_id)
        id_map: dict[uuid.UUID, uuid.UUID] = {r.id: uuid.uuid4() for r in source_rows}
        binary_copies: list[tuple[str, uuid.UUID, str]] = []

        # Insert parents before children so FK constraints never fail —
        # a simple repeated pass is fine at this bounded scale (Part 41).
        remaining = list(source_rows)
        inserted: set[uuid.UUID] = set()
        while remaining:
            progressed = False
            still_remaining = []
            for r in remaining:
                if r.parent_id is not None and r.parent_id not in inserted:
                    still_remaining.append(r)
                    continue
                new_row = WritingProjectFile(
                    id=id_map[r.id],
                    writing_project_id=dest_project_id,
                    parent_id=id_map[r.parent_id] if r.parent_id is not None else None,
                    kind=r.kind,
                    name=r.name,
                    mime_type=r.mime_type,
                    size_bytes=r.size_bytes,
                    content_text=r.content_text,
                    storage_key=None,  # set below once bytes are copied
                )
                self._db.add(new_row)
                if r.kind == "binary" and r.storage_key:
                    binary_copies.append((r.storage_key, id_map[r.id], r.mime_type or ""))
                inserted.add(r.id)
                progressed = True
            remaining = still_remaining
            if not progressed and remaining:
                # Should be unreachable (would imply a cycle in the
                # source tree, which this repository's own move()
                # guard never allows to be created) — break rather than
                # loop forever.
                break
        self._db.commit()
        return id_map, binary_copies

    def set_binary_storage_key(self, file_id: uuid.UUID, storage_key: str) -> None:
        """Called by the duplicate-project route after it has physically
        copied a binary asset's bytes to the new file's own storage
        location — fills in the `storage_key` the row above was created
        with `None` for."""
        row = self._db.get(WritingProjectFile, file_id)
        if row is not None:
            row.storage_key = storage_key
            self._db.commit()
