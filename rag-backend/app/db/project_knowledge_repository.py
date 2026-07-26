"""Project Memory storage — see app/db/models_project_knowledge.py for the
full design rationale. Same "404, not 403" and "verify both sides'
ownership independently" conventions as ScopesRepository: every method is
scoped to a caller's user_id and returns None/False indistinguishably for
an item that doesn't exist or belongs to someone else.
"""

import uuid
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.time_utils import utcnow
from app.db.models_conversations import Conversation
from app.db.models_project_knowledge import ProjectKnowledgeItem
from app.db.models_projects import Project

_APPROVED = "approved"
_DRAFT = "draft"
_EDITABLE_FIELDS = frozenset(
    {
        "research_topic",
        "research_question",
        "key_concepts",
        "methodology",
        "frameworks",
        "analysis_techniques",
        "decisions",
        "open_questions",
        "keywords",
        "status",
    }
)


@dataclass(frozen=True)
class ProjectKnowledgeRecord:
    id: uuid.UUID
    project_id: uuid.UUID
    conversation_id: uuid.UUID | None
    conversation_title: str | None
    status: str
    research_topic: str
    research_question: str
    key_concepts: list[str]
    methodology: str
    frameworks: list[str]
    analysis_techniques: list[str]
    decisions: list[str]
    open_questions: list[str]
    keywords: list[str]
    referenced_documents: list[dict[str, str]]
    created_at: datetime
    updated_at: datetime
    approved_at: datetime | None


def _to_record(row: ProjectKnowledgeItem, conversation_title: str | None) -> ProjectKnowledgeRecord:
    return ProjectKnowledgeRecord(
        id=row.id,
        project_id=row.project_id,
        conversation_id=row.conversation_id,
        conversation_title=conversation_title,
        status=row.status,
        research_topic=row.research_topic,
        research_question=row.research_question,
        key_concepts=list(row.key_concepts),
        methodology=row.methodology,
        frameworks=list(row.frameworks),
        analysis_techniques=list(row.analysis_techniques),
        decisions=list(row.decisions),
        open_questions=list(row.open_questions),
        keywords=list(row.keywords),
        referenced_documents=[dict(doc) for doc in row.referenced_documents],  # type: ignore[call-overload]
        created_at=row.created_at,
        updated_at=row.updated_at,
        approved_at=row.approved_at,
    )


class ProjectKnowledgeRepository:
    def __init__(self, db: Session) -> None:
        self._db = db

    def _conversation_title(self, conversation_id: uuid.UUID | None) -> str | None:
        if conversation_id is None:
            return None
        conversation = self._db.get(Conversation, conversation_id)
        return conversation.title if conversation is not None else None

    def _conversation_titles(
        self, conversation_ids: list[uuid.UUID | None]
    ) -> dict[uuid.UUID, str | None]:
        """One batched query for every distinct conversation referenced
        across a list of items, instead of the list_* methods below each
        running a separate SELECT per row via _conversation_title (an N+1
        that used to scale with how many summaries a project/user had —
        this runs on every chat turn with project context, and on every
        Project Memory screen load)."""
        unique_ids = {cid for cid in conversation_ids if cid is not None}
        if not unique_ids:
            return {}
        rows = self._db.execute(
            select(Conversation.id, Conversation.title).where(Conversation.id.in_(unique_ids))
        ).all()
        titles: dict[uuid.UUID, str | None] = {}
        for row in rows:
            titles[row[0]] = row[1]
        return titles

    def create_draft(
        self,
        *,
        user_id: uuid.UUID,
        project_id: uuid.UUID,
        conversation_id: uuid.UUID,
        research_topic: str,
        research_question: str,
        key_concepts: list[str],
        methodology: str,
        frameworks: list[str],
        analysis_techniques: list[str],
        decisions: list[str],
        open_questions: list[str],
        keywords: list[str],
        referenced_documents: list[dict[str, str]],
    ) -> ProjectKnowledgeRecord | None:
        """Verifies the project AND the conversation independently belong
        to user_id (a caller-owned project is never proof a caller-supplied
        conversation_id is theirs) before creating a draft item — never
        idempotent, since re-generating a summary for the same conversation
        is a deliberate user action each time (e.g. to refresh after more
        of the conversation happened), not a duplicate-prevention case."""
        project = self._db.execute(
            select(Project).where(Project.id == project_id, Project.user_id == user_id)
        ).scalar_one_or_none()
        if project is None:
            return None

        conversation = self._db.execute(
            select(Conversation).where(
                Conversation.id == conversation_id, Conversation.user_id == user_id
            )
        ).scalar_one_or_none()
        if conversation is None:
            return None

        row = ProjectKnowledgeItem(
            project_id=project_id,
            conversation_id=conversation_id,
            user_id=user_id,
            status=_DRAFT,
            research_topic=research_topic,
            research_question=research_question,
            key_concepts=key_concepts,
            methodology=methodology,
            frameworks=frameworks,
            analysis_techniques=analysis_techniques,
            decisions=decisions,
            open_questions=open_questions,
            keywords=keywords,
            referenced_documents=referenced_documents,
        )
        self._db.add(row)
        self._db.commit()
        self._db.refresh(row)
        return _to_record(row, conversation.title)

    def get(
        self, user_id: uuid.UUID, project_id: uuid.UUID, item_id: uuid.UUID
    ) -> ProjectKnowledgeRecord | None:
        row = self._db.execute(
            select(ProjectKnowledgeItem).where(
                ProjectKnowledgeItem.id == item_id,
                ProjectKnowledgeItem.project_id == project_id,
                ProjectKnowledgeItem.user_id == user_id,
            )
        ).scalar_one_or_none()
        if row is None:
            return None
        return _to_record(row, self._conversation_title(row.conversation_id))

    def update(
        self,
        user_id: uuid.UUID,
        project_id: uuid.UUID,
        item_id: uuid.UUID,
        updates: dict[str, object],
    ) -> ProjectKnowledgeRecord | None:
        """Only touches fields actually present in `updates` (the route
        builds this from the request's `model_fields_set`, mirroring
        PATCH /projects/{id}'s own partial-update convention) — never
        touches `referenced_documents` (system-computed, not user-editable;
        see the model's docstring) even if a caller tried to sneak it in,
        since only _EDITABLE_FIELDS keys are ever applied. Setting
        status="approved" stamps `approved_at`; setting it back to "draft"
        clears it — approved_at is always exactly "was this ever approved,
        and if so when did the *current* approval happen", never a
        first-ever-approved timestamp that survives an unapprove."""
        row = self._db.execute(
            select(ProjectKnowledgeItem).where(
                ProjectKnowledgeItem.id == item_id,
                ProjectKnowledgeItem.project_id == project_id,
                ProjectKnowledgeItem.user_id == user_id,
            )
        ).scalar_one_or_none()
        if row is None:
            return None

        for field, value in updates.items():
            if field not in _EDITABLE_FIELDS:
                continue
            setattr(row, field, value)

        if "status" in updates:
            row.approved_at = utcnow() if updates["status"] == _APPROVED else None

        self._db.commit()
        self._db.refresh(row)
        return _to_record(row, self._conversation_title(row.conversation_id))

    def delete(self, user_id: uuid.UUID, project_id: uuid.UUID, item_id: uuid.UUID) -> bool:
        row = self._db.execute(
            select(ProjectKnowledgeItem).where(
                ProjectKnowledgeItem.id == item_id,
                ProjectKnowledgeItem.project_id == project_id,
                ProjectKnowledgeItem.user_id == user_id,
            )
        ).scalar_one_or_none()
        if row is None:
            return False
        self._db.delete(row)
        self._db.commit()
        return True

    def list_for_project(
        self, user_id: uuid.UUID, project_id: uuid.UUID
    ) -> list[ProjectKnowledgeRecord] | None:
        project = self._db.execute(
            select(Project).where(Project.id == project_id, Project.user_id == user_id)
        ).scalar_one_or_none()
        if project is None:
            return None
        rows = (
            self._db.execute(
                select(ProjectKnowledgeItem)
                .where(ProjectKnowledgeItem.project_id == project_id)
                .order_by(ProjectKnowledgeItem.created_at.desc())
            )
            .scalars()
            .all()
        )
        titles = self._conversation_titles([row.conversation_id for row in rows])
        return [_to_record(row, titles.get(row.conversation_id)) for row in rows]  # type: ignore[arg-type]

    def list_approved_for_projects(
        self, user_id: uuid.UUID, project_ids: list[uuid.UUID]
    ) -> list[ProjectKnowledgeRecord]:
        """Feeds app/core/project_context.py's prompt injection — every
        approved item across the given projects (all re-verified as
        user_id's own here, never trusting the caller's list alone).
        Empty `project_ids` trivially returns []."""
        if not project_ids:
            return []
        rows = (
            self._db.execute(
                select(ProjectKnowledgeItem)
                .join(Project, Project.id == ProjectKnowledgeItem.project_id)
                .where(
                    ProjectKnowledgeItem.project_id.in_(project_ids),
                    ProjectKnowledgeItem.status == _APPROVED,
                    Project.user_id == user_id,
                )
                .order_by(ProjectKnowledgeItem.approved_at.asc())
            )
            .scalars()
            .all()
        )
        titles = self._conversation_titles([row.conversation_id for row in rows])
        return [_to_record(row, titles.get(row.conversation_id)) for row in rows]  # type: ignore[arg-type]

    def list_approved_for_user(self, user_id: uuid.UUID) -> list[ProjectKnowledgeRecord]:
        """Every approved item across every project user_id owns, with no
        project_id filter at all — feeds "general chat" (a conversation in
        zero projects): intelligent research assistance may pool approved
        summaries across all of a user's own projects there (see
        app/api/routes_conversations.py), since there is no specific
        project to scope to. Full project *documents* are never affected
        by this — those stay gated by the existing per-conversation
        project_ids scope tiers (app/core/scoped_retrieval.py), untouched
        by this method."""
        rows = (
            self._db.execute(
                select(ProjectKnowledgeItem)
                .join(Project, Project.id == ProjectKnowledgeItem.project_id)
                .where(ProjectKnowledgeItem.status == _APPROVED, Project.user_id == user_id)
                .order_by(ProjectKnowledgeItem.approved_at.asc())
            )
            .scalars()
            .all()
        )
        titles = self._conversation_titles([row.conversation_id for row in rows])
        return [_to_record(row, titles.get(row.conversation_id)) for row in rows]  # type: ignore[arg-type]
