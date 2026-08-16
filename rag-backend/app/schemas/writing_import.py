"""Milestone 5.4 (LaTeX Templates & Project Import) — request/response
shapes for the ZIP-import "upload -> inspect -> preview -> confirm" flow
(Part 9/14)."""

from __future__ import annotations

from pydantic import BaseModel, Field

_MAX_TITLE_CHARS = 200
_MAX_DESCRIPTION_CHARS = 2000


class ImportFilePreviewResponse(BaseModel):
    path: str
    kind: str
    size_bytes: int


class ImportWarningResponse(BaseModel):
    path: str
    reason: str


class ImportInspectionResponse(BaseModel):
    """Part 14 — everything the "review detected files/root document"
    preview screen needs. `session_id` is opaque and ownership-scoped
    (Part 31) — the confirm/cancel calls that follow always re-verify it
    belongs to the calling user."""

    session_id: str
    suggested_title: str
    files: list[ImportFilePreviewResponse]
    root_candidates: list[str]
    preselected_root: str | None
    warnings: list[ImportWarningResponse]
    total_size_bytes: int
    expires_at: str


class ConfirmImportRequest(BaseModel):
    title: str = Field(min_length=1, max_length=_MAX_TITLE_CHARS)
    description: str | None = Field(default=None, max_length=_MAX_DESCRIPTION_CHARS)
    # Required when `root_candidates` has more than one entry (Part 12);
    # optional otherwise — omitting it when there's exactly one preselected
    # candidate uses that one, and omitting it with zero candidates
    # creates the project with no root set yet (same state a normal
    # project can already be in).
    root_path: str | None = None
