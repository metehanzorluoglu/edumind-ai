from datetime import datetime

from pydantic import BaseModel


class StatusResponse(BaseModel):
    """GET /status — deliberately excludes raw document text, filesystem
    paths, API keys, private environment variables, and system prompts
    (see app/api/routes_status.py). Protected: requires Authorization,
    unlike /health and /health/ready."""

    backend_reachable: bool
    ollama_reachable: bool
    qdrant_reachable: bool
    generation_model: str
    embedding_model: str
    document_count: int
    chunk_count: int
    document_type_counts: dict[str, int]
    last_ingestion_at: datetime | None
    relevance_threshold_enabled: bool
    # --- Vision (milestone V1) ---
    vision_enabled: bool
    vision_model: str | None
    vision_model_available: bool | None
    # --- Image generation (milestone IG) ---
    # The backend's single source of truth a disabled frontend reads to hide
    # every image-gen UI affordance automatically (its router is not even
    # mounted when this is false — see app/main.py). Mirrors vision_enabled's
    # "expose a boolean the app gates on" contract, just for the opposite
    # direction (this writes images; vision reads them).
    image_generation_enabled: bool
    # --- Document library / folder management (Milestone 1) ---
    # The backend's single source of truth the frontend reads to fall back
    # to the pre-Milestone-1 flat Documents list when this is false — see
    # app/config.py's `folder_library_enabled` for the full flag reasoning.
    folder_library_enabled: bool
    # --- Conversation document scope (Milestone 2) ---
    conversation_scope_enabled: bool
    # --- Zoom-In / strict selected-source mode (Milestone 4) ---
    zoom_in_enabled: bool
    # --- Developer/Settings page (milestone V4): availability for every
    # model this backend can call, and how long the one Ollama round trip
    # this check makes took — see app/core/readiness.py. Latency is null
    # exactly when ollama_reachable is False (nothing to time).
    text_model_available: bool
    embedding_model_available: bool
    ollama_latency_ms: float | None
    qdrant_latency_ms: float | None
