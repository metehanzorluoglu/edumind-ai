import uuid
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import delete, func, select, update
from sqlalchemy.orm import Session

from app.core.time_utils import utcnow
from app.db.models_conversations import Conversation, MessageAttachment
from app.db.models_project_knowledge import ProjectKnowledgeItem
from app.db.models_projects import Project, ProjectConversation
from app.db.models_research_preferences import ProjectProfile, ResearchPreferenceSuggestion
from app.db.models_scopes import ProjectAttachment, ProjectDocument, ProjectNote


@dataclass(frozen=True)
class ProjectSummary:
    id: uuid.UUID
    name: str
    description: str | None
    conversation_count: int
    created_at: datetime
    updated_at: datetime


@dataclass(frozen=True)
class ProjectConversationRecord:
    conversation_id: uuid.UUID
    title: str
    added_at: datetime
    sort_order: int | None
    updated_at: datetime


def _to_summary(row: Project, *, conversation_count: int) -> ProjectSummary:
    return ProjectSummary(
        id=row.id,
        name=row.name,
        description=row.description,
        conversation_count=conversation_count,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


class ProjectsRepository:
    """All methods are scoped to a given `user_id` and return `None`/`False`
    for a project that doesn't exist *or* belongs to a different user —
    deliberately indistinguishable, matching DocumentsRepository/
    ConversationsRepository's "404, not 403" convention. Every method that
    touches `project_conversations` additionally re-verifies the
    *conversation's* ownership independently — a project being the caller's
    own is never treated as proof the conversation is too."""

    def __init__(self, db: Session) -> None:
        self._db = db

    def create(self, *, user_id: uuid.UUID, name: str, description: str | None) -> Project:
        project = Project(user_id=user_id, name=name, description=description)
        self._db.add(project)
        self._db.commit()
        self._db.refresh(project)
        return project

    def get(self, user_id: uuid.UUID, project_id: uuid.UUID) -> Project | None:
        stmt = select(Project).where(Project.id == project_id, Project.user_id == user_id)
        return self._db.execute(stmt).scalar_one_or_none()

    def _conversation_count(self, project_id: uuid.UUID) -> int:
        return self._db.execute(
            select(func.count())
            .select_from(ProjectConversation)
            .where(ProjectConversation.project_id == project_id)
        ).scalar_one()

    def get_summary(self, user_id: uuid.UUID, project_id: uuid.UUID) -> ProjectSummary | None:
        project = self.get(user_id, project_id)
        if project is None:
            return None
        return _to_summary(project, conversation_count=self._conversation_count(project.id))

    def list_for_user(
        self, user_id: uuid.UUID, *, limit: int, offset: int
    ) -> tuple[list[ProjectSummary], int]:
        total = self._db.execute(
            select(func.count()).select_from(Project).where(Project.user_id == user_id)
        ).scalar_one()

        stmt = (
            select(Project)
            .where(Project.user_id == user_id)
            .order_by(Project.updated_at.desc())
            .limit(limit)
            .offset(offset)
        )
        projects = list(self._db.execute(stmt).scalars().all())
        counts = self._conversation_counts([project.id for project in projects])
        summaries = [
            _to_summary(project, conversation_count=counts.get(project.id, 0))
            for project in projects
        ]
        return summaries, total

    def _conversation_counts(self, project_ids: list[uuid.UUID]) -> dict[uuid.UUID, int]:
        """One grouped query for every project on the page, instead of
        `list_for_user` running a separate COUNT per project (an N+1 that
        used to scale with page size) — GET /projects is the app's main
        project list load, so this runs on every visit to it."""
        if not project_ids:
            return {}
        rows = self._db.execute(
            select(ProjectConversation.project_id, func.count())
            .where(ProjectConversation.project_id.in_(project_ids))
            .group_by(ProjectConversation.project_id)
        ).all()
        counts: dict[uuid.UUID, int] = {}
        for row in rows:
            counts[row[0]] = row[1]
        return counts

    def rename(self, user_id: uuid.UUID, project_id: uuid.UUID, name: str) -> Project | None:
        project = self.get(user_id, project_id)
        if project is None:
            return None
        project.name = name
        self._db.commit()
        self._db.refresh(project)
        return project

    def update_description(
        self, user_id: uuid.UUID, project_id: uuid.UUID, description: str | None
    ) -> Project | None:
        project = self.get(user_id, project_id)
        if project is None:
            return None
        project.description = description
        self._db.commit()
        self._db.refresh(project)
        return project

    def delete(self, user_id: uuid.UUID, project_id: uuid.UUID) -> bool:
        """Deletes the project row and its ProjectConversation association
        rows — never the conversations themselves (see Project's
        docstring). The association rows are deleted explicitly here
        rather than left to ondelete=CASCADE: SQLite (this app's default
        database) does not enforce declared foreign-key actions unless
        "PRAGMA foreign_keys=ON" has been set on the connection, which this
        app does not do (see app/core/document_deletion.py for this
        codebase's established pattern of explicit, application-level
        cross-entity cleanup rather than relying on implicit DB cascade).
        Also deletes (contextual-research-scopes milestone) this project's
        ProjectDocument/ProjectAttachment/ProjectNote association rows —
        never the documents/attachments those associations pointed at —
        and (Project Memory) this project's ProjectKnowledgeItem rows: a
        knowledge item's home is its project, unlike its source
        conversation (which it deliberately outlives — see
        ConversationsRepository.delete()), so deleting the project
        deletes its memory too. Also (intelligent research assistance)
        this project's ProjectProfile row and
        ResearchPreferenceSuggestion rows — a profile/suggestion has no
        meaning independent of its project. Also (image generation) un-saves
        (never deletes) any generated image bookmarked to this project —
        see MessageAttachment.saved_project_id's docs."""
        project = self.get(user_id, project_id)
        if project is None:
            return False
        self._db.execute(
            update(MessageAttachment)
            .where(MessageAttachment.saved_project_id == project_id)
            .values(saved_project_id=None)
        )
        self._db.execute(
            delete(ProjectConversation).where(ProjectConversation.project_id == project_id)
        )
        self._db.execute(delete(ProjectDocument).where(ProjectDocument.project_id == project_id))
        self._db.execute(
            delete(ProjectAttachment).where(ProjectAttachment.project_id == project_id)
        )
        self._db.execute(delete(ProjectNote).where(ProjectNote.project_id == project_id))
        self._db.execute(
            delete(ProjectKnowledgeItem).where(ProjectKnowledgeItem.project_id == project_id)
        )
        self._db.execute(delete(ProjectProfile).where(ProjectProfile.project_id == project_id))
        self._db.execute(
            delete(ResearchPreferenceSuggestion).where(
                ResearchPreferenceSuggestion.project_id == project_id
            )
        )
        self._db.delete(project)
        self._db.commit()
        return True

    def get_project_ids_for_conversation(
        self, user_id: uuid.UUID, conversation_id: uuid.UUID
    ) -> list[uuid.UUID]:
        """Every project (owned by user_id) that currently holds this
        conversation — feeds project-scope retrieval (see
        app/core/scoped_retrieval.py). Returns [] (never an error) for a
        conversation in zero projects, the common case."""
        stmt = (
            select(ProjectConversation.project_id)
            .join(Project, Project.id == ProjectConversation.project_id)
            .where(
                ProjectConversation.conversation_id == conversation_id,
                Project.user_id == user_id,
            )
        )
        return list(self._db.execute(stmt).scalars().all())

    def list_conversations(
        self, user_id: uuid.UUID, project_id: uuid.UUID, *, limit: int, offset: int
    ) -> tuple[list[ProjectConversationRecord], int] | None:
        """Returns None if the project doesn't exist or isn't the caller's
        — same "404, not 403" convention as get(). A conversation
        association whose conversation has since been deleted can never
        appear here regardless (ondelete=CASCADE on
        project_conversations.conversation_id removes the association the
        moment the conversation is gone)."""
        project = self.get(user_id, project_id)
        if project is None:
            return None

        total = self._conversation_count(project_id)
        stmt = (
            select(ProjectConversation, Conversation)
            .join(Conversation, Conversation.id == ProjectConversation.conversation_id)
            .where(ProjectConversation.project_id == project_id)
            .order_by(ProjectConversation.added_at.desc())
            .limit(limit)
            .offset(offset)
        )
        rows = self._db.execute(stmt).all()
        records = [
            ProjectConversationRecord(
                conversation_id=link.conversation_id,
                title=conversation.title,
                added_at=link.added_at,
                sort_order=link.sort_order,
                updated_at=conversation.updated_at,
            )
            for link, conversation in rows
        ]
        return records, total

    def add_conversation(
        self, user_id: uuid.UUID, project_id: uuid.UUID, conversation_id: uuid.UUID
    ) -> ProjectConversationRecord | None:
        """Returns None if the project doesn't belong to `user_id`, or the
        conversation doesn't exist *or* belongs to a different user — a
        project being the caller's own is never sufficient proof the
        conversation is too (see class docstring). Idempotent: re-adding a
        conversation already in the project returns the existing
        association unchanged rather than erroring or duplicating it."""
        project = self.get(user_id, project_id)
        if project is None:
            return None
        conversation = self._db.execute(
            select(Conversation).where(
                Conversation.id == conversation_id, Conversation.user_id == user_id
            )
        ).scalar_one_or_none()
        if conversation is None:
            return None

        existing = self._db.get(ProjectConversation, (project_id, conversation_id))
        if existing is None:
            existing = ProjectConversation(project_id=project_id, conversation_id=conversation_id)
            self._db.add(existing)
            project.updated_at = utcnow()
            self._db.commit()
            self._db.refresh(existing)

        return ProjectConversationRecord(
            conversation_id=existing.conversation_id,
            title=conversation.title,
            added_at=existing.added_at,
            sort_order=existing.sort_order,
            updated_at=conversation.updated_at,
        )

    def remove_conversation(
        self, user_id: uuid.UUID, project_id: uuid.UUID, conversation_id: uuid.UUID
    ) -> bool:
        """Removes only the association — never the conversation itself
        (see Project's docstring). Returns False if the project isn't the
        caller's, or no such association exists."""
        project = self.get(user_id, project_id)
        if project is None:
            return False
        link = self._db.get(ProjectConversation, (project_id, conversation_id))
        if link is None:
            return False
        self._db.delete(link)
        project.updated_at = utcnow()
        self._db.commit()
        return True
