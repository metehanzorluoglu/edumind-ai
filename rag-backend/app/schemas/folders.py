from datetime import datetime

from pydantic import BaseModel, Field

from app.schemas.documents import DocumentSummary


class FolderResponse(BaseModel):
    id: str
    name: str
    parent_id: str | None = None
    created_at: datetime
    updated_at: datetime
    # Direct-child counts only (never recursive) — see FolderRecord's
    # docstring. Lets the UI show "12 documents" on a folder row, and tell
    # the user up front whether Delete will need move_contents_to_root.
    folder_count: int
    document_count: int


class FolderListResponse(BaseModel):
    folders: list[FolderResponse]


class FolderBreadcrumb(BaseModel):
    id: str
    name: str


class CreateFolderRequest(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    parent_id: str | None = None


class UpdateFolderRequest(BaseModel):
    """Partial update — only fields actually present in the request body
    are applied (see `model_fields_set`, same convention as
    UpdateProjectRequest): a rename-only PATCH never moves the folder, and
    a move-only PATCH never renames it. `parent_id: null` explicitly means
    "move to root" when the field IS present; omitting `parent_id`
    entirely leaves the folder where it is."""

    name: str | None = Field(default=None, min_length=1, max_length=255)
    parent_id: str | None = None


class FolderContentsResponse(BaseModel):
    """GET /folders/contents — one round trip for everything a folder
    library screen needs to render: which folder this is (None = root),
    the breadcrumb chain to get here, its direct child folders, and a page
    of its direct documents. Avoids the two-separate-list-calls N+1 a
    naive "GET /folders?parent=X" + "GET /documents?folder=X" pair would
    cost on every navigation."""

    folder: FolderResponse | None
    breadcrumbs: list[FolderBreadcrumb]
    folders: list[FolderResponse]
    documents: list[DocumentSummary]
    documents_total: int


class DeleteFolderResponse(BaseModel):
    deleted: bool
    folder_id: str
    # >0 only when the caller opted into move_contents_to_root — see
    # FoldersRepository.delete. Both 0 for a folder that was already empty.
    moved_folders: int
    moved_documents: int
