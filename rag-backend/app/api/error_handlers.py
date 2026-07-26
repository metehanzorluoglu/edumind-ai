import logging

from fastapi import FastAPI, Request, status
from fastapi.responses import JSONResponse

from app.core.errors import EmbeddingProviderError, LLMProviderError
from app.vectorstore.errors import VectorStoreError

logger = logging.getLogger(__name__)

_GENERIC_DETAIL = "Internal server error"


def register_exception_handlers(app: FastAPI) -> None:
    @app.exception_handler(EmbeddingProviderError)
    async def _handle_embedding_error(
        _request: Request, exc: EmbeddingProviderError
    ) -> JSONResponse:
        return JSONResponse(status_code=status.HTTP_502_BAD_GATEWAY, content={"detail": str(exc)})

    @app.exception_handler(LLMProviderError)
    async def _handle_llm_error(_request: Request, exc: LLMProviderError) -> JSONResponse:
        return JSONResponse(status_code=status.HTTP_502_BAD_GATEWAY, content={"detail": str(exc)})

    @app.exception_handler(VectorStoreError)
    async def _handle_vector_store_error(_request: Request, exc: VectorStoreError) -> JSONResponse:
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, content={"detail": str(exc)}
        )

    @app.exception_handler(Exception)
    async def _handle_unhandled_error(request: Request, exc: Exception) -> JSONResponse:
        """Catches anything not already handled above (a bug, a missing
        migration, a DB error, ...). The response body never changes with
        environment — the client only ever sees a generic message, in dev
        and in production alike — but the full traceback is always logged
        server-side via `exc_info`, tagged with the request that triggered
        it, so a bug like this is never silently swallowed on the way to
        becoming a bare "Internal Server Error" the operator can't diagnose."""
        logger.error(
            "Unhandled exception on %s %s", request.method, request.url.path, exc_info=exc
        )
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content={"detail": _GENERIC_DETAIL},
        )
