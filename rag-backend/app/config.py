from functools import lru_cache
from typing import Literal

from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    app_env: Literal["development", "test", "production"] = "development"
    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"] = "INFO"
    host: str = "0.0.0.0"
    port: int = Field(default=8000, ge=1, le=65535)

    # Plain string, not list[str]: pydantic-settings attempts a JSON decode of any
    # complex-typed field read from the environment/.env before validators run, which
    # rejects a plain comma-separated value. Keep the raw field a str and split via
    # the cors_origins_list property instead.
    #
    # Default covers every origin this repo's own dev setup can be opened
    # from: this machine on either loopback spelling, a second LAN machine
    # on whichever port Expo's web dev server actually bound to (8081, or
    # 8082 if 8081 was taken), and that LAN machine's bare/no-port origin
    # (see .env.example's CORS_ORIGINS comment for the full reasoning).
    cors_origins: str = (
        "http://localhost:8081,http://localhost:8082,http://127.0.0.1:8081,"
        "http://192.168.0.99,http://192.168.0.99:8081,http://192.168.0.99:8082"
    )

    ollama_base_url: str = "http://localhost:11434"
    ollama_llm_model: str = "qwen3:8b"
    ollama_embed_model: str = "mxbai-embed-large"

    # --- Vision (milestone V1: image/PDF-page understanding via a
    # dedicated vision-capable model, alongside — never instead of — the
    # existing text model above). See app/services/vision_service.py and
    # app/core/model_routing.py.
    vision_enabled: bool = True
    ollama_vision_model: str = "qwen2.5vl:7b"
    # Caps the number of images a single message/request may attach —
    # bounds both request size and how many images get sent to the vision
    # model in one call.
    vision_max_images_per_message: int = Field(default=4, ge=1, le=20)
    # Per-image size ceiling in bytes (10 MiB default) — rejected before any
    # resize/decode attempt, so an oversized upload fails fast and cheaply
    # rather than after doing real work on it.
    vision_max_image_bytes: int = Field(default=10_485_760, ge=1024)
    # Upper bound on how many pages of one PDF get rendered to images in a
    # single request — a large document attached whole could otherwise
    # render (and then send to the vision model) hundreds of pages.
    vision_max_pdf_pages: int = Field(default=10, ge=1, le=100)
    # Vision inference is slower than text generation (larger multimodal
    # forward pass per image) — a longer default timeout than a bare text
    # chat call would use, still bounded so a truly stuck request fails
    # instead of hanging the connection indefinitely.
    vision_request_timeout_seconds: float = Field(default=180.0, ge=1.0, le=600.0)
    # Longest side (pixels) a PNG/JPEG image sent to the vision model may
    # have — downscaled if larger (milestone V4: directly reduces request
    # size and generation latency; see
    # app/services/vision_service.py's render_attachments_to_images). The
    # default matches common multimodal-model guidance for where
    # additional resolution stops improving output.
    vision_max_image_dimension: int = Field(default=1568, ge=256, le=4096)

    # --- Image generation (Ollama x/flux2-klein by default) — writes new
    # images from a text prompt, the opposite direction of vision_enabled
    # above (qwen2.5vl reads an uploaded image; this generates a fresh one).
    # Deliberately a separate model/flag from every OLLAMA_*/VISION_* setting
    # above: see app/core/image_generation_service.py's module docstring for
    # why the two are never routed through the same client or model.
    image_generation_enabled: bool = True
    ollama_image_model: str = "x/flux2-klein"
    # Bounds each individual image's HTTP call to Ollama (image_generation_
    # service.py's ImageGenerationService, an httpx.Client timeout) — never
    # a shared budget across a whole num_images batch, since each image is
    # its own request. Generating one image commonly takes tens of seconds
    # and can run well past a minute on a cold model or larger dimensions,
    # which is why this defaults far higher than vision_request_timeout_
    # seconds — bounded so a truly stuck request still fails instead of
    # hanging the connection indefinitely.
    image_generation_request_timeout_seconds: float = Field(default=300.0, ge=1.0, le=1800.0)
    # Caps POST /images/generate's num_images per request — bounds both
    # request latency (images are generated one at a time, see
    # ImageGenerationService.generate) and how much a single call can load
    # the Ollama server.
    image_generation_max_images: int = Field(default=4, ge=1, le=10)
    # A generated image becomes a real MessageAttachment row
    # (source="generated") once persisted, stored via the very same
    # AttachmentStorage instance (CHAT_ATTACHMENTS_DIR below) as an
    # uploaded attachment — not a separate directory: every attachment
    # content-serving/deletion code path (GET .../attachments/{id},
    # ConversationsRepository.delete) reads through that one storage
    # instance, so a generated image must live there too to be found again.

    # --- Chat attachments (milestone V2: users may attach images/PDFs to a
    # chat message, stored for possible future vision-model use — never
    # auto-ingested into the RAG corpus; see
    # app/services/attachment_storage.py and MessageAttachment in
    # app/db/models_conversations.py). Deliberately a separate settings
    # block from VISION_* above: those bound what a single vision-model
    # call may process; these bound what a user may upload and store,
    # which happens whether or not vision is ever invoked on it.
    chat_attachments_dir: str = "./data/chat-attachments"
    chat_attachment_max_bytes: int = Field(default=10_485_760, ge=1024)
    chat_attachment_max_files_per_message: int = Field(default=5, ge=1, le=20)
    chat_attachment_max_pdf_pages: int = Field(default=50, ge=1, le=500)
    # HEIC is explicitly optional per the milestone spec, and pymupdf (this
    # project's only imaging dependency) cannot decode it — it can only be
    # validated by file signature, and its EXIF cannot practically be
    # stripped (see app/services/attachment_storage.py). Off by default.
    chat_attachment_allow_heic: bool = False

    # --- Rate limiting (milestone V4) — protects the one endpoint that
    # calls an LLM (POST /conversations/{id}/messages, text or vision)
    # from being flooded by a single caller. In-memory only, per-process
    # — see app/core/rate_limiter.py's module docstring for why that's an
    # accepted tradeoff here, not an oversight.
    chat_rate_limit_max_requests: int = Field(default=20, ge=1, le=1000)
    chat_rate_limit_window_seconds: float = Field(default=60.0, ge=1.0, le=3600.0)

    qdrant_mode: Literal["local", "server"] = "local"
    qdrant_path: str = "./data/qdrant_storage"
    qdrant_url: str = "http://localhost:6333"
    qdrant_collection_name: str = "education_research"

    # --- Database (auth, conversations, per-user document metadata) ---
    # SQLite by default for local dev — no extra infra required, matching
    # this project's existing "no Docker required" posture. Postgres in
    # production is a pure config change: every model uses dialect-portable
    # SQLAlchemy types (Uuid, DateTime(timezone=True), String), not any
    # SQLite-only or Postgres-only column type.
    database_url: str = "sqlite:///./data/app.db"

    # --- Auth: JWT access tokens + opaque refresh tokens ---
    jwt_secret: str = Field(min_length=16)
    jwt_access_ttl_minutes: int = Field(default=15, ge=1, le=1440)
    refresh_token_ttl_days: int = Field(default=30, ge=1, le=365)

    # --- Auth: OAuth providers ---
    # Client secrets are read here (server-side only) and never returned to
    # any API response — GET /auth/providers reports only which providers
    # are configured (client_id present), never the secret itself.
    google_client_id: str = ""
    google_client_secret: str = ""
    google_redirect_uri: str = ""

    facebook_client_id: str = ""
    facebook_client_secret: str = ""
    facebook_redirect_uri: str = ""

    linkedin_client_id: str = ""
    linkedin_client_secret: str = ""
    linkedin_redirect_uri: str = ""

    # Comma-separated allowlist of app-side redirect_uri values GET
    # /auth/{provider}/authorize is permitted to send the user back to after
    # login (custom URL scheme for native, same-origin web route for web) —
    # never an open redirect to an arbitrary caller-supplied URI.
    allowed_auth_redirect_uris: str = (
        "expoeducationassistant://auth-callback,http://localhost:8081/auth-callback"
    )

    # --- Auth: dev-only test login (see app/api/routes_auth.py) ---
    # Disabled by default. Hard-refused at startup and per-request whenever
    # app_env == "production", regardless of this flag's value, so a
    # misconfigured production deploy can never expose it.
    auth_dev_login_enabled: bool = False

    # Optional: a user id (UUID string) to backfill onto pre-existing,
    # unowned Qdrant points/documents from before per-user scoping existed
    # (see `python -m cli.documents adopt-legacy`). Left blank by default —
    # legacy documents are simply hidden (never exposed globally) until an
    # operator explicitly opts to assign them to one dev user.
    dev_legacy_owner_user_id: str = ""

    frontend_url: str = "http://localhost:8081"

    # --- Retrieval / context-preparation tuning (milestone 8 §9) ---
    # Defaults below are exactly the values that were previously hardcoded
    # constants in app/core/retriever.py, app/core/context_preparation.py and
    # app/core/rag_service.py — moving them here does not change any current
    # behavior; it only makes them overridable without a code change.
    retrieval_top_k: int = Field(default=8, ge=1, le=50)
    # Per-tier budgets for scope-aware retrieval (contextual-research-scopes
    # milestone) — chat-scope and project-scope documents each get their
    # own top_k, separate from retrieval_top_k (which is reused unchanged
    # as the general-corpus tier's budget, so a conversation with no scope
    # associations behaves exactly as before this feature existed). See
    # app/core/scoped_retrieval.py.
    retrieval_chat_scope_top_k: int = Field(default=5, ge=1, le=50)
    retrieval_project_scope_top_k: int = Field(default=5, ge=1, le=50)
    retrieval_fetch_k: int = Field(default=24, ge=1, le=200)
    retrieval_mmr_relevance_weight: float = Field(default=0.7, ge=0.0, le=1.0)
    # Disabled by default (None): milestone 6/7 documented that the backend has
    # no relevance threshold. Only set this once a real evaluation corpus has
    # calibrated a value for the actual embedding model + corpus in use — see
    # milestone 8 §8 / scripts/calibrate_threshold.py. A score is cosine
    # similarity in [0, 1] (this system's only supported distance metric).
    retrieval_min_score: float | None = Field(default=None, ge=0.0, le=1.0)

    context_max_chunks_per_document: int = Field(default=3, ge=1, le=50)
    context_max_total_chars: int = Field(default=8000, ge=500, le=100_000)
    context_dedup_similarity_threshold: float = Field(default=0.92, ge=0.0, le=1.0)

    @field_validator("retrieval_min_score", mode="before")
    @classmethod
    def _blank_env_value_means_disabled(cls, value: object) -> object:
        # RETRIEVAL_MIN_SCORE= (empty) in a .env file must mean "disabled", not
        # a validation error — this is the documented way to leave it off.
        if isinstance(value, str) and value.strip() == "":
            return None
        return value

    @model_validator(mode="after")
    def _validate_retrieval_ranges(self) -> "Settings":
        if self.retrieval_fetch_k < self.retrieval_top_k:
            raise ValueError(
                "retrieval_fetch_k "
                f"({self.retrieval_fetch_k}) must be >= retrieval_top_k ({self.retrieval_top_k}): "
                "the candidate pool fed into MMR selection cannot be smaller than what MMR "
                "must return."
            )
        return self

    @property
    def cors_origins_list(self) -> list[str]:
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]

    @property
    def allowed_auth_redirect_uris_list(self) -> list[str]:
        return [uri.strip() for uri in self.allowed_auth_redirect_uris.split(",") if uri.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
