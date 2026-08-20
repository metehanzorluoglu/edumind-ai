import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app import __version__
from app.api.error_handlers import register_exception_handlers
from app.api.routes_attachments import router as attachments_router
from app.api.routes_auth import router as auth_router
from app.api.routes_chat import router as chat_router
from app.api.routes_conversations import router as conversations_router
from app.api.routes_documents import router as documents_router
from app.api.routes_folders import router as folders_router
from app.api.routes_health import router as health_router
from app.api.routes_images import router as images_router
from app.api.routes_notebooks import router as notebooks_router
from app.api.routes_projects import router as projects_router
from app.api.routes_search import router as search_router
from app.api.routes_status import router as status_router
from app.api.routes_writing import router as writing_router
from app.api.routes_writing_context import router as writing_context_router
from app.api.routes_writing_files import router as writing_files_router
from app.api.routes_writing_import import router as writing_import_router
from app.api.routes_writing_templates import router as writing_templates_router
from app.config import get_settings, refuse_dev_email_backend_in_production
from app.core.evidence_shadow import shutdown_shadow_executor
from app.db.conversations_repository import sweep_stale_generating_messages
from app.db.session import get_session_factory
from app.logging_config import configure_logging

logger = logging.getLogger("app.startup")


@asynccontextmanager
async def _lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Startup-only: a message can only genuinely be 'generating' while
    the process that started its background worker (see
    app/core/generation_manager.py) is still alive — that in-memory
    registry never survives a restart. Any row still 'generating' when a
    *new* process starts is therefore orphaned by a prior unclean
    shutdown, not a live generation; sweeping it to 'interrupted' here
    (once, before the app accepts any request) is what keeps a stale row
    from showing an unresolvable spinner forever after a deploy/crash/
    OOM-kill."""
    session = get_session_factory()()
    try:
        swept = sweep_stale_generating_messages(session)
        if swept:
            logger.info("Swept %d stale 'generating' message(s) to 'interrupted' on startup", swept)
    finally:
        session.close()
    try:
        yield
    finally:
        # Milestone 11 §22's shutdown semantics: best-effort, non-blocking
        # — an in-flight shadow job is diagnostic-only (see
        # app/core/evidence_shadow.py) and never worth delaying process
        # shutdown for. A no-op in every deployment until a future
        # milestone turns EVIDENCE_ANALYSIS_ENABLED on.
        shutdown_shadow_executor()


def create_app() -> FastAPI:
    settings = get_settings()
    configure_logging(settings)
    refuse_dev_email_backend_in_production(settings)

    app = FastAPI(
        title="Education Research RAG Assistant",
        version=__version__,
        lifespan=_lifespan,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins_list,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    register_exception_handlers(app)

    app.include_router(health_router)
    app.include_router(auth_router)
    app.include_router(chat_router)
    app.include_router(conversations_router)
    app.include_router(projects_router)
    app.include_router(writing_router)
    app.include_router(writing_context_router)
    app.include_router(writing_files_router)
    app.include_router(writing_templates_router)
    app.include_router(writing_import_router)
    app.include_router(search_router)
    app.include_router(documents_router)
    # Folder library (Milestone 1) is always mounted, unlike images below —
    # every handler in routes_folders.py (and the two folder-aware
    # additions inside routes_documents.py) checks
    # settings.folder_library_enabled itself and 404s when it's off, since
    # one of those additions (PATCH /documents/{id}) lives on the
    # documents_router mounted just above and can't be gated by simply not
    # including a second router — see routes_folders.py's module docstring.
    app.include_router(folders_router)
    app.include_router(notebooks_router)
    app.include_router(attachments_router)
    # Image generation is wholly gated on IMAGE_GENERATION_ENABLED — when
    # disabled the router is simply not mounted, so every /images/* request
    # returns 404 (FastAPI's default for an unknown route) rather than a
    # feature-present-but-unavailable status. This is the single backend
    # source of truth the frontend mirrors via GET /status's
    # image_generation_enabled field (see app/api/routes_status.py) to hide
    # its own image-gen UI. The same flag has a defensive second gate inside
    # routes_images.py for the case where the router is included while
    # disabled (feature-test wiring); in the normal disabled path this if
    # is false and the endpoint is unreached and unmounted.
    if settings.image_generation_enabled:
        app.include_router(images_router)
    app.include_router(status_router)

    return app


app = create_app()
