"""Observe -> Suggest -> User approves -> Save preference (see
app/db/models_research_preferences.py::ResearchPreferenceSuggestion) — this
repository is the "Suggest"/"Save" half; app/core/research_preferences.py is
the "Observe" half. Same "404, not 403" ownership convention as every other
repository in this app.
"""

import uuid
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.time_utils import utcnow
from app.db.models_projects import Project
from app.db.models_research_preferences import ResearchPreferenceSuggestion
from app.db.project_profile_repository import ProjectProfileRepository

_SUPPRESSED = "suppressed"
_CONFIRMED = "confirmed"
_REJECTED = "rejected"
_PENDING = "pending"
_RESOLVED_STATUSES = frozenset({_CONFIRMED, _REJECTED, _SUPPRESSED})


@dataclass(frozen=True)
class ResearchPreferenceRecord:
    id: uuid.UUID
    project_id: uuid.UUID
    field: str
    suggested_value: str
    status: str
    observed_count: int
    created_at: datetime
    updated_at: datetime
    resolved_at: datetime | None


def _to_record(row: ResearchPreferenceSuggestion) -> ResearchPreferenceRecord:
    return ResearchPreferenceRecord(
        id=row.id,
        project_id=row.project_id,
        field=row.field,
        suggested_value=row.suggested_value,
        status=row.status,
        observed_count=row.observed_count,
        created_at=row.created_at,
        updated_at=row.updated_at,
        resolved_at=row.resolved_at,
    )


class ResearchPreferenceRepository:
    def __init__(self, db: Session, project_profile_repository: ProjectProfileRepository) -> None:
        self._db = db
        self._project_profile_repository = project_profile_repository

    def record_observation(
        self, user_id: uuid.UUID, project_id: uuid.UUID, field: str, value: str
    ) -> None:
        """Never auto-saves anything — only ever creates/updates a
        "pending" suggestion for the user to act on later. A "suppressed"
        ("Never suggest again") tuple is never touched again, which is
        what makes that action actually permanent. A "rejected" tuple
        that's observed again resurfaces as "pending" (a fresh repetition
        of the same pattern is worth asking about again), keeping its
        cumulative observed_count rather than resetting to 1. A
        "confirmed" tuple is already active in the profile — nothing to
        do. Silently no-ops if project_id isn't user_id's (this is always
        called from an already-ownership-verified route context, but never
        trusts that alone)."""
        project = self._db.execute(
            select(Project).where(Project.id == project_id, Project.user_id == user_id)
        ).scalar_one_or_none()
        if project is None:
            return

        existing = self._db.execute(
            select(ResearchPreferenceSuggestion).where(
                ResearchPreferenceSuggestion.project_id == project_id,
                ResearchPreferenceSuggestion.field == field,
                ResearchPreferenceSuggestion.suggested_value == value,
            )
        ).scalar_one_or_none()

        if existing is None:
            self._db.add(
                ResearchPreferenceSuggestion(
                    project_id=project_id,
                    user_id=user_id,
                    field=field,
                    suggested_value=value,
                    status=_PENDING,
                    observed_count=1,
                )
            )
            self._db.commit()
            return

        if existing.status in (_SUPPRESSED, _CONFIRMED):
            return

        existing.observed_count += 1
        if existing.status == _REJECTED:
            existing.status = _PENDING
            existing.resolved_at = None
        self._db.commit()

    def list_pending(
        self, user_id: uuid.UUID, project_id: uuid.UUID, *, min_observations: int = 2
    ) -> list[ResearchPreferenceRecord] | None:
        project = self._db.execute(
            select(Project).where(Project.id == project_id, Project.user_id == user_id)
        ).scalar_one_or_none()
        if project is None:
            return None

        rows = (
            self._db.execute(
                select(ResearchPreferenceSuggestion)
                .where(
                    ResearchPreferenceSuggestion.project_id == project_id,
                    ResearchPreferenceSuggestion.status == _PENDING,
                    ResearchPreferenceSuggestion.observed_count >= min_observations,
                )
                .order_by(ResearchPreferenceSuggestion.updated_at.desc())
            )
            .scalars()
            .all()
        )
        return [_to_record(row) for row in rows]

    def update_status(
        self, user_id: uuid.UUID, project_id: uuid.UUID, suggestion_id: uuid.UUID, status: str
    ) -> ResearchPreferenceRecord | None:
        """Confirming writes through to the project profile (the only
        path that ever does — see
        ProjectProfileRepository.apply_confirmed_value); rejecting or
        suppressing never touches the profile at all."""
        row = self._db.execute(
            select(ResearchPreferenceSuggestion).where(
                ResearchPreferenceSuggestion.id == suggestion_id,
                ResearchPreferenceSuggestion.project_id == project_id,
                ResearchPreferenceSuggestion.user_id == user_id,
            )
        ).scalar_one_or_none()
        if row is None:
            return None

        if status == _CONFIRMED:
            self._project_profile_repository.apply_confirmed_value(
                user_id, project_id, row.field, row.suggested_value
            )

        row.status = status
        row.resolved_at = utcnow() if status in _RESOLVED_STATUSES else None
        self._db.commit()
        self._db.refresh(row)
        return _to_record(row)

    def delete(
        self, user_id: uuid.UUID, project_id: uuid.UUID, suggestion_id: uuid.UUID
    ) -> bool:
        row = self._db.execute(
            select(ResearchPreferenceSuggestion).where(
                ResearchPreferenceSuggestion.id == suggestion_id,
                ResearchPreferenceSuggestion.project_id == project_id,
                ResearchPreferenceSuggestion.user_id == user_id,
            )
        ).scalar_one_or_none()
        if row is None:
            return False
        self._db.delete(row)
        self._db.commit()
        return True
