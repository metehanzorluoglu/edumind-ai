from datetime import datetime

from pydantic import BaseModel, Field

from app.ingestion.metadata_schema import DocumentType


class ProjectSummaryResponse(BaseModel):
    id: str
    name: str
    description: str | None = None
    conversation_count: int
    created_at: datetime
    updated_at: datetime


class ProjectListResponse(BaseModel):
    projects: list[ProjectSummaryResponse]
    total: int


class CreateProjectRequest(BaseModel):
    # 80 chars matches the `projects.name` column (String(80)) — sanitized
    # (control-character stripping, whitespace collapse) in
    # app/api/routes_projects.py before this ever reaches storage or a
    # response; the frontend must still render it as plain text, never raw
    # HTML, regardless of what's sanitized here.
    name: str = Field(min_length=1, max_length=80)
    description: str | None = Field(default=None, max_length=2000)


class UpdateProjectRequest(BaseModel):
    """Partial update — the route only ever touches a field that was
    actually present in the request body (see `model_fields_set`), so a
    rename-only PATCH never clobbers the description back to null, and
    vice versa. `name`, when present, can never be blanked out; `description`
    can be explicitly cleared by sending `"description": null`."""

    name: str | None = Field(default=None, min_length=1, max_length=80)
    description: str | None = Field(default=None, max_length=2000)


class ProjectConversationResponse(BaseModel):
    conversation_id: str
    title: str
    added_at: datetime
    sort_order: int | None = None
    updated_at: datetime


class ProjectConversationListResponse(BaseModel):
    conversations: list[ProjectConversationResponse]
    total: int


class AddProjectConversationRequest(BaseModel):
    conversation_id: str


class AddProjectDocumentRequest(BaseModel):
    """Associates an already-ingested document (see POST /documents) with
    this project as project-scope retrieval evidence — never uploads or
    re-embeds anything; document_id must already belong to the caller."""

    document_id: str


class ProjectDocumentResponse(BaseModel):
    document_id: str
    source_filename: str
    document_type: DocumentType
    added_at: datetime


class ProjectDocumentListResponse(BaseModel):
    documents: list[ProjectDocumentResponse]
    total: int


class ProjectAttachmentResponse(BaseModel):
    """One promoted chat attachment (see
    app/core/attachment_promotion.py) currently placed in this project's
    scope — document_id is the searchable Document it was ingested into."""

    message_attachment_id: str
    document_id: str
    source_filename: str
    mime: str
    added_at: datetime


class ProjectAttachmentListResponse(BaseModel):
    attachments: list[ProjectAttachmentResponse]
    total: int


class CreateProjectNoteRequest(BaseModel):
    content: str = Field(min_length=1, max_length=10_000)


class ProjectNoteResponse(BaseModel):
    id: str
    content: str
    created_at: datetime
    updated_at: datetime


class ProjectNoteListResponse(BaseModel):
    notes: list[ProjectNoteResponse]
    total: int
