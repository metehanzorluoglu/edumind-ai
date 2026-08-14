"""M3.1 Notebook spec ("Research Notes Workspace"): request/response shapes
for /notebooks. See app/db/models_documents.py's Notebook/NotebookEntry
docstrings for the preservation-semantics design this mirrors — every
NotebookEntry field here is a SNAPSHOT, never a live join.
"""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

from app.schemas.documents import HighlightVisualAnchor

_MAX_NOTEBOOK_NAME_CHARS = 200
_MAX_NOTE_TEXT_CHARS = 4000

NotebookEntryType = Literal["highlight", "manual"]

# M3.1 Notebook spec §18: hard cap on how many entries a single "Ask EduM8"
# call from the Notebook may include — exceeding it is a clear rejection,
# never a silent truncation (see routes_notebooks.py's ask-context endpoint
# equivalent on the frontend, which reuses the existing Chat pipeline; the
# cap itself is enforced client-side against this same constant, mirrored
# here for backend-side defense in depth wherever entry ids are posted back).
MAX_NOTEBOOK_AI_ENTRIES = 5


class NotebookResponse(BaseModel):
    id: str
    name: str
    entry_count: int
    created_at: datetime
    updated_at: datetime


class NotebookListResponse(BaseModel):
    notebooks: list[NotebookResponse]
    total: int


class CreateNotebookRequest(BaseModel):
    name: str = Field(min_length=1, max_length=_MAX_NOTEBOOK_NAME_CHARS)


class RenameNotebookRequest(BaseModel):
    name: str = Field(min_length=1, max_length=_MAX_NOTEBOOK_NAME_CHARS)


class NotebookEntryResponse(BaseModel):
    id: str
    notebook_id: str
    entry_type: NotebookEntryType
    highlight_id: str | None = None
    document_id: str | None = None
    document_title: str | None = None
    page_number: int | None = None
    excerpt: str | None = None
    note_text: str | None = None
    chunk_id: str | None = None
    chunk_index: int | None = None
    visual_anchor: HighlightVisualAnchor | None = None
    # M3.1 Notebook spec §5: computed fresh on every read — True only if
    # `document_id` is set AND that document still exists for this user
    # right now. `document_id` itself is never cleared when the source
    # document is deleted (see NotebookEntry's backend model docstring —
    # it's a snapshot field, kept so "Open source" can still try), so the
    # frontend must not infer availability from `document_id` alone; this
    # is the one field it should actually branch on to show "Source
    # unavailable" / disable "Open source" (a manual entry, which never
    # had a document_id, is also correctly `false` here — "unavailable"
    # only means something for a highlight-derived entry).
    source_available: bool = False
    created_at: datetime
    updated_at: datetime


class NotebookEntryListResponse(BaseModel):
    entries: list[NotebookEntryResponse]
    total: int


class AddHighlightEntryRequest(BaseModel):
    """POST /notebooks/{id}/entries with entry_type="highlight" —
    `document_id`/`highlight_id` identify a highlight the caller owns,
    re-verified server-side (routes_notebooks.py looks it up via
    DocumentHighlightsRepository, never trusts a client-supplied excerpt/
    anchor). Every snapshot field (excerpt, page, chunk anchor, visual
    anchor, document title) is DERIVED server-side from that highlight and
    its document at add-time, not accepted from the request body — this is
    what makes the resulting NotebookEntry a trustworthy, independent copy
    rather than caller-supplied data merely labeled as one. `note_text` is
    the one optional override: omit it to snapshot the highlight's current
    note as-is, or supply a different value (e.g. the user edited the note
    in the add-to-notebook picker before saving). Idempotent: adding the
    same highlight_id to the same notebook twice returns the existing
    entry unchanged, never a duplicate."""

    entry_type: Literal["highlight"] = "highlight"
    document_id: str
    highlight_id: str
    note_text: str | None = Field(default=None, max_length=_MAX_NOTE_TEXT_CHARS)


class AddManualEntryRequest(BaseModel):
    entry_type: Literal["manual"] = "manual"
    note_text: str = Field(min_length=1, max_length=_MAX_NOTE_TEXT_CHARS)


class UpdateNotebookEntryRequest(BaseModel):
    note_text: str | None = Field(default=None, max_length=_MAX_NOTE_TEXT_CHARS)


class NotebookMembershipResponse(BaseModel):
    """GET /documents/{document_id}/highlights/{highlight_id}/notebooks —
    backs the Reader's "Saved to N notebook(s)" indicator and the
    add-to-notebook picker's "already saved here" checkmarks."""

    notebooks: list[NotebookResponse]
