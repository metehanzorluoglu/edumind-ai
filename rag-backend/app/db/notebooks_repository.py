"""M3.1 Notebook spec ("Research Notes Workspace"): CRUD for `notebooks` and
`notebook_entries` — see app/db/models_documents.py's Notebook/NotebookEntry
docstrings for the preservation-semantics design (snapshot fields, no
cascading FK to DocumentHighlight/Document).

Every method scoped to a `user_id` returns None/False/empty for a row that
doesn't exist *or* belongs to a different user — the same "404, not 403"
convention every other per-user repository in this app follows.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app.core.time_utils import utcnow
from app.db.models_documents import Notebook, NotebookEntry


@dataclass(frozen=True)
class NotebookRecord:
    id: uuid.UUID
    user_id: uuid.UUID
    name: str
    created_at: datetime
    updated_at: datetime
    entry_count: int = 0


@dataclass(frozen=True)
class NotebookEntryRecord:
    id: uuid.UUID
    notebook_id: uuid.UUID
    user_id: uuid.UUID
    entry_type: str
    highlight_id: uuid.UUID | None
    document_id: str | None
    document_title_snapshot: str | None
    page_number: int | None
    excerpt_snapshot: str | None
    note_text: str | None
    chunk_id_snapshot: str | None
    chunk_index_snapshot: int | None
    visual_anchor_snapshot_json: str | None
    created_at: datetime
    updated_at: datetime


def _to_notebook_record(row: Notebook, entry_count: int = 0) -> NotebookRecord:
    return NotebookRecord(
        id=row.id,
        user_id=row.user_id,
        name=row.name,
        created_at=row.created_at,
        updated_at=row.updated_at,
        entry_count=entry_count,
    )


def _to_entry_record(row: NotebookEntry) -> NotebookEntryRecord:
    return NotebookEntryRecord(
        id=row.id,
        notebook_id=row.notebook_id,
        user_id=row.user_id,
        entry_type=row.entry_type,
        highlight_id=row.highlight_id,
        document_id=row.document_id,
        document_title_snapshot=row.document_title_snapshot,
        page_number=row.page_number,
        excerpt_snapshot=row.excerpt_snapshot,
        note_text=row.note_text,
        chunk_id_snapshot=row.chunk_id_snapshot,
        chunk_index_snapshot=row.chunk_index_snapshot,
        visual_anchor_snapshot_json=row.visual_anchor_snapshot_json,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


class NotebooksRepository:
    def __init__(self, db: Session) -> None:
        self._db = db

    # --- Notebooks ---

    def create(self, *, user_id: uuid.UUID, name: str) -> NotebookRecord:
        now = utcnow()
        row = Notebook(id=uuid.uuid4(), user_id=user_id, name=name, created_at=now, updated_at=now)
        self._db.add(row)
        self._db.commit()
        self._db.refresh(row)
        return _to_notebook_record(row, entry_count=0)

    def _entry_count(self, notebook_id: uuid.UUID) -> int:
        return self._db.execute(
            select(func.count())
            .select_from(NotebookEntry)
            .where(NotebookEntry.notebook_id == notebook_id)
        ).scalar_one()

    def list_for_user(
        self, user_id: uuid.UUID, *, limit: int = 20, offset: int = 0
    ) -> tuple[list[NotebookRecord], int]:
        total = self._db.execute(
            select(func.count()).select_from(Notebook).where(Notebook.user_id == user_id)
        ).scalar_one()
        rows = (
            self._db.execute(
                select(Notebook)
                .where(Notebook.user_id == user_id)
                .order_by(Notebook.updated_at.desc())
                .limit(limit)
                .offset(offset)
            )
            .scalars()
            .all()
        )
        records = [_to_notebook_record(row, entry_count=self._entry_count(row.id)) for row in rows]
        return records, total

    def get(self, user_id: uuid.UUID, notebook_id: uuid.UUID) -> NotebookRecord | None:
        row = self._db.get(Notebook, notebook_id)
        if row is None or row.user_id != user_id:
            return None
        return _to_notebook_record(row, entry_count=self._entry_count(row.id))

    def rename(
        self, user_id: uuid.UUID, notebook_id: uuid.UUID, name: str
    ) -> NotebookRecord | None:
        row = self._db.get(Notebook, notebook_id)
        if row is None or row.user_id != user_id:
            return None
        row.name = name
        row.updated_at = utcnow()
        self._db.commit()
        self._db.refresh(row)
        return _to_notebook_record(row, entry_count=self._entry_count(row.id))

    def delete(self, user_id: uuid.UUID, notebook_id: uuid.UUID) -> bool:
        """Deletes the notebook and only its own entries — never touches
        source documents, highlights, or conversations (M3.1 Notebook spec
        §1). Entries are deleted explicitly (not left to the declared FK
        cascade) for the same SQLite-doesn't-enforce-FKs reason every other
        cascade in this app is explicit — see DocumentHighlightsRepository.
        delete_for_document's docstring."""
        row = self._db.get(Notebook, notebook_id)
        if row is None or row.user_id != user_id:
            return False
        self._db.execute(delete(NotebookEntry).where(NotebookEntry.notebook_id == notebook_id))
        self._db.delete(row)
        self._db.commit()
        return True

    # --- Entries ---

    def list_entries(
        self, user_id: uuid.UUID, notebook_id: uuid.UUID, *, limit: int = 20, offset: int = 0
    ) -> tuple[list[NotebookEntryRecord], int] | None:
        """Returns None if the notebook doesn't exist or isn't the caller's
        — same ownership-first pattern as every list endpoint in this app."""
        if self.get(user_id, notebook_id) is None:
            return None
        total = self._db.execute(
            select(func.count())
            .select_from(NotebookEntry)
            .where(NotebookEntry.notebook_id == notebook_id)
        ).scalar_one()
        rows = (
            self._db.execute(
                select(NotebookEntry)
                .where(NotebookEntry.notebook_id == notebook_id)
                .order_by(NotebookEntry.created_at.desc())
                .limit(limit)
                .offset(offset)
            )
            .scalars()
            .all()
        )
        return [_to_entry_record(row) for row in rows], total

    def get_entry(
        self, user_id: uuid.UUID, notebook_id: uuid.UUID, entry_id: uuid.UUID
    ) -> NotebookEntryRecord | None:
        row = self._db.get(NotebookEntry, entry_id)
        if row is None or row.user_id != user_id or row.notebook_id != notebook_id:
            return None
        return _to_entry_record(row)

    def add_highlight_entry(
        self,
        *,
        user_id: uuid.UUID,
        notebook_id: uuid.UUID,
        highlight_id: uuid.UUID,
        document_id: str,
        document_title: str | None,
        page_number: int | None,
        excerpt: str,
        note_text: str | None,
        chunk_id: str | None,
        chunk_index: int | None,
        visual_anchor_json: str | None,
    ) -> NotebookEntryRecord | None:
        """Idempotent (M3.1 Notebook spec §7): adding the same highlight to
        the same notebook twice returns the EXISTING entry rather than
        creating a duplicate row. Returns None only if the notebook itself
        doesn't exist / isn't owned by this user — callers must separately
        verify the highlight belongs to this user before calling this."""
        notebook = self._db.get(Notebook, notebook_id)
        if notebook is None or notebook.user_id != user_id:
            return None

        existing = self._db.execute(
            select(NotebookEntry).where(
                NotebookEntry.notebook_id == notebook_id,
                NotebookEntry.highlight_id == highlight_id,
                NotebookEntry.entry_type == "highlight",
            )
        ).scalar_one_or_none()
        if existing is not None:
            return _to_entry_record(existing)

        now = utcnow()
        row = NotebookEntry(
            id=uuid.uuid4(),
            notebook_id=notebook_id,
            user_id=user_id,
            entry_type="highlight",
            highlight_id=highlight_id,
            document_id=document_id,
            document_title_snapshot=document_title,
            page_number=page_number,
            excerpt_snapshot=excerpt,
            note_text=note_text,
            chunk_id_snapshot=chunk_id,
            chunk_index_snapshot=chunk_index,
            visual_anchor_snapshot_json=visual_anchor_json,
            created_at=now,
            updated_at=now,
        )
        self._db.add(row)
        notebook.updated_at = now
        self._db.commit()
        self._db.refresh(row)
        return _to_entry_record(row)

    def add_manual_entry(
        self, *, user_id: uuid.UUID, notebook_id: uuid.UUID, note_text: str
    ) -> NotebookEntryRecord | None:
        notebook = self._db.get(Notebook, notebook_id)
        if notebook is None or notebook.user_id != user_id:
            return None
        now = utcnow()
        row = NotebookEntry(
            id=uuid.uuid4(),
            notebook_id=notebook_id,
            user_id=user_id,
            entry_type="manual",
            highlight_id=None,
            document_id=None,
            document_title_snapshot=None,
            page_number=None,
            excerpt_snapshot=None,
            note_text=note_text,
            chunk_id_snapshot=None,
            chunk_index_snapshot=None,
            visual_anchor_snapshot_json=None,
            created_at=now,
            updated_at=now,
        )
        self._db.add(row)
        notebook.updated_at = now
        self._db.commit()
        self._db.refresh(row)
        return _to_entry_record(row)

    def update_entry_note(
        self,
        user_id: uuid.UUID,
        notebook_id: uuid.UUID,
        entry_id: uuid.UUID,
        *,
        note_text: str | None,
    ) -> NotebookEntryRecord | None:
        row = self._db.get(NotebookEntry, entry_id)
        if row is None or row.user_id != user_id or row.notebook_id != notebook_id:
            return None
        row.note_text = note_text
        row.updated_at = utcnow()
        self._db.commit()
        self._db.refresh(row)
        return _to_entry_record(row)

    def remove_entry(self, user_id: uuid.UUID, notebook_id: uuid.UUID, entry_id: uuid.UUID) -> bool:
        row = self._db.get(NotebookEntry, entry_id)
        if row is None or row.user_id != user_id or row.notebook_id != notebook_id:
            return False
        self._db.delete(row)
        self._db.commit()
        return True

    def list_notebooks_for_highlight(
        self, user_id: uuid.UUID, highlight_id: uuid.UUID
    ) -> list[NotebookRecord]:
        """Backs the Reader's "Saved to N notebook(s)" indicator and the
        add-to-notebook picker's "already saved here" checkmarks."""
        rows = (
            self._db.execute(
                select(Notebook)
                .join(NotebookEntry, NotebookEntry.notebook_id == Notebook.id)
                .where(
                    Notebook.user_id == user_id,
                    NotebookEntry.user_id == user_id,
                    NotebookEntry.highlight_id == highlight_id,
                    NotebookEntry.entry_type == "highlight",
                )
                .order_by(Notebook.updated_at.desc())
            )
            .scalars()
            .all()
        )
        return [_to_notebook_record(row, entry_count=self._entry_count(row.id)) for row in rows]
