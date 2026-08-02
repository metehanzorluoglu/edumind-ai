from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app import __version__
from app.api.error_handlers import register_exception_handlers
from app.api.routes_attachments import router as attachments_router
from app.api.routes_auth import router as auth_router
from app.api.routes_chat import router as chat_router
from app.api.routes_conversations import router as conversations_router
from app.api.routes_documents import router as documents_router
from app.api.routes_health import router as health_router
from app.api.routes_images import router as images_router
from app.api.routes_projects import router as projects_router
from app.api.routes_search import router as search_router
from app.api.routes_status import router as status_router
from app.config import get_settings, refuse_dev_email_backend_in_production
from app.logging_config import configure_logging


def create_app() -> FastAPI:
    settings = get_settings()
    configure_logging(settings)
    refuse_dev_email_backend_in_production(settings)

    app = FastAPI(
        title="Education Research RAG Assistant",
        version=__version__,
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
    app.include_router(search_router)
    app.include_router(documents_router)
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
