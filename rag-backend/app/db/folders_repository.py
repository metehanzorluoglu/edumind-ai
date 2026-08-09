"""SQL-backed folder tree for Milestone 1 (Document Library / Folder
Management) — the organizational layer above `documents` (see
app/db/models_folders.py). Every method is scoped to a given `user_id` and
returns `None` for a folder that doesn't exist *or* belongs to a different
user — same "404, not 403" convention as DocumentsRepository/
ProjectsRepository/ScopesRepository. A folder never restricts retrieval and
is never written into a Qdrant payload — see app/api/routes_folders.py's
module docstring for the retrieval-boundary reasoning this deliberately
stays out of.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.time_utils import utcnow
from app.db.models_documents import Document
from app.db.models_folders import Folder


class FolderNameConflictError(Exception):
    """Raised by create()/rename()/move() when the target name already
    names another folder that is a direct sibling (same user_id, same
    parent_id) — mapped to HTTP 409 by the route layer. Carries the
    conflicting name so the error message doesn't need a second lookup."""

    def __init__(self, name: str) -> None:
        super().__init__(f"A folder named {name!r} already exists here")
        self.name = name


class CircularFolderReferenceError(Exception):
    """Raised by move() when the requested new parent is the folder itself
    or one of its own descendants — mapped to HTTP 400 by the route layer.
    Never partially applied: the move is rejected before anything is
    written."""


class FolderNotEmptyError(Exception):
    """Raised by delete() when the folder still directly contains a
    subfolder or a document and the caller did not opt into
    move_contents_to_root — mapped to HTTP 409 by the route layer. Carries
    the direct counts so the client can show "12 documents, 2 folders"
    without a second request."""

    def __init__(self, folder_count: int, document_count: int) -> None:
        super().__init__(
            f"Folder is not empty ({folder_count} folder(s), {document_count} document(s))"
        )
        self.folder_count = folder_count
        self.document_count = document_count


@dataclass(frozen=True)
class FolderRecord:
    id: uuid.UUID
    user_id: uuid.UUID
    parent_id: uuid.UUID | None
    name: str
    created_at: datetime
    updated_at: datetime
    # Direct-child counts only (never recursive) — cheap to keep accurate
    # (a single grouped query per listing, see _counts_for_folders) and
    # exactly what the UI needs to know whether "Delete" can proceed
    # without a second request, and whether a folder row should render as
    # non-empty in the library view.
    folder_count: int
    document_count: int


@dataclass(frozen=True)
class FolderDeleteResult:
    folder_id: uuid.UUID
    moved_folders: int
    moved_documents: int


def _to_record(row: Folder, *, folder_count: int, document_count: int) -> FolderRecord:
    return FolderRecord(
        id=row.id,
        user_id=row.user_id,
        parent_id=row.parent_id,
        name=row.name,
        created_at=row.created_at,
        updated_at=row.updated_at,
        folder_count=folder_count,
        document_count=document_count,
    )


class FoldersRepository:
    def __init__(self, db: Session) -> None:
        self._db = db

    # --- internal helpers -------------------------------------------------

    def _get_row(self, user_id: uuid.UUID, folder_id: uuid.UUID) -> Folder | None:
        row = self._db.get(Folder, folder_id)
        if row is None or row.user_id != user_id:
            return None
        return row

    def _counts_for_folders(
        self, folder_ids: list[uuid.UUID]
    ) -> dict[uuid.UUID, tuple[int, int]]:
        """One grouped query per table for the whole page of folders being
        listed, instead of a per-folder COUNT (an N+1 that would scale with
        how many folders/documents a level holds) — same technique as
        ProjectsRepository._conversation_counts."""
        if not folder_ids:
            return {}
        folder_rows = self._db.execute(
            select(Folder.parent_id, func.count())
            .where(Folder.parent_id.in_(folder_ids))
            .group_by(Folder.parent_id)
        ).all()
        document_rows = self._db.execute(
            select(Document.folder_id, func.count())
            .where(Document.folder_id.in_(folder_ids))
            .group_by(Document.folder_id)
        ).all()
        folder_counts = {row[0]: row[1] for row in folder_rows}
        document_counts = {row[0]: row[1] for row in document_rows}
        return {
            fid: (folder_counts.get(fid, 0), document_counts.get(fid, 0)) for fid in folder_ids
        }

    def _direct_child_names(
        self, user_id: uuid.UUID, parent_id: uuid.UUID | None, *, exclude_id: uuid.UUID | None
    ) -> set[str]:
        stmt = select(Folder.name, Folder.id).where(
            Folder.user_id == user_id, Folder.parent_id == parent_id
        )
        return {
            name for name, fid in self._db.execute(stmt).all() if fid != exclude_id
        }

    def _is_self_or_descendant(
        self, user_id: uuid.UUID, candidate_id: uuid.UUID, of_folder_id: uuid.UUID
    ) -> bool:
        """True if `candidate_id` IS `of_folder_id`, or is reachable by
        walking `of_folder_id`'s descendants — checked here by walking
        *upward* from `candidate_id` toward root instead (cheaper: a
        candidate parent has at most one ancestor chain to walk, versus
        enumerating every descendant of a possibly-large subtree). A
        `visited` guard makes this safe even against a pre-existing corrupt
        cycle rather than looping forever."""
        current: uuid.UUID | None = candidate_id
        visited: set[uuid.UUID] = set()
        while current is not None:
            if current == of_folder_id:
                return True
            if current in visited:
                return False
            visited.add(current)
            row = self._db.get(Folder, current)
            if row is None or row.user_id != user_id:
                return False
            current = row.parent_id
        return False

    # --- reads --------------------------------------------------------

    def get(self, user_id: uuid.UUID, folder_id: uuid.UUID) -> FolderRecord | None:
        row = self._get_row(user_id, folder_id)
        if row is None:
            return None
        folder_count, document_count = self._counts_for_folders([folder_id]).get(
            folder_id, (0, 0)
        )
        return _to_record(row, folder_count=folder_count, document_count=document_count)

    def list_children(
        self, user_id: uuid.UUID, parent_id: uuid.UUID | None
    ) -> list[FolderRecord] | None:
        """Direct child folders of `parent_id` (None = root), sorted by
        name. Returns None if `parent_id` is given but doesn't exist /
        isn't the caller's — the route maps that to 404. Root (parent_id is
        None) is always valid and simply returns []  for a user with no
        folders yet."""
        if parent_id is not None and self._get_row(user_id, parent_id) is None:
            return None
        rows = list(
            self._db.execute(
                select(Folder)
                .where(Folder.user_id == user_id, Folder.parent_id == parent_id)
                .order_by(Folder.name)
            )
            .scalars()
            .all()
        )
        counts = self._counts_for_folders([row.id for row in rows])
        return [
            _to_record(row, folder_count=counts.get(row.id, (0, 0))[0],
                       document_count=counts.get(row.id, (0, 0))[1])
            for row in rows
        ]

    def list_path(self, user_id: uuid.UUID, folder_id: uuid.UUID) -> list[FolderRecord] | None:
        """Breadcrumb chain from root to `folder_id` inclusive (e.g. [Research,
        AI Education]) — None if folder_id doesn't exist/isn't the caller's.
        Walks parent_id upward (bounded by a `visited` guard, same
        reasoning as _is_self_or_descendant) and reverses once at the end,
        rather than requiring a separate materialized-path column."""
        chain: list[Folder] = []
        visited: set[uuid.UUID] = set()
        current: uuid.UUID | None = folder_id
        while current is not None:
            if current in visited:
                break
            visited.add(current)
            row = self._get_row(user_id, current)
            if row is None:
                # folder_id itself not found/owned (first iteration), or an
                # ancestor is unexpectedly missing/foreign (a corrupted
                # chain, which app-level ownership checks on every
                # create()/move() should make unreachable in practice) —
                # either way, a partial/broken breadcrumb is worse than
                # none, so this is a hard None rather than "best effort".
                return None
            chain.append(row)
            current = row.parent_id
        if not chain:
            return None
        chain.reverse()
        counts = self._counts_for_folders([row.id for row in chain])
        return [
            _to_record(row, folder_count=counts.get(row.id, (0, 0))[0],
                       document_count=counts.get(row.id, (0, 0))[1])
            for row in chain
        ]

    # --- writes -------------------------------------------------------

    def create(
        self, user_id: uuid.UUID, *, name: str, parent_id: uuid.UUID | None
    ) -> FolderRecord | None:
        """Returns None if `parent_id` is given but doesn't exist / isn't
        the caller's. Raises FolderNameConflictError if a sibling folder
        already has this exact name (case-sensitive — matches this
        system's existing plain-string title handling elsewhere, e.g.
        ProjectsRepository never case-folds `name` either)."""
        if parent_id is not None and self._get_row(user_id, parent_id) is None:
            return None
        if name in self._direct_child_names(user_id, parent_id, exclude_id=None):
            raise FolderNameConflictError(name)

        folder = Folder(user_id=user_id, parent_id=parent_id, name=name)
        self._db.add(folder)
        self._db.commit()
        self._db.refresh(folder)
        return _to_record(folder, folder_count=0, document_count=0)

    def rename(self, user_id: uuid.UUID, folder_id: uuid.UUID, name: str) -> FolderRecord | None:
        row = self._get_row(user_id, folder_id)
        if row is None:
            return None
        if name != row.name and name in self._direct_child_names(
            user_id, row.parent_id, exclude_id=folder_id
        ):
            raise FolderNameConflictError(name)
        row.name = name
        row.updated_at = utcnow()
        self._db.commit()
        self._db.refresh(row)
        folder_count, document_count = self._counts_for_folders([folder_id]).get(
            folder_id, (0, 0)
        )
        return _to_record(row, folder_count=folder_count, document_count=document_count)

    def move(
        self, user_id: uuid.UUID, folder_id: uuid.UUID, new_parent_id: uuid.UUID | None
    ) -> FolderRecord | None:
        """Reparents `folder_id` under `new_parent_id` (None = root).
        Returns None if the folder, or a given new_parent_id, doesn't
        exist / isn't the caller's. Raises CircularFolderReferenceError if
        `new_parent_id` is the folder itself or one of its own
        descendants (which would otherwise detach that whole subtree from
        the tree root). Raises FolderNameConflictError if a sibling already
        has this folder's name at the destination."""
        row = self._get_row(user_id, folder_id)
        if row is None:
            return None
        if new_parent_id is not None:
            if self._get_row(user_id, new_parent_id) is None:
                return None
            if self._is_self_or_descendant(user_id, new_parent_id, folder_id):
                raise CircularFolderReferenceError(
                    "Cannot move a folder into itself or one of its own subfolders"
                )
        if row.name in self._direct_child_names(user_id, new_parent_id, exclude_id=folder_id):
            raise FolderNameConflictError(row.name)

        row.parent_id = new_parent_id
        row.updated_at = utcnow()
        self._db.commit()
        self._db.refresh(row)
        folder_count, document_count = self._counts_for_folders([folder_id]).get(
            folder_id, (0, 0)
        )
        return _to_record(row, folder_count=folder_count, document_count=document_count)

    def delete(
        self, user_id: uuid.UUID, folder_id: uuid.UUID, *, move_contents_to_root: bool
    ) -> FolderDeleteResult | None:
        """Returns None if the folder doesn't exist / isn't the caller's.
        Raises FolderNotEmptyError (never silently deletes contained
        documents — see the milestone's "least destructive" requirement)
        if the folder directly contains a subfolder or a document and
        `move_contents_to_root` is False. When True, direct child folders
        and direct child documents are first re-rooted to top-level
        (parent_id / folder_id = NULL) — never to this folder's own
        parent, and never recursively re-rooting a grandchild that was
        already nested under one of those direct children, so the rest of
        the subtree's internal structure is preserved exactly as it was."""
        row = self._get_row(user_id, folder_id)
        if row is None:
            return None

        child_folders = list(
            self._db.execute(
                select(Folder).where(Folder.user_id == user_id, Folder.parent_id == folder_id)
            )
            .scalars()
            .all()
        )
        child_documents = list(
            self._db.execute(
                select(Document).where(
                    Document.user_id == user_id, Document.folder_id == folder_id
                )
            )
            .scalars()
            .all()
        )

        if (child_folders or child_documents) and not move_contents_to_root:
            raise FolderNotEmptyError(len(child_folders), len(child_documents))

        for child in child_folders:
            child.parent_id = None
            child.updated_at = utcnow()
        for document in child_documents:
            document.folder_id = None

        self._db.delete(row)
        self._db.commit()
        return FolderDeleteResult(
            folder_id=folder_id,
            moved_folders=len(child_folders),
            moved_documents=len(child_documents),
        )
