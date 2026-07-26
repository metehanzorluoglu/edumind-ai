"""Chat-scope and project-scope document associations — the SQL source of
truth for "which documents are tied to this conversation/project" (see
app/core/document_scoping.py for the service that keeps Qdrant's
denormalized conversation_ids/project_ids payload fields in sync with what
this repository knows).

All methods are scoped to a given `user_id` and return `None`/`False`
indistinguishably for an association whose conversation/project *or*
document doesn't exist or belongs to a different user — same "404, not
403" convention as DocumentsRepository/ConversationsRepository/
ProjectsRepository. Every add_* method re-verifies ownership of BOTH sides
independently (mirroring ProjectsRepository.add_conversation's own
docstring reasoning): a caller-owned conversation/project is never treated
as proof a caller-supplied document_id is theirs too.

Never duplicates a document's vectors or its `documents` row — an
association here is purely a pointer to an already-ingested Document.
"""

import uuid
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import delete, select, update
from sqlalchemy.orm import Session

from app.db.models_conversations import Conversation, MessageAttachment
from app.db.models_documents import Document
from app.db.models_projects import Project
from app.db.models_scopes import (
    ConversationDocument,
    ProjectAttachment,
    ProjectDocument,
    ProjectNote,
)


@dataclass(frozen=True)
class ConversationDocumentRecord:
    conversation_id: uuid.UUID
    document_id: str
    added_at: datetime
    source_filename: str
    document_type: str


@dataclass(frozen=True)
class ProjectDocumentRecord:
    project_id: uuid.UUID
    document_id: str
    added_at: datetime
    source_filename: str
    document_type: str


@dataclass(frozen=True)
class ProjectAttachmentRecord:
    project_id: uuid.UUID
    message_attachment_id: uuid.UUID
    document_id: str
    added_at: datetime
    source_filename: str
    mime: str


@dataclass(frozen=True)
class ProjectNoteRecord:
    id: uuid.UUID
    project_id: uuid.UUID
    content: str
    created_at: datetime
    updated_at: datetime


class ScopesRepository:
    def __init__(self, db: Session) -> None:
        self._db = db

    # --- conversation <-> document -----------------------------------

    def add_conversation_document(
        self, user_id: uuid.UUID, conversation_id: uuid.UUID, document_id: str
    ) -> ConversationDocumentRecord | None:
        """Idempotent: re-adding a document already associated with this
        conversation returns the existing association unchanged rather
        than erroring or duplicating it (same composite-PK-get pattern as
        ProjectsRepository.add_conversation)."""
        conversation = self._db.execute(
            select(Conversation).where(
                Conversation.id == conversation_id, Conversation.user_id == user_id
            )
        ).scalar_one_or_none()
        if conversation is None:
            return None

        document = self._db.execute(
            select(Document).where(
                Document.document_id == document_id, Document.user_id == user_id
            )
        ).scalar_one_or_none()
        if document is None:
            return None

        existing = self._db.get(ConversationDocument, (conversation_id, document_id))
        if existing is None:
            existing = ConversationDocument(
                conversation_id=conversation_id, document_id=document_id
            )
            self._db.add(existing)
            self._db.commit()
            self._db.refresh(existing)

        return ConversationDocumentRecord(
            conversation_id=existing.conversation_id,
            document_id=existing.document_id,
            added_at=existing.added_at,
            source_filename=document.source_filename,
            document_type=document.document_type,
        )

    def remove_conversation_document(
        self, user_id: uuid.UUID, conversation_id: uuid.UUID, document_id: str
    ) -> bool:
        conversation = self._db.execute(
            select(Conversation).where(
                Conversation.id == conversation_id, Conversation.user_id == user_id
            )
        ).scalar_one_or_none()
        if conversation is None:
            return False
        link = self._db.get(ConversationDocument, (conversation_id, document_id))
        if link is None:
            return False
        self._db.delete(link)
        self._db.commit()
        return True

    def list_conversation_documents(
        self, user_id: uuid.UUID, conversation_id: uuid.UUID
    ) -> list[ConversationDocumentRecord] | None:
        conversation = self._db.execute(
            select(Conversation).where(
                Conversation.id == conversation_id, Conversation.user_id == user_id
            )
        ).scalar_one_or_none()
        if conversation is None:
            return None
        rows = self._db.execute(
            select(ConversationDocument, Document)
            .join(Document, Document.document_id == ConversationDocument.document_id)
            .where(ConversationDocument.conversation_id == conversation_id)
        ).all()
        return [
            ConversationDocumentRecord(
                conversation_id=link.conversation_id,
                document_id=link.document_id,
                added_at=link.added_at,
                source_filename=doc.source_filename,
                document_type=doc.document_type,
            )
            for link, doc in rows
        ]

    def list_conversation_ids_for_document(self, user_id: uuid.UUID, document_id: str) -> list[str]:
        """Every conversation_id (owned by user_id) currently associated
        with document_id — feeds
        app/core/document_scoping.py's Qdrant resync, which always
        recomputes the full current set from this table (the source of
        truth) rather than incrementally patching Qdrant's payload."""
        stmt = (
            select(ConversationDocument.conversation_id)
            .join(Conversation, Conversation.id == ConversationDocument.conversation_id)
            .where(ConversationDocument.document_id == document_id, Conversation.user_id == user_id)
        )
        return [str(cid) for cid in self._db.execute(stmt).scalars().all()]

    # --- project <-> document -------------------------------------------

    def add_project_document(
        self, user_id: uuid.UUID, project_id: uuid.UUID, document_id: str
    ) -> ProjectDocumentRecord | None:
        project = self._db.execute(
            select(Project).where(Project.id == project_id, Project.user_id == user_id)
        ).scalar_one_or_none()
        if project is None:
            return None

        document = self._db.execute(
            select(Document).where(
                Document.document_id == document_id, Document.user_id == user_id
            )
        ).scalar_one_or_none()
        if document is None:
            return None

        existing = self._db.get(ProjectDocument, (project_id, document_id))
        if existing is None:
            existing = ProjectDocument(project_id=project_id, document_id=document_id)
            self._db.add(existing)
            self._db.commit()
            self._db.refresh(existing)

        return ProjectDocumentRecord(
            project_id=existing.project_id,
            document_id=existing.document_id,
            added_at=existing.added_at,
            source_filename=document.source_filename,
            document_type=document.document_type,
        )

    def remove_project_document(
        self, user_id: uuid.UUID, project_id: uuid.UUID, document_id: str
    ) -> bool:
        project = self._db.execute(
            select(Project).where(Project.id == project_id, Project.user_id == user_id)
        ).scalar_one_or_none()
        if project is None:
            return False
        link = self._db.get(ProjectDocument, (project_id, document_id))
        if link is None:
            return False
        self._db.delete(link)
        self._db.commit()
        return True

    def list_project_documents(
        self, user_id: uuid.UUID, project_id: uuid.UUID
    ) -> list[ProjectDocumentRecord] | None:
        project = self._db.execute(
            select(Project).where(Project.id == project_id, Project.user_id == user_id)
        ).scalar_one_or_none()
        if project is None:
            return None
        rows = self._db.execute(
            select(ProjectDocument, Document)
            .join(Document, Document.document_id == ProjectDocument.document_id)
            .where(ProjectDocument.project_id == project_id)
        ).all()
        return [
            ProjectDocumentRecord(
                project_id=link.project_id,
                document_id=link.document_id,
                added_at=link.added_at,
                source_filename=doc.source_filename,
                document_type=doc.document_type,
            )
            for link, doc in rows
        ]

    def list_project_ids_for_document(self, user_id: uuid.UUID, document_id: str) -> list[str]:
        """Every project_id (owned by user_id) currently associated with
        document_id — same reasoning as list_conversation_ids_for_document
        above. Unions two sources: a direct ProjectDocument association,
        and any ProjectAttachment (a promoted chat attachment — see
        app/core/attachment_promotion.py) whose resulting document_id
        matches, so a promoted attachment is retrievable at project scope
        with no separate ProjectDocument row ever created for it."""
        direct_stmt = (
            select(ProjectDocument.project_id)
            .join(Project, Project.id == ProjectDocument.project_id)
            .where(ProjectDocument.document_id == document_id, Project.user_id == user_id)
        )
        promoted_stmt = (
            select(ProjectAttachment.project_id)
            .join(Project, Project.id == ProjectAttachment.project_id)
            .where(ProjectAttachment.document_id == document_id, Project.user_id == user_id)
        )
        project_ids = set(self._db.execute(direct_stmt).scalars().all())
        project_ids.update(self._db.execute(promoted_stmt).scalars().all())
        return [str(pid) for pid in project_ids]

    # --- project <-> attachment (promoted chat attachments) -------------

    def add_project_attachment(
        self,
        user_id: uuid.UUID,
        project_id: uuid.UUID,
        message_attachment_id: uuid.UUID,
        document_id: str,
    ) -> ProjectAttachmentRecord | None:
        """Idempotent, same shape as add_project_document — re-verifies
        both the project AND the attachment belong to user_id
        independently. Called only after the attachment has already been
        ingested into document_id (see app/core/attachment_promotion.py) —
        this method itself never ingests anything, only records/updates
        the pointer."""
        project = self._db.execute(
            select(Project).where(Project.id == project_id, Project.user_id == user_id)
        ).scalar_one_or_none()
        if project is None:
            return None

        attachment = self._db.execute(
            select(MessageAttachment).where(
                MessageAttachment.id == message_attachment_id,
                MessageAttachment.user_id == user_id,
            )
        ).scalar_one_or_none()
        if attachment is None:
            return None

        existing = self._db.get(ProjectAttachment, (project_id, message_attachment_id))
        if existing is None:
            existing = ProjectAttachment(
                project_id=project_id,
                message_attachment_id=message_attachment_id,
                document_id=document_id,
            )
            self._db.add(existing)
        else:
            existing.document_id = document_id
        self._db.commit()
        self._db.refresh(existing)

        return ProjectAttachmentRecord(
            project_id=existing.project_id,
            message_attachment_id=existing.message_attachment_id,
            document_id=document_id,
            added_at=existing.added_at,
            source_filename=attachment.original_filename,
            mime=attachment.mime,
        )

    def remove_project_attachment(
        self, user_id: uuid.UUID, project_id: uuid.UUID, message_attachment_id: uuid.UUID
    ) -> bool:
        project = self._db.execute(
            select(Project).where(Project.id == project_id, Project.user_id == user_id)
        ).scalar_one_or_none()
        if project is None:
            return False
        link = self._db.get(ProjectAttachment, (project_id, message_attachment_id))
        if link is None:
            return False
        self._db.delete(link)
        self._db.commit()
        return True

    def list_project_attachments(
        self, user_id: uuid.UUID, project_id: uuid.UUID
    ) -> list[ProjectAttachmentRecord] | None:
        project = self._db.execute(
            select(Project).where(Project.id == project_id, Project.user_id == user_id)
        ).scalar_one_or_none()
        if project is None:
            return None
        rows = self._db.execute(
            select(ProjectAttachment, MessageAttachment)
            .join(
                MessageAttachment,
                MessageAttachment.id == ProjectAttachment.message_attachment_id,
            )
            .where(ProjectAttachment.project_id == project_id)
        ).all()
        return [
            ProjectAttachmentRecord(
                project_id=link.project_id,
                message_attachment_id=link.message_attachment_id,
                document_id=link.document_id or "",
                added_at=link.added_at,
                source_filename=attachment.original_filename,
                mime=attachment.mime,
            )
            for link, attachment in rows
        ]

    def list_project_ids_for_attachment(
        self, user_id: uuid.UUID, message_attachment_id: uuid.UUID
    ) -> list[uuid.UUID]:
        """Every project (owned by user_id) this specific attachment is
        currently promoted into — feeds
        app/core/attachment_promotion.py's scope-switch "clear this
        attachment's prior placement" step."""
        stmt = (
            select(ProjectAttachment.project_id)
            .join(Project, Project.id == ProjectAttachment.project_id)
            .where(
                ProjectAttachment.message_attachment_id == message_attachment_id,
                Project.user_id == user_id,
            )
        )
        return list(self._db.execute(stmt).scalars().all())

    # --- project notes ---------------------------------------------------

    def add_project_note(
        self, user_id: uuid.UUID, project_id: uuid.UUID, content: str
    ) -> ProjectNoteRecord | None:
        project = self._db.execute(
            select(Project).where(Project.id == project_id, Project.user_id == user_id)
        ).scalar_one_or_none()
        if project is None:
            return None
        note = ProjectNote(project_id=project_id, user_id=user_id, content=content)
        self._db.add(note)
        self._db.commit()
        self._db.refresh(note)
        return ProjectNoteRecord(
            id=note.id,
            project_id=note.project_id,
            content=note.content,
            created_at=note.created_at,
            updated_at=note.updated_at,
        )

    def remove_project_note(
        self, user_id: uuid.UUID, project_id: uuid.UUID, note_id: uuid.UUID
    ) -> bool:
        project = self._db.execute(
            select(Project).where(Project.id == project_id, Project.user_id == user_id)
        ).scalar_one_or_none()
        if project is None:
            return False
        note = self._db.execute(
            select(ProjectNote).where(
                ProjectNote.id == note_id, ProjectNote.project_id == project_id
            )
        ).scalar_one_or_none()
        if note is None:
            return False
        self._db.delete(note)
        self._db.commit()
        return True

    def list_project_notes(
        self, user_id: uuid.UUID, project_id: uuid.UUID
    ) -> list[ProjectNoteRecord] | None:
        project = self._db.execute(
            select(Project).where(Project.id == project_id, Project.user_id == user_id)
        ).scalar_one_or_none()
        if project is None:
            return None
        rows = (
            self._db.execute(
                select(ProjectNote)
                .where(ProjectNote.project_id == project_id)
                .order_by(ProjectNote.created_at.desc())
            )
            .scalars()
            .all()
        )
        return [
            ProjectNoteRecord(
                id=row.id,
                project_id=row.project_id,
                content=row.content,
                created_at=row.created_at,
                updated_at=row.updated_at,
            )
            for row in rows
        ]

    # --- cross-cutting cleanup ------------------------------------------

    def delete_associations_for_document(self, document_id: str) -> None:
        """Called by app/core/document_deletion.py's delete_document_by_id
        BEFORE the SQL documents row itself is deleted — SQLite does not
        enforce declared FK ondelete actions in this app (see
        ConversationsRepository.delete's docstring), so a document's
        association rows must be removed explicitly or they become
        permanently orphaned rows pointing at a document_id that no longer
        exists. Not itself scoped to a user_id: by the time this is
        called, the caller has already verified the document belongs to
        the deleting user (see DocumentsRepository.get), and an
        association row can only ever exist if both sides once passed
        that same ownership check when it was created."""
        self._db.execute(
            delete(ConversationDocument).where(ConversationDocument.document_id == document_id)
        )
        self._db.execute(delete(ProjectDocument).where(ProjectDocument.document_id == document_id))
        self._db.execute(
            delete(ProjectAttachment).where(ProjectAttachment.document_id == document_id)
        )
        self._db.execute(
            update(MessageAttachment)
            .where(MessageAttachment.promoted_document_id == document_id)
            .values(promoted_document_id=None)
        )
        self._db.commit()
