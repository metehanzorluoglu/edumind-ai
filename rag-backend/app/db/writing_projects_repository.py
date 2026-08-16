"""Milestone 5 (Academic Writing & LaTeX Foundation) — repository for
WritingProject/WritingProjectDocument. Same "plain dataclass read-shape,
Session-based, ownership-checked-by-user_id-filter" convention as
projects_repository.py."""

import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Literal

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app.db.models_documents import Document
from app.db.models_writing import WritingProject, WritingProjectDocument, WritingProjectFile

#: Every outcome add_reference() can report — never raises for any of
#: these ordinary cases (see that method's own docstring). Defined here
#: (not in app/schemas/writing.py) since it's fundamentally a repository-
#: layer concept; the API schema imports and re-uses this exact type
#: rather than maintaining a second, parallel literal.
AddReferenceOutcome = Literal[
    "added", "already_present", "project_not_found", "document_not_found", "limit_reached"
]

#: Milestone 5 Section 38 — a reasonable ceiling on how many references
#: one manuscript can hold. Comfortably above any realistic paper's
#: bibliography (even a dissertation rarely cites more than a few
#: hundred works) while still ruling out unbounded association-table
#: growth from a scripted/malicious caller.
MAX_REFERENCES_PER_PROJECT = 500


@dataclass(frozen=True)
class WritingProjectSummary:
    id: uuid.UUID
    title: str
    description: str | None
    reference_count: int
    file_count: int
    archived_at: datetime | None
    created_at: datetime
    updated_at: datetime


@dataclass(frozen=True)
class WritingProjectRecord:
    """The full project, including its LaTeX source — returned only by
    get()/create()/update(), never by list_for_user() (Section 40:
    listing 50+ projects must not transfer every manuscript's full
    source just to render a summary card)."""

    id: uuid.UUID
    user_id: uuid.UUID
    title: str
    description: str | None
    main_tex_content: str
    root_file_id: uuid.UUID | None
    archived_at: datetime | None
    created_at: datetime
    updated_at: datetime


@dataclass(frozen=True)
class WritingProjectReference:
    """One project reference — deliberately just the document_id and
    when it was added. Bibliographic identity (title/authors/year/
    citation_key) is never stored here; the caller re-reads it live from
    DocumentsRepository (Section 3: "always read current canonical
    Document metadata")."""

    document_id: str
    added_at: datetime


def _to_summary(
    row: WritingProject, *, reference_count: int, file_count: int
) -> WritingProjectSummary:
    return WritingProjectSummary(
        id=row.id,
        title=row.title,
        description=row.description,
        reference_count=reference_count,
        file_count=file_count,
        archived_at=row.archived_at,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


def _to_record(row: WritingProject) -> WritingProjectRecord:
    return WritingProjectRecord(
        id=row.id,
        user_id=row.user_id,
        title=row.title,
        description=row.description,
        main_tex_content=row.main_tex_content,
        root_file_id=row.root_file_id,
        archived_at=row.archived_at,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


class WritingProjectsRepository:
    def __init__(self, db: Session) -> None:
        self._db = db

    def create(
        self, *, user_id: uuid.UUID, title: str, description: str | None, main_tex_content: str
    ) -> WritingProjectRecord:
        """Milestone 5.3 Part 15 — every new project gets a real
        `main.tex` WritingProjectFile row from the moment it's created
        (never only a bare `main_tex_content` column, which would leave
        a brand-new project with no file-tree entry to show/select/
        rename until some later lazy-materialization step). Both rows
        are created in the same transaction as a single unit."""
        project_id = uuid.uuid4()
        file_id = uuid.uuid4()
        row = WritingProject(
            id=project_id,
            user_id=user_id,
            title=title,
            description=description,
            main_tex_content=main_tex_content,
        )
        # Inserted in two steps (project row first, WITHOUT root_file_id
        # — then the file row — then root_file_id is set and committed
        # again) rather than one batch: `writing_projects.root_file_id`
        # references `writing_project_files.id`, and
        # `writing_project_files.writing_project_id` references
        # `writing_projects.id` right back — a genuine circular FK
        # dependency between these two brand-new rows that only SQLite's
        # (this app's only real target — FK enforcement is never turned
        # on here, see this milestone's report) relaxed enforcement would
        # tolerate in a single batch. Doing it in two commits keeps this
        # code correct even if this app ever ran against a database that
        # DOES enforce FKs at insert time.
        self._db.add(row)
        self._db.commit()
        file_row = WritingProjectFile(
            id=file_id,
            writing_project_id=project_id,
            parent_id=None,
            kind="text",
            name="main.tex",
            content_text=main_tex_content,
            size_bytes=len(main_tex_content.encode("utf-8")),
        )
        self._db.add(file_row)
        row.root_file_id = file_id
        self._db.commit()
        self._db.refresh(row)
        return _to_record(row)

    def get(self, user_id: uuid.UUID, project_id: uuid.UUID) -> WritingProjectRecord | None:
        """Returns None for a project that doesn't exist *or* belongs to a
        different user — same indistinguishable-404 convention as
        DocumentsRepository.get."""
        row = self._db.get(WritingProject, project_id)
        if row is None or row.user_id != user_id:
            return None
        return _to_record(row)

    def list_for_user(
        self,
        user_id: uuid.UUID,
        *,
        search: str | None = None,
        sort: Literal["updated_at", "name", "created_at"] = "updated_at",
        include_archived: bool = False,
    ) -> list[WritingProjectSummary]:
        """Milestone 5.3 Part 26/27/28 — the project dashboard's own
        listing. `search` matches title/description substrings only
        (Part 27: "No AI search... no filesystem-content search yet"),
        case-insensitively. `include_archived=False` (the default) is
        what the dashboard's own default active-projects view uses (Part
        30); an explicit "Archived" view passes True."""
        query = select(WritingProject).where(WritingProject.user_id == user_id)
        if not include_archived:
            query = query.where(WritingProject.archived_at.is_(None))
        if search:
            like = f"%{search.lower()}%"
            query = query.where(
                func.lower(WritingProject.title).like(like)
                | func.lower(func.coalesce(WritingProject.description, "")).like(like)
            )
        if sort == "name":
            query = query.order_by(func.lower(WritingProject.title).asc())
        elif sort == "created_at":
            query = query.order_by(WritingProject.created_at.desc())
        else:
            query = query.order_by(WritingProject.updated_at.desc())
        rows = self._db.execute(query).scalars().all()
        if not rows:
            return []
        project_ids = [row.id for row in rows]
        ref_count_rows = self._db.execute(
            select(WritingProjectDocument.writing_project_id, func.count())
            .where(WritingProjectDocument.writing_project_id.in_(project_ids))
            .group_by(WritingProjectDocument.writing_project_id)
        ).all()
        ref_counts: dict[uuid.UUID, int] = {row[0]: row[1] for row in ref_count_rows}
        file_count_rows = self._db.execute(
            select(WritingProjectFile.writing_project_id, func.count())
            .where(WritingProjectFile.writing_project_id.in_(project_ids))
            .group_by(WritingProjectFile.writing_project_id)
        ).all()
        file_counts: dict[uuid.UUID, int] = {row[0]: row[1] for row in file_count_rows}
        return [
            _to_summary(
                row,
                reference_count=ref_counts.get(row.id, 0),
                file_count=file_counts.get(row.id, 0),
            )
            for row in rows
        ]

    def archive(self, user_id: uuid.UUID, project_id: uuid.UUID) -> WritingProjectRecord | None:
        """Milestone 5.3 Part 30 — hides the project from the default
        dashboard view without deleting anything. Idempotent: archiving
        an already-archived project just refreshes nothing and returns
        the current record."""
        row = self._db.get(WritingProject, project_id)
        if row is None or row.user_id != user_id:
            return None
        if row.archived_at is None:
            row.archived_at = datetime.now(row.created_at.tzinfo)
            self._db.commit()
            self._db.refresh(row)
        return _to_record(row)

    def restore(self, user_id: uuid.UUID, project_id: uuid.UUID) -> WritingProjectRecord | None:
        row = self._db.get(WritingProject, project_id)
        if row is None or row.user_id != user_id:
            return None
        if row.archived_at is not None:
            row.archived_at = None
            self._db.commit()
            self._db.refresh(row)
        return _to_record(row)

    def duplicate_metadata(
        self, user_id: uuid.UUID, source_project_id: uuid.UUID, *, new_title: str
    ) -> WritingProjectRecord | None:
        """Milestone 5.3 Part 29 — creates the NEW project's own row
        (title/description/main_tex_content copied, always active/
        unarchived regardless of the source's state) and copies its
        reference associations (never the referenced Documents
        themselves — Part 29: "should NOT duplicate Documents"). Does
        NOT touch WritingProjectFile rows or root_file_id — the caller
        (routes_writing.py's duplicate endpoint) does that via
        WritingProjectFilesRepository.duplicate_all_for_project, since
        binary asset bytes need a filesystem copy this repository has no
        business performing."""
        source = self._db.get(WritingProject, source_project_id)
        if source is None or source.user_id != user_id:
            return None
        new_project_id = uuid.uuid4()
        new_row = WritingProject(
            id=new_project_id,
            user_id=user_id,
            title=new_title,
            description=source.description,
            main_tex_content=source.main_tex_content,
        )
        self._db.add(new_row)
        self._db.commit()

        source_refs = self._db.execute(
            select(WritingProjectDocument).where(
                WritingProjectDocument.writing_project_id == source_project_id
            )
        ).scalars().all()
        for ref in source_refs:
            self._db.add(
                WritingProjectDocument(
                    writing_project_id=new_project_id, document_id=ref.document_id
                )
            )
        if source_refs:
            self._db.commit()
        self._db.refresh(new_row)
        return _to_record(new_row)

    def set_root_file_id(self, project_id: uuid.UUID, file_id: uuid.UUID) -> None:
        """Used only by the duplicate-project flow, after
        WritingProjectFilesRepository.duplicate_all_for_project has
        already copied the file tree and told the caller which new id
        corresponds to the source's root file."""
        row = self._db.get(WritingProject, project_id)
        if row is not None:
            row.root_file_id = file_id
            self._db.commit()

    def update(
        self,
        user_id: uuid.UUID,
        project_id: uuid.UUID,
        updates: dict[str, object],
    ) -> WritingProjectRecord | None:
        """Partial update — only fields actually present in `updates` are
        touched, same convention as DocumentsRepository.update_metadata.
        Allowed keys: title, description, main_tex_content."""
        allowed = {"title", "description", "main_tex_content"}
        unknown = set(updates) - allowed
        if unknown:
            raise ValueError(f"update() cannot touch field(s): {sorted(unknown)}")
        row = self._db.get(WritingProject, project_id)
        if row is None or row.user_id != user_id:
            return None
        for field, value in updates.items():
            setattr(row, field, value)
        row.updated_at = datetime.now(row.created_at.tzinfo)
        # Milestone 5.3 Part 2 — write-through the OTHER direction: this
        # legacy endpoint (PATCH /writing-projects/{id} with
        # main_tex_content) predates the file-tree model and the
        # frontend's own editor now saves through
        # PATCH .../files/{file_id} instead (see routes_writing_files.py)
        # whenever the active file is a real WritingProjectFile row —
        # but any OTHER caller of this endpoint (a script, a future
        # integration, this codebase's own tests) must never leave the
        # root file's `content_text` silently stale. Mirrors
        # WritingProjectFilesRepository.update_text_content's identical
        # write-through in the other direction.
        if "main_tex_content" in updates and row.root_file_id is not None:
            root_file_row = self._db.get(WritingProjectFile, row.root_file_id)
            if root_file_row is not None and root_file_row.kind == "text":
                root_file_row.content_text = updates["main_tex_content"]
                root_file_row.size_bytes = len(
                    str(updates["main_tex_content"]).encode("utf-8")
                )
                root_file_row.updated_at = row.updated_at
        self._db.commit()
        self._db.refresh(row)
        return _to_record(row)

    def delete(self, user_id: uuid.UUID, project_id: uuid.UUID) -> bool:
        """Deletes the project and its own reference-association rows.

        The association rows are removed explicitly, not left to the
        declared `ondelete="CASCADE"` on WritingProjectDocument.writing_
        project_id — no ORM `relationship()` is defined between these two
        models (deliberately: see models_writing.py), and SQLite never
        enforces declared FK ondelete actions in this app (the same
        reasoning as delete_references_for_document below, and
        ScopesRepository.delete_associations_for_document's docstring).
        Without this, deleting a project would leave orphaned
        writing_project_documents rows referencing a project_id that no
        longer exists."""
        row = self._db.get(WritingProject, project_id)
        if row is None or row.user_id != user_id:
            return False
        self._db.execute(
            delete(WritingProjectDocument).where(
                WritingProjectDocument.writing_project_id == project_id
            )
        )
        self._db.delete(row)
        self._db.commit()
        return True

    def list_references(
        self, user_id: uuid.UUID, project_id: uuid.UUID
    ) -> list[WritingProjectReference] | None:
        """Returns None if the project doesn't exist / isn't the caller's
        (same indistinguishable convention); [] for a project with no
        references yet."""
        project_row = self._db.get(WritingProject, project_id)
        if project_row is None or project_row.user_id != user_id:
            return None
        rows = self._db.execute(
            select(WritingProjectDocument)
            .where(WritingProjectDocument.writing_project_id == project_id)
            .order_by(WritingProjectDocument.added_at.asc())
        ).scalars().all()
        return [
            WritingProjectReference(document_id=row.document_id, added_at=row.added_at)
            for row in rows
        ]

    def reference_count(self, project_id: uuid.UUID) -> int:
        return self._db.execute(
            select(func.count())
            .select_from(WritingProjectDocument)
            .where(WritingProjectDocument.writing_project_id == project_id)
        ).scalar_one()

    def add_reference(
        self, user_id: uuid.UUID, project_id: uuid.UUID, document_id: str
    ) -> AddReferenceOutcome:
        """Adds one (project, document) association. Returns one of:
        "added", "already_present", "project_not_found",
        "document_not_found", "limit_reached" — never raises for any of
        these ordinary outcomes (Section 37: ownership must be enforced,
        never leak whether a guessed document_id belongs to someone else
        — "document_not_found" is returned identically whether the id
        truly doesn't exist or belongs to a different user, matching
        DocumentsRepository.get's own indistinguishable convention)."""
        project_row = self._db.get(WritingProject, project_id)
        if project_row is None or project_row.user_id != user_id:
            return "project_not_found"

        document_row = self._db.get(Document, document_id)
        if document_row is None or document_row.user_id != user_id:
            return "document_not_found"

        existing = self._db.get(WritingProjectDocument, (project_id, document_id))
        if existing is not None:
            return "already_present"

        if self.reference_count(project_id) >= MAX_REFERENCES_PER_PROJECT:
            return "limit_reached"

        self._db.add(
            WritingProjectDocument(writing_project_id=project_id, document_id=document_id)
        )
        self._db.commit()
        return "added"

    def delete_references_for_document(self, document_id: str) -> None:
        """Called by app/core/document_deletion.py's delete_document_by_id
        BEFORE the SQL documents row itself is deleted — SQLite does not
        enforce declared FK ondelete actions in this app (see
        ScopesRepository.delete_associations_for_document's docstring),
        so a document's writing-project reference rows must be removed
        explicitly or they become permanently orphaned rows pointing at a
        document_id that no longer exists. Not itself scoped to a
        user_id: by the time this is called, the caller has already
        verified the document belongs to the deleting user, and a
        reference row can only ever exist if both sides once passed that
        same ownership check when it was added. Removing this association
        never touches the WritingProject row itself (Section 29 — "do
        not cascade-delete the Writing Project"); if the deleted
        document's citation key is still present in main_tex_content, the
        existing missing-citation-detection mechanism reports it, with no
        separate snapshot required."""
        self._db.execute(
            delete(WritingProjectDocument).where(
                WritingProjectDocument.document_id == document_id
            )
        )

    def remove_reference(
        self, user_id: uuid.UUID, project_id: uuid.UUID, document_id: str
    ) -> bool:
        """Removes the association only — never touches the Document row,
        its highlights, or any Notebook entry (Section 5)."""
        project_row = self._db.get(WritingProject, project_id)
        if project_row is None or project_row.user_id != user_id:
            return False
        result = self._db.execute(
            delete(WritingProjectDocument).where(
                WritingProjectDocument.writing_project_id == project_id,
                WritingProjectDocument.document_id == document_id,
            )
        )
        self._db.commit()
        # mypy infers a bare `delete()` execute() as Result[Any] (no
        # .rowcount) rather than CursorResult — a known SQLAlchemy stub
        # gap; `update()` elsewhere in this codebase infers correctly.
        return (result.rowcount or 0) > 0  # type: ignore[attr-defined]
