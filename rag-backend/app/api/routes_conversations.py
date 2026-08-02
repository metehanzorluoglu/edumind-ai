import json
import time
import uuid
from collections.abc import AsyncIterator, Iterator
from dataclasses import dataclass, field
from pathlib import Path

import pymupdf
from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import StreamingResponse
from pydantic import ValidationError
from starlette.datastructures import UploadFile

from app.config import Settings
from app.core.answer_transparency import build_transparency_snapshot, transparency_to_dict
from app.core.citation_validation import validate_citations
from app.core.conversation_title import generate_title, sanitize_title
from app.core.document_scoping import (
    add_document_to_conversation,
    remove_document_from_conversation,
)
from app.core.errors import AttachmentValidationError, LLMProviderError, VisionServiceError
from app.core.model_routing import ModelRoute, choose_model
from app.core.project_context import format_project_context
from app.core.prompt_builder import NO_EVIDENCE_ANSWER
from app.core.rag_service import CorpusEvidence, RagService, RetrieverLike, retrieve_and_cite
from app.core.rate_limiter import RateLimiter
from app.core.request_timing import RequestTimer
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
from app.db.project_knowledge_repository import ProjectKnowledgeRecord, ProjectKnowledgeRepository
from app.db.project_profile_repository import ProjectProfileRecord, ProjectProfileRepository
from app.db.projects_repository import ProjectsRepository
from app.db.scopes_repository import ConversationDocumentRecord
from app.deps import (
    AttachmentStorageDep,
    ChatRateLimiterDep,
    ConversationScopeRepositoryDep,
    ConversationsRepositoryDep,
    ProjectKnowledgeRepositoryDep,
    ProjectProfileRepositoryDep,
    ProjectsRepositoryDep,
    RagServiceDep,
    RequestTimerDep,
    RetrieverDep,
    ScopesRepositoryDep,
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
    AddConversationDocumentRequest,
    ConversationDetailResponse,
    ConversationDocumentResponse,
    ConversationListResponse,
    ConversationScopeResponse,
    ConversationSummaryResponse,
    MessageAttachmentResponse,
    MessageResponse,
    MessageSourceResponse,
    PostConversationMessageRequest,
    RenameConversationRequest,
    UpdateConversationScopeRequest,
)
from app.services.attachment_storage import (
    AttachmentStorage,
    ValidatedAttachment,
    validate_attachment,
)
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
    )


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
    conversation_scope_repository: ConversationScopeRepositoryDep,
) -> ConversationScopeResponse:
    """Toggling here takes effect starting with this conversation's *next*
    message — a past message's own `transparency.retrieval_scope` always
    keeps showing what was active when it was actually generated."""
    updates = request.model_dump(exclude_unset=True)
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


@router.post(
    "/{conversation_id}/documents",
    response_model=ConversationDocumentResponse,
    status_code=status.HTTP_201_CREATED,
)
def add_conversation_document(
    conversation_id: uuid.UUID,
    request: AddConversationDocumentRequest,
    user: CurrentUserDep,
    scopes_repository: ScopesRepositoryDep,
    vector_store: VectorStoreDep,
) -> ConversationDocumentResponse:
    """Associates an already-ingested document (see POST /documents) with
    this conversation as chat-scope retrieval evidence (contextual
    research scopes) — never duplicates the document's vectors, only adds
    a pointer plus a Qdrant payload resync (see
    app/core/document_scoping.py). Idempotent: re-adding a document already
    associated with this conversation returns the existing association
    unchanged."""
    record = add_document_to_conversation(
        conversation_id=conversation_id,
        document_id=request.document_id,
        user_id=user.id,
        scopes_repository=scopes_repository,
        vector_store=vector_store,
    )
    if record is None:
        # Deliberately the same 404 whether the conversation doesn't exist,
        # isn't the caller's, the document doesn't exist, or belongs to a
        # different user — never reveals which (see ScopesRepository).
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, detail="Conversation or document not found"
        )
    return _conversation_document_response(record)


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
    conversation's/project's scope)."""
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
) -> StreamingResponse:
    """Request cancellation (milestone V4): if the client disconnects
    mid-stream, Starlette's StreamingResponse stops iterating
    event_stream() below and the generator is torn down, throwing
    GeneratorExit in at its current `yield` — a BaseException, not an
    Exception, so it is never caught by the `except LLMProviderError`
    around the token loop and always propagates straight out, skipping
    the `repository.add_assistant_message(...)` call entirely. A
    cancelled generation is therefore never persisted as if it had
    finished — see
    tests/unit/api/test_routes_conversations_cancellation.py, which
    drives this exact mechanism directly rather than only asserting it in
    a comment.

    `timer` (see app/core/request_timing.py) is passed explicitly, not
    read ambiently, because event_stream() below runs as a StreamingResponse
    body — after FastAPI's dependency AsyncExitStack (and the ambient
    "current timer" it binds) has already closed. rag_service.prepare()
    just above still runs inside that window, so its own internal stages
    (embedding/retrieval/reranking/prompt_construction — see
    app/core/retriever.py and app/core/rag_service.py) already reached the
    same `timer` instance via the ambient accessor by the time this
    function receives it as a parameter; `timer` here is only needed for
    what happens *after* that window closes."""
    prepared = rag_service.prepare(
        parsed.query,
        user_id=str(user.id),
        top_k=parsed.top_k,
        filters=parsed.filters,
        conversation_id=str(conversation_id),
        project_ids=tuple(str(p) for p in project_ids),
        project_context=project_context,
        include_chat=scope_settings.chat_enabled,
        include_project=scope_settings.project_enabled,
        include_general=scope_settings.general_enabled,
    )

    def _transparency_dict(sources: list[RetrievedChunk]) -> dict[str, object]:
        return transparency_to_dict(
            build_transparency_snapshot(
                chat_enabled=scope_settings.chat_enabled,
                project_enabled=scope_settings.project_enabled,
                general_enabled=scope_settings.general_enabled,
                include_other_project_summaries=scope_settings.include_other_project_summaries,
                sources=sources,
                approved_items=approved_items,
                profiles=profiles,
            )
        )

    def event_stream() -> Iterator[str]:
        # Progress events (milestone: fix the indefinite "Connecting…" UI
        # on a CPU-only Ollama host — a cold model load alone was measured
        # at ~44s, and prompt evaluation past 2,560 tokens at 155s+, with
        # nothing sent to the client in the meantime before this existed).
        # All progress events are sent before the first ChatTokenEvent,
        # never after — see ChatProgressEvent's docstring. A client that
        # doesn't recognize `type: "progress"` skips it (parseChatEvent's
        # existing forward-compatible unknown-type handling) and simply
        # keeps whatever "connecting" state it already shows, so this is
        # purely additive: no existing token/sources/done consumer changes
        # behavior from these being present.
        yield _sse(ChatProgressEvent(stage="connected"))
        yield _sse(ChatProgressEvent(stage="retrieving"))
        yield _sse(ChatProgressEvent(stage="processing_context"))

        if timer.enabled:
            timer.record_metric("retrieved_chunk_count", len(prepared.retrieved_sources))
            timer.record_metric(
                "context_characters", sum(len(c.text) for c in prepared.retrieved_sources)
            )
            # chars/4 is a rough, well-known heuristic (not a real
            # tokenizer call) — see actual_prompt_tokens in
            # app/core/llm_provider.py's _record_ollama_metrics for
            # Ollama's own, authoritative prompt_eval_count once the LLM
            # call finishes; this estimate exists specifically to be
            # available *before* that, when only prompt length is known.
            estimated_prompt_chars = len(prepared.system_prompt) + len(prepared.user_prompt)
            timer.record_metric("estimated_prompt_tokens", round(estimated_prompt_chars / 4))

        if prepared.insufficient_evidence:
            transparency = _transparency_dict(prepared.retrieved_sources)
            yield _sse(ChatTokenEvent(content=NO_EVIDENCE_ANSWER))
            yield _sse(ChatSourcesEvent(sources=prepared.retrieved_sources))
            timer.log_summary(note="insufficient_evidence")
            yield _sse(
                ChatDoneEvent(
                    citations=prepared.citations,
                    insufficient_evidence=True,
                    transparency=TransparencyResponse.model_validate(transparency),
                    debug_timings=timer.as_dict() or None,
                )
            )
            repository.add_assistant_message(
                conversation_id,
                content=NO_EVIDENCE_ANSWER,
                citations=[],
                citation_warnings=[],
                insufficient_evidence=True,
                sources=[],
                transparency=transparency,
            )
            return

        # Sent immediately, before the blocking Ollama call below — this is
        # the pair of events that actually covers the long CPU-host wait
        # (cold model load + prompt evaluation). Both fire back to back
        # since the backend has no way to distinguish "still loading" from
        # "now evaluating the prompt" from outside Ollama's own process;
        # together they replace "Connecting…" with a status that stays
        # visible for the whole wait instead of going stale.
        yield _sse(ChatProgressEvent(stage="loading_model"))
        yield _sse(ChatProgressEvent(stage="generating"))

        answer_parts: list[str] = []
        # _timed_token_stream adds per-token bookkeeping (see its
        # docstring) — only worth paying for, and only constructed, when
        # profiling is actually on; the disabled path iterates
        # rag_service.stream_answer(prepared) exactly as before this
        # instrumentation existed.
        token_stream = (
            _timed_token_stream(rag_service.stream_answer(prepared, timer=timer), timer)
            if timer.enabled
            else rag_service.stream_answer(prepared, timer=timer)
        )
        try:
            for token in token_stream:
                answer_parts.append(token)
                yield _sse(ChatTokenEvent(content=token))
        except LLMProviderError as exc:
            timer.log_summary(note="llm_error")
            yield _sse(ChatErrorEvent(message=str(exc)))
            return

        answer = "".join(answer_parts)
        validation = validate_citations(answer, prepared.citations)
        transparency = _transparency_dict(prepared.retrieved_sources)
        yield _sse(ChatSourcesEvent(sources=prepared.retrieved_sources))
        timer.log_summary()
        yield _sse(
            ChatDoneEvent(
                citations=prepared.citations,
                citation_warnings=validation.warnings,
                transparency=TransparencyResponse.model_validate(transparency),
                debug_timings=timer.as_dict() or None,
            )
        )
        repository.add_assistant_message(
            conversation_id,
            content=answer,
            citations=prepared.citations,
            citation_warnings=validation.warnings,
            insufficient_evidence=False,
            sources=prepared.retrieved_sources,
            transparency=transparency,
        )

    # Server-Timing (https://www.w3.org/TR/server-timing/) can only carry
    # stages recorded *before* headers are sent — auth through
    # prompt_construction, everything rag_service.prepare() above already
    # did. LLM generation/streaming/total complete only once event_stream()
    # is exhausted, long after headers went out; those reach the caller via
    # the trailing ChatDoneEvent.debug_timings field instead (JSON, see
    # above) and via backend logs (RequestTimer.log_summary()).
    headers = {"Server-Timing": timer.server_timing_header()} if timer.enabled else None
    return StreamingResponse(event_stream(), media_type="text/event-stream", headers=headers)


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
) -> StreamingResponse:
    """The vision-routed counterpart to _stream_text_reply (milestone V3)
    — never short-circuits on "insufficient evidence" the way the text
    path does: the attached image(s)/page(s) are themselves evidence the
    model can reason about even when `route.use_retrieval` is False, or
    True but retrieval happened to find nothing in the corpus for this
    query, so this always actually calls the vision model.

    `event_stream` below is an *async* generator (unlike
    _stream_text_reply's sync one) because VisionService.stream_chat is
    async — see that module's docstring for why: real cancellation
    propagation and a genuinely separate generation-stall timeout both
    require it. Starlette's StreamingResponse natively accepts an async
    generator as `content` (no `iterate_in_threadpool` wrapping — see
    Starlette's own StreamingResponse.__init__), so a client disconnect
    here correctly delivers asyncio.CancelledError at whatever `await`
    this generator is currently suspended on, including mid-wait for the
    vision model's first token — the exact case the old sync
    thread-pooled generator could not be cancelled during (see this
    task's investigation). A cancelled generation is never persisted as
    if it had finished, same guarantee _stream_text_reply documents for
    its own (differently-implemented) cancellation path.

    `timer` (see app/core/request_timing.py) is passed explicitly for the
    same reason _stream_text_reply's is: event_stream() below runs after
    FastAPI's dependency AsyncExitStack (and the ambient "current timer"
    it binds) has already closed."""
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
            include_chat=scope_settings.chat_enabled,
            include_project=scope_settings.project_enabled,
            include_general=scope_settings.general_enabled,
        )
    else:
        evidence = CorpusEvidence(sources=[], citations=[])

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

    async def event_stream() -> AsyncIterator[str]:
        # Same purpose as _stream_text_reply's progress events (see
        # ChatProgressEvent's docstring) — a vision request's "loading_model"
        # + "generating" wait was measured at 114-232+ seconds even fully
        # warm during this task's investigation, with nothing sent to the
        # client in the meantime before this existed.
        yield _sse(ChatProgressEvent(stage="connected"))
        if route.use_retrieval:
            yield _sse(ChatProgressEvent(stage="retrieving"))
        yield _sse(ChatProgressEvent(stage="processing_context"))

        if timer.enabled:
            timer.record_metric("estimated_prompt_tokens", round(prompt_chars / 4))

        yield _sse(ChatProgressEvent(stage="loading_model"))
        yield _sse(ChatProgressEvent(stage="generating"))

        answer_parts: list[str] = []
        raw_stream = vision_service.stream_chat(
            system_prompt=system_prompt, prompt=user_prompt, images=images, timer=timer
        )
        token_stream = (
            _timed_async_token_stream(raw_stream, timer) if timer.enabled else raw_stream
        )
        try:
            async for token in token_stream:
                answer_parts.append(token)
                yield _sse(ChatTokenEvent(content=token))
        except VisionServiceError as exc:
            timer.log_summary(note=f"vision_error:{exc.category}")
            yield _sse(ChatErrorEvent(message=str(exc), error_category=str(exc.category)))
            return

        answer = "".join(answer_parts)
        validation = validate_citations(answer, evidence.citations)
        transparency = transparency_to_dict(
            build_transparency_snapshot(
                chat_enabled=scope_settings.chat_enabled,
                project_enabled=scope_settings.project_enabled,
                general_enabled=scope_settings.general_enabled,
                include_other_project_summaries=scope_settings.include_other_project_summaries,
                sources=evidence.sources,
                approved_items=approved_items,
                profiles=profiles,
            )
        )
        yield _sse(ChatSourcesEvent(sources=evidence.sources))
        if timer.enabled:
            timer.record_metric("vision_total_ms", timer.total_ms())
        timer.log_summary()
        yield _sse(
            ChatDoneEvent(
                citations=evidence.citations,
                citation_warnings=validation.warnings,
                transparency=TransparencyResponse.model_validate(transparency),
                debug_timings=timer.as_dict() or None,
            )
        )
        repository.add_assistant_message(
            conversation_id,
            content=answer,
            citations=evidence.citations,
            citation_warnings=validation.warnings,
            insufficient_evidence=False,
            sources=evidence.sources,
            transparency=transparency,
        )

    headers = {"Server-Timing": timer.server_timing_header()} if timer.enabled else None
    return StreamingResponse(event_stream(), media_type="text/event-stream", headers=headers)


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
    timer: RequestTimer,
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
    # like it always has.
    scope_settings = conversation_scope_repository.get_or_create(user.id, conversation_id)
    assert scope_settings is not None  # conversation ownership already verified above

    # Contextual research scopes: every project (if any) this conversation
    # currently belongs to — threaded into retrieval below as the
    # project-scope tier(s), priority-ordered above the general corpus (see
    # app/core/scoped_retrieval.py). [] for a conversation in zero
    # projects, the common case today.
    project_ids = projects_repository.get_project_ids_for_conversation(user.id, conversation_id)
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
    if route.is_vision:
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
    request_timer: RequestTimerDep,
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
        request_timer,
    )


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
