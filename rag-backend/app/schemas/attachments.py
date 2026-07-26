from typing import Literal, Self

from pydantic import BaseModel, model_validator

from app.ingestion.metadata_schema import DocumentType, JournalQuartile

AttachmentScope = Literal["chat", "project", "general"]


class _ScopeRequestBase(BaseModel):
    scope: AttachmentScope
    project_id: str | None = None

    @model_validator(mode="after")
    def _project_id_required_for_project_scope(self) -> Self:
        if self.scope == "project" and not self.project_id:
            raise ValueError("project_id is required when scope is 'project'")
        return self


class PromoteAttachmentRequest(_ScopeRequestBase):
    """Ingests a chat attachment (PDF only — see
    app/core/attachment_promotion.py) into a real searchable Document and
    places it in the requested scope. Bibliographic fields mirror
    POST /documents' own Form fields, since the same metadata is being
    recorded for the resulting document either way."""

    document_type: DocumentType
    journal_quartile: JournalQuartile = None
    title: str | None = None
    authors: list[str] | None = None
    publication_year: int | None = None
    source_venue: str | None = None
    doi: str | None = None
    source_url: str | None = None


class SwitchAttachmentScopeRequest(_ScopeRequestBase):
    """Moves an already-promoted attachment's document to a new scope —
    no bibliographic fields, since nothing is being (re-)ingested."""


class PromotedAttachmentResponse(BaseModel):
    attachment_id: str
    document_id: str
    scope: AttachmentScope
    project_id: str | None = None
    source_filename: str
    document_type: DocumentType
    reused: bool


class SaveAttachmentToProjectRequest(BaseModel):
    """PATCH /attachments/{id}/project — a simple gallery bookmark for a
    generated image (see MessageAttachment.saved_project_id's docs), not
    RAG scope placement. `project_id=None` un-saves it."""

    project_id: str | None = None
