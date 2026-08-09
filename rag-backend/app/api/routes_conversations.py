import json
import time
import uuid
from collections.abc import AsyncIterator, Callable, Iterator
from dataclasses import dataclass, field
from pathlib import Path

import pymupdf
from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import StreamingResponse
from pydantic import ValidationError
from sqlalchemy.orm import Session
from starlette.datastructures import UploadFile

from app.config import Settings
from app.core.answer_transparency import build_transparency_snapshot, transparency_to_dict
from app.core.citation import Citation
from app.core.citation_validation import validate_citations
from app.core.conversation_title import generate_title, sanitize_title
from app.core.document_scoping import (
    InvalidDocumentIdsError,
    add_conversation_documents,
    remove_document_from_conversation,
    replace_conversation_documents,
)
from app.core.errors import AttachmentValidationError, LLMProviderError, VisionServiceError
from app.core.evidence_client import EvidenceClient
from app.core.evidence_shadow import maybe_schedule_evidence_shadow
from app.core import generation_manager
from app.core.generation_events import GenerationUpdate, GenProgress
from app.core.intent_detection import is_instructional_design_request
from app.core.llm_provider import LLMProvider
from app.core.model_routing import ModelRoute, choose_model
from app.core.project_context import format_project_context
from app.core.prompt_builder import NO_EVIDENCE_ANSWER, ZOOM_IN_NO_EVIDENCE_ANSWER
from app.core.rag_service import CorpusEvidence, RagService, RetrieverLike, retrieve_and_cite
from app.core.rate_limiter import RateLimiter
from app.core.request_timing import RequestTimer, bind_timer, unbind_timer
from app.core.retrieval_schemas import RetrievalFilters, RetrievedChunk
from app.core.security import CurrentUserDep, get_current_user
from app.core.vision_prompt_builder import build_vision_prompt
from app.db.conversation_scope_repository import (
    ConversationScopeRecord,
    ConversationScopeRepository,
)
from app.db.conversations_repository import (
    ConversationsRepository,
    ConversationSummary,
    MessageRecord,
    NewAttachment,
)
from app.db.models_auth import User
from app.db.models_conversations import Message
from app.db.project_knowledge_repository import ProjectKnowledgeRecord, ProjectKnowledgeRepository
from app.db.project_profile_repository import ProjectProfileRecord, ProjectProfileRepository
from app.db.projects_repository import ProjectsRepository
from app.db.scopes_repository import ConversationDocumentRecord, ScopesRepository
from app.deps import (
    AttachmentStorageDep,
    ChatRateLimiterDep,
    ConversationScopeRepositoryDep,
    ConversationsRepositoryDep,
    DocumentsRepositoryDep,
    EvidenceClientDep,
    LLMProviderDep,
    ProjectKnowledgeRepositoryDep,
    ProjectProfileRepositoryDep,
    ProjectsRepositoryDep,
    RagServiceDep,
    RequestTimerDep,
    RetrieverDep,
    ScopesRepositoryDep,
    SessionFactoryDep,
    SettingsDep,
    VectorStoreDep,
    VisionServiceDep,
)
from app.schemas.chat import (
    ChatDoneEvent,
    ChatErrorEvent,
    ChatEvent,
    ChatProgressEvent,
    ChatSourcesEvent,
    ChatTokenEvent,
    TransparencyResponse,
)
from app.schemas.conversations import (
    AddConversationDocumentsRequest,
    ConversationDetailResponse,
    ConversationDocumentListResponse,
    ConversationDocumentResponse,
    ConversationListResponse,
    ConversationScopeResponse,
    ConversationSummaryResponse,
    MessageAttachmentResponse,
    MessageResponse,
    MessageSourceResponse,
    PostConversationMessageRequest,
    RenameConversationRequest,
    ReplaceConversationDocumentsRequest,
    UpdateConversationScopeRequest,
)
from app.services.attachment_storage import (
    AttachmentStorage,
    ValidatedAttachment,
    validate_attachment,
)
from app.services.pdf_batch_planner import BatchPlan, plan_pdf_batches
from app.services.vision_batch_orchestrator import stream_batched_pdf_analysis
from app.services.vision_service import (
    AttachmentForVision,
    VisionService,
    render_attachments_to_images,
    render_pdf_pages,
)

router = APIRouter(
    prefix="/conversations", tags=["conversations"], dependencies=[Depends(get_current_user)]
)

_MAX_LIMIT = 100


def _summary_response(summary: ConversationSummary) -> ConversationSummaryResponse:
    return ConversationSummaryResponse(
        id=str(summary.id),
        title=summary.title,
        created_at=summary.created_at,
        updated_at=summary.updated_at,
        message_count=summary.message_count,
        last_message_preview=summary.last_message_preview,
    )


def _transparency_response(data: dict[str, object]) -> TransparencyResponse | None:
    """None for a user message or any assistant message sent before this
    column existed (both persist `transparency={}`) — there is genuinely
    nothing to show, so the frontend's transparency accordion doesn't
    render at all rather than showing an empty one."""
    if not data:
        return None
    return TransparencyResponse.model_validate(data)


def _message_response(message: MessageRecord) -> MessageResponse:
    return MessageResponse(
        id=str(message.id),
        role=message.role,  # type: ignore[arg-type]
        content=message.content,
        citations=message.citations,  # type: ignore[arg-type]
        citation_warnings=message.citation_warnings,
        insufficient_evidence=message.insufficient_evidence,
        created_at=message.created_at,
        sources=[
            MessageSourceResponse(
                rank=s.rank,
                document_id=s.document_id,
                chunk_id=s.chunk_id,
                chunk_index=s.chunk_index,
                page_number=s.page_number,
                score=s.score,
                snippet_text=s.snippet_text,
                title=s.title,
                authors=s.authors,
                publication_year=s.publication_year,
                source_venue=s.source_venue,
                document_type=s.document_type,  # type: ignore[arg-type]
                journal_quartile=s.journal_quartile,  # type: ignore[arg-type]
                doi=s.doi,
                source_url=s.source_url,
                source_filename=s.source_filename,
                scope=s.scope,  # type: ignore[arg-type]
            )
            for s in message.sources
        ],
        attachments=[
            MessageAttachmentResponse(
                id=str(a.id),
                mime=a.mime,
                filename=a.original_filename,
                size_bytes=a.size_bytes,
                page_count=a.page_count,
                page_range_start=a.page_range_start,
                page_range_end=a.page_range_end,
                created_at=a.created_at,
                source=a.source,  # type: ignore[arg-type]
                generation_prompt=a.generation_prompt,
                generation_negative_prompt=a.generation_negative_prompt,
                generation_seed=a.generation_seed,
                generation_model=a.generation_model,
                generation_width=a.generation_width,
                generation_height=a.generation_height,
                saved_project_id=str(a.saved_project_id) if a.saved_project_id else None,
            )
            for a in message.attachments
        ],
        transparency=_transparency_response(message.transparency),
        status=message.status,  # type: ignore[arg-type]
        error_message=message.error_message,
    )


def _sse(event: ChatEvent) -> str:
    return f"data: {event.model_dump_json()}\n\n"


def _timed_token_stream(tokens: Iterator[str], timer: RequestTimer) -> Iterator[str]:
    """Wraps an LLM token iterator to split its wall-clock cost into two
    stages: time spent inside `next()` (blocked waiting on Ollama) is
    "llm_generation"; the time between handing a token back and being
    asked for the next one — spent in the caller's own per-token work
    (formatting + `yield`ing the SSE chunk, plus Starlette actually
    writing those bytes to the connection) — is "streaming". Measuring
    from here, wrapped *around* the caller's yield, is what makes that
    second interval visible at all: the caller's own code never calls
    back into this stage explicitly. Only ever constructed when
    timer.enabled (see event_stream() below), so this per-token
    bookkeeping never runs when PERFORMANCE_PROFILING is off."""
    iterator = iter(tokens)
    while True:
        t0 = time.perf_counter()
        try:
            token = next(iterator)
        except StopIteration:
            return
        timer.record("llm_generation", (time.perf_counter() - t0) * 1000)
        t_yield_start = time.perf_counter()
        yield token
        timer.record("streaming", (time.perf_counter() - t_yield_start) * 1000)


async def _timed_async_token_stream(
    tokens: AsyncIterator[str], timer: RequestTimer
) -> AsyncIterator[str]:
    """The vision-path counterpart to _timed_token_stream above — same
    "time inside next() vs. time in the caller's own yield handling"
    split, under the "vision_generation"/"streaming" stage names, for
    VisionService.stream_chat's async generator (see that module's
    docstring for why vision uses an async client/generator while text
    does not)."""
    aiterator = tokens.__aiter__()
    while True:
        t0 = time.perf_counter()
        try:
            token = await aiterator.__anext__()
        except StopAsyncIteration:
            return
        timer.record("vision_generation", (time.perf_counter() - t0) * 1000)
        t_yield_start = time.perf_counter()
        yield token
        timer.record("streaming", (time.perf_counter() - t_yield_start) * 1000)


def _image_dimension_summary(images: list[bytes]) -> tuple[int, int]:
    """Returns (largest single side in pixels, summed pixel count) across
    `images` — the numeric summary recorded onto the profiling timer for
    original_image_dimensions/processed_image_dimensions (see
    _handle_conversation_message below; RequestTimer's metrics are a flat
    name->float namespace, so a per-image WxH pair isn't directly
    representable there — see that call site's comment). Returns (0, 0)
    for an empty list rather than raising, since "no images" is a normal
    state (e.g. every attachment was a PDF, so there are no *original*
    image dimensions to summarize)."""
    max_dimension = 0
    total_pixels = 0
    for image in images:
        try:
            pixmap = pymupdf.Pixmap(image)  # type: ignore[no-untyped-call]
        except Exception:
            continue
        max_dimension = max(max_dimension, pixmap.width, pixmap.height)
        total_pixels += pixmap.width * pixmap.height
    return max_dimension, total_pixels


@router.post("", response_model=ConversationDetailResponse, status_code=status.HTTP_201_CREATED)
def create_conversation(
    user: CurrentUserDep, repository: ConversationsRepositoryDep
) -> ConversationDetailResponse:
    conversation = repository.create(user_id=user.id)
    return ConversationDetailResponse(
        id=str(conversation.id),
        title=conversation.title,
        title_is_custom=conversation.title_is_custom,
        created_at=conversation.created_at,
        updated_at=conversation.updated_at,
        messages=[],
    )


@router.get("", response_model=ConversationListResponse)
def list_conversations(
    user: CurrentUserDep,
    repository: ConversationsRepositoryDep,
    limit: int = Query(default=20, ge=1, le=_MAX_LIMIT),
    offset: int = Query(default=0, ge=0),
) -> ConversationListResponse:
    summaries, total = repository.list_for_user(user.id, limit=limit, offset=offset)
    return ConversationListResponse(
        conversations=[_summary_response(s) for s in summaries], total=total
    )


@router.get("/{conversation_id}", response_model=ConversationDetailResponse)
def get_conversation(
    conversation_id: uuid.UUID, user: CurrentUserDep, repository: ConversationsRepositoryDep
) -> ConversationDetailResponse:
    conversation = repository.get(user.id, conversation_id)
    if conversation is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Conversation not found")
    messages = repository.get_messages(user.id, conversation_id) or []
    return ConversationDetailResponse(
        id=str(conversation.id),
        title=conversation.title,
        title_is_custom=conversation.title_is_custom,
        created_at=conversation.created_at,
        updated_at=conversation.updated_at,
        messages=[_message_response(m) for m in messages],
    )


@router.patch("/{conversation_id}", response_model=ConversationSummaryResponse)
def rename_conversation(
    conversation_id: uuid.UUID,
    request: RenameConversationRequest,
    user: CurrentUserDep,
    repository: ConversationsRepositoryDep,
) -> ConversationSummaryResponse:
    title = sanitize_title(request.title)
    if not title:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, detail="Title cannot be empty")
    conversation = repository.rename(user.id, conversation_id, title)
    if conversation is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Conversation not found")
    messages = repository.get_messages(user.id, conversation_id) or []
    last = messages[-1] if messages else None
    return ConversationSummaryResponse(
        id=str(conversation.id),
        title=conversation.title,
        created_at=conversation.created_at,
        updated_at=conversation.updated_at,
        message_count=len(messages),
        last_message_preview=last.content[:120] if last else None,
    )


@router.delete("/{conversation_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_conversation(
    conversation_id: uuid.UUID, user: CurrentUserDep, repository: ConversationsRepositoryDep
) -> None:
    deleted = repository.delete(user.id, conversation_id)
    if not deleted:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Conversation not found")


def _scope_response(record: ConversationScopeRecord) -> ConversationScopeResponse:
    return ConversationScopeResponse(
        chat_enabled=record.chat_enabled,
        project_enabled=record.project_enabled,
        general_enabled=record.general_enabled,
        include_other_project_summaries=record.include_other_project_summaries,
        zoom_in_mode=record.zoom_in_mode,
    )


def _effective_scope_flags(scope_settings: ConversationScopeRecord) -> tuple[bool, bool, bool]:
    """Milestone 4 (Zoom-In / strict selected-source mode): the single
    place that turns a conversation's persisted scope settings into the
    `include_chat`/`include_project`/`include_general` flags actually
    passed to retrieval (see resolve_scope_plan in
    app/core/scoped_retrieval.py — the exact, pre-existing per-tier
    inclusion mechanism this reuses; no new retrieval code path exists for
    Zoom-In). When `zoom_in_mode` is set, it overrides the three
    individual tier toggles entirely: chat is force-included (Zoom-In IS
    the chat tier) and project/general are force-excluded (no fallback,
    ever — not "reduced," not "deprioritized," not queried at all),
    regardless of what the toggle bar itself says. When `zoom_in_mode` is
    False (the default for every conversation before this milestone and
    every conversation that has never turned it on), this returns exactly
    (chat_enabled, project_enabled, general_enabled) unchanged — byte-for-
    byte today's pre-Milestone-4 behavior."""
    if scope_settings.zoom_in_mode:
        return True, False, False
    return (
        scope_settings.chat_enabled,
        scope_settings.project_enabled,
        scope_settings.general_enabled,
    )


def _require_zoom_in_enabled(settings: Settings) -> None:
    """Milestone 4: gates only the ability to ever SET
    conversation_scope_settings.zoom_in_mode=True (see
    update_conversation_scope below) — mirrors
    _require_conversation_scope_enabled's "backend enforces, frontend only
    hides" split. GET .../scope always reports the true persisted value
    regardless of this flag; a conversation already in Zoom-In when this
    flag is turned off keeps retrieving strictly rather than being
    silently widened."""
    if not settings.zoom_in_enabled:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Zoom-In is disabled")


@router.get("/{conversation_id}/scope", response_model=ConversationScopeResponse)
def get_conversation_scope(
    conversation_id: uuid.UUID,
    user: CurrentUserDep,
    conversation_scope_repository: ConversationScopeRepositoryDep,
) -> ConversationScopeResponse:
    """The research workspace's "active scope" toggle bar — lazily
    created (every tier on except pooling other projects' summaries) on
    first read, so a conversation that never opens its scope settings
    still has a well-defined one."""
    record = conversation_scope_repository.get_or_create(user.id, conversation_id)
    if record is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Conversation not found")
    return _scope_response(record)


@router.patch("/{conversation_id}/scope", response_model=ConversationScopeResponse)
def update_conversation_scope(
    conversation_id: uuid.UUID,
    request: UpdateConversationScopeRequest,
    user: CurrentUserDep,
    settings: SettingsDep,
    conversation_scope_repository: ConversationScopeRepositoryDep,
    scopes_repository: ScopesRepositoryDep,
) -> ConversationScopeResponse:
    """Toggling here takes effect starting with this conversation's *next*
    message — a past message's own `transparency.retrieval_scope` always
    keeps showing what was active when it was actually generated.

    Milestone 4 (Zoom-In): a request that sets `zoom_in_mode=True` is
    additionally checked against two conditions before being applied —
    `zoom_in_enabled` (see _require_zoom_in_enabled) and "this conversation
    currently has at least one selected chat-scope document" (see
    UpdateConversationScopeRequest's docstring) — either check failing
    leaves the stored settings completely untouched (checked before the
    repository call, not after). Turning `zoom_in_mode` back OFF, or a
    request that doesn't mention it at all, is never subject to either
    check."""
    updates = request.model_dump(exclude_unset=True)
    if updates.get("zoom_in_mode") is True:
        # Existence/ownership must be established BEFORE the ≥1-source
        # check below: count_conversation_documents returns 0 (not an
        # error) for a nonexistent/foreign conversation_id (see its own
        # docstring), which would otherwise surface as a misleading 422
        # ("add a source") instead of the correct 404 for a conversation
        # that was never this user's to begin with.
        if conversation_scope_repository.get_or_create(user.id, conversation_id) is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Conversation not found")
        _require_zoom_in_enabled(settings)
        selected_document_count = scopes_repository.count_conversation_documents(
            user.id, conversation_id
        )
        if selected_document_count == 0:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail=(
                    "Zoom-In requires at least one selected source. Add a source before "
                    "turning Zoom-In on."
                ),
            )
    record = conversation_scope_repository.update(user.id, conversation_id, updates)
    if record is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Conversation not found")
    return _scope_response(record)


def _conversation_document_response(
    record: ConversationDocumentRecord,
) -> ConversationDocumentResponse:
    return ConversationDocumentResponse(
        document_id=record.document_id,
        source_filename=record.source_filename,
        document_type=record.document_type,  # type: ignore[arg-type]
        added_at=record.added_at,
    )


def _conversation_document_list_response(
    records: list[ConversationDocumentRecord],
) -> ConversationDocumentListResponse:
    documents = [_conversation_document_response(r) for r in records]
    return ConversationDocumentListResponse(documents=documents, total=len(documents))


def _require_conversation_scope_enabled(settings: Settings) -> None:
    """Milestone 2 (conversation document scope): gates only the bulk
    selection-management surface added/changed THIS milestone (list, bulk
    add, replace) — see app/config.py's `conversation_scope_enabled`
    docstring for why DELETE (pre-existing, unconditional before this
    milestone) and the scope toggle-bar endpoints are deliberately NOT
    gated here."""
    if not settings.conversation_scope_enabled:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Conversation scope is disabled")


@router.get("/{conversation_id}/documents", response_model=ConversationDocumentListResponse)
def list_conversation_documents(
    conversation_id: uuid.UUID,
    user: CurrentUserDep,
    settings: SettingsDep,
    scopes_repository: ScopesRepositoryDep,
) -> ConversationDocumentListResponse:
    """Milestone 2: the conversation's current chat-scope document
    selection — what retrieval's "chat" tier actually draws from for this
    conversation's next turn (see app/core/scoped_retrieval.py)."""
    _require_conversation_scope_enabled(settings)
    records = scopes_repository.list_conversation_documents(user.id, conversation_id)
    if records is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Conversation not found")
    return _conversation_document_list_response(records)


@router.post(
    "/{conversation_id}/documents",
    response_model=ConversationDocumentListResponse,
    status_code=status.HTTP_201_CREATED,
)
def add_conversation_documents_route(
    conversation_id: uuid.UUID,
    request: AddConversationDocumentsRequest,
    user: CurrentUserDep,
    settings: SettingsDep,
    scopes_repository: ScopesRepositoryDep,
    documents_repository: DocumentsRepositoryDep,
    vector_store: VectorStoreDep,
) -> ConversationDocumentListResponse:
    """Milestone 2: associates one or more already-ingested documents (see
    POST /documents) with this conversation as chat-scope retrieval
    evidence in a single call — never duplicates vectors, only adds
    pointers plus a Qdrant payload resync per document (see
    app/core/document_scoping.py). Idempotent per id and de-duplicated
    within the request; returns the conversation's full current selection
    (not just the newly-added ids)."""
    _require_conversation_scope_enabled(settings)
    try:
        records = add_conversation_documents(
            conversation_id=conversation_id,
            document_ids=request.document_ids,
            user_id=user.id,
            scopes_repository=scopes_repository,
            documents_repository=documents_repository,
            vector_store=vector_store,
        )
    except InvalidDocumentIdsError as exc:
        # Deliberately the same 404 shape as "conversation not found" below
        # — never confirms/denies which specific id exists or belongs to
        # another user (see InvalidDocumentIdsError's docstring).
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            detail=f"One or more documents not found: {exc.invalid_ids}",
        ) from exc
    if records is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Conversation not found")
    return _conversation_document_list_response(records)


@router.put("/{conversation_id}/documents", response_model=ConversationDocumentListResponse)
def replace_conversation_documents_route(
    conversation_id: uuid.UUID,
    request: ReplaceConversationDocumentsRequest,
    user: CurrentUserDep,
    settings: SettingsDep,
    scopes_repository: ScopesRepositoryDep,
    documents_repository: DocumentsRepositoryDep,
    vector_store: VectorStoreDep,
) -> ConversationDocumentListResponse:
    """Milestone 2: makes `document_ids` this conversation's ENTIRE
    chat-scope selection — documents not listed are removed, documents
    listed but not yet associated are added, documents in both are left
    untouched (see replace_conversation_documents). `document_ids: []`
    clears the selection; there is no separate clear endpoint."""
    _require_conversation_scope_enabled(settings)
    try:
        records = replace_conversation_documents(
            conversation_id=conversation_id,
            document_ids=request.document_ids,
            user_id=user.id,
            scopes_repository=scopes_repository,
            documents_repository=documents_repository,
            vector_store=vector_store,
        )
    except InvalidDocumentIdsError as exc:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            detail=f"One or more documents not found: {exc.invalid_ids}",
        ) from exc
    if records is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Conversation not found")
    return _conversation_document_list_response(records)


@router.delete(
    "/{conversation_id}/documents/{document_id}", status_code=status.HTTP_204_NO_CONTENT
)
def remove_conversation_document(
    conversation_id: uuid.UUID,
    document_id: str,
    user: CurrentUserDep,
    scopes_repository: ScopesRepositoryDep,
    vector_store: VectorStoreDep,
) -> None:
    """Removes only the association — never the document itself (it may
    still be part of the caller's general corpus or another
    conversation's/project's scope). Pre-existing, unconditional (not
    gated by conversation_scope_enabled — see
    _require_conversation_scope_enabled's docstring)."""
    removed = remove_document_from_conversation(
        conversation_id=conversation_id,
        document_id=document_id,
        user_id=user.id,
        scopes_repository=scopes_repository,
        vector_store=vector_store,
    )
    if not removed:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Association not found")


@dataclass
class ParsedAttachmentUpload:
    filename: str
    content: bytes
    page_range_start: int | None
    page_range_end: int | None


@dataclass
class ParsedMessageRequest:
    query: str
    top_k: int
    filters: RetrievalFilters | None
    client_message_id: str | None
    # The "Also use my research corpus" toggle (milestone V3) — see
    # PostConversationMessageRequest.use_corpus.
    use_corpus: bool = False
    attachments: list[ParsedAttachmentUpload] = field(default_factory=list)


@dataclass
class BatchedPdfRequest:
    """Bundles what _stream_vision_reply needs to run the batched-PDF
    pipeline (see app/services/vision_batch_orchestrator.py) instead of
    the older single-call render_attachments_to_images path — only ever
    constructed by _handle_conversation_message when a lone PDF
    attachment's page count doesn't fit in one batch (see
    BatchPlan.needs_batching). `pdf_data` is the validated PDF's raw
    bytes — rendering happens one batch at a time inside the
    orchestrator, never eagerly here, which is what keeps this pipeline's
    memory use roughly constant regardless of document length."""

    pdf_data: bytes
    plan: BatchPlan


def _coerce_optional_int(value: object) -> int | None:
    if value is None:
        return None
    try:
        return int(value)  # type: ignore[call-overload,no-any-return]
    except (TypeError, ValueError) as exc:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, detail="page range values must be integers"
        ) from exc


def _load_json_form_field(raw: object, *, field_name: str) -> object:
    if not isinstance(raw, str) or not raw.strip():
        return None
    try:
        return json.loads(raw)
    except ValueError as exc:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, detail=f"{field_name} is not valid JSON"
        ) from exc


async def _parse_json_message_request(request: Request) -> ParsedMessageRequest:
    try:
        body = await request.json()
    except ValueError as exc:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, detail="Request body is not valid JSON"
        ) from exc
    try:
        parsed = PostConversationMessageRequest.model_validate(body)
    except ValidationError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, detail=exc.errors()) from exc
    return ParsedMessageRequest(
        query=parsed.query,
        top_k=parsed.top_k,
        filters=parsed.filters,
        client_message_id=parsed.client_message_id,
        use_corpus=parsed.use_corpus,
    )


async def _parse_multipart_message_request(request: Request) -> ParsedMessageRequest:
    form = await request.form()

    filters_payload = _load_json_form_field(form.get("filters"), field_name="filters")
    try:
        parsed = PostConversationMessageRequest.model_validate(
            {
                "query": form.get("query", ""),
                "top_k": form.get("top_k") or 8,
                "filters": filters_payload,
                "client_message_id": form.get("client_message_id") or None,
                "use_corpus": form.get("use_corpus") or False,
            }
        )
    except ValidationError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, detail=exc.errors()) from exc

    page_ranges = _load_json_form_field(form.get("page_ranges"), field_name="page_ranges") or []
    if not isinstance(page_ranges, list):
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, detail="page_ranges must be a JSON array"
        )

    uploads: list[ParsedAttachmentUpload] = []
    for index, value in enumerate(form.getlist("files")):
        if not isinstance(value, UploadFile):
            continue
        content = await value.read()
        range_entry = page_ranges[index] if index < len(page_ranges) else None
        range_start = None
        range_end = None
        if isinstance(range_entry, dict):
            range_start = _coerce_optional_int(range_entry.get("start"))
            range_end = _coerce_optional_int(range_entry.get("end"))
        uploads.append(
            ParsedAttachmentUpload(
                filename=Path(value.filename).name if value.filename else "attachment",
                content=content,
                page_range_start=range_start,
                page_range_end=range_end,
            )
        )

    return ParsedMessageRequest(
        query=parsed.query,
        top_k=parsed.top_k,
        filters=parsed.filters,
        client_message_id=parsed.client_message_id,
        use_corpus=parsed.use_corpus,
        attachments=uploads,
    )


async def _parse_message_request(request: Request) -> ParsedMessageRequest:
    content_type = request.headers.get("content-type", "")
    if content_type.startswith("multipart/form-data"):
        return await _parse_multipart_message_request(request)
    return await _parse_json_message_request(request)


def _store_new_attachments(
    parsed: ParsedMessageRequest,
    validated: list[ValidatedAttachment],
    *,
    message_id: uuid.UUID,
    user_id: uuid.UUID,
    attachment_storage: AttachmentStorage,
    repository: ConversationsRepository,
) -> None:
    """Writes every attachment's file to disk, then records all of them in
    one repository call. If a later file in the loop fails to write
    (milestone V4 — e.g. a full disk), every file already written during
    *this* call is deleted before the exception propagates — otherwise
    those earlier files would be orphaned on disk forever: no DB row is
    ever created for them (repository.add_attachments only runs after
    the whole loop succeeds), so nothing would ever reference them again
    to clean them up later."""
    new_attachments = []
    written_storage_keys: list[str] = []
    try:
        for upload, result in zip(parsed.attachments, validated, strict=True):
            attachment_id = uuid.uuid4()
            storage_key = attachment_storage.save(
                user_id=user_id, attachment_id=attachment_id, mime=result.mime, data=result.data
            )
            written_storage_keys.append(storage_key)
            new_attachments.append(
                NewAttachment(
                    id=attachment_id,
                    mime=result.mime,
                    original_filename=upload.filename,
                    size_bytes=len(result.data),
                    page_count=result.page_count,
                    page_range_start=upload.page_range_start,
                    page_range_end=upload.page_range_end,
                    storage_key=storage_key,
                )
            )
        repository.add_attachments(message_id, user_id, new_attachments)
    except Exception:
        for storage_key in written_storage_keys:
            attachment_storage.delete(storage_key)
        raise


def _message_source_to_chunk(source: object) -> RetrievedChunk:
    """MessageSourceRecord -> RetrievedChunk — the two shapes are
    deliberately field-for-field mirrors (see MessageSource's own
    docstring in app/db/models_conversations.py); used only when replaying
    a previously-persisted answer's sources back out as a ChatSourcesEvent
    (see _replay_finished_reply below), which only ever has the DB record
    shape on hand, never the original RetrievedChunk."""
    return RetrievedChunk(
        score=source.score,
        text=source.snippet_text,
        document_id=source.document_id or "",
        chunk_id=source.chunk_id,
        document_type=source.document_type,  # type: ignore[arg-type]
        journal_quartile=source.journal_quartile,  # type: ignore[arg-type]
        title=source.title,
        authors=source.authors,
        publication_year=source.publication_year,
        source_venue=source.source_venue,
        doi=source.doi,
        source_url=source.source_url,
        source_filename=source.source_filename,
        chunk_index=source.chunk_index,
        page_number=source.page_number,
        scope=source.scope,  # type: ignore[arg-type]
    )


def _final_reply_events(
    repository: ConversationsRepository, assistant_message_id: uuid.UUID, timer: RequestTimer
) -> Iterator[str]:
    """Reads the authoritative, already-persisted final row for
    `assistant_message_id` and yields the sources/done (or error) SSE
    event(s) for it — the common tail shared by a live generation that
    just finished, a reconnect that caught up to one already finished, and
    a full replay of one that finished before this request even began
    (see _replay_finished_reply)."""
    final = repository.get_message(assistant_message_id)
    if final is None:
        yield _sse(ChatErrorEvent(message="This message could not be found."))
        return
    if final.status == "error":
        yield _sse(ChatErrorEvent(message=final.error_message or "Generation failed."))
        return
    if final.status == "cancelled":
        yield _sse(ChatErrorEvent(message="Message generation was cancelled."))
        return
    if final.status == "interrupted":
        yield _sse(
            ChatErrorEvent(
                message=(
                    "Generation was interrupted by a server restart before it finished. "
                    "Press Retry to try again."
                )
            )
        )
        return
    sources = [_message_source_to_chunk(s) for s in final.sources]
    yield _sse(ChatSourcesEvent(sources=sources))
    yield _sse(
        ChatDoneEvent(
            citations=[Citation.model_validate(c) for c in final.citations],
            citation_warnings=final.citation_warnings,
            insufficient_evidence=final.insufficient_evidence,
            transparency=(
                TransparencyResponse.model_validate(final.transparency)
                if final.transparency
                else None
            ),
            debug_timings=timer.as_dict() or None,
        )
    )


def _replay_finished_reply(
    repository: ConversationsRepository, assistant_message_id: uuid.UUID, timer: RequestTimer
) -> StreamingResponse:
    """A retry (or any resend of the same client_message_id) that finds an
    already-'complete' assistant reply for its user message — this is what
    keeps Retry from ever generating (or persisting) a duplicate answer
    once BUG-1's recovery has done its job. Replays the full stored answer
    as one token chunk (it already exists in full; there is nothing to
    stream token-by-token) followed by the normal sources/done events, so
    the frontend's existing event handling needs no special case at all."""

    def event_stream() -> Iterator[str]:
        yield _sse(ChatProgressEvent(stage="connected"))
        final = repository.get_message(assistant_message_id)
        if final is not None and final.content:
            yield _sse(ChatTokenEvent(content=final.content))
        yield from _final_reply_events(repository, assistant_message_id, timer)

    return StreamingResponse(event_stream(), media_type="text/event-stream")


def _stream_text_reply(
    conversation_id: uuid.UUID,
    parsed: ParsedMessageRequest,
    user: User,
    repository: ConversationsRepository,
    rag_service: RagService,
    project_ids: list[uuid.UUID],
    project_context: str | None,
    scope_settings: ConversationScopeRecord,
    approved_items: list[ProjectKnowledgeRecord],
    profiles: list[ProjectProfileRecord],
    timer: RequestTimer,
    *,
    settings: Settings,
    assistant_message: Message,
    attach_only: bool,
    attachment_storage: AttachmentStorage,
    session_factory: Callable[[], Session],
    evidence_client: EvidenceClient,
) -> StreamingResponse:
    """Streams (or attaches to) one assistant reply. The actual LLM call
    now runs on a detached background thread (see
    app/core/generation_manager.py) rather than inline in this generator —
    the fix for QA finding BUG-1 (a dropped browser connection, e.g.
    `net::ERR_QUIC_PROTOCOL_ERROR` on a long-lived stream through
    Cloudflare, must never discard an answer the backend actually finished
    computing). This function's own generator is now just a *view* onto
    that worker's state: it survives being torn down by a disconnect
    exactly as harmlessly as closing a browser tab on a YouTube video
    doesn't stop the video encoding server-side — because nothing about
    the worker depends on this generator still running.

    `attach_only=True` means a live worker for `assistant_message` already
    exists (a retry/reconnect found it 'generating') — this call polls it
    without spawning a second one, which is what keeps a fast double-retry
    from starting a duplicate generation for the same question.

    `timer` is passed explicitly (not read ambiently) because this
    generator — and, further, the background worker it may spawn — both
    run after FastAPI's dependency AsyncExitStack (and the ambient
    "current timer" it binds) has already closed; retrieval/prompt
    construction below rebind it explicitly (see bind_timer/unbind_timer)
    for exactly the duration those specific calls need it."""

    def event_stream() -> Iterator[str]:
        # Sent before any blocking work at all (milestone: fix both the
        # indefinite "Connecting…" UI *and* the ~8s of retrieval/prompt-
        # build latency this event used to be stuck behind — a live
        # measurement on the Oracle CPU host found "time to first SSE
        # byte" was actually 100% retrieval+prompt-construction time, none
        # of it model load — see the performance investigation). A client
        # that doesn't recognize `type: "progress"` skips it (see
        # ChatProgressEvent's docstring).
        yield _sse(ChatProgressEvent(stage="connected"))

        if attach_only:
            yield _sse(ChatProgressEvent(stage="generating"))
            for delta in generation_manager.poll_until_done(assistant_message.id):
                yield _sse(ChatTokenEvent(content=delta))
            yield from _final_reply_events(repository, assistant_message.id, timer)
            return

        yield _sse(ChatProgressEvent(stage="retrieving"))
        include_chat, include_project, include_general = _effective_scope_flags(scope_settings)
        token = bind_timer(timer)
        try:
            prepared = rag_service.prepare(
                parsed.query,
                user_id=str(user.id),
                top_k=parsed.top_k,
                filters=parsed.filters,
                conversation_id=str(conversation_id),
                project_ids=tuple(str(p) for p in project_ids),
                project_context=project_context,
                include_chat=include_chat,
                include_project=include_project,
                include_general=include_general,
                strict_mode=scope_settings.zoom_in_mode,
            )
        finally:
            unbind_timer(token)
        yield _sse(ChatProgressEvent(stage="processing_context"))

        if timer.enabled:
            timer.record_metric("retrieved_chunk_count", len(prepared.retrieved_sources))
            timer.record_metric(
                "context_characters", sum(len(c.text) for c in prepared.retrieved_sources)
            )
            estimated_prompt_chars = len(prepared.system_prompt) + len(prepared.user_prompt)
            timer.record_metric("estimated_prompt_tokens", round(estimated_prompt_chars / 4))

        transparency = transparency_to_dict(
            build_transparency_snapshot(
                chat_enabled=include_chat,
                project_enabled=include_project,
                general_enabled=include_general,
                include_other_project_summaries=scope_settings.include_other_project_summaries,
                sources=prepared.retrieved_sources,
                approved_items=approved_items,
                profiles=profiles,
                zoom_in=scope_settings.zoom_in_mode,
            )
        )

        # No model is ever called on the insufficient-evidence path (see
        # generation_manager.run_text_generation's own early branch) — so,
        # same as before this redesign, 'loading_model'/'generating' must
        # never be claimed for it.
        if not prepared.insufficient_evidence:
            yield _sse(ChatProgressEvent(stage="loading_model"))
            yield _sse(ChatProgressEvent(stage="generating"))

        # Response-mode-specific token limit (see Settings.
        # ollama_num_predict_lesson_mode's own docstring for why): applied
        # only when this specific query is asking for instructional design,
        # never as a blanket increase for every chat turn.
        num_predict_override = (
            {"num_predict": settings.ollama_num_predict_lesson_mode}
            if is_instructional_design_request(parsed.query)
            else None
        )

        def _stream_answer() -> Iterator[str]:
            tokens = rag_service.stream_answer(
                prepared, timer=timer, options_override=num_predict_override
            )
            return _timed_token_stream(tokens, timer) if timer.enabled else tokens

        generation_manager.start_text_generation(
            assistant_message_id=assistant_message.id,
            stream_answer=_stream_answer,
            insufficient_evidence=prepared.insufficient_evidence,
            no_evidence_answer=(
                ZOOM_IN_NO_EVIDENCE_ANSWER if scope_settings.zoom_in_mode else NO_EVIDENCE_ANSWER
            ),
            retrieved_sources=prepared.retrieved_sources,
            citations=prepared.citations,
            transparency=transparency,
            attachment_storage=attachment_storage,
            timer=timer,
            session_factory=session_factory,
        )

        for delta in generation_manager.poll_until_done(assistant_message.id):
            yield _sse(ChatTokenEvent(content=delta))
        yield from _final_reply_events(repository, assistant_message.id, timer)

        # Milestone 11 §21: strictly AFTER the SSE stream has already
        # yielded every event above — this line runs once the consumer
        # has drained the generator that far, so it can never delay TTFT,
        # token streaming, or the final reply events. Scheduling onto the
        # bounded executor (see app/core/evidence_shadow.py) is a fast,
        # in-memory operation; the actual evidence-service HTTP call(s)
        # happen later, on a separate worker thread, long after this
        # request has returned. Diagnostic-only (Milestone 11 §2/§23): no
        # branch of this call can alter `prepared`, the persisted answer,
        # or anything already sent above.
        maybe_schedule_evidence_shadow(
            settings=settings,
            zoom_in_mode=scope_settings.zoom_in_mode,
            query=parsed.query,
            # prepared.citations is index-aligned 1:1 with
            # prepared.retrieved_sources (see app/core/citation.py's
            # build_citations — both are the same "S1, S2, ..." order),
            # so this pairs each chunk's actual text with the exact
            # citation ID the generator/frontend already use for it.
            source_texts=[
                (citation.source_id, chunk.text)
                for citation, chunk in zip(
                    prepared.citations, prepared.retrieved_sources, strict=True
                )
            ],
            evidence_client=evidence_client,
        )

    return StreamingResponse(event_stream(), media_type="text/event-stream")


def _stream_vision_reply(
    conversation_id: uuid.UUID,
    parsed: ParsedMessageRequest,
    route: ModelRoute,
    images: list[bytes],
    user: User,
    repository: ConversationsRepository,
    vision_service: VisionService,
    retriever: RetrieverLike,
    settings: Settings,
    project_ids: list[uuid.UUID],
    project_context: str | None,
    scope_settings: ConversationScopeRecord,
    approved_items: list[ProjectKnowledgeRecord],
    profiles: list[ProjectProfileRecord],
    timer: RequestTimer,
    *,
    assistant_message: Message,
    attach_only: bool,
    attachment_storage: AttachmentStorage,
    session_factory: Callable[[], Session],
    batched_pdf: BatchedPdfRequest | None = None,
    llm_provider: LLMProvider | None = None,
) -> StreamingResponse:
    """The vision-routed counterpart to _stream_text_reply — see that
    function's docstring for the shared recovery design (QA finding
    BUG-1). Never short-circuits on "insufficient evidence" the way the
    text path does: the attached image(s)/page(s) are themselves evidence
    the model can reason about even when `route.use_retrieval` is False,
    or True but retrieval happened to find nothing in the corpus for this
    query, so this always actually calls the vision model.

    The background worker (see generation_manager.run_vision_generation)
    drives VisionService.stream_chat's async generator on its own private
    event loop — this function's own event_stream() stays a plain sync
    generator (like the text path's), unlike the pre-recovery-redesign
    version of this function, since polling a GenerationState needs
    nothing async at all.

    `batched_pdf`, when given (see _handle_conversation_message), routes
    this call through the batched-PDF pipeline instead
    (app/services/vision_batch_orchestrator.py) — sequential per-batch
    analysis calls reported as ChatProgressEvent.detail lines, followed by
    one final synthesis streamed as ordinary tokens — instead of the
    single vision_service.stream_chat call below (`images` is unused in
    that case). `llm_provider` is only required together with
    `batched_pdf`: the batched pipeline's text-mode batches and its final
    synthesis both use the fast text model, never the vision model, once
    a document's images have already been distilled into per-batch
    findings — see that module's docstring for why."""
    # Milestone 4 (Zoom-In) attachment-semantics decision: Zoom-In
    # restricts corpus RETRIEVAL only (which tiers `retrieve_and_cite`
    # queries) — it never restricts or affects a message's own attached
    # image(s)/PDF page(s), which are direct user-supplied evidence, not
    # something drawn from the corpus, and are always fully visible to the
    # vision model regardless of Zoom-In. See the Milestone 4 report's
    # "attachment semantics" section for the full investigation/rationale.
    include_chat, include_project, include_general = _effective_scope_flags(scope_settings)
    if route.use_retrieval:
        evidence = retrieve_and_cite(
            retriever,
            parsed.query,
            user_id=str(user.id),
            top_k=parsed.top_k,
            filters=parsed.filters,
            max_chunks_per_document=settings.context_max_chunks_per_document,
            max_total_context_chars=settings.context_max_total_chars,
            dedup_similarity_threshold=settings.context_dedup_similarity_threshold,
            conversation_id=str(conversation_id),
            project_ids=tuple(str(p) for p in project_ids),
            chat_scope_top_k=settings.retrieval_chat_scope_top_k,
            project_scope_top_k=settings.retrieval_project_scope_top_k,
            include_chat=include_chat,
            include_project=include_project,
            include_general=include_general,
            retrieval_mode_label="zoom_in" if scope_settings.zoom_in_mode else None,
        )
    else:
        evidence = CorpusEvidence(sources=[], citations=[])

    # The batched pipeline builds its own, smaller per-batch/reduce
    # prompts lazily (see vision_batch_orchestrator.py) rather than one
    # big single-shot prompt up front, so there is nothing to size-check
    # here for that case — vision_max_prompt_chars only ever bounded the
    # single-call prompt built below.
    prompt_chars: int | None = None
    system_prompt = user_prompt = ""
    if batched_pdf is None:
        system_prompt, user_prompt = build_vision_prompt(
            parsed.query, evidence.sources, project_context=project_context
        )
        prompt_chars = len(system_prompt) + len(user_prompt)
        if prompt_chars > settings.vision_max_prompt_chars:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                detail=(
                    f"This message's combined prompt is {prompt_chars} characters, exceeds the "
                    f"{settings.vision_max_prompt_chars}-character limit for a vision request — "
                    "try a shorter question, disabling 'use my research corpus' for this message, "
                    "or a conversation with fewer approved Project Memory items."
                ),
            )

    def event_stream() -> Iterator[str]:
        def _drain_batched_updates() -> Iterator[str]:
            """poll_batched_vision's tagged updates, translated to SSE —
            shared by the attach_only reconnect branch below and the
            normal first-connection path, so the two can never drift on
            how a GenProgress/GenToken becomes a ChatProgressEvent/
            ChatTokenEvent."""
            for update in generation_manager.poll_batched_vision(assistant_message.id):
                if isinstance(update, GenProgress):
                    yield _sse(ChatProgressEvent(stage="generating", detail=update.detail))
                else:
                    yield _sse(ChatTokenEvent(content=update.text))

        yield _sse(ChatProgressEvent(stage="connected"))

        if attach_only:
            yield _sse(ChatProgressEvent(stage="generating"))
            if batched_pdf is not None:
                yield from _drain_batched_updates()
            else:
                for delta in generation_manager.poll_until_done(assistant_message.id):
                    yield _sse(ChatTokenEvent(content=delta))
            yield from _final_reply_events(repository, assistant_message.id, timer)
            return

        if route.use_retrieval:
            yield _sse(ChatProgressEvent(stage="retrieving"))
        yield _sse(ChatProgressEvent(stage="processing_context"))

        if prompt_chars is not None and timer.enabled:
            timer.record_metric("estimated_prompt_tokens", round(prompt_chars / 4))

        transparency = transparency_to_dict(
            build_transparency_snapshot(
                chat_enabled=include_chat,
                project_enabled=include_project,
                general_enabled=include_general,
                include_other_project_summaries=scope_settings.include_other_project_summaries,
                sources=evidence.sources,
                approved_items=approved_items,
                profiles=profiles,
                zoom_in=scope_settings.zoom_in_mode,
            )
        )

        yield _sse(ChatProgressEvent(stage="loading_model"))
        yield _sse(ChatProgressEvent(stage="generating"))

        if batched_pdf is not None:
            assert llm_provider is not None  # always passed together with batched_pdf

            def _stream_updates() -> AsyncIterator[GenerationUpdate]:
                return stream_batched_pdf_analysis(
                    pdf_data=batched_pdf.pdf_data,
                    plan=batched_pdf.plan,
                    query=parsed.query,
                    sources=evidence.sources,
                    project_context=project_context,
                    vision_service=vision_service,
                    text_provider=llm_provider,
                    max_retries=settings.vision_batch_max_retries,
                    timer=timer,
                )

            generation_manager.start_batched_vision_generation(
                assistant_message_id=assistant_message.id,
                stream_updates=_stream_updates,
                retrieved_sources=evidence.sources,
                citations=evidence.citations,
                transparency=transparency,
                attachment_storage=attachment_storage,
                timer=timer,
                session_factory=session_factory,
            )
            yield from _drain_batched_updates()
        else:

            def _stream_chat() -> AsyncIterator[str]:
                raw = vision_service.stream_chat(
                    system_prompt=system_prompt, prompt=user_prompt, images=images, timer=timer
                )
                return _timed_async_token_stream(raw, timer) if timer.enabled else raw

            generation_manager.start_vision_generation(
                assistant_message_id=assistant_message.id,
                stream_chat=_stream_chat,
                retrieved_sources=evidence.sources,
                citations=evidence.citations,
                transparency=transparency,
                attachment_storage=attachment_storage,
                timer=timer,
                session_factory=session_factory,
            )

            for delta in generation_manager.poll_until_done(assistant_message.id):
                yield _sse(ChatTokenEvent(content=delta))

        if timer.enabled:
            timer.record_metric("vision_total_ms", timer.total_ms())

        # A vision-specific error category (see GenerationState's own
        # docstring for why this is read from the live in-memory state,
        # not the database) is only available while this is still the
        # same connection that was live when the worker failed — a later
        # reconnect/replay falls through to _final_reply_events' generic
        # (category-less) error event instead, which is the best either
        # path can honestly offer at that point.
        live_state = generation_manager.get(assistant_message.id)
        if live_state is not None:
            content, status = live_state.snapshot()
            if status == "error":
                yield _sse(
                    ChatErrorEvent(
                        message=live_state.error_message or "Generation failed.",
                        error_category=live_state.error_category,
                    )
                )
                return
        yield from _final_reply_events(repository, assistant_message.id, timer)

    return StreamingResponse(event_stream(), media_type="text/event-stream")


def _handle_conversation_message(
    conversation_id: uuid.UUID,
    parsed: ParsedMessageRequest,
    user: User,
    repository: ConversationsRepository,
    rag_service: RagService,
    attachment_storage: AttachmentStorage,
    settings: Settings,
    vision_service: VisionService,
    retriever: RetrieverLike,
    rate_limiter: RateLimiter,
    projects_repository: ProjectsRepository,
    project_knowledge_repository: ProjectKnowledgeRepository,
    project_profile_repository: ProjectProfileRepository,
    conversation_scope_repository: ConversationScopeRepository,
    scopes_repository: ScopesRepository,
    timer: RequestTimer,
    session_factory: Callable[[], Session],
    llm_provider: LLMProvider,
    evidence_client: EvidenceClient,
) -> StreamingResponse:
    # Checked before any DB/validation work (milestone V4 — see
    # app/core/rate_limiter.py): the cheapest possible rejection for a
    # caller that's already over their limit, and keyed by user_id so one
    # abusive account can never affect another's ability to send messages.
    if not rate_limiter.allow(str(user.id)):
        retry_after = rate_limiter.seconds_until_next_slot(str(user.id))
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            detail=(
                "Too many messages sent recently. Please wait a moment and try again."
            ),
            headers={"Retry-After": str(max(1, round(retry_after)))},
        )

    with timer.stage("conversation_lookup"):
        conversation = repository.get(user.id, conversation_id)
    if conversation is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Conversation not found")

    # Research workspace: the conversation's own "active scope" toggle bar
    # (see app/db/models_conversation_scope.py) — lazily created with
    # every tier on except pooling other projects' summaries, so a
    # conversation that never opens its scope settings behaves exactly
    # like it always has. Milestone 2 (conversation document scope)
    # observability: wraps this plus the project-association lookup and
    # the new selected_document_count query in one "scope_resolution"
    # stage — "how long did it take to know what this turn's retrieval
    # scope actually is," distinct from "conversation_lookup" (the
    # conversation row itself, timed separately above) and "retrieval"
    # (the actual Qdrant search, timed inside app/core/retriever.py).
    with timer.stage("scope_resolution"):
        scope_settings = conversation_scope_repository.get_or_create(user.id, conversation_id)
        assert scope_settings is not None  # conversation ownership already verified above

        # Contextual research scopes: every project (if any) this
        # conversation currently belongs to — threaded into retrieval
        # below as the project-scope tier(s), priority-ordered above the
        # general corpus (see app/core/scoped_retrieval.py). [] for a
        # conversation in zero projects, the common case today.
        project_ids = projects_repository.get_project_ids_for_conversation(
            user.id, conversation_id
        )
        selected_document_count = scopes_repository.count_conversation_documents(
            user.id, conversation_id
        )
    if timer.enabled:
        timer.record_metric("selected_document_count", float(selected_document_count))
        # Milestone 4 (Zoom-In) observability — recorded here (independent
        # of retrieve_and_cite's own "zoom_in" retrieval_mode tag, set
        # later, per-route, only once retrieval actually runs) so
        # "was this turn even eligible for Zoom-In" is visible even on a
        # path that never reaches retrieval at all (e.g. rate-limited,
        # attachment-validation error).
        timer.record_tag("zoom_in_mode", "true" if scope_settings.zoom_in_mode else "false")
    # Project Memory + Research Profile: user-approved knowledge items and
    # confirmed research preferences, formatted into a non-citable
    # "Project Context" block (see app/core/project_context.py) — empty
    # (no block at all) when there's nothing approved/confirmed yet, or
    # when the "Project" scope toggle is off. Intelligent research
    # assistance: pooling *other* projects' approved summaries (regardless
    # of whether this conversation belongs to a project itself) is a
    # separate, explicit, off-by-default toggle
    # (`include_other_project_summaries`) — a project-scoped conversation
    # only ever sees its *own* project's summaries/profile unless that
    # toggle is on, and a project-less conversation sees nothing at all
    # by default.
    if scope_settings.project_enabled and project_ids:
        approved_items = project_knowledge_repository.list_approved_for_projects(
            user.id, project_ids
        )
        profiles = [
            profile
            for project_id in project_ids
            if (profile := project_profile_repository.get_or_create(user.id, project_id))
            is not None
        ]
    else:
        approved_items = []
        profiles = []
    if scope_settings.include_other_project_summaries:
        approved_items = approved_items + [
            item
            for item in project_knowledge_repository.list_approved_for_user(user.id)
            if item.project_id not in project_ids
        ]
    project_context = format_project_context(approved_items, profiles)

    if len(parsed.attachments) > settings.chat_attachment_max_files_per_message:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=(
                f"Too many attachments ({len(parsed.attachments)}), exceeds the "
                f"{settings.chat_attachment_max_files_per_message}-file limit"
            ),
        )

    try:
        validated = [
            validate_attachment(
                upload.content,
                declared_filename=upload.filename,
                max_bytes=settings.chat_attachment_max_bytes,
                max_pdf_pages=settings.chat_attachment_max_pdf_pages,
                allow_heic=settings.chat_attachment_allow_heic,
                page_range_start=upload.page_range_start,
                page_range_end=upload.page_range_end,
            )
            for upload in parsed.attachments
        ]
    except AttachmentValidationError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc

    if parsed.attachments and not settings.vision_enabled:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail=(
                "Vision is disabled on this server (VISION_ENABLED=false); remove the "
                "attachment(s) to send a text-only message."
            ),
        )

    # The single place a chat turn's model/retrieval is decided (milestone
    # V3) — any attachment at all (image or PDF) routes to the vision
    # model; a PDF's pages are rendered to images below exactly like any
    # other attached image once that decision is made (see
    # app/core/model_routing.py).
    route = choose_model(
        has_images=len(parsed.attachments) > 0,
        corpus_enabled=parsed.use_corpus,
        text_model=settings.ollama_llm_model,
        vision_model=settings.ollama_vision_model,
    )

    vision_images: list[bytes] = []
    batched_pdf: BatchedPdfRequest | None = None
    if route.is_vision:
        # A lone PDF attachment with no explicit, user-chosen page range
        # is the only case the batched pipeline (see
        # app/services/pdf_batch_planner.py) ever applies to — planning is
        # cheap (no rendering, no model calls) so it's always attempted
        # first; a plan with 0 or 1 batches falls straight through to the
        # older single-call render_attachments_to_images path below,
        # completely unchanged, same as a bare image attachment or a PDF
        # with an explicit range always has.
        single_pdf = (
            validated[0]
            if len(validated) == 1
            and validated[0].mime == "application/pdf"
            and parsed.attachments[0].page_range_start is None
            else None
        )
        plan = None
        if single_pdf is not None:
            try:
                plan = plan_pdf_batches(
                    single_pdf.data,
                    batch_size=min(
                        settings.vision_batch_pages_per_batch, settings.vision_max_images_per_message
                    ),
                    max_pages=settings.vision_batch_max_pages,
                    text_min_chars=settings.vision_batch_text_min_chars,
                )
            except VisionServiceError as exc:
                raise HTTPException(status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc

        if plan is not None and plan.needs_batching:
            batched_pdf = BatchedPdfRequest(pdf_data=single_pdf.data, plan=plan)  # type: ignore[union-attr]
            if timer.enabled:
                timer.record_metric("attachment_count", len(parsed.attachments))
                timer.record_metric("pdf_page_count", plan.total_page_count)
                timer.record_metric("vision_batch_planned_count", len(plan.batches))
                timer.record_metric(
                    "vision_batch_skipped_blank_pages", len(plan.skipped_blank_pages)
                )
        else:
            try:
                vision_images = render_attachments_to_images(
                    [
                        AttachmentForVision(
                            mime=result.mime,
                            data=result.data,
                            page_range_start=upload.page_range_start,
                            page_range_end=upload.page_range_end,
                        )
                        for upload, result in zip(parsed.attachments, validated, strict=True)
                    ],
                    max_images=settings.vision_max_images_per_message,
                    max_pdf_pages=settings.vision_max_pdf_pages,
                    max_image_dimension=settings.vision_max_image_dimension,
                    max_image_pixels=settings.vision_max_image_pixels,
                    max_total_pixels=settings.vision_max_total_pixels,
                )
            except VisionServiceError as exc:
                raise HTTPException(status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc

            if timer.enabled:
                timer.record_metric("attachment_count", len(parsed.attachments))
                timer.record_metric(
                    "pdf_page_count",
                    sum(r.page_count or 0 for r in validated if r.mime == "application/pdf"),
                )
                timer.record_metric(
                    "original_attachment_bytes", sum(len(r.data) for r in validated)
                )
                timer.record_metric(
                    "processed_attachment_bytes", sum(len(image) for image in vision_images)
                )
                # "dimensions" (plural, per-image) don't fit RequestTimer's
                # flat name->float metric namespace (see
                # app/core/request_timing.py) — recorded as two numeric
                # summaries instead: the largest single side and the summed
                # pixel count, for both the original (image attachments
                # only — a PDF has no "dimensions" before it's rendered) and
                # the fully processed (rendered + resized) sets. Every
                # per-image WxH pair is still visible in full via the
                # existing max_pixels/max_total_pixels VisionServiceError
                # messages when a limit is actually hit; this is a summary
                # for the *normal*, non-error case.
                original_max_dim, original_total_px = _image_dimension_summary(
                    [r.data for r in validated if r.mime != "application/pdf"]
                )
                processed_max_dim, processed_total_px = _image_dimension_summary(vision_images)
                timer.record_metric("original_image_max_dimension_px", original_max_dim)
                timer.record_metric("original_image_total_pixels", original_total_px)
                timer.record_metric("processed_image_max_dimension_px", processed_max_dim)
                timer.record_metric("processed_image_total_pixels", processed_total_px)

    is_first_message = repository.get_messages(user.id, conversation_id) == []
    message = repository.add_user_message(
        conversation_id, parsed.query, client_message_id=parsed.client_message_id
    )
    if is_first_message and not conversation.title_is_custom:
        repository.maybe_set_auto_title(conversation_id, generate_title(parsed.query))

    # A retry replaying the same client_message_id returns the original
    # message row above rather than inserting a new one (see
    # ConversationsRepository.add_user_message) — checking for attachments
    # already stored against that row (rather than unconditionally
    # re-validating-and-saving `parsed.attachments` again) is what keeps a
    # retried send from writing a second copy of the same files to disk.
    # A retry always re-runs generation against *this* request's uploaded
    # bytes regardless (see vision_images above) — same as the text path,
    # which has never had an idempotency guard on the assistant's reply,
    # only on the user's own message.
    if parsed.attachments and not repository.list_attachments_for_message(message.id):
        _store_new_attachments(
            parsed,
            validated,
            message_id=message.id,
            user_id=user.id,
            attachment_storage=attachment_storage,
            repository=repository,
        )

    # Stream-disconnect recovery (QA finding BUG-1) + Retry idempotency:
    # does an assistant reply already exist for *this* user message? A
    # retry replays the same client_message_id, which resolves to the
    # same `message` row above (see add_user_message) — so this lookup is
    # what makes a retry either (a) a no-op replay of an already-complete
    # answer, (b) an attach onto a still-running generation, or (c) a
    # fresh attempt, and never a duplicate generation for the same
    # question. See app/core/generation_manager.py for the worker side.
    existing_reply = repository.get_assistant_reply_for_user_message(message.id)
    attach_only = False
    if existing_reply is not None and existing_reply.status == "complete":
        return _replay_finished_reply(repository, existing_reply.id, timer)
    if existing_reply is not None and existing_reply.status == "generating":
        if generation_manager.get(existing_reply.id) is not None:
            assistant_message = existing_reply
            attach_only = True
        else:
            # No live worker for a 'generating' row in *this* process — an
            # unlikely race (the sweep at startup normally already caught
            # this case; see sweep_stale_generating_messages), but never
            # silently hang: treat it as retry-eligible rather than
            # attaching to nothing.
            assistant_message = repository.reset_assistant_message_for_retry(existing_reply.id)
    elif existing_reply is not None:
        # status in error/cancelled/interrupted — re-arm the same row
        # rather than creating a second assistant message for this
        # question.
        assistant_message = repository.reset_assistant_message_for_retry(existing_reply.id)
    else:
        assistant_message = repository.create_pending_assistant_message(
            conversation_id, parent_message_id=message.id
        )

    if route.is_vision:
        return _stream_vision_reply(
            conversation_id,
            parsed,
            route,
            vision_images,
            user,
            repository,
            vision_service,
            retriever,
            settings,
            project_ids,
            project_context,
            scope_settings,
            approved_items,
            profiles,
            timer,
            assistant_message=assistant_message,
            attach_only=attach_only,
            attachment_storage=attachment_storage,
            session_factory=session_factory,
            batched_pdf=batched_pdf,
            llm_provider=llm_provider,
        )
    return _stream_text_reply(
        conversation_id,
        parsed,
        user,
        repository,
        rag_service,
        project_ids,
        project_context,
        scope_settings,
        approved_items,
        profiles,
        timer,
        settings=settings,
        assistant_message=assistant_message,
        attach_only=attach_only,
        attachment_storage=attachment_storage,
        session_factory=session_factory,
        evidence_client=evidence_client,
    )


@router.post("/{conversation_id}/messages")
async def post_conversation_message(
    conversation_id: uuid.UUID,
    request: Request,
    user: CurrentUserDep,
    repository: ConversationsRepositoryDep,
    rag_service: RagServiceDep,
    attachment_storage: AttachmentStorageDep,
    settings: SettingsDep,
    vision_service: VisionServiceDep,
    retriever: RetrieverDep,
    rate_limiter: ChatRateLimiterDep,
    projects_repository: ProjectsRepositoryDep,
    project_knowledge_repository: ProjectKnowledgeRepositoryDep,
    project_profile_repository: ProjectProfileRepositoryDep,
    conversation_scope_repository: ConversationScopeRepositoryDep,
    scopes_repository: ScopesRepositoryDep,
    request_timer: RequestTimerDep,
    session_factory: SessionFactoryDep,
    llm_provider: LLMProviderDep,
    evidence_client: EvidenceClientDep,
) -> StreamingResponse:
    """Accepts either `application/json` (the original, text-only shape —
    see PostConversationMessageRequest) or `multipart/form-data` (adds
    file attachments: milestone V2). FastAPI cannot declare both a JSON
    body model and File/Form parameters on one route, so the body is
    parsed manually here based on the request's actual Content-Type
    rather than declaratively — see _parse_message_request. A
    multipart request uses the same form fields as the JSON body's
    fields (query, top_k, filters as a JSON string, client_message_id,
    use_corpus), plus a repeated `files` field for attachments and an
    optional `page_ranges` JSON-array form field (one entry per file, each
    `{"start": int, "end": int}` or null) for an attached PDF's selected
    page range.

    Any attachment at all routes this turn to the vision model instead of
    the text model (milestone V3 — see app/core/model_routing.py);
    `use_corpus` then decides whether retrieval also runs alongside
    vision. A text-only message (no attachments) behaves exactly as
    before — `use_corpus` is ignored for it, since retrieval has always
    unconditionally run for a text-only turn.

    The actual work (attachment validation/storage, model routing, DB
    writes, and calling the RAG/vision pipeline) is unchanged, synchronous,
    blocking code — see _handle_conversation_message — run through
    run_in_threadpool so it never blocks the event loop, the same
    guarantee FastAPI gives for free to every other (plain `def`) route in
    this app.
    """
    parsed = await _parse_message_request(request)
    return await run_in_threadpool(
        _handle_conversation_message,
        conversation_id,
        parsed,
        user,
        repository,
        rag_service,
        attachment_storage,
        settings,
        vision_service,
        retriever,
        rate_limiter,
        projects_repository,
        project_knowledge_repository,
        project_profile_repository,
        conversation_scope_repository,
        scopes_repository,
        request_timer,
        session_factory,
        llm_provider,
        evidence_client,
    )


@router.post(
    "/{conversation_id}/messages/{message_id}/cancel", status_code=status.HTTP_202_ACCEPTED
)
def cancel_message_generation(
    conversation_id: uuid.UUID,
    message_id: uuid.UUID,
    user: CurrentUserDep,
    repository: ConversationsRepositoryDep,
) -> Response:
    """Explicit user cancellation (QA finding BUG-1's "distinguish
    explicit cancellation from accidental disconnection" requirement) —
    deliberately a real, separate action from a client simply
    disappearing: this is the *only* thing that actually stops the
    background worker (see generation_manager.request_cancel); a dropped
    connection alone does nothing to it, by design.

    Ownership is checked the same way every other message/attachment
    route in this file does: the conversation must belong to `user`, and
    the message must actually belong to *that* conversation — never
    trusts `message_id` alone (a message ID for a different user's
    conversation must 404, not be cancellable)."""
    conversation = repository.get(user.id, conversation_id)
    if conversation is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Conversation not found")
    message = repository.get_message(message_id)
    if (
        message is None
        or message.conversation_id != conversation_id
        or message.role != "assistant"
    ):
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Message not found")
    if message.status != "generating":
        # Nothing to cancel — already finished, failed, or already
        # cancelled. Not an error: a Cancel button race (the generation
        # finished a moment before the click landed) is a normal outcome,
        # not a client mistake.
        return Response(status_code=status.HTTP_202_ACCEPTED)
    generation_manager.request_cancel(message_id)
    return Response(status_code=status.HTTP_202_ACCEPTED)


@router.get("/{conversation_id}/messages/{message_id}/attachments/{attachment_id}")
def get_message_attachment_content(
    conversation_id: uuid.UUID,
    message_id: uuid.UUID,
    attachment_id: uuid.UUID,
    user: CurrentUserDep,
    repository: ConversationsRepositoryDep,
    attachment_storage: AttachmentStorageDep,
) -> Response:
    """Serves one attachment's raw bytes back (milestone V3 — needed so a
    persisted image attachment can actually be shown as a thumbnail after
    a page reload, not just described by metadata; see
    MessageAttachmentResponse, which deliberately never includes a
    filesystem path). 404s (never distinguishing "doesn't exist" from
    "belongs to someone else") unless conversation_id, message_id, and
    attachment_id all actually chain together and the conversation is
    `user`'s own — see
    ConversationsRepository.get_attachment_content_info.
    """
    info = repository.get_attachment_content_info(
        user.id, conversation_id, message_id, attachment_id
    )
    if info is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Attachment not found")
    storage_key, mime, _page_count = info
    return Response(content=attachment_storage.read(storage_key), media_type=mime)


@router.get("/{conversation_id}/messages/{message_id}/attachments/{attachment_id}/preview")
def get_message_attachment_page_preview(
    conversation_id: uuid.UUID,
    message_id: uuid.UUID,
    attachment_id: uuid.UUID,
    user: CurrentUserDep,
    repository: ConversationsRepositoryDep,
    attachment_storage: AttachmentStorageDep,
    page: int = Query(default=1, ge=1),
) -> Response:
    """Renders one page of a stored PDF attachment as a PNG image
    (milestone V4 — lets the frontend show a page preview/thumbnail
    without downloading and rendering the whole PDF client-side). Reuses
    render_pdf_pages, the same PDF-to-image renderer the vision pipeline
    itself uses (see app/services/vision_service.py), so a preview always
    matches what the vision model actually sees. Same ownership/404
    behavior as get_message_attachment_content above; additionally 404s a
    `page` beyond the PDF's known page_count, and 400s for a non-PDF
    attachment (there is nothing to "page" through)."""
    info = repository.get_attachment_content_info(
        user.id, conversation_id, message_id, attachment_id
    )
    if info is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Attachment not found")
    storage_key, mime, page_count = info
    if mime != "application/pdf":
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, detail="Only PDF attachments have a page preview"
        )
    if page_count is not None and page > page_count:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            detail=f"Page {page} exceeds this PDF's {page_count} page(s)",
        )

    try:
        [rendered] = render_pdf_pages(
            attachment_storage.read(storage_key), max_pages=1, first_page=page, last_page=page
        )
    except VisionServiceError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc

    return Response(content=rendered, media_type="image/png")
