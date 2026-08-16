"""Milestone 5.3 (LaTeX Project Workspace & File Management) — request/
response schemas for a Writing Project's file tree. Deliberately a
separate module from app/schemas/writing.py (which stays scoped to the
project-level resource) rather than growing that file indefinitely."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

from app.core.writing_file_validation import MAX_NAME_LENGTH

WritingProjectFileKindResponse = Literal["folder", "text", "binary", "generated"]


class WritingProjectFileNodeResponse(BaseModel):
    """One real (database-backed) file or folder entry."""

    id: str
    parent_id: str | None
    kind: WritingProjectFileKindResponse
    name: str
    path: str
    mime_type: str | None = None
    size_bytes: int
    is_root: bool = False


class GeneratedFileNodeResponse(BaseModel):
    """Milestone 5.3 Part 3 — `references.bib`, synthesized fresh on
    every call from the exact same live BibTeX generation
    GET /writing-projects/{id}/bibliography already uses. Never a real
    row (see WritingProjectFile's own docstring) — deliberately a
    DIFFERENT response type from WritingProjectFileNodeResponse (no
    `id`, no mutation actions apply to it) so the frontend can never
    accidentally attempt to rename/move/delete it through the same code
    path as a real file."""

    name: Literal["references.bib"] = "references.bib"
    path: Literal["references.bib"] = "references.bib"
    read_only: Literal[True] = True
    reference_count: int


class WritingProjectFileTreeResponse(BaseModel):
    files: list[WritingProjectFileNodeResponse]
    generated: list[GeneratedFileNodeResponse]
    root_file_id: str | None
    total_size_bytes: int
    file_count: int
    #: Milestone 5.3 Part 12 — surfaced so the frontend can show
    #: "87 / 150 files" style headroom without hardcoding the limit.
    max_files: int
    max_total_bytes: int


class WritingProjectFileContentResponse(BaseModel):
    file: WritingProjectFileNodeResponse
    #: Populated for kind == "text" only.
    content_text: str | None = None


class CreateFolderRequest(BaseModel):
    parent_id: str | None = None
    name: str = Field(min_length=1, max_length=MAX_NAME_LENGTH)


class CreateTextFileRequest(BaseModel):
    parent_id: str | None = None
    name: str = Field(min_length=1, max_length=MAX_NAME_LENGTH)
    content_text: str = Field(default="", max_length=500_000)


class UpdateFileContentRequest(BaseModel):
    content_text: str = Field(max_length=500_000)


class RenameFileRequest(BaseModel):
    name: str = Field(min_length=1, max_length=MAX_NAME_LENGTH)


class MoveFileRequest(BaseModel):
    #: null = move to the project root.
    new_parent_id: str | None = None


class SetRootFileRequest(BaseModel):
    file_id: str


class WritingProjectFileMutationResponse(BaseModel):
    file: WritingProjectFileNodeResponse


class WritingProjectFileErrorResponse(BaseModel):
    """A structured, non-500 outcome for a create/rename/move/delete
    request that failed an ordinary, expected validation rule (Part 5/6/
    7/8/9's own "validate X" requirements) — mirrors this codebase's
    existing convention of a clear `detail` string on an HTTPException,
    documented here only so the frontend's error-branch mapping has one
    place to read the full list of reason codes from."""

    detail: str
