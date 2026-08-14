"""Frontend Milestone 3 (Document Reader): CRUD for `document_highlights` —
a user-authored highlight (optionally with a note) anchored to a specific
passage of a specific document. See app/db/models_documents.py's
DocumentHighlight docstring for the anchor design.

Every method that takes a `document_id`/`highlight_id` is scoped to a
`user_id` and returns `None`/`False`/an empty list for a row that doesn't
exist *or* belongs to a different user — same "404, not 403" convention as
every other per-user repository in this app (DocumentsRepository,
ProjectsRepository, ...). Callers are still expected to verify the
document itself belongs to the caller (via DocumentsRepository.get) before
creating a highlight — this repository does not re-check that a
document_id is real, only that any row it returns/mutates is the caller's
own.
"""

import uuid
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.core.time_utils import utcnow
from app.db.models_documents import DocumentHighlight


@dataclass(frozen=True)
class DocumentHighlightRecord:
    id: uuid.UUID
    user_id: uuid.UUID
    document_id: str
    chunk_id: str | None
    chunk_index: int | None
    page_number: int
    selected_text: str
    note_text: str | None
    visual_anchor_json: str | None
    created_at: datetime
    updated_at: datetime


def _to_record(row: DocumentHighlight) -> DocumentHighlightRecord:
    return DocumentHighlightRecord(
        id=row.id,
        user_id=row.user_id,
        document_id=row.document_id,
        chunk_id=row.chunk_id,
        chunk_index=row.chunk_index,
        page_number=row.page_number,
        selected_text=row.selected_text,
        note_text=row.note_text,
        visual_anchor_json=row.visual_anchor_json,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


class DocumentHighlightsRepository:
    def __init__(self, db: Session) -> None:
        self._db = db

    def create(
        self,
        *,
        user_id: uuid.UUID,
        document_id: str,
        chunk_id: str | None,
        chunk_index: int | None,
        page_number: int,
        selected_text: str,
        note_text: str | None,
        visual_anchor_json: str | None = None,
    ) -> DocumentHighlightRecord:
        now = utcnow()
        row = DocumentHighlight(
            id=uuid.uuid4(),
            user_id=user_id,
            document_id=document_id,
            chunk_id=chunk_id,
            chunk_index=chunk_index,
            page_number=page_number,
            selected_text=selected_text,
            note_text=note_text,
            visual_anchor_json=visual_anchor_json,
            created_at=now,
            updated_at=now,
        )
        self._db.add(row)
        self._db.commit()
        self._db.refresh(row)
        return _to_record(row)

    def list_for_document(
        self, user_id: uuid.UUID, document_id: str
    ) -> list[DocumentHighlightRecord]:
        """Reading order first (chunk_index), then creation order for two
        highlights inside the same chunk — a stable, predictable order for
        both the annotation panel and "go to source" navigation."""
        stmt = (
            select(DocumentHighlight)
            .where(
                DocumentHighlight.user_id == user_id,
                DocumentHighlight.document_id == document_id,
            )
            .order_by(DocumentHighlight.chunk_index, DocumentHighlight.created_at)
        )
        return [_to_record(row) for row in self._db.execute(stmt).scalars().all()]

    def get(
        self, user_id: uuid.UUID, document_id: str, highlight_id: uuid.UUID
    ) -> DocumentHighlightRecord | None:
        row = self._db.get(DocumentHighlight, highlight_id)
        if row is None or row.user_id != user_id or row.document_id != document_id:
            return None
        return _to_record(row)

    def update_note(
        self,
        user_id: uuid.UUID,
        document_id: str,
        highlight_id: uuid.UUID,
        *,
        note_text: str | None,
    ) -> DocumentHighlightRecord | None:
        row = self._db.get(DocumentHighlight, highlight_id)
        if row is None or row.user_id != user_id or row.document_id != document_id:
            return None
        row.note_text = note_text
        row.updated_at = utcnow()
        self._db.commit()
        self._db.refresh(row)
        return _to_record(row)

    def delete(self, user_id: uuid.UUID, document_id: str, highlight_id: uuid.UUID) -> bool:
        row = self._db.get(DocumentHighlight, highlight_id)
        if row is None or row.user_id != user_id or row.document_id != document_id:
            return False
        self._db.delete(row)
        self._db.commit()
        return True

    def delete_for_document(self, document_id: str) -> None:
        """Called by app/core/document_deletion.py's delete_document_by_id
        BEFORE the SQL documents row itself is deleted — SQLite does not
        enforce declared FK ondelete actions in this app (see
        ProjectsRepository.delete's docstring), so a document's highlights
        must be removed explicitly or they become permanently orphaned
        rows pointing at a document_id that no longer exists. Not scoped
        to a user_id: by the time this is called, the caller has already
        verified the document belongs to the deleting user."""
        self._db.execute(
            delete(DocumentHighlight).where(DocumentHighlight.document_id == document_id)
        )
        self._db.commit()
