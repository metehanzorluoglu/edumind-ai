import uuid
from collections.abc import Iterator

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse

from app.core.errors import ImageGenerationError
from app.core.image_generation_service import ImageGenerationService
from app.core.security import CurrentUserDep, get_current_user
from app.db.conversations_repository import (
    ConversationsRepository,
    MessageAttachmentRecord,
    NewAttachment,
)
from app.deps import (
    AttachmentStorageDep,
    ConversationsRepositoryDep,
    ImageGenerationServiceDep,
    ProjectsRepositoryDep,
    SettingsDep,
)
from app.schemas.conversations import MessageAttachmentResponse
from app.schemas.images import (
    GenerateImagesRequest,
    ImageGenerationDoneEvent,
    ImageGenerationErrorEvent,
    ImageGenerationEvent,
    ImageGenerationProgressEvent,
    decode_reference_data_url,
)
from app.services.attachment_storage import AttachmentStorage

router = APIRouter(prefix="/images", tags=["images"], dependencies=[Depends(get_current_user)])

# Extension for a persisted reference attachment's filename, by mime — purely
# cosmetic (the mime is the source of truth when serving bytes back).
_EXT_BY_MIME = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp"}


def _attachment_response(record: MessageAttachmentRecord) -> MessageAttachmentResponse:
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


def _sse(event: ImageGenerationEvent) -> str:
    return f"data: {event.model_dump_json()}\n\n"


def stream_generate_images(
    *,
    user_id: uuid.UUID,
    conversation_id: uuid.UUID,
    request: GenerateImagesRequest,
    save_to_project_id: uuid.UUID | None,
    ollama_image_model: str,
    conversations_repository: ConversationsRepository,
    image_storage: AttachmentStorage,
    image_generation_service: ImageGenerationService,
    decoded_refs: list[tuple[str, bytes]],
) -> StreamingResponse:
    """Streams one `progress` SSE event per completed image — real,
    per-image progress (never a faked fraction for a single image; see
    ImageGenerationProgressEvent's docs) — then a `done` event once every
    requested image has been generated AND persisted. An `error` event
    (never an HTTP error status — the response has already started
    streaming a 200 by the time generation can fail) covers a model
    failure on any image in the batch.

    Request cancellation: if the client disconnects mid-generation (the
    frontend's Cancel button aborts the underlying fetch — see
    EducationAssistantClient.streamImageGeneration), Starlette's
    StreamingResponse stops iterating event_stream() below and throws
    GeneratorExit in at its current `yield` — a BaseException, so the
    `except ImageGenerationError` around the generation loop never catches
    it, and it propagates straight out, skipping every line below the
    loop: no attachment file is ever written to disk (that only happens in
    the persistence block *after* the loop) and no message is ever
    persisted. Exactly mirrors routes_conversations.py's
    _stream_text_reply's own documented cancellation mechanism — see
    tests/unit/api/test_routes_conversations_cancellation.py for the proof
    that relies on, and tests/api/test_images.py for this endpoint's own
    version of the same test.
    """

    def event_stream() -> Iterator[str]:
        reference_bytes = [data for _, data in decoded_refs] or None
        results = []
        try:
            for index in range(request.num_images):
                image_seed = request.seed + index if request.seed is not None else None
                result = image_generation_service.generate_one(
                    prompt=request.prompt,
                    negative_prompt=request.negative_prompt,
                    width=request.width,
                    height=request.height,
                    seed=image_seed,
                    reference_images=reference_bytes,
                )
                results.append(result)
                yield _sse(
                    ImageGenerationProgressEvent(
                        completed=len(results), total=request.num_images
                    )
                )
        except ImageGenerationError as exc:
            yield _sse(ImageGenerationErrorEvent(message=str(exc)))
            return

        new_attachments: list[NewAttachment] = []
        written_storage_keys: list[str] = []
        try:
            # Persist the reference images first, on the same assistant message
            # as the generated images (source="reference") — same storage +
            # rollback path. Their bytes were already decoded once in the route
            # handler (and validated by the schema before that), so this is a
            # write-only step; decoded_refs is reused for the model call above.
            for ref_mime, ref_data in decoded_refs:
                ref_id = uuid.uuid4()
                ref_key = image_storage.save(
                    user_id=user_id, attachment_id=ref_id, mime=ref_mime, data=ref_data
                )
                written_storage_keys.append(ref_key)
                new_attachments.append(
                    NewAttachment(
                        id=ref_id,
                        mime=ref_mime,
                        original_filename=(
                            f"reference-{ref_id}.{_EXT_BY_MIME.get(ref_mime, 'bin')}"
                        ),
                        size_bytes=len(ref_data),
                        page_count=None,
                        page_range_start=None,
                        page_range_end=None,
                        storage_key=ref_key,
                        source="reference",
                    )
                )
            for result in results:
                storage_key = image_storage.save(
                    user_id=user_id, attachment_id=result.id, mime="image/png", data=result.data
                )
                written_storage_keys.append(storage_key)
                new_attachments.append(
                    NewAttachment(
                        id=result.id,
                        mime="image/png",
                        original_filename=f"generated-{result.id}.png",
                        size_bytes=len(result.data),
                        page_count=None,
                        page_range_start=None,
                        page_range_end=None,
                        storage_key=storage_key,
                        source="generated",
                        generation_prompt=request.prompt,
                        generation_negative_prompt=request.negative_prompt,
                        generation_seed=result.seed,
                        generation_model=ollama_image_model,
                        generation_width=request.width,
                        generation_height=request.height,
                        saved_project_id=save_to_project_id,
                    )
                )
            message = conversations_repository.add_generated_image_message(
                user_id, conversation_id, content=request.prompt, attachments=new_attachments
            )
        except Exception:
            for storage_key in written_storage_keys:
                image_storage.delete(storage_key)
            raise

        if message is None:
            # The conversation existed a moment ago (checked in the route)
            # but no longer does — a genuine race (e.g. deleted from
            # another tab mid-request), not a caller bug; the
            # already-written files are cleaned up like any other failure.
            for storage_key in written_storage_keys:
                image_storage.delete(storage_key)
            yield _sse(ImageGenerationErrorEvent(message="Conversation not found"))
            return

        yield _sse(
            ImageGenerationDoneEvent(
                message_id=str(message.id),
                conversation_id=str(conversation_id),
                images=[_attachment_response(a) for a in message.attachments],
            )
        )

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@router.post("/generate")
def post_generate_images(
    request: GenerateImagesRequest,
    user: CurrentUserDep,
    settings: SettingsDep,
    conversations_repository: ConversationsRepositoryDep,
    projects_repository: ProjectsRepositoryDep,
    image_storage: AttachmentStorageDep,
    image_generation_service: ImageGenerationServiceDep,
) -> StreamingResponse:
    """Generates `request.num_images` image(s) from a text prompt via the
    configured Ollama image model (x/flux2-klein by default —
    IMAGE_GENERATION_ENABLED/OLLAMA_IMAGE_MODEL), streaming real per-image
    progress as a Server-Sent Events response (see stream_generate_images),
    then persists them as a single new message (role="assistant") in the
    given conversation, each image stored as a MessageAttachment with
    source="generated" — reusing every existing attachment-serving/
    -deletion code path unchanged. Never calls the text/vision models and
    never touches retrieval, citations, or conversation scope — image
    generation is a wholly separate pipeline (see
    app/core/image_generation_service.py's module docstring).

    Every *pre-generation* validation below still happens synchronously,
    before any SSE streaming starts, so a bad request (disabled feature,
    unknown conversation/project, too many images) still gets a normal
    HTTP error status — only a failure *during* generation itself (after
    streaming has already begun) becomes an `error` SSE event instead.
    """
    if not settings.image_generation_enabled:
        # Defensive second gate — the router is normally not mounted at all
        # when IMAGE_GENERATION_ENABLED is false (see app/main.py), so this
        # branch is dead in the standard disabled path. It only fires if the
        # router is ever included while disabled (e.g. a feature-test harness
        # that mounts routes directly), in which case it mirrors the
        # not-mounted behavior exactly: 404, the feature does not exist here.
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            detail="Image generation is disabled on this backend.",
        )

    try:
        conversation_id = uuid.UUID(request.conversation_id)
    except ValueError as exc:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, detail="conversation_id is not a valid id"
        ) from exc
    if conversations_repository.get(user.id, conversation_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Conversation not found")

    save_to_project_id: uuid.UUID | None = None
    if request.save_to_project_id:
        try:
            save_to_project_id = uuid.UUID(request.save_to_project_id)
        except ValueError as exc:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT, detail="save_to_project_id is not a valid id"
            ) from exc
        if projects_repository.get(user.id, save_to_project_id) is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Project not found")

    if request.num_images > settings.image_generation_max_images:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=(
                f"num_images ({request.num_images}) exceeds the "
                f"{settings.image_generation_max_images}-image limit"
            ),
        )

    # Decode each reference once, synchronously, so any malformed/oversized
    # payload (the schema already rejects these — this is a defensive second
    # gate) returns a normal 422 *before* streaming begins, and so the bytes
    # are decoded a single time for both the model call and persistence.
    decoded_refs: list[tuple[str, bytes]] = []
    for ref in request.reference_images or ():
        try:
            _, data = decode_reference_data_url(ref.data_url)
        except ValueError as exc:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(exc)
            ) from exc
        decoded_refs.append((ref.mime, data))

    return stream_generate_images(
        user_id=user.id,
        conversation_id=conversation_id,
        request=request,
        save_to_project_id=save_to_project_id,
        ollama_image_model=settings.ollama_image_model,
        conversations_repository=conversations_repository,
        image_storage=image_storage,
        image_generation_service=image_generation_service,
        decoded_refs=decoded_refs,
    )
