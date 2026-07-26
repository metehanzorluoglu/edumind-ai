import uuid

from fastapi import APIRouter, Depends, HTTPException, status

from app.core.attachment_promotion import (
    AttachmentNotPromotableError,
    PromotionResult,
    promote_attachment,
    switch_attachment_scope,
)
from app.core.security import CurrentUserDep, get_current_user
from app.deps import (
    AttachmentStorageDep,
    ConversationsRepositoryDep,
    DocumentsRepositoryDep,
    EmbeddingProviderDep,
    ProjectsRepositoryDep,
    ScopesRepositoryDep,
    VectorStoreDep,
)
from app.schemas.attachments import (
    PromoteAttachmentRequest,
    PromotedAttachmentResponse,
    SaveAttachmentToProjectRequest,
    SwitchAttachmentScopeRequest,
)
from app.schemas.conversations import MessageAttachmentResponse

router = APIRouter(
    prefix="/attachments", tags=["attachments"], dependencies=[Depends(get_current_user)]
)


def _promoted_attachment_response(result: PromotionResult) -> PromotedAttachmentResponse:
    return PromotedAttachmentResponse(
        attachment_id=str(result.attachment_id),
        document_id=result.document_id,
        scope=result.scope,
        project_id=result.project_id,
        source_filename=result.source_filename,
        document_type=result.document_type,  # type: ignore[arg-type]
        reused=result.reused,
    )


@router.post(
    "/{attachment_id}/promote",
    response_model=PromotedAttachmentResponse,
    status_code=status.HTTP_201_CREATED,
)
def post_promote_attachment(
    attachment_id: uuid.UUID,
    request: PromoteAttachmentRequest,
    user: CurrentUserDep,
    conversations_repository: ConversationsRepositoryDep,
    documents_repository: DocumentsRepositoryDep,
    scopes_repository: ScopesRepositoryDep,
    vector_store: VectorStoreDep,
    embedding_provider: EmbeddingProviderDep,
    attachment_storage: AttachmentStorageDep,
) -> PromotedAttachmentResponse:
    """Ingests a chat attachment (PDF only) into a real searchable Document
    and places it in the requested scope — idempotent for the same
    attachment (a second call reuses the already-ingested document and
    just re-applies scope placement, identical to PATCH .../scope)."""
    try:
        result = promote_attachment(
            attachment_id=attachment_id,
            user_id=user.id,
            scope=request.scope,
            project_id=uuid.UUID(request.project_id) if request.project_id else None,
            document_type=request.document_type,
            journal_quartile=request.journal_quartile,
            title=request.title,
            authors=request.authors,
            publication_year=request.publication_year,
            source_venue=request.source_venue,
            doi=request.doi,
            source_url=request.source_url,
            conversations_repository=conversations_repository,
            documents_repository=documents_repository,
            scopes_repository=scopes_repository,
            vector_store=vector_store,
            embedding_provider=embedding_provider,
            attachment_storage=attachment_storage,
        )
    except AttachmentNotPromotableError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(exc)) from exc
    if result is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Attachment not found")
    return _promoted_attachment_response(result)


@router.patch("/{attachment_id}/scope", response_model=PromotedAttachmentResponse)
def patch_attachment_scope(
    attachment_id: uuid.UUID,
    request: SwitchAttachmentScopeRequest,
    user: CurrentUserDep,
    conversations_repository: ConversationsRepositoryDep,
    documents_repository: DocumentsRepositoryDep,
    scopes_repository: ScopesRepositoryDep,
    vector_store: VectorStoreDep,
) -> PromotedAttachmentResponse:
    """Moves an already-promoted attachment's document to a new scope —
    404 if the attachment doesn't exist, isn't the caller's, or has never
    been promoted (nothing to switch)."""
    try:
        result = switch_attachment_scope(
            attachment_id=attachment_id,
            user_id=user.id,
            scope=request.scope,
            project_id=uuid.UUID(request.project_id) if request.project_id else None,
            conversations_repository=conversations_repository,
            documents_repository=documents_repository,
            scopes_repository=scopes_repository,
            vector_store=vector_store,
        )
    except ValueError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(exc)) from exc
    if result is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, detail="Attachment not found or not yet promoted"
        )
    return _promoted_attachment_response(result)


@router.patch("/{attachment_id}/project", response_model=MessageAttachmentResponse)
def patch_attachment_saved_project(
    attachment_id: uuid.UUID,
    request: SaveAttachmentToProjectRequest,
    user: CurrentUserDep,
    conversations_repository: ConversationsRepositoryDep,
    projects_repository: ProjectsRepositoryDep,
) -> MessageAttachmentResponse:
    """Saves (or, with `project_id: null`, un-saves) an attachment — in
    practice always a generated image (see image_generation_service.py) —
    to one of the caller's Projects, as a simple gallery bookmark. Never
    ingests anything or affects RAG scope/retrieval — see
    MessageAttachment.saved_project_id's docs for why this is deliberately
    a different mechanism from POST /attachments/{id}/promote."""
    project_id: uuid.UUID | None = None
    if request.project_id:
        try:
            project_id = uuid.UUID(request.project_id)
        except ValueError as exc:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT, detail="project_id is not a valid id"
            ) from exc
        if projects_repository.get(user.id, project_id) is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Project not found")

    record = conversations_repository.set_attachment_saved_project(
        user.id, attachment_id, project_id
    )
    if record is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Attachment not found")
    return MessageAttachmentResponse(
        id=str(record.id),
        mime=record.mime,
        filename=record.original_filename,
        size_bytes=record.size_bytes,
        page_count=record.page_count,
        page_range_start=record.page_range_start,
        page_range_end=record.page_range_end,
        created_at=record.created_at,
        source=record.source,  # type: ignore[arg-type]
        generation_prompt=record.generation_prompt,
        generation_negative_prompt=record.generation_negative_prompt,
        generation_seed=record.generation_seed,
        generation_model=record.generation_model,
        generation_width=record.generation_width,
        generation_height=record.generation_height,
        saved_project_id=str(record.saved_project_id) if record.saved_project_id else None,
    )
