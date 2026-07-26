from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

KnowledgeItemStatus = Literal["draft", "approved"]


class GenerateConversationSummaryRequest(BaseModel):
    """Generates a new draft Project Memory item from an existing
    conversation's message history — the conversation must already belong
    to the caller, but does not need to already be associated with this
    project via POST /projects/{id}/conversations."""

    conversation_id: str


class ReferencedDocument(BaseModel):
    document_id: str
    source_filename: str


class ProjectKnowledgeItemResponse(BaseModel):
    id: str
    project_id: str
    conversation_id: str | None
    conversation_title: str | None
    status: KnowledgeItemStatus
    research_topic: str
    research_question: str
    key_concepts: list[str]
    methodology: str
    frameworks: list[str]
    analysis_techniques: list[str]
    decisions: list[str]
    open_questions: list[str]
    keywords: list[str]
    referenced_documents: list[ReferencedDocument]
    created_at: datetime
    updated_at: datetime
    approved_at: datetime | None


class ProjectKnowledgeItemListResponse(BaseModel):
    items: list[ProjectKnowledgeItemResponse]
    total: int


class UpdateProjectKnowledgeItemRequest(BaseModel):
    """Partial update, same `model_fields_set`-driven convention as PATCH
    /projects/{id} — only a field actually present in the request body is
    ever touched. Setting `status` to "approved" is how a user approves a
    draft (RULES: users must preview, edit, and approve before a summary
    becomes Project knowledge) — nothing else ever flips it.
    `referenced_documents` is intentionally not present here: it is
    system-computed at generation time, never hand-edited (see
    ProjectKnowledgeRepository.update)."""

    research_topic: str | None = Field(default=None, max_length=2000)
    research_question: str | None = Field(default=None, max_length=2000)
    key_concepts: list[str] | None = None
    methodology: str | None = Field(default=None, max_length=4000)
    frameworks: list[str] | None = None
    analysis_techniques: list[str] | None = None
    decisions: list[str] | None = None
    open_questions: list[str] | None = None
    keywords: list[str] | None = None
    status: KnowledgeItemStatus | None = None
