from collections.abc import Iterator

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse

from app.core.citation_validation import validate_citations
from app.core.errors import LLMProviderError
from app.core.prompt_builder import NO_EVIDENCE_ANSWER
from app.core.security import CurrentUserDep, get_current_user
from app.deps import RagServiceDep
from app.schemas.chat import (
    ChatDoneEvent,
    ChatErrorEvent,
    ChatEvent,
    ChatRequest,
    ChatSourcesEvent,
    ChatTokenEvent,
)

router = APIRouter(tags=["chat"], dependencies=[Depends(get_current_user)])


def _sse(event: ChatEvent) -> str:
    return f"data: {event.model_dump_json()}\n\n"


@router.post("/chat")
def post_chat(
    request: ChatRequest, user: CurrentUserDep, rag_service: RagServiceDep
) -> StreamingResponse:
    prepared = rag_service.prepare(
        request.query, user_id=str(user.id), top_k=request.top_k, filters=request.filters
    )

    def event_stream() -> Iterator[str]:
        if prepared.insufficient_evidence:
            yield _sse(ChatTokenEvent(content=NO_EVIDENCE_ANSWER))
            yield _sse(ChatSourcesEvent(sources=prepared.retrieved_sources))
            yield _sse(ChatDoneEvent(citations=prepared.citations, insufficient_evidence=True))
            return

        answer_parts: list[str] = []
        try:
            for token in rag_service.stream_answer(prepared):
                answer_parts.append(token)
                yield _sse(ChatTokenEvent(content=token))
        except LLMProviderError as exc:
            yield _sse(ChatErrorEvent(message=str(exc)))
            return

        validation = validate_citations("".join(answer_parts), prepared.citations)
        yield _sse(ChatSourcesEvent(sources=prepared.retrieved_sources))
        yield _sse(
            ChatDoneEvent(citations=prepared.citations, citation_warnings=validation.warnings)
        )

    return StreamingResponse(event_stream(), media_type="text/event-stream")
