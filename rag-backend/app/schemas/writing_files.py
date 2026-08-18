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


ReferenceModeType = Literal["edum8_library", "imported_bib", "template_tex", "inline_template"]
CitationKeySourceType = Literal["edum8", "bib_file", "bibitem", "none"]


class ReferenceKeyResponse(BaseModel):
    """One resolved citation key, deterministically parsed — never an
    EduM8-invented key. `title` is a best-effort DISPLAY label only
    (from a real BibTeX `title` field or the text following a
    `\\bibitem`), never itself used as the key."""

    key: str
    title: str | None = None


class Edum8SwitchProposalResponse(BaseModel):
    """A safe, single-substitution rewrite EduM8 can apply on explicit
    user confirmation — see app/core/reference_mode.py's
    propose_edum8_switch for exactly when this is (and is never)
    offered."""

    file_path: str
    find: str
    replace: str


class ReferenceModeResponse(BaseModel):
    """Bibliography Source Detection — how this project ACTUALLY manages
    its citations/references right now, detected from real project
    content (see app/core/reference_mode.py), never assumed from
    references.bib merely existing (it always does, as a virtual file —
    GeneratedFileNodeResponse above)."""

    mode: ReferenceModeType
    bibliography_source: str | None
    citation_key_source: CitationKeySourceType
    #: Empty for mode == "edum8_library" — the frontend already has its
    #: own separately-fetched EduM8 reference list for that case.
    keys: list[ReferenceKeyResponse]
    edum8_available: bool
    no_key_source_reason: str | None = None
    #: Set only when a SAFE automatic rewrite exists (imported_bib mode
    #: only). Never set for template_tex/inline_template — those get
    #: `edum8_switch_instructions` instead.
    edum8_switch_proposal: Edum8SwitchProposalResponse | None = None
    #: Set when mode != "edum8_library" and no safe automatic proposal
    #: exists — human-readable instructions, never an automatic rewrite.
    edum8_switch_instructions: str | None = None


class SwitchToEdum8Request(BaseModel):
    """Echoes back the EXACT proposal the GET endpoint returned — the
    apply endpoint re-verifies `find` is still present in the root
    file's CURRENT content before writing anything, so a proposal
    computed against stale content can never silently clobber a file
    the user has since edited."""

    file_path: str = Field(min_length=1)
    find: str = Field(min_length=1)
    replace: str = Field(min_length=1)


class SwitchToEdum8Response(BaseModel):
    file: WritingProjectFileNodeResponse


class WritingProjectFileErrorResponse(BaseModel):
    """A structured, non-500 outcome for a create/rename/move/delete
    request that failed an ordinary, expected validation rule (Part 5/6/
    7/8/9's own "validate X" requirements) — mirrors this codebase's
    existing convention of a clear `detail` string on an HTTPException,
    documented here only so the frontend's error-branch mapping has one
    place to read the full list of reason codes from."""

    detail: str
