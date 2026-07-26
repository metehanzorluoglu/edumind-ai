from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

PreferenceStatus = Literal["confirmed", "rejected", "suppressed"]


class ProjectProfileResponse(BaseModel):
    project_id: str
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


class UpdateProjectProfileRequest(BaseModel):
    """Partial update — same `model_fields_set`-driven convention as every
    other PATCH in this app. A user can edit any of these 8 fields
    directly, any time — this is the same write path a confirmed research
    preference suggestion uses internally (see
    ProjectProfileRepository.apply_confirmed_value)."""

    research_questions: list[str] | None = None
    frameworks: list[str] | None = None
    methodology: list[str] | None = None
    participants: str | None = Field(default=None, max_length=4000)
    data: str | None = Field(default=None, max_length=4000)
    analysis: list[str] | None = None
    citation_style: str | None = Field(default=None, max_length=100)
    output_format: str | None = Field(default=None, max_length=100)


class ResearchPreferenceSuggestionResponse(BaseModel):
    id: str
    project_id: str
    field: str
    suggested_value: str
    status: str
    observed_count: int
    created_at: datetime
    updated_at: datetime
    resolved_at: datetime | None


class ResearchPreferenceListResponse(BaseModel):
    suggestions: list[ResearchPreferenceSuggestionResponse]
    total: int


class UpdateResearchPreferenceStatusRequest(BaseModel):
    """Drives the Observe -> Suggest -> User approves -> Save preference
    workflow's three user actions: "confirmed" (Confirm — writes through
    to the Project Profile), "rejected" (Reject — dismissed this once, may
    resurface if the pattern repeats again), "suppressed" (Never suggest
    again — permanent)."""

    status: PreferenceStatus
