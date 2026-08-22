"""Milestone 5.1 (Secure LaTeX Compilation Service) — the standalone
compiler service's FastAPI app. Mirrors evidence-service/app/main.py's
shape (settings on app.state, a bounded executor, a /health endpoint) —
this process never imports anything from rag-backend's `app.*` package
and is deployed as a wholly separate container (Part 1: "It must NOT run
inside rag-backend, frontend, Ollama, Qdrant, evidence service")."""

from __future__ import annotations

import logging
import subprocess
from collections.abc import Awaitable, Callable
from functools import lru_cache

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from app.compiler import (
    CompileOutcome,
    InverseSearchOutcome,
    run_compile_job,
    run_inverse_search_job,
    to_response,
)
from app.concurrency import BoundedJobExecutor, JobTimeoutError, QueueFullError
from app.config import Settings
from app.schemas import (
    CompileRequest,
    ErrorResponse,
    HealthResponse,
    InverseSearchRequest,
    InverseSearchResponse,
)

logger = logging.getLogger("latex_compiler")

#: A compile function is any callable with this shape — the real one
#: (`app.compiler.run_compile_job`) shells out to pdflatex/bibtex; tests
#: inject a fake one (see tests/test_main.py) so the full FastAPI
#: request/response cycle (size validation, queue/timeout error mapping,
#: response shape) is exercised WITHOUT requiring a TeX Live install in
#: every environment that runs this test suite — mirrors evidence-
#: service/app/main.py's ModelLoader seam.
CompileFn = Callable[..., Awaitable[CompileOutcome]]
#: SyncTeX implementation — same injectable-seam convention as CompileFn
#: above, for the same reason (exercise the full request/response cycle
#: without requiring a real TeX Live install in every test environment).
InverseSearchFn = Callable[..., Awaitable[InverseSearchOutcome]]


@lru_cache
def get_settings() -> Settings:
    return Settings()


class ServiceState:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.executor = BoundedJobExecutor(
            concurrency=settings.concurrency, queue_depth=settings.queue_depth
        )


def create_app(
    *,
    settings: Settings | None = None,
    compile_fn: CompileFn | None = None,
    inverse_search_fn: InverseSearchFn | None = None,
) -> FastAPI:
    resolved_settings = settings if settings is not None else get_settings()
    resolved_compile_fn: CompileFn = compile_fn if compile_fn is not None else run_compile_job
    resolved_inverse_search_fn: InverseSearchFn = (
        inverse_search_fn if inverse_search_fn is not None else run_inverse_search_job
    )
    app = FastAPI(title="EduM8 LaTeX Compiler")
    app.state.compiler = ServiceState(resolved_settings)

    @app.get("/health", response_model=HealthResponse)
    async def health() -> HealthResponse:
        version = None
        try:
            proc = subprocess.run(
                ["pdflatex", "--version"], capture_output=True, timeout=5, text=True
            )
            version = proc.stdout.splitlines()[0] if proc.stdout else None
        except Exception:  # noqa: BLE001 — health must never crash on a probe failure
            version = None
        return HealthResponse(status="ready", pdflatex_version=version)

    @app.post(
        "/compile",
        responses={503: {"model": ErrorResponse}, 400: {"model": ErrorResponse}},
    )
    async def compile_job(payload: CompileRequest, request: Request) -> JSONResponse:
        state: ServiceState = request.app.state.compiler
        settings = state.settings

        # Part 9/12 — never trust the caller, even though the caller is
        # our own backend (defense in depth, matching evidence-service's
        # own "Do not trust caller" convention).
        if len(payload.main_tex.encode("utf-8")) > settings.max_main_tex_bytes:
            return JSONResponse(
                status_code=400,
                content=ErrorResponse(
                    error="main_tex_too_large",
                    detail=f"main.tex exceeds {settings.max_main_tex_bytes} bytes",
                ).model_dump(),
            )
        if len(payload.references_bib.encode("utf-8")) > settings.max_references_bib_bytes:
            return JSONResponse(
                status_code=400,
                content=ErrorResponse(
                    error="references_bib_too_large",
                    detail=f"references.bib exceeds {settings.max_references_bib_bytes} bytes",
                ).model_dump(),
            )

        # Milestone 5.3 Part 12/17/45 — same "never trust the caller"
        # posture, extended to the new extra_files map: count, decoded
        # size, and total decoded size are all bounded independently of
        # whatever rag-backend already enforced on its own side.
        import base64
        import binascii

        if len(payload.extra_files) > settings.max_extra_files_count:
            return JSONResponse(
                status_code=400,
                content=ErrorResponse(
                    error="too_many_extra_files",
                    detail=f"extra_files exceeds {settings.max_extra_files_count} entries",
                ).model_dump(),
            )
        decoded_extra_files: dict[str, bytes] = {}
        total_extra_bytes = 0
        for rel_path, encoded in payload.extra_files.items():
            try:
                data = base64.b64decode(encoded, validate=True)
            except (binascii.Error, ValueError):
                return JSONResponse(
                    status_code=400,
                    content=ErrorResponse(
                        error="invalid_extra_file_encoding",
                        detail=f"{rel_path!r} is not valid base64",
                    ).model_dump(),
                )
            if len(data) > settings.max_extra_file_bytes:
                return JSONResponse(
                    status_code=400,
                    content=ErrorResponse(
                        error="extra_file_too_large",
                        detail=f"{rel_path!r} exceeds {settings.max_extra_file_bytes} bytes",
                    ).model_dump(),
                )
            total_extra_bytes += len(data)
            decoded_extra_files[rel_path] = data
        if total_extra_bytes > settings.max_extra_files_total_bytes:
            return JSONResponse(
                status_code=400,
                content=ErrorResponse(
                    error="extra_files_too_large",
                    detail=f"extra_files total exceeds {settings.max_extra_files_total_bytes} bytes",
                ).model_dump(),
            )

        logger.info(
            "compile job %s admitted (extra_files=%d, extra_bytes=%d)",
            payload.job_id,
            len(decoded_extra_files),
            total_extra_bytes,
        )

        async def _job() -> CompileOutcome:
            return await resolved_compile_fn(
                main_tex=payload.main_tex,
                references_bib=payload.references_bib,
                extra_files=decoded_extra_files,
                settings=settings,
            )

        try:
            outcome = await state.executor.run(_job, timeout_seconds=settings.job_timeout_seconds)  # type: ignore[arg-type]
        except QueueFullError as exc:
            logger.info("compile job %s rejected: queue full", payload.job_id)
            return JSONResponse(
                status_code=503,
                content=ErrorResponse(error="queue_full", detail=str(exc)).model_dump(),
            )
        except JobTimeoutError:
            logger.info("compile job %s: whole-job timeout", payload.job_id)
            from app.schemas import CompileResponse, Diagnostic

            return JSONResponse(
                status_code=200,
                content=CompileResponse(
                    status="timeout",
                    diagnostics=[Diagnostic(severity="error", message="Compilation timed out.")],
                ).model_dump(),
            )

        response = to_response(outcome)  # type: ignore[arg-type]
        logger.info(
            "compile job %s finished: status=%s duration_ms=%.1f pdf_size=%s",
            payload.job_id,
            response.status,
            response.duration_ms,
            response.pdf_size_bytes,
        )
        return JSONResponse(status_code=200, content=response.model_dump())

    # SyncTeX implementation — the compiled-preview double-click ->
    # source-location inverse query. Stateless like every other endpoint
    # here: the caller (rag-backend) sends the SAME SyncTeX database it
    # already retrieved from ITS OWN artifact store (this service never
    # remembers a prior compile once /compile has returned). Never a
    # 4xx/5xx for "no reliable answer" at a given page/coordinate —
    # InverseSearchResponse.resolved=False covers that; only genuinely
    # oversized/malformed input gets a 400, matching /compile's own
    # posture toward its two size-bounded inputs.
    @app.post(
        "/inverse-search",
        responses={503: {"model": ErrorResponse}, 400: {"model": ErrorResponse}},
    )
    async def inverse_search(payload: InverseSearchRequest, request: Request) -> JSONResponse:
        state: ServiceState = request.app.state.compiler
        settings = state.settings

        import base64
        import binascii

        if len(payload.synctex_base64) > settings.max_synctex_bytes * 2:
            # A generous pre-decode length check (base64 expands ~33%) —
            # rejects a wildly oversized body before ever spending a
            # base64-decode pass on it, same "cheapest rejection first"
            # posture /compile's own size checks already take.
            return JSONResponse(
                status_code=400,
                content=ErrorResponse(
                    error="synctex_too_large",
                    detail=f"synctex_base64 exceeds {settings.max_synctex_bytes} decoded bytes",
                ).model_dump(),
            )
        try:
            synctex_bytes = base64.b64decode(payload.synctex_base64, validate=True)
        except (binascii.Error, ValueError):
            return JSONResponse(
                status_code=400,
                content=ErrorResponse(
                    error="invalid_synctex_encoding",
                    detail="synctex_base64 is not valid base64",
                ).model_dump(),
            )
        if len(synctex_bytes) > settings.max_synctex_bytes:
            return JSONResponse(
                status_code=400,
                content=ErrorResponse(
                    error="synctex_too_large",
                    detail=f"synctex_base64 exceeds {settings.max_synctex_bytes} decoded bytes",
                ).model_dump(),
            )

        async def _job() -> InverseSearchOutcome:
            return await resolved_inverse_search_fn(
                synctex_bytes=synctex_bytes,
                page=payload.page,
                x=payload.x,
                y=payload.y,
                settings=settings,
            )

        try:
            # Shares the SAME bounded executor/concurrency slot as
            # /compile — a real query is a near-instant read-only
            # operation (no TeX engine invoked at all), so this only
            # ever meaningfully queues behind an actual compile, never
            # the reverse; reusing the one already-hardened admission
            # path is simpler and safer than a second, independent one.
            outcome = await state.executor.run(  # type: ignore[arg-type]
                _job, timeout_seconds=settings.synctex_edit_timeout_seconds
            )
        except QueueFullError as exc:
            return JSONResponse(
                status_code=503,
                content=ErrorResponse(error="queue_full", detail=str(exc)).model_dump(),
            )
        except JobTimeoutError:
            return JSONResponse(
                status_code=200,
                content=InverseSearchResponse(resolved=False).model_dump(),
            )

        response = InverseSearchResponse(
            resolved=outcome.resolved, file=outcome.file, line=outcome.line
        )
        return JSONResponse(status_code=200, content=response.model_dump())

    return app


app = create_app()
