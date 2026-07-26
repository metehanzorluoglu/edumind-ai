import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, UniqueConstraint, Uuid, func
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.types import JSON

from app.db.base import Base

# Fields a confirmed suggestion can ever write to — list-valued, since more
# than one methodology/analysis technique/framework can genuinely apply to
# the same project at once (see ProjectProfileRepository.apply_confirmed_value).
LIST_VALUED_PROFILE_FIELDS = frozenset({"frameworks", "methodology", "analysis"})
# The remaining observable fields are singular preferences — confirming a
# new value replaces the old one (a project has exactly one citation style
# / output format at a time, unlike frameworks or methods).
STRING_VALUED_PROFILE_FIELDS = frozenset({"citation_style", "output_format"})

_DEFAULT_STATUS = "pending"


class ProjectProfile(Base):
    """One editable research profile per project — "Research questions",
    "Frameworks", "Methodology", "Participants", "Data", "Analysis",
    "Citation style", "Output format" (see GOAL: intelligent research
    assistance without hidden user profiles). A user can edit any field
    directly at any time (PATCH /projects/{id}/profile); a field can also
    be populated by confirming a suggested research preference (see
    ResearchPreferenceSuggestion below) — never any other way. Lazily
    created on first read/write (see ProjectProfileRepository.get_or_create)
    — there is no explicit "create profile" step, since every project has
    exactly one, always."""

    __tablename__ = "project_profiles"

    project_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True
    )
    research_questions: Mapped[list[str]] = mapped_column(JSON, nullable=False, default=list)
    frameworks: Mapped[list[str]] = mapped_column(JSON, nullable=False, default=list)
    methodology: Mapped[list[str]] = mapped_column(JSON, nullable=False, default=list)
    participants: Mapped[str] = mapped_column(Text, nullable=False, default="")
    data: Mapped[str] = mapped_column(Text, nullable=False, default="")
    analysis: Mapped[list[str]] = mapped_column(JSON, nullable=False, default=list)
    citation_style: Mapped[str] = mapped_column(String(100), nullable=False, default="")
    output_format: Mapped[str] = mapped_column(String(100), nullable=False, default="")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )


class ResearchPreferenceSuggestion(Base):
    """The Observe -> Suggest -> User approves -> Save preference workflow
    (see app/core/research_preferences.py) — never auto-saved. Created only
    when a *fixed, neutral research-methodology vocabulary term* (never a
    sensitive personal trait) is observed inside an already user-approved
    Project Memory item (see app/db/models_project_knowledge.py); one row
    per distinct (project_id, field, suggested_value), with `observed_count`
    incremented on repeat observation rather than duplicated.

    `status` drives the whole lifecycle: "pending" (observed, awaiting the
    user), "confirmed" (user approved it — the one and only path that ever
    writes to ProjectProfile, via
    ProjectProfileRepository.apply_confirmed_value), "rejected" (dismissed
    this one time — a fresh future repetition of the same pattern can still
    re-suggest it), "suppressed" ("Never suggest again" — permanently
    blocks this exact tuple; see
    ResearchPreferenceRepository.record_observation, which checks for this
    status before ever creating or incrementing a row).
    """

    __tablename__ = "research_preference_suggestions"
    __table_args__ = (
        UniqueConstraint(
            "project_id", "field", "suggested_value", name="uq_research_preference_tuple"
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    field: Mapped[str] = mapped_column(String(32), nullable=False)
    suggested_value: Mapped[str] = mapped_column(String(200), nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default=_DEFAULT_STATUS)
    observed_count: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
