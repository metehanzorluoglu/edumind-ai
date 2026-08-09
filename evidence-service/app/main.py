"""Milestone 11 (Evidence Service & Shadow Infrastructure Implementation)
§3/§5/§9/§12 — the stateless evidence-service FastAPI app.

Responsibilities ONLY (Milestone 11 §3): load the pinned NLI model,
classify premise/hypothesis pairs, expose readiness/liveness, enforce
concurrency limits and input validation, return structured
classifications. No database, no Qdrant, no Ollama, no user/session
logic, no conversation access, no retrieval — this process never imports
anything from rag-backend's `app.*` package and is deployed as a wholly
separate container (see README.md)."""

from __future__ import annotations

import asyncio
import logging
import os
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from functools import lru_cache

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from app.concurrency import BoundedInferenceExecutor, InferenceTimeoutError, QueueFullError
from app.config import Settings
from app.model import ModelSanityCheckFailed, NLIModel
from app.schemas import (
    ClassifyBatchRequest,
    ClassifyBatchResponse,
    ErrorResponse,
    HealthResponse,
    SourceProbabilities,
    SourceResult,
)

logger = logging.getLogger("evidence_service")


@lru_cache
def get_settings() -> Settings:
    return Settings()


class ServiceState:
    """Mutable process-wide state — model + readiness + the bounded
    executor. Held on `app.state`, not a module global, so a test can
    construct an isolated FastAPI app instance (see tests/conftest.py)."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.model: NLIModel | None = None
        self.ready = False
        self.load_error: str | None = None
        self.executor = BoundedInferenceExecutor(
            concurrency=settings.concurrency, queue_depth=settings.queue_depth
        )


#: A model loader is any zero-arg async callable returning a loaded,
#: sanity-checked NLIModel (or raising). The real one
#: (`_default_model_loader` below) does the actual torch/transformers
#: load; tests inject a fake one so the full FastAPI request/response
#: cycle (validation, concurrency, error mapping) is exercised WITHOUT
#: downloading or running the 355M-parameter model — Milestone 11 §32's
#: explicit CI requirement.
ModelLoader = Callable[[], Awaitable[NLIModel]]


async def _default_model_loader(settings: Settings) -> NLIModel:
    os.environ.setdefault("HF_HOME", settings.hf_home)
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
    model = await asyncio.to_thread(
        NLIModel.load, model_id=settings.model_id, revision=settings.model_revision
    )
    await asyncio.to_thread(model.run_sanity_check)
    return model


def _make_lifespan(settings: Settings, model_loader: ModelLoader | None):
    @asynccontextmanager
    async def _lifespan(app: FastAPI) -> AsyncIterator[None]:
        """Milestone 11 §9/§12: the model loads at startup, off the event
        loop (blocking IO/CPU work), and readiness stays False until BOTH
        the load and the startup sanity check succeed. A load or
        sanity-check failure is logged and leaves the service permanently
        not-ready (no retry loop here — an operator restarting the
        container is the intended recovery path, matching this repo's
        existing Ollama/Qdrant healthcheck conventions of "fail visibly,
        let the orchestrator restart" rather than silent background
        retries)."""
        state = ServiceState(settings)
        app.state.evidence = state

        loader = model_loader if model_loader is not None else (
            lambda: _default_model_loader(settings)
        )
        try:
            model = await loader()
        except ModelSanityCheckFailed as exc:
            logger.error("Model sanity check failed — service will report not-ready: %s", exc)
            state.load_error = str(exc)
        except Exception as exc:  # noqa: BLE001 — must never crash the process on a bad model
            logger.exception("Model load failed — service will report not-ready")
            state.load_error = f"model load failed: {exc}"
        else:
            state.model = model
            state.ready = True
            logger.info(
                "Evidence service ready (%s@%s)", settings.model_id, settings.model_revision
            )
        yield

    return _lifespan


def create_app(
    *, settings: Settings | None = None, model_loader: ModelLoader | None = None
) -> FastAPI:
    """`settings`/`model_loader` are test seams (Milestone 11 §32: "Mock
    evidence client/service in unit/integration tests") — production
    (`app = create_app()` at module bottom) uses neither, which resolves
    to the real Settings() and the real torch/transformers model load."""
    resolved_settings = settings if settings is not None else get_settings()
    app = FastAPI(
        title="EduM8 Evidence Service",
        lifespan=_make_lifespan(resolved_settings, model_loader),
    )

    @app.get("/health", response_model=HealthResponse)
    async def health(request: Request) -> HealthResponse:
        """Milestone 10 §39 / Milestone 11 §5: status/model identity
        only — never predictions, never claim/source content. Always
        returns HTTP 200 (readiness is communicated via the `ready`
        field, not the status code) so a Docker HEALTHCHECK / compose
        healthcheck can distinguish "container up but model still
        loading" from "container unreachable" — see
        deploy/oracle/docker-compose.oracle.yml's evidence-service
        healthcheck, which greps this field."""
        state: ServiceState = request.app.state.evidence
        if state.load_error is not None:
            return HealthResponse(
                status="error",
                ready=False,
                model_id=state.settings.model_id,
                model_revision=state.settings.model_revision,
                error=state.load_error,
            )
        # Reports the ACTUALLY LOADED model's own identity (state.model.*)
        # once ready, not merely the configured Settings.model_id/
        # model_revision — these are expected to match in production
        # (Settings drives what gets loaded), but reporting the loaded
        # model's own attributes is the ground truth of what inference is
        # really using, and is what a test injecting a different model
        # via `model_loader` (Milestone 11 §32) actually observes.
        model = state.model
        return HealthResponse(
            status="ready" if state.ready else "loading",
            ready=state.ready,
            model_id=model.model_id if model is not None else state.settings.model_id,
            model_revision=(
                model.model_revision if model is not None else state.settings.model_revision
            ),
        )

    @app.post(
        "/classify_batch",
        response_model=ClassifyBatchResponse,
        responses={
            400: {"model": ErrorResponse},
            503: {"model": ErrorResponse},
            504: {"model": ErrorResponse},
        },
    )
    async def classify_batch(payload: ClassifyBatchRequest, request: Request) -> JSONResponse:
        state: ServiceState = request.app.state.evidence
        settings = state.settings

        if not state.ready or state.model is None:
            return JSONResponse(
                status_code=503,
                content=ErrorResponse(
                    error="not_ready", detail="model is not loaded/ready yet"
                ).model_dump(),
            )

        # Milestone 11 §6: "Do not trust caller" — every limit enforced
        # here regardless of what the backend client is expected to send.
        if len(payload.claim) > settings.max_claim_length:
            return JSONResponse(
                status_code=400,
                content=ErrorResponse(
                    error="claim_too_long",
                    detail=f"claim exceeds {settings.max_claim_length} characters",
                ).model_dump(),
            )
        if len(payload.sources) > settings.max_sources_per_claim:
            return JSONResponse(
                status_code=400,
                content=ErrorResponse(
                    error="too_many_sources",
                    detail=f"at most {settings.max_sources_per_claim} sources per request",
                ).model_dump(),
            )
        oversized = [s.source_id for s in payload.sources if len(s.text) > settings.max_source_length]
        if oversized:
            return JSONResponse(
                status_code=400,
                content=ErrorResponse(
                    error="source_too_long",
                    detail=(
                        f"source(s) {oversized} exceed {settings.max_source_length} characters"
                    ),
                ).model_dump(),
            )

        model = state.model
        pairs = [(source.text, payload.claim) for source in payload.sources]

        async def _infer() -> tuple[list[str], list[list[float]]]:
            return await asyncio.to_thread(model.predict_batch, pairs)

        start = time.perf_counter()
        try:
            (labels, probs), _queue_wait_ms = await state.executor.run(
                _infer, timeout_seconds=settings.request_timeout_seconds
            )
        except QueueFullError as exc:
            return JSONResponse(
                status_code=503,
                content=ErrorResponse(error="queue_full", detail=str(exc)).model_dump(),
            )
        except InferenceTimeoutError as exc:
            return JSONResponse(
                status_code=504,
                content=ErrorResponse(error="timeout", detail=str(exc)).model_dump(),
            )
        latency_ms = (time.perf_counter() - start) * 1000

        idx = model.label_to_index
        results = [
            SourceResult(
                source_id=source.source_id,
                label=label.upper(),  # type: ignore[arg-type]
                probabilities=SourceProbabilities(
                    entailment=prob_row[idx["entailment"]],
                    neutral=prob_row[idx["neutral"]],
                    contradiction=prob_row[idx["contradiction"]],
                ),
            )
            for source, label, prob_row in zip(payload.sources, labels, probs, strict=True)
        ]
        response = ClassifyBatchResponse(
            results=results,
            model_id=model.model_id,
            model_revision=model.model_revision,
            latency_ms=round(latency_ms, 2),
        )
        return JSONResponse(status_code=200, content=response.model_dump())

    return app


app = create_app()
