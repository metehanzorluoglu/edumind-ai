import tempfile
import uuid
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, Form, HTTPException, Query, UploadFile, status

from app.core.conversation_summarization import (
    SummaryGenerationError,
    generate_conversation_summary,
)
from app.core.conversation_title import sanitize_title
from app.core.document_ingestion import ingest_or_reuse_document
from app.core.document_scoping import (
    add_document_to_project,
    remove_attachment_from_project,
    remove_document_from_project,
)
from app.core.research_preferences import observe_approved_item
from app.core.security import CurrentUserDep, get_current_user
from app.db.project_knowledge_repository import ProjectKnowledgeRecord
from app.db.project_profile_repository import ProjectProfileRecord
from app.db.projects_repository import ProjectConversationRecord, ProjectSummary
from app.db.research_preference_repository import ResearchPreferenceRecord
from app.db.scopes_repository import (
    ProjectAttachmentRecord,
    ProjectDocumentRecord,
    ProjectNoteRecord,
)
from app.deps import (
    ConversationsRepositoryDep,
    DocumentsRepositoryDep,
    EmbeddingProviderDep,
    LLMProviderDep,
    ProjectKnowledgeRepositoryDep,
    ProjectProfileRepositoryDep,
    ProjectsRepositoryDep,
    ResearchPreferenceRepositoryDep,
    ScopesRepositoryDep,
    VectorStoreDep,
)
from app.ingestion.errors import DocumentExtractionError, UnsupportedFileTypeError
from app.ingestion.metadata_schema import DocumentType, JournalQuartile
from app.schemas.project_knowledge import (
    GenerateConversationSummaryRequest,
    ProjectKnowledgeItemListResponse,
    ProjectKnowledgeItemResponse,
    ReferencedDocument,
    UpdateProjectKnowledgeItemRequest,
)
from app.schemas.project_profile import (
    ProjectProfileResponse,
    ResearchPreferenceListResponse,
    ResearchPreferenceSuggestionResponse,
    UpdateProjectProfileRequest,
    UpdateResearchPreferenceStatusRequest,
)
from app.schemas.projects import (
    AddProjectConversationRequest,
    AddProjectDocumentRequest,
    CreateProjectNoteRequest,
    CreateProjectRequest,
    ProjectAttachmentListResponse,
    ProjectAttachmentResponse,
    ProjectConversationListResponse,
    ProjectConversationResponse,
    ProjectDocumentListResponse,
    ProjectDocumentResponse,
    ProjectListResponse,
    ProjectNoteListResponse,
    ProjectNoteResponse,
    ProjectSummaryResponse,
    UpdateProjectRequest,
)

router = APIRouter(prefix="/projects", tags=["projects"], dependencies=[Depends(get_current_user)])

_MAX_LIMIT = 100


def _summary_response(summary: ProjectSummary) -> ProjectSummaryResponse:
    return ProjectSummaryResponse(
        id=str(summary.id),
        name=summary.name,
        description=summary.description,
        conversation_count=summary.conversation_count,
        created_at=summary.created_at,
        updated_at=summary.updated_at,
    )


def _conversation_response(record: ProjectConversationRecord) -> ProjectConversationResponse:
    return ProjectConversationResponse(
        conversation_id=str(record.conversation_id),
        title=record.title,
        added_at=record.added_at,
        sort_order=record.sort_order,
        updated_at=record.updated_at,
    )


def _sanitize_description(description: str | None) -> str | None:
    if description is None:
        return None
    cleaned = sanitize_title(description)
    return cleaned or None


def _project_document_response(record: ProjectDocumentRecord) -> ProjectDocumentResponse:
    return ProjectDocumentResponse(
        document_id=record.document_id,
        source_filename=record.source_filename,
        document_type=record.document_type,  # type: ignore[arg-type]
        added_at=record.added_at,
    )


def _project_attachment_response(record: ProjectAttachmentRecord) -> ProjectAttachmentResponse:
    return ProjectAttachmentResponse(
        message_attachment_id=str(record.message_attachment_id),
        document_id=record.document_id,
        source_filename=record.source_filename,
        mime=record.mime,
        added_at=record.added_at,
    )


def _project_note_response(record: ProjectNoteRecord) -> ProjectNoteResponse:
    return ProjectNoteResponse(
        id=str(record.id),
        content=record.content,
        created_at=record.created_at,
        updated_at=record.updated_at,
    )


def _knowledge_item_response(record: ProjectKnowledgeRecord) -> ProjectKnowledgeItemResponse:
    return ProjectKnowledgeItemResponse(
        id=str(record.id),
        project_id=str(record.project_id),
        conversation_id=str(record.conversation_id) if record.conversation_id else None,
        conversation_title=record.conversation_title,
        status=record.status,  # type: ignore[arg-type]
        research_topic=record.research_topic,
        research_question=record.research_question,
        key_concepts=record.key_concepts,
        methodology=record.methodology,
        frameworks=record.frameworks,
        analysis_techniques=record.analysis_techniques,
        decisions=record.decisions,
        open_questions=record.open_questions,
        keywords=record.keywords,
        referenced_documents=[ReferencedDocument(**doc) for doc in record.referenced_documents],
        created_at=record.created_at,
        updated_at=record.updated_at,
        approved_at=record.approved_at,
    )


def _project_profile_response(record: ProjectProfileRecord) -> ProjectProfileResponse:
    return ProjectProfileResponse(
        project_id=str(record.project_id),
        research_questions=record.research_questions,
        frameworks=record.frameworks,
        methodology=record.methodology,
        participants=record.participants,
        data=record.data,
        analysis=record.analysis,
        citation_style=record.citation_style,
        output_format=record.output_format,
        created_at=record.created_at,
        updated_at=record.updated_at,
    )


def _research_preference_response(
    record: ResearchPreferenceRecord,
) -> ResearchPreferenceSuggestionResponse:
    return ResearchPreferenceSuggestionResponse(
        id=str(record.id),
        project_id=str(record.project_id),
        field=record.field,
        suggested_value=record.suggested_value,
        status=record.status,
        observed_count=record.observed_count,
        created_at=record.created_at,
        updated_at=record.updated_at,
        resolved_at=record.resolved_at,
    )


def _read_upload_to_tempfile(file: UploadFile) -> Path:
    if not file.filename:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Uploaded file has no filename"
        )
    suffix = Path(file.filename).suffix
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp_file:
        tmp_file.write(file.file.read())
        return Path(tmp_file.name)


@router.post("", response_model=ProjectSummaryResponse, status_code=status.HTTP_201_CREATED)
def create_project(
    request: CreateProjectRequest, user: CurrentUserDep, repository: ProjectsRepositoryDep
) -> ProjectSummaryResponse:
    name = sanitize_title(request.name)
    if not name:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, detail="Name cannot be empty")
    project = repository.create(
        user_id=user.id, name=name, description=_sanitize_description(request.description)
    )
    summary = repository.get_summary(user.id, project.id)
    assert summary is not None  # just created by this same user, in this same transaction
    return _summary_response(summary)


@router.get("", response_model=ProjectListResponse)
def list_projects(
    user: CurrentUserDep,
    repository: ProjectsRepositoryDep,
    limit: int = Query(default=20, ge=1, le=_MAX_LIMIT),
    offset: int = Query(default=0, ge=0),
) -> ProjectListResponse:
    summaries, total = repository.list_for_user(user.id, limit=limit, offset=offset)
    return ProjectListResponse(projects=[_summary_response(s) for s in summaries], total=total)


@router.get("/{project_id}", response_model=ProjectSummaryResponse)
def get_project(
    project_id: uuid.UUID, user: CurrentUserDep, repository: ProjectsRepositoryDep
) -> ProjectSummaryResponse:
    summary = repository.get_summary(user.id, project_id)
    if summary is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Project not found")
    return _summary_response(summary)


@router.patch("/{project_id}", response_model=ProjectSummaryResponse)
def update_project(
    project_id: uuid.UUID,
    request: UpdateProjectRequest,
    user: CurrentUserDep,
    repository: ProjectsRepositoryDep,
) -> ProjectSummaryResponse:
    fields_set = request.model_fields_set
    if "name" in fields_set:
        name = sanitize_title(request.name or "")
        if not name:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT, detail="Name cannot be empty"
            )
        if repository.rename(user.id, project_id, name) is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Project not found")
    if "description" in fields_set:
        description = _sanitize_description(request.description)
        if repository.update_description(user.id, project_id, description) is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Project not found")

    summary = repository.get_summary(user.id, project_id)
    if summary is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Project not found")
    return _summary_response(summary)


@router.delete("/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_project(
    project_id: uuid.UUID, user: CurrentUserDep, repository: ProjectsRepositoryDep
) -> None:
    deleted = repository.delete(user.id, project_id)
    if not deleted:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Project not found")


@router.get("/{project_id}/conversations", response_model=ProjectConversationListResponse)
def list_project_conversations(
    project_id: uuid.UUID,
    user: CurrentUserDep,
    repository: ProjectsRepositoryDep,
    limit: int = Query(default=20, ge=1, le=_MAX_LIMIT),
    offset: int = Query(default=0, ge=0),
) -> ProjectConversationListResponse:
    result = repository.list_conversations(user.id, project_id, limit=limit, offset=offset)
    if result is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Project not found")
    records, total = result
    return ProjectConversationListResponse(
        conversations=[_conversation_response(r) for r in records], total=total
    )


@router.post(
    "/{project_id}/conversations",
    response_model=ProjectConversationResponse,
    status_code=status.HTTP_201_CREATED,
)
def add_project_conversation(
    project_id: uuid.UUID,
    request: AddProjectConversationRequest,
    user: CurrentUserDep,
    repository: ProjectsRepositoryDep,
) -> ProjectConversationResponse:
    try:
        conversation_id = uuid.UUID(request.conversation_id)
    except ValueError as exc:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, detail="Invalid conversation_id"
        ) from exc

    record = repository.add_conversation(user.id, project_id, conversation_id)
    if record is None:
        # Deliberately the same 404 whether the project doesn't exist, isn't
        # the caller's, the conversation doesn't exist, or belongs to a
        # different user — never reveals which (see repository docstring).
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, detail="Project or conversation not found"
        )
    return _conversation_response(record)


@router.delete(
    "/{project_id}/conversations/{conversation_id}", status_code=status.HTTP_204_NO_CONTENT
)
def remove_project_conversation(
    project_id: uuid.UUID,
    conversation_id: uuid.UUID,
    user: CurrentUserDep,
    repository: ProjectsRepositoryDep,
) -> None:
    removed = repository.remove_conversation(user.id, project_id, conversation_id)
    if not removed:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Association not found")


@router.post(
    "/{project_id}/documents",
    response_model=ProjectDocumentResponse,
    status_code=status.HTTP_201_CREATED,
)
def add_project_document(
    project_id: uuid.UUID,
    request: AddProjectDocumentRequest,
    user: CurrentUserDep,
    scopes_repository: ScopesRepositoryDep,
    vector_store: VectorStoreDep,
) -> ProjectDocumentResponse:
    """Associates an already-ingested document (see POST /documents) with
    this project as project-scope retrieval evidence (contextual research
    scopes) — never duplicates the document's vectors, only adds a pointer
    plus a Qdrant payload resync (see app/core/document_scoping.py).
    Idempotent: re-adding a document already associated with this project
    returns the existing association unchanged."""
    record = add_document_to_project(
        project_id=project_id,
        document_id=request.document_id,
        user_id=user.id,
        scopes_repository=scopes_repository,
        vector_store=vector_store,
    )
    if record is None:
        # Deliberately the same 404 whether the project doesn't exist, isn't
        # the caller's, the document doesn't exist, or belongs to a
        # different user — never reveals which (see ScopesRepository).
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Project or document not found")
    return _project_document_response(record)


@router.delete("/{project_id}/documents/{document_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_project_document(
    project_id: uuid.UUID,
    document_id: str,
    user: CurrentUserDep,
    scopes_repository: ScopesRepositoryDep,
    vector_store: VectorStoreDep,
) -> None:
    """Removes only the association — never the document itself (it may
    still be part of the caller's general corpus or another project's/
    conversation's scope)."""
    removed = remove_document_from_project(
        project_id=project_id,
        document_id=document_id,
        user_id=user.id,
        scopes_repository=scopes_repository,
        vector_store=vector_store,
    )
    if not removed:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Association not found")


@router.get("/{project_id}/documents", response_model=ProjectDocumentListResponse)
def list_project_documents(
    project_id: uuid.UUID, user: CurrentUserDep, scopes_repository: ScopesRepositoryDep
) -> ProjectDocumentListResponse:
    records = scopes_repository.list_project_documents(user.id, project_id)
    if records is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Project not found")
    documents = [_project_document_response(r) for r in records]
    return ProjectDocumentListResponse(documents=documents, total=len(documents))


@router.post(
    "/{project_id}/documents/upload",
    response_model=ProjectDocumentResponse,
    status_code=status.HTTP_201_CREATED,
)
def upload_project_document(
    project_id: uuid.UUID,
    user: CurrentUserDep,
    documents_repository: DocumentsRepositoryDep,
    embedding_provider: EmbeddingProviderDep,
    vector_store: VectorStoreDep,
    scopes_repository: ScopesRepositoryDep,
    file: UploadFile,
    document_type: Annotated[DocumentType, Form()],
    journal_quartile: Annotated[JournalQuartile, Form()] = None,
    title: Annotated[str | None, Form()] = None,
    authors: Annotated[str | None, Form(description="Comma-separated author names")] = None,
    publication_year: Annotated[int | None, Form()] = None,
    source_venue: Annotated[str | None, Form()] = None,
    doi: Annotated[str | None, Form()] = None,
    source_url: Annotated[str | None, Form()] = None,
) -> ProjectDocumentResponse:
    """Uploads a file directly into this project's corpus — reuses an
    already-ingested document with the same content instead of erroring
    (see app/core/document_ingestion.py; unlike plain POST /documents,
    which still hard-409s on a duplicate), then associates it with this
    project. Never duplicates vectors either way."""
    author_list = [name.strip() for name in authors.split(",") if name.strip()] if authors else None
    tmp_path = _read_upload_to_tempfile(file)
    try:
        document_record, _reused = ingest_or_reuse_document(
            tmp_path,
            document_type=document_type,
            documents_repository=documents_repository,
            embedding_provider=embedding_provider,
            vector_store=vector_store,
            user_id=user.id,
            journal_quartile=journal_quartile,
            title=title,
            authors=author_list,
            publication_year=publication_year,
            source_venue=source_venue,
            doi=doi,
            source_url=source_url,
            original_filename=file.filename,
        )
    except UnsupportedFileTypeError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except DocumentExtractionError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(exc)
        ) from exc
    finally:
        tmp_path.unlink(missing_ok=True)

    record = add_document_to_project(
        project_id=project_id,
        document_id=document_record.document_id,
        user_id=user.id,
        scopes_repository=scopes_repository,
        vector_store=vector_store,
    )
    if record is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Project not found")
    return _project_document_response(record)


@router.get("/{project_id}/attachments", response_model=ProjectAttachmentListResponse)
def list_project_attachments(
    project_id: uuid.UUID, user: CurrentUserDep, scopes_repository: ScopesRepositoryDep
) -> ProjectAttachmentListResponse:
    records = scopes_repository.list_project_attachments(user.id, project_id)
    if records is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Project not found")
    attachments = [_project_attachment_response(r) for r in records]
    return ProjectAttachmentListResponse(attachments=attachments, total=len(attachments))


@router.delete(
    "/{project_id}/attachments/{message_attachment_id}", status_code=status.HTTP_204_NO_CONTENT
)
def remove_project_attachment(
    project_id: uuid.UUID,
    message_attachment_id: uuid.UUID,
    user: CurrentUserDep,
    scopes_repository: ScopesRepositoryDep,
    vector_store: VectorStoreDep,
) -> None:
    """Removes only the promotion association — never the attachment or
    its underlying document (which may still be reachable through another
    scope)."""
    removed = remove_attachment_from_project(
        project_id=project_id,
        message_attachment_id=message_attachment_id,
        user_id=user.id,
        scopes_repository=scopes_repository,
        vector_store=vector_store,
    )
    if not removed:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Association not found")


@router.get("/{project_id}/notes", response_model=ProjectNoteListResponse)
def list_project_notes(
    project_id: uuid.UUID, user: CurrentUserDep, scopes_repository: ScopesRepositoryDep
) -> ProjectNoteListResponse:
    records = scopes_repository.list_project_notes(user.id, project_id)
    if records is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Project not found")
    notes = [_project_note_response(r) for r in records]
    return ProjectNoteListResponse(notes=notes, total=len(notes))


@router.post(
    "/{project_id}/notes", response_model=ProjectNoteResponse, status_code=status.HTTP_201_CREATED
)
def add_project_note(
    project_id: uuid.UUID,
    request: CreateProjectNoteRequest,
    user: CurrentUserDep,
    scopes_repository: ScopesRepositoryDep,
) -> ProjectNoteResponse:
    record = scopes_repository.add_project_note(user.id, project_id, request.content)
    if record is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Project not found")
    return _project_note_response(record)


@router.delete("/{project_id}/notes/{note_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_project_note(
    project_id: uuid.UUID,
    note_id: uuid.UUID,
    user: CurrentUserDep,
    scopes_repository: ScopesRepositoryDep,
) -> None:
    removed = scopes_repository.remove_project_note(user.id, project_id, note_id)
    if not removed:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Note not found")


@router.get(
    "/{project_id}/conversation-summary", response_model=ProjectKnowledgeItemListResponse
)
def list_conversation_summaries(
    project_id: uuid.UUID,
    user: CurrentUserDep,
    project_knowledge_repository: ProjectKnowledgeRepositoryDep,
) -> ProjectKnowledgeItemListResponse:
    """Every Project Memory item for this project — draft and approved
    alike, so the UI's "Project Memory" section can show generated
    summaries awaiting review as well as ones already approved."""
    records = project_knowledge_repository.list_for_project(user.id, project_id)
    if records is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Project not found")
    items = [_knowledge_item_response(r) for r in records]
    return ProjectKnowledgeItemListResponse(items=items, total=len(items))


@router.post(
    "/{project_id}/conversation-summary",
    response_model=ProjectKnowledgeItemResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_conversation_summary(
    project_id: uuid.UUID,
    request: GenerateConversationSummaryRequest,
    user: CurrentUserDep,
    conversations_repository: ConversationsRepositoryDep,
    project_knowledge_repository: ProjectKnowledgeRepositoryDep,
    llm_provider: LLMProviderDep,
) -> ProjectKnowledgeItemResponse:
    """Generates a structured draft summary of an existing conversation
    (never the raw transcript itself — see
    app/core/conversation_summarization.py) and stores it as a
    project_knowledge_items row with status="draft". This is always just
    the start of the RULES workflow: the caller must still preview, edit
    (PATCH), and explicitly approve (PATCH status="approved") before it
    ever becomes Project knowledge that reaches a chat prompt — see
    app/core/project_context.py."""
    try:
        conversation_id = uuid.UUID(request.conversation_id)
    except ValueError as exc:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, detail="Invalid conversation_id"
        ) from exc

    messages = conversations_repository.get_messages(user.id, conversation_id)
    if messages is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Conversation not found")

    try:
        fields = generate_conversation_summary(llm_provider, messages)
    except SummaryGenerationError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(exc)) from exc

    record = project_knowledge_repository.create_draft(
        user_id=user.id,
        project_id=project_id,
        conversation_id=conversation_id,
        research_topic=fields.research_topic,
        research_question=fields.research_question,
        key_concepts=fields.key_concepts,
        methodology=fields.methodology,
        frameworks=fields.frameworks,
        analysis_techniques=fields.analysis_techniques,
        decisions=fields.decisions,
        open_questions=fields.open_questions,
        keywords=fields.keywords,
        referenced_documents=fields.referenced_documents,
    )
    if record is None:
        # Deliberately the same 404 whether the project doesn't exist,
        # isn't the caller's, the conversation doesn't exist, or belongs
        # to a different user — never reveals which.
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, detail="Project or conversation not found"
        )
    return _knowledge_item_response(record)


@router.patch(
    "/{project_id}/conversation-summary/{item_id}",
    response_model=ProjectKnowledgeItemResponse,
)
def update_conversation_summary(
    project_id: uuid.UUID,
    item_id: uuid.UUID,
    request: UpdateProjectKnowledgeItemRequest,
    user: CurrentUserDep,
    project_knowledge_repository: ProjectKnowledgeRepositoryDep,
    research_preference_repository: ResearchPreferenceRepositoryDep,
) -> ProjectKnowledgeItemResponse:
    """Edits any of the qualitative summary fields and/or approves it
    (status="approved") — only fields actually present in the request
    body are touched (see model_fields_set), matching PATCH
    /projects/{id}'s own partial-update convention. Only an approved item
    is ever surfaced to retrieval as Project Context.

    Approving is also the one moment intelligent research assistance ever
    "observes" anything (see app/core/research_preferences.py): a fixed
    research-methodology vocabulary is matched against this item's own
    fields — never raw chat — and any match is recorded as a pending
    suggestion (never auto-saved to the Project Profile)."""
    updates = request.model_dump(exclude_unset=True)
    was_already_approved = (
        existing.status == "approved"
        if (existing := project_knowledge_repository.get(user.id, project_id, item_id))
        else False
    )
    record = project_knowledge_repository.update(user.id, project_id, item_id, updates)
    if record is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Summary not found")

    if record.status == "approved" and not was_already_approved:
        for field, value in observe_approved_item(record):
            research_preference_repository.record_observation(user.id, project_id, field, value)

    return _knowledge_item_response(record)


@router.delete(
    "/{project_id}/conversation-summary/{item_id}", status_code=status.HTTP_204_NO_CONTENT
)
def delete_conversation_summary(
    project_id: uuid.UUID,
    item_id: uuid.UUID,
    user: CurrentUserDep,
    project_knowledge_repository: ProjectKnowledgeRepositoryDep,
) -> None:
    removed = project_knowledge_repository.delete(user.id, project_id, item_id)
    if not removed:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Summary not found")


@router.get("/{project_id}/profile", response_model=ProjectProfileResponse)
def get_project_profile(
    project_id: uuid.UUID,
    user: CurrentUserDep,
    project_profile_repository: ProjectProfileRepositoryDep,
) -> ProjectProfileResponse:
    record = project_profile_repository.get_or_create(user.id, project_id)
    if record is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Project not found")
    return _project_profile_response(record)


@router.patch("/{project_id}/profile", response_model=ProjectProfileResponse)
def update_project_profile(
    project_id: uuid.UUID,
    request: UpdateProjectProfileRequest,
    user: CurrentUserDep,
    project_profile_repository: ProjectProfileRepositoryDep,
) -> ProjectProfileResponse:
    """A user can edit any of the 8 Project Profile fields directly, any
    time — the same write path a confirmed research preference suggestion
    uses internally (see ProjectProfileRepository.apply_confirmed_value)."""
    updates = request.model_dump(exclude_unset=True)
    record = project_profile_repository.update(user.id, project_id, updates)
    if record is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Project not found")
    return _project_profile_response(record)


@router.get(
    "/{project_id}/research-preferences", response_model=ResearchPreferenceListResponse
)
def list_research_preferences(
    project_id: uuid.UUID,
    user: CurrentUserDep,
    research_preference_repository: ResearchPreferenceRepositoryDep,
) -> ResearchPreferenceListResponse:
    """Only ever surfaces a suggestion once it's been observed at least
    twice ("repeated actions", not a single mention) and is still
    "pending" — a confirmed/rejected/suppressed suggestion never reappears
    here (see ResearchPreferenceRepository.list_pending)."""
    records = research_preference_repository.list_pending(user.id, project_id)
    if records is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Project not found")
    suggestions = [_research_preference_response(r) for r in records]
    return ResearchPreferenceListResponse(suggestions=suggestions, total=len(suggestions))


@router.patch(
    "/{project_id}/research-preferences/{suggestion_id}",
    response_model=ResearchPreferenceSuggestionResponse,
)
def update_research_preference_status(
    project_id: uuid.UUID,
    suggestion_id: uuid.UUID,
    request: UpdateResearchPreferenceStatusRequest,
    user: CurrentUserDep,
    research_preference_repository: ResearchPreferenceRepositoryDep,
) -> ResearchPreferenceSuggestionResponse:
    """The three actions the UI offers for a suggestion: Confirm
    (status="confirmed" — writes through to the Project Profile, the only
    path that ever does), Reject (status="rejected" — dismissed this once,
    may resurface if the pattern repeats), Never suggest again
    (status="suppressed" — permanent)."""
    record = research_preference_repository.update_status(
        user.id, project_id, suggestion_id, request.status
    )
    if record is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Suggestion not found")
    return _research_preference_response(record)


@router.delete(
    "/{project_id}/research-preferences/{suggestion_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def delete_research_preference(
    project_id: uuid.UUID,
    suggestion_id: uuid.UUID,
    user: CurrentUserDep,
    research_preference_repository: ResearchPreferenceRepositoryDep,
) -> None:
    """Removes the suggestion row outright regardless of status — never
    touches the Project Profile even if it had been confirmed (removing a
    suggestion record is a different action from editing the profile
    itself, which has its own PATCH)."""
    removed = research_preference_repository.delete(user.id, project_id, suggestion_id)
    if not removed:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Suggestion not found")
