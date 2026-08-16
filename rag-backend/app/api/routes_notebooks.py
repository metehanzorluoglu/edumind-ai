"""Frontend Milestone 3.1 — M3.1 Notebook spec ("Research Notes Workspace").

Every route here is ownership-scoped and follows this app's existing
"404, not 403" convention (see NotebooksRepository's module docstring) —
a notebook/entry that doesn't exist *or* belongs to a different user is
indistinguishable. No route in this file ever touches Qdrant, embeddings,
or the retrieval pipeline (M3.1 Notebook spec §20: Notebook entries are
never automatic RAG sources) and there is no "ask" endpoint here at all
(§21: Ask EduM8 reuses the existing Chat pipeline entirely — the frontend
builds a TransientAIContext from already-loaded NotebookEntryResponse data
and posts it through the ordinary conversation-message endpoint, exactly
like a Reader-selection Zoom-In today).
"""

import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import TypeAdapter

from app.core.security import CurrentUserDep, get_current_user
from app.db.documents_repository import DocumentsRepository
from app.db.notebooks_repository import NotebookEntryRecord, NotebookRecord
from app.deps import (
    DocumentHighlightsRepositoryDep,
    DocumentsRepositoryDep,
    NotebooksRepositoryDep,
)
from app.schemas.documents import HighlightVisualAnchor
from app.schemas.notebooks import (
    AddHighlightEntryRequest,
    AddManualEntryRequest,
    CreateNotebookRequest,
    NotebookEntryListResponse,
    NotebookEntryResponse,
    NotebookListResponse,
    NotebookMembershipResponse,
    NotebookResponse,
    RenameNotebookRequest,
    UpdateNotebookEntryRequest,
)

router = APIRouter(tags=["notebooks"], dependencies=[Depends(get_current_user)])

_AddEntryRequestAdapter: TypeAdapter[AddHighlightEntryRequest | AddManualEntryRequest] = (
    TypeAdapter(AddHighlightEntryRequest | AddManualEntryRequest)
)


def _notebook_response(record: NotebookRecord) -> NotebookResponse:
    return NotebookResponse(
        id=str(record.id),
        name=record.name,
        entry_count=record.entry_count,
        created_at=record.created_at,
        updated_at=record.updated_at,
    )


def _entry_response(
    record: NotebookEntryRecord, *, source_available: bool
) -> NotebookEntryResponse:
    return NotebookEntryResponse(
        id=str(record.id),
        notebook_id=str(record.notebook_id),
        entry_type=record.entry_type,  # type: ignore[arg-type]
        highlight_id=str(record.highlight_id) if record.highlight_id else None,
        document_id=record.document_id,
        document_title=record.document_title_snapshot,
        document_authors=record.document_authors_snapshot,
        document_publication_year=record.document_publication_year_snapshot,
        page_number=record.page_number,
        excerpt=record.excerpt_snapshot,
        note_text=record.note_text,
        chunk_id=record.chunk_id_snapshot,
        chunk_index=record.chunk_index_snapshot,
        visual_anchor=(
            HighlightVisualAnchor.model_validate_json(record.visual_anchor_snapshot_json)
            if record.visual_anchor_snapshot_json is not None
            else None
        ),
        source_available=source_available,
        created_at=record.created_at,
        updated_at=record.updated_at,
    )


def _check_source_available(
    documents_repository: DocumentsRepository, user_id: uuid.UUID, document_id: str | None
) -> bool:
    if document_id is None:
        return False
    return documents_repository.get(user_id, document_id) is not None


@router.get("/notebooks", response_model=NotebookListResponse)
def list_notebooks(
    user: CurrentUserDep,
    notebooks_repository: NotebooksRepositoryDep,
    limit: int = 20,
    offset: int = 0,
) -> NotebookListResponse:
    records, total = notebooks_repository.list_for_user(user.id, limit=limit, offset=offset)
    return NotebookListResponse(notebooks=[_notebook_response(r) for r in records], total=total)


@router.post("/notebooks", response_model=NotebookResponse, status_code=status.HTTP_201_CREATED)
def create_notebook(
    request: CreateNotebookRequest,
    user: CurrentUserDep,
    notebooks_repository: NotebooksRepositoryDep,
) -> NotebookResponse:
    record = notebooks_repository.create(user_id=user.id, name=request.name)
    return _notebook_response(record)


@router.patch("/notebooks/{notebook_id}", response_model=NotebookResponse)
def rename_notebook(
    notebook_id: uuid.UUID,
    request: RenameNotebookRequest,
    user: CurrentUserDep,
    notebooks_repository: NotebooksRepositoryDep,
) -> NotebookResponse:
    record = notebooks_repository.rename(user.id, notebook_id, request.name)
    if record is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Notebook not found")
    return _notebook_response(record)


@router.delete("/notebooks/{notebook_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_notebook(
    notebook_id: uuid.UUID,
    user: CurrentUserDep,
    notebooks_repository: NotebooksRepositoryDep,
) -> None:
    """Deletes the notebook and only its own entries — never the source
    documents, highlights, or conversations any entry pointed at (M3.1
    Notebook spec §1)."""
    if not notebooks_repository.delete(user.id, notebook_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Notebook not found")


@router.get("/notebooks/{notebook_id}/entries", response_model=NotebookEntryListResponse)
def list_notebook_entries(
    notebook_id: uuid.UUID,
    user: CurrentUserDep,
    notebooks_repository: NotebooksRepositoryDep,
    documents_repository: DocumentsRepositoryDep,
    limit: int = 20,
    offset: int = 0,
) -> NotebookEntryListResponse:
    result = notebooks_repository.list_entries(user.id, notebook_id, limit=limit, offset=offset)
    if result is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Notebook not found")
    records, total = result
    # One availability check per DISTINCT document_id on this page of
    # entries (never per entry) — a notebook commonly has several entries
    # from the same source document.
    availability_cache: dict[str, bool] = {}
    entries = []
    for r in records:
        if r.document_id is not None and r.document_id not in availability_cache:
            availability_cache[r.document_id] = _check_source_available(
                documents_repository, user.id, r.document_id
            )
        entries.append(
            _entry_response(
                r, source_available=availability_cache.get(r.document_id, False)
            )
        )
    return NotebookEntryListResponse(entries=entries, total=total)


@router.post(
    "/notebooks/{notebook_id}/entries",
    response_model=NotebookEntryResponse,
    status_code=status.HTTP_201_CREATED,
)
def add_notebook_entry(
    notebook_id: uuid.UUID,
    user: CurrentUserDep,
    notebooks_repository: NotebooksRepositoryDep,
    document_highlights_repository: DocumentHighlightsRepositoryDep,
    documents_repository: DocumentsRepositoryDep,
    body: dict,
) -> NotebookEntryResponse:
    """Accepts either an `entry_type: "highlight"` or `entry_type:
    "manual"` body (see AddHighlightEntryRequest/AddManualEntryRequest) —
    a plain dict param plus TypeAdapter validation, since FastAPI's
    Pydantic-model-body binding does not support a bare (non-field)
    discriminated union as the whole request body."""
    request = _AddEntryRequestAdapter.validate_python(body)

    if isinstance(request, AddManualEntryRequest):
        record = notebooks_repository.add_manual_entry(
            user_id=user.id, notebook_id=notebook_id, note_text=request.note_text
        )
        if record is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Notebook not found")
        return _entry_response(record, source_available=False)

    # entry_type == "highlight" — re-derive every snapshot field from the
    # caller's OWN highlight/document rows server-side (see
    # AddHighlightEntryRequest's docstring); never trust a client-supplied
    # excerpt/anchor for what becomes a permanent research record.
    try:
        highlight_uuid = uuid.UUID(request.highlight_id)
    except ValueError as exc:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, detail="Invalid highlight_id"
        ) from exc
    highlight = document_highlights_repository.get(user.id, request.document_id, highlight_uuid)
    if highlight is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Highlight not found")
    document = documents_repository.get(user.id, request.document_id)
    document_title = (
        (document.title or document.source_filename) if document is not None else None
    )

    record = notebooks_repository.add_highlight_entry(
        user_id=user.id,
        notebook_id=notebook_id,
        highlight_id=highlight.id,
        document_id=highlight.document_id,
        document_title=document_title,
        # Milestone 4: same snapshot-at-add-time rule as document_title
        # above — copied once, here, and never re-read from the source
        # Document again (see NotebookEntry's docstring).
        document_authors=document.authors if document is not None else None,
        document_publication_year=document.publication_year if document is not None else None,
        page_number=highlight.page_number,
        excerpt=highlight.selected_text,
        note_text=request.note_text if request.note_text is not None else highlight.note_text,
        chunk_id=highlight.chunk_id,
        chunk_index=highlight.chunk_index,
        visual_anchor_json=highlight.visual_anchor_json,
    )
    if record is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Notebook not found")
    return _entry_response(record, source_available=document is not None)


@router.patch(
    "/notebooks/{notebook_id}/entries/{entry_id}", response_model=NotebookEntryResponse
)
def update_notebook_entry(
    notebook_id: uuid.UUID,
    entry_id: uuid.UUID,
    request: UpdateNotebookEntryRequest,
    user: CurrentUserDep,
    notebooks_repository: NotebooksRepositoryDep,
    documents_repository: DocumentsRepositoryDep,
) -> NotebookEntryResponse:
    """The note is the only mutable field on an entry — for a manual entry
    this IS the entry's content; for a highlight-derived entry this edits
    the independently-persisted snapshot copy, never the live highlight's
    own note (see NotebookEntry's docstring)."""
    record = notebooks_repository.update_entry_note(
        user.id, notebook_id, entry_id, note_text=request.note_text
    )
    if record is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Entry not found")
    return _entry_response(
        record,
        source_available=_check_source_available(documents_repository, user.id, record.document_id),
    )


@router.delete(
    "/notebooks/{notebook_id}/entries/{entry_id}", status_code=status.HTTP_204_NO_CONTENT
)
def remove_notebook_entry(
    notebook_id: uuid.UUID,
    entry_id: uuid.UUID,
    user: CurrentUserDep,
    notebooks_repository: NotebooksRepositoryDep,
) -> None:
    """Removes this entry from this notebook only — never deletes the
    source DocumentHighlight, Document, or any other notebook's copy of
    the same highlight (M3.1 Notebook spec §5's asymmetry runs the other
    way too: removing an entry here has zero effect on the Reader)."""
    if not notebooks_repository.remove_entry(user.id, notebook_id, entry_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Entry not found")


@router.get(
    "/documents/{document_id}/highlights/{highlight_id}/notebooks",
    response_model=NotebookMembershipResponse,
)
def get_highlight_notebook_membership(
    document_id: str,
    highlight_id: uuid.UUID,
    user: CurrentUserDep,
    document_highlights_repository: DocumentHighlightsRepositoryDep,
    notebooks_repository: NotebooksRepositoryDep,
) -> NotebookMembershipResponse:
    """Backs the Reader's "Saved to N notebook(s)" indicator and the
    add-to-notebook picker's "already saved here" checkmarks — never
    exposes another user's notebooks even if they happened to save an
    (impossible, since highlights are per-user) identical highlight_id."""
    if document_highlights_repository.get(user.id, document_id, highlight_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Highlight not found")
    notebooks = notebooks_repository.list_notebooks_for_highlight(user.id, highlight_id)
    return NotebookMembershipResponse(notebooks=[_notebook_response(n) for n in notebooks])
