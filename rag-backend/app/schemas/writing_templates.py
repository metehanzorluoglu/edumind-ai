"""Milestone 5.4 (LaTeX Templates & Project Import) — request/response
shapes for the curated template registry."""

from __future__ import annotations

from pydantic import BaseModel, Field

_MAX_TITLE_CHARS = 200
_MAX_DESCRIPTION_CHARS = 2000


class WritingTemplateSummaryResponse(BaseModel):
    """One gallery card — deliberately no file bodies (Part 48: "gallery
    should not load template file bodies eagerly")."""

    id: str
    name: str
    description: str
    category: str
    license: str
    source: str
    version: int
    file_count: int


class WritingTemplateListResponse(BaseModel):
    templates: list[WritingTemplateSummaryResponse]
    total: int


class WritingTemplateFileResponse(BaseModel):
    path: str
    kind: str


class WritingTemplateDetailResponse(WritingTemplateSummaryResponse):
    """GET /writing-templates/{id} — includes the file LIST (paths only,
    for the preview UI) but never file bodies over this endpoint; the
    gallery's "Preview" affordance shows structure, never a compiled
    PDF (Part 22: "do not compile every template merely to show gallery
    cards")."""

    root: str
    files: list[WritingTemplateFileResponse]


class CreateFromTemplateRequest(BaseModel):
    title: str = Field(min_length=1, max_length=_MAX_TITLE_CHARS)
    description: str | None = Field(default=None, max_length=_MAX_DESCRIPTION_CHARS)
