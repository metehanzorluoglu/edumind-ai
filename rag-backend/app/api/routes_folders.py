"""Milestone 1 (Document Library / Folder Management): folder CRUD +
combined folder/document listing for the Documents page's file-manager UX.

A folder is PURELY organizational metadata — see app/db/models_folders.py
and app/db/models_documents.py's `folder_id` docstring. It is never written
into a Qdrant payload, never consulted by app/core/retriever.py or
app/core/scoped_retrieval.py, and moving a document between folders never
re-parses, re-chunks, or re-embeds it (see DocumentsRepository.
move_to_folder). The future Zoom-In/Scope retrieval boundary this milestone
is explicitly laying groundwork for (see the milestone report's Retrieval /
AI Changes section) stays keyed on document_id via the existing
conversation_documents/project_documents association tables — never on
folder_id, which a user could reorganize at any time without that silently
changing what a conversation or project can see.

Every endpoint here (and the two folder-aware additions to
app/api/routes_documents.py: `folder_id` on POST /documents, and
PATCH /documents/{id}) is gated on Settings.folder_library_enabled — see
_require_enabled below and app/config.py's docstring for why this is a
uniform runtime check in every handler rather than simply not mounting this
router: PATCH /documents/{id} (the "move a document" endpoint) lives on the
*documents* router, which is always mounted, so gating only this router
would leave that one endpoint reachable while disabled. A single consistent
check across every folder-touching handler avoids that split.
"""

import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.api.routes_documents import _document_summary
from app.config import Settings
from app.core.security import CurrentUserDep, get_current_user
from app.db.folders_repository import (
    CircularFolderReferenceError,
    FolderDeleteResult,
    FolderNameConflictError,
    FolderNotEmptyError,
    FolderRecord,
)
from app.deps import (
    DocumentFileStorageDep,
    DocumentsRepositoryDep,
    FoldersRepositoryDep,
    SettingsDep,
)
from app.schemas.folders import (
    CreateFolderRequest,
    DeleteFolderResponse,
    FolderBreadcrumb,
    FolderContentsResponse,
    FolderResponse,
    UpdateFolderRequest,
)

router = APIRouter(prefix="/folders", tags=["folders"], dependencies=[Depends(get_current_user)])

# get_folder_contents() below reuses routes_documents.py's own
# _document_summary() rather than building a second DocumentSummary here
# (this module used to have its own copy, which silently fell behind as
# routes_documents.py's DocumentSummary grew — Milestone 4's volume/issue/
# page_start/page_end/publisher/abstract/keywords/language/
# metadata_sources fields, and Milestone 4.1's last_enriched_at/
# enrichment_provider/enrichment_status/has_usable_doi, were never present
# on a document reached through the folder-library listing until this fix.
# One shared builder is the only way that can't happen again.

_MAX_LIMIT = 200


def _require_enabled(settings: Settings) -> None:
    if not settings.folder_library_enabled:
        # 404, not 403: matches this app's existing "an unmounted/disabled
        # route simply doesn't exist" convention for image generation (see
        # app/main.py) — the client should already be hiding every folder
        # affordance based on GET /status's folder_library_enabled, so
        # reaching here at all means a stale client or direct API use.
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Folder library is disabled")


def _parse_uuid(value: str, *, field: str) -> uuid.UUID:
    try:
        return uuid.UUID(value)
    except ValueError as exc:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, detail=f"Invalid {field}"
        ) from exc


def _folder_response(record: FolderRecord) -> FolderResponse:
    return FolderResponse(
        id=str(record.id),
        name=record.name,
        parent_id=str(record.parent_id) if record.parent_id else None,
        created_at=record.created_at,
        updated_at=record.updated_at,
        folder_count=record.folder_count,
        document_count=record.document_count,
    )


@router.post("", response_model=FolderResponse, status_code=status.HTTP_201_CREATED)
def create_folder(
    request: CreateFolderRequest,
    user: CurrentUserDep,
    settings: SettingsDep,
    repository: FoldersRepositoryDep,
) -> FolderResponse:
    _require_enabled(settings)
    parent_id = _parse_uuid(request.parent_id, field="parent_id") if request.parent_id else None
    name = request.name.strip()
    if not name:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, detail="Name cannot be empty")
    try:
        record = repository.create(user.id, name=name, parent_id=parent_id)
    except FolderNameConflictError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    if record is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Parent folder not found")
    return _folder_response(record)


@router.get("/contents", response_model=FolderContentsResponse)
def get_folder_contents(
    user: CurrentUserDep,
    settings: SettingsDep,
    folders_repository: FoldersRepositoryDep,
    documents_repository: DocumentsRepositoryDep,
    document_file_storage: DocumentFileStorageDep,
    folder_id: str | None = Query(default=None, description="Omit or blank for root"),
    limit: int = Query(default=50, ge=1, le=_MAX_LIMIT),
    offset: int = Query(default=0, ge=0),
) -> FolderContentsResponse:
    """One round trip for a folder library screen: the folder itself (None
    for root), its breadcrumb chain, its direct child folders, and a page
    of its direct documents — see FolderContentsResponse's docstring for
    why this is one endpoint instead of two."""
    _require_enabled(settings)
    parsed_folder_id = _parse_uuid(folder_id, field="folder_id") if folder_id else None

    breadcrumbs: list[FolderBreadcrumb] = []
    folder_response: FolderResponse | None = None
    if parsed_folder_id is not None:
        path = folders_repository.list_path(user.id, parsed_folder_id)
        if path is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Folder not found")
        breadcrumbs = [FolderBreadcrumb(id=str(f.id), name=f.name) for f in path]
        folder_response = _folder_response(path[-1])

    child_folders = folders_repository.list_children(user.id, parsed_folder_id)
    if child_folders is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Folder not found")

    documents, documents_total = documents_repository.list_in_folder(
        user.id, parsed_folder_id, limit=limit, offset=offset
    )

    return FolderContentsResponse(
        folder=folder_response,
        breadcrumbs=breadcrumbs,
        folders=[_folder_response(f) for f in child_folders],
        documents=[_document_summary(d, document_file_storage) for d in documents],
        documents_total=documents_total,
    )


@router.patch("/{folder_id}", response_model=FolderResponse)
def update_folder(
    folder_id: str,
    request: UpdateFolderRequest,
    user: CurrentUserDep,
    settings: SettingsDep,
    repository: FoldersRepositoryDep,
) -> FolderResponse:
    _require_enabled(settings)
    parsed_id = _parse_uuid(folder_id, field="folder_id")
    fields_set = request.model_fields_set

    record: FolderRecord | None = None
    try:
        if "name" in fields_set:
            name = (request.name or "").strip()
            if not name:
                raise HTTPException(
                    status.HTTP_422_UNPROCESSABLE_CONTENT, detail="Name cannot be empty"
                )
            record = repository.rename(user.id, parsed_id, name)
            if record is None:
                raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Folder not found")

        if "parent_id" in fields_set:
            new_parent_id = (
                _parse_uuid(request.parent_id, field="parent_id") if request.parent_id else None
            )
            record = repository.move(user.id, parsed_id, new_parent_id)
            if record is None:
                raise HTTPException(
                    status.HTTP_404_NOT_FOUND, detail="Folder or destination not found"
                )
    except FolderNameConflictError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    except CircularFolderReferenceError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc

    if record is None:
        record = repository.get(user.id, parsed_id)
        if record is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Folder not found")
    return _folder_response(record)


@router.delete("/{folder_id}", response_model=DeleteFolderResponse)
def delete_folder(
    folder_id: str,
    user: CurrentUserDep,
    settings: SettingsDep,
    repository: FoldersRepositoryDep,
    move_contents_to_root: bool = Query(
        default=False,
        description="If true, directly-contained folders/documents are moved to root instead "
        "of blocking the delete.",
    ),
) -> DeleteFolderResponse:
    """Safe by default: a non-empty folder is refused with 409 (see
    FolderNotEmptyError) unless the caller explicitly opts into
    `move_contents_to_root=true` — enforced here regardless of what the
    frontend does, so a non-empty folder can never be silently emptied by
    a stale or hand-crafted request (see the milestone's "least
    destructive" requirement)."""
    _require_enabled(settings)
    parsed_id = _parse_uuid(folder_id, field="folder_id")
    try:
        result: FolderDeleteResult | None = repository.delete(
            user.id, parsed_id, move_contents_to_root=move_contents_to_root
        )
    except FolderNotEmptyError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    if result is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Folder not found")
    return DeleteFolderResponse(
        deleted=True,
        folder_id=str(result.folder_id),
        moved_folders=result.moved_folders,
        moved_documents=result.moved_documents,
    )
