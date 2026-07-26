"""One editable research profile per project (see
app/db/models_research_preferences.py::ProjectProfile) — same "404, not
403" ownership convention as every other repository in this app.
"""

import uuid
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models_projects import Project
from app.db.models_research_preferences import (
    LIST_VALUED_PROFILE_FIELDS,
    STRING_VALUED_PROFILE_FIELDS,
    ProjectProfile,
)

_EDITABLE_FIELDS = frozenset(
    {
        "research_questions",
        "frameworks",
        "methodology",
        "participants",
        "data",
        "analysis",
        "citation_style",
        "output_format",
    }
)


@dataclass(frozen=True)
class ProjectProfileRecord:
    project_id: uuid.UUID
    research_questions: list[str]
    frameworks: list[str]
    methodology: list[str]
    participants: str
    data: str
    analysis: list[str]
    citation_style: str
    output_format: str
    created_at: datetime
    updated_at: datetime


def _to_record(row: ProjectProfile) -> ProjectProfileRecord:
    return ProjectProfileRecord(
        project_id=row.project_id,
        research_questions=list(row.research_questions),
        frameworks=list(row.frameworks),
        methodology=list(row.methodology),
        participants=row.participants,
        data=row.data,
        analysis=list(row.analysis),
        citation_style=row.citation_style,
        output_format=row.output_format,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


class ProjectProfileRepository:
    def __init__(self, db: Session) -> None:
        self._db = db

    def get_or_create(
        self, user_id: uuid.UUID, project_id: uuid.UUID
    ) -> ProjectProfileRecord | None:
        """Returns None if the project doesn't exist or isn't user_id's —
        never creates a profile row for a project that fails that check.
        Every project has exactly one profile always; this is the only
        place a row is ever inserted (no explicit "create profile" route
        exists)."""
        project = self._db.execute(
            select(Project).where(Project.id == project_id, Project.user_id == user_id)
        ).scalar_one_or_none()
        if project is None:
            return None

        row = self._db.get(ProjectProfile, project_id)
        if row is None:
            row = ProjectProfile(project_id=project_id)
            self._db.add(row)
            self._db.commit()
            self._db.refresh(row)
        return _to_record(row)

    def update(
        self, user_id: uuid.UUID, project_id: uuid.UUID, updates: dict[str, object]
    ) -> ProjectProfileRecord | None:
        """Partial update — only fields actually present in `updates` (the
        route builds this from the request's `model_fields_set`) are
        touched, same convention as every other PATCH in this app."""
        if self.get_or_create(user_id, project_id) is None:
            return None
        row = self._db.get(ProjectProfile, project_id)
        assert row is not None  # just get-or-created above
        for field, value in updates.items():
            if field in _EDITABLE_FIELDS:
                setattr(row, field, value)
        self._db.commit()
        self._db.refresh(row)
        return _to_record(row)

    def apply_confirmed_value(
        self, user_id: uuid.UUID, project_id: uuid.UUID, field: str, value: str
    ) -> None:
        """The one and only path that ever writes to a profile without a
        direct user edit — called exclusively from
        ResearchPreferenceRepository.update_status when a suggestion is
        confirmed. List-valued fields (frameworks/methodology/analysis)
        append `value` if not already present; string-valued fields
        (citation_style/output_format) are replaced outright, since a
        project has exactly one of those at a time."""
        if self.get_or_create(user_id, project_id) is None:
            return
        row = self._db.get(ProjectProfile, project_id)
        assert row is not None

        if field in LIST_VALUED_PROFILE_FIELDS:
            current = list(getattr(row, field))
            if value not in current:
                setattr(row, field, [*current, value])
        elif field in STRING_VALUED_PROFILE_FIELDS:
            setattr(row, field, value)

        self._db.commit()
