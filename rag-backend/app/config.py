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
    # How many chunks app/core/document_ingestion_jobs.py groups into one
    # embedding_provider.embed_batch() call during document ingestion — was
    # a hardcoded constant (8) before this setting existed. Measured
    # directly against the live Ollama server (see the performance
    # investigation): batching barely speeds up per-item embedding time
    # (~5-8%, not a multiple — mxbai-embed-large processes a batch's items
    # essentially sequentially on this CPU-only host), so raising this
    # mainly reduces HTTP round-trip overhead and progress-log granularity,
    # not compute cost. 32 matches OllamaEmbeddingProvider's own internal
    # embed_batch() ceiling (app/core/embedding_provider.py's
    # _DEFAULT_BATCH_SIZE) exactly, so every ingestion batch becomes one
    # HTTP call instead of splitting across two.
    embedding_batch_size: int = Field(default=32, ge=1)
    # Whether the text model (qwen3:8b) runs with its "thinking" reasoning
    # trace enabled for ordinary chat turns. Off by default: on a CPU-only
    # host, thinking tokens routinely dwarf the visible answer (observed
    # ~120 hidden tokens for a one-sentence reply) and add tens of seconds
    # of latency for no user-visible benefit. Set OLLAMA_THINKING_ENABLED=true
    # to turn thinking back on globally — e.g. for a future "deep reasoning"
    # mode — without any code change; see app/core/llm_provider.py's `think`
    # parameter, which this flows into unchanged.
    ollama_thinking_enabled: bool = False
    # Caps completion length for ordinary chat turns (Ollama's `num_predict`
    # chat option — see app/core/llm_provider.py's OllamaLLMProvider, which
    # passes this through the `options` object unchanged). Unset upstream:
    # neither qwen3:8b's Modelfile nor this app previously set any limit, so
    # generation was bounded only by the model's context window — a
    # pathological/looping completion had no ceiling below that. 512 is
    # generous for a citation-grounded RAG answer (observed real completions
    # in the 25-120 token range) while still bounding the worst case. A
    # future "deep response" mode can pass a larger value by constructing
    # its own OllamaLLMProvider(options={"num_predict": N}) — this setting
    # only controls the app-wide default instance (app/deps.py::
    # get_llm_provider), not the class's own capability.
    ollama_num_predict: int = Field(default=512, ge=1)
    # Response-mode-specific override of ollama_num_predict for an
    # instructional-design request (see app/core/intent_detection.py and
    # prompt_builder.py's _INSTRUCTIONAL_DESIGN_ADDENDUM) — a full lesson/
    # unit/curriculum design covering objectives, research activities,
    # ML methodology, the engineering-design cycle, and assessment
    # genuinely needs more than an ordinary citation-grounded answer does.
    # Only applied when that intent is actually detected; every other chat
    # turn is unaffected. Raised from 512 specifically because testing
    # this feature found the *previous* (undifferentiated) 512-token cap
    # was not itself the reason lesson answers were thin — the model
    # stopped well under it, choosing brevity per the base system prompt —
    # but the new addendum explicitly asks for substantially more content
    # than 512 tokens can hold, so this is a response-shape-driven
    # increase, not a blind one. See the performance investigation for the
    # measured generation-time impact of this larger cap.
    ollama_num_predict_lesson_mode: int = Field(default=1536, ge=1)

    # Per-stage timing instrumentation (see app/core/request_timing.py) for
    # the upload and chat pipelines. Off by default: when false, every
    # instrumentation call site takes a single `if not enabled` branch and
    # returns — no timer calls, no extra logging, no response-header work.
    performance_profiling: bool = False

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
    # Bounds *time-to-first-token* only (cold model load + prompt/image
    # evaluation combined — Ollama's HTTP API gives no signal that
    # distinguishes those two phases from outside, so they cannot be
    # bounded separately here; see classify_vision_error_category's
    # docstring). Raised from the original 180.0 default based on a live
    # measurement on the Oracle CPU host (VM.Standard.A1.Flex, ARM64, 4
    # OCPUs): a single already-warm, small (640x360) screenshot alone
    # measured ~114s of prompt evaluation, and a resized 1568px-capped
    # screenshot ~232s — both already past the old 180s default with the
    # model fully warm, which is the direct cause of this task's reported
    # "did not respond in time" production error (see
    # app/core/ollama_errors.py). This value is deliberately generous
    # rather than tuned tight: see vision_generation_timeout_seconds below
    # for the tighter, separate bound on a *stalled* generation once
    # output has actually started.
    vision_request_timeout_seconds: float = Field(default=300.0, ge=1.0, le=900.0)
    # Bounds the gap between two *already-streaming* output chunks once
    # generation has started producing tokens — a materially tighter
    # budget than vision_request_timeout_seconds above, since a genuinely
    # stalled decode (as opposed to the model still evaluating the image)
    # should be detected and classified faster. Enforced via
    # asyncio.wait_for() around each chunk after the first — see
    # VisionService.stream_chat, which is why this needs
    # ollama.AsyncClient rather than the sync client the rest of this
    # settings block's single vision_request_timeout_seconds sufficed for
    # before. Not measured directly (a stalled-decode scenario isn't
    # something this task's live testing could safely reproduce against
    # the production Ollama instance) — 60s is a conservative multiple of
    # the ~4-5 tokens/second decode rate actually observed during live
    # measurement (worst case ~15s/token), left generous on purpose.
    vision_generation_timeout_seconds: float = Field(default=60.0, ge=1.0, le=300.0)
    # Longest side (pixels) a PNG/JPEG image sent to the vision model may
    # have — downscaled if larger (milestone V4: directly reduces request
    # size and generation latency; see
    # app/services/vision_service.py's render_attachments_to_images).
    # Lowered from the original 1568 default based on the same live
    # measurement referenced above: prompt-eval time tracks image token
    # count, which tracks pixel count — a 640x360 (230K px) image produced
    # 1061 vision tokens / ~114s, while a 1568x882 (1.38M px) image
    # produced 1821 tokens / ~232s. 1024 cuts worst-case pixel area by
    # more than half versus 1568 while remaining large enough to keep
    # document body text and typical screenshot UI legible (the
    # long-standing common guidance this default originally followed).
    vision_max_image_dimension: int = Field(default=1024, ge=256, le=4096)
    # Caps total decoded pixels for one *original* (pre-resize) image —
    # checked immediately after decode, before the (comparatively
    # expensive) resize step runs, so a decompression-bomb-style upload
    # (a small file that decodes to an enormous pixmap) is rejected
    # cheaply rather than after doing real work on it. Independent of
    # vision_max_image_dimension: that setting bounds the *processed*
    # image's side length; this bounds the *original* image's total pixel
    # count before any resizing has happened. 20 megapixels comfortably
    # covers any real photo/screenshot upload (a 24MP camera photo is an
    # outlier this app has no reason to accept whole) while still catching
    # a pathological aspect ratio (e.g. 1x50,000,000) that a side-length
    # cap alone would miss.
    vision_max_image_pixels: int = Field(default=20_000_000, ge=100_000)
    # Sum of every image/page's pixel count in one request, checked after
    # PDF rendering (each rendered page counts too) — bounds the
    # aggregate vision-encoder workload for a multi-image/multi-page
    # message, which vision_max_images_per_message/vision_max_pdf_pages
    # alone do not: four maximally-sized images individually under
    # vision_max_image_pixels could still sum to an enormous combined
    # workload without this check.
    vision_max_total_pixels: int = Field(default=60_000_000, ge=100_000)
    # Caps the vision system+user prompt's combined character count
    # (query + retrieved-source text + project context, when the "use my
    # corpus" toggle is on) — mirrors context_max_total_chars' role for
    # the text pipeline. Checked before calling Ollama at all (see
    # app/api/routes_conversations.py), so an oversized prompt is rejected
    # with a clear error rather than adding avoidable text-token
    # evaluation time on top of an already-expensive image evaluation.
    vision_max_prompt_chars: int = Field(default=20_000, ge=100)
    # Caps completion length for a vision reply (Ollama's `num_predict`
    # chat option) — mirrors ollama_num_predict's role for the text
    # pipeline (see app/core/llm_provider.py). Vision had no cap at all
    # before this: an unbounded completion is a worse risk here than for
    # text, since vision decode was measured at only ~4-5 tokens/second on
    # this CPU host (vs. the text model's own separately-measured ~4-5
    # tokens/second too, coincidentally similar on this host) — either
    # way, a runaway completion has no ceiling below the model's context
    # window without this.
    vision_num_predict: int = Field(default=512, ge=1)

    # --- Batched PDF analysis (see app/services/pdf_batch_planner.py and
    # app/services/vision_batch_orchestrator.py). Only used for a PDF
    # attachment with no explicit page range whose page count doesn't fit
    # in a single vision call — see _handle_conversation_message in
    # app/api/routes_conversations.py for the "batch or single-call"
    # decision. A document that fits in one batch is entirely unaffected
    # by this block and keeps using the older single-call
    # render_attachments_to_images path (vision_max_pdf_pages/
    # vision_max_images_per_message above), so today's latency/UX for an
    # ordinary short attachment doesn't change.
    #
    # Pages per batch — clamped at request time to
    # min(vision_batch_pages_per_batch, vision_max_images_per_message) so
    # a vision-mode batch can never exceed the one hard ceiling that
    # actually matters for a single Ollama vision call (how many images it
    # may take at once); a text-mode batch (no images at all — see the
    # planner's docstring) doesn't strictly need this cap but shares it
    # for one predictable batch size either way.
    vision_batch_pages_per_batch: int = Field(default=8, ge=1, le=20)
    # Safety ceiling on how many of a document's pages are ever analyzed
    # for one message — NOT a rejection threshold (see
    # chat_attachment_max_pdf_pages below for the separate upload-time
    # limit): a document longer than this is still accepted and processed,
    # just truncated to its first N pages, with that fact surfaced
    # honestly in the final answer (see build_reduce_prompt's
    # `truncated_at_page`) rather than silently ignored. Sized well above
    # a typical book/dissertation/report's length; an operator processing
    # routinely longer documents may raise it.
    vision_batch_max_pages: int = Field(default=500, ge=1, le=5000)
    # Extra attempts for one batch's analysis call after its first
    # attempt fails (a transient Ollama timeout/overload) — retries only
    # that batch, never the whole document (see
    # vision_batch_orchestrator.py's module docstring). 0 disables retrying
    # entirely (fail a batch on its first error).
    vision_batch_max_retries: int = Field(default=2, ge=0, le=5)
    # A page needs at least this many extracted characters (and no
    # embedded image) to be analyzed as plain text instead of being
    # rendered and sent to the vision model — see
    # pdf_batch_planner.PageClassification's docstring for the full
    # text-vs-vision decision. Low enough to accept a short paragraph or
    # caption-only page as text, high enough to not mistake a page number
    # or running header for real body content.
    vision_batch_text_min_chars: int = Field(default=40, ge=1)

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
    # Upload-time acceptance limit only — how many pages a PDF may have to
    # be attached at all, checked once by validate_attachment before it's
    # ever stored. Deliberately generous (a full book/dissertation/report
    # fits comfortably): this app no longer rejects a long PDF outright
    # for being long — see app/services/pdf_batch_planner.py and
    # vision_batch_max_pages above for the *separate* ceiling on how many
    # of those pages actually get analyzed once the message is sent. Was
    # 50 before the batched-analysis pipeline existed, back when this was
    # also the effective analysis limit; raised now that analysis itself
    # scales past whatever a single vision call could hold.
    chat_attachment_max_pdf_pages: int = Field(default=2000, ge=1, le=5000)
    # HEIC is explicitly optional per the milestone spec, and pymupdf (this
    # project's only imaging dependency) cannot decode it — it can only be
    # validated by file signature, and its EXIF cannot practically be
    # stripped (see app/services/attachment_storage.py). Off by default.
    chat_attachment_allow_heic: bool = False

    # --- Original document file storage (Frontend Milestone 3.1: Original
    # Document Reader) — see app/services/document_file_storage.py.
    # Deliberately a separate directory from chat_attachments_dir above:
    # different lifecycle (deleted only when the owning document itself is
    # deleted, never per-message), different retention expectations, and
    # kept distinct so an operator's backup/retention policy can treat "RAG
    # corpus originals" and "chat attachments" differently if desired.
    document_storage_dir: str = "./data/document-files"

    # --- Rate limiting (milestone V4) — protects the one endpoint that
    # calls an LLM (POST /conversations/{id}/messages, text or vision)
    # from being flooded by a single caller. In-memory only, per-process
    # — see app/core/rate_limiter.py's module docstring for why that's an
    # accepted tradeoff here, not an oversight.
    chat_rate_limit_max_requests: int = Field(default=20, ge=1, le=1000)
    chat_rate_limit_window_seconds: float = Field(default=60.0, ge=1.0, le=3600.0)

    # --- Document library / folder management (Milestone 1) ---
    # Kill switch for the whole feature: when False, POST /folders, PATCH
    # /folders/{id}, DELETE /folders/{id}, GET /folders/contents, and
    # PATCH /documents/{id} (move) all 404 (see the `_require_enabled`
    # check each of those handlers runs — app/api/routes_folders.py and
    # app/api/routes_documents.py), any `folder_id` passed to POST
    # /documents is ignored (the upload behaves exactly as it did before
    # this milestone), and the frontend falls back to the flat Documents
    # list it mirrors from GET /status's folder_library_enabled field (see
    # app/api/routes_status.py) — no separate frontend build flag decides
    # this, matching FeatureFlags.tsx's existing "/status is the source of
    # truth" rule for imageGenerator. True by default: unlike image
    # generation (which depends on an extra Ollama model being pulled),
    # folder organization is pure SQL metadata with no extra runtime
    # dependency, so there's no reason to ship it off. Deliberately named
    # without an app-specific prefix, unlike this project's other ~30
    # existing settings (IMAGE_GENERATION_ENABLED, VISION_ENABLED, etc.) —
    # see the Milestone 1 report for why an EDUM8_-prefixed name was
    # considered and rejected as inconsistent with every flag already here.
    folder_library_enabled: bool = True

    # --- Conversation document scope (Milestone 2) ---
    # Gates only the bulk selection-management surface this milestone adds
    # (GET .../documents list, POST .../documents bulk-add, PUT
    # .../documents replace) — see
    # app/api/routes_conversations.py's _require_conversation_scope_enabled.
    # Deliberately does NOT gate DELETE .../documents/{id} or the
    # GET/PATCH .../scope toggle-bar endpoints: those (and retrieval's own
    # consumption of conversation_documents via app/core/scoped_retrieval.py)
    # already shipped, unconditional, in an earlier ("contextual research
    # scopes" / "research workspace") milestone — this flag is a rollback
    # switch for what's new here, not a way to regress what already
    # worked. True by default: like folder_library_enabled, this is pure
    # SQL + a payload resync with no extra runtime dependency to justify
    # shipping it off. Named without an app-specific prefix for the same
    # reason folder_library_enabled is — see that setting's docstring.
    conversation_scope_enabled: bool = True

    # --- Zoom-In / strict selected-source mode (Milestone 4) ---
    # Deliberately a SEPARATE flag from conversation_scope_enabled above,
    # not a reuse of it: conversation_scope_enabled gates ordinary
    # (non-exclusive) "prioritize these sources" selection, which can stay
    # on for every user even while Zoom-In itself is being rolled out or
    # rolled back independently — see the Milestone 4 report for why
    # overloading the existing flag was considered and rejected. Gates only
    # the ability to ever SET conversation_scope_settings.zoom_in_mode=True
    # (see app/api/routes_conversations.py's `_require_zoom_in_enabled`,
    # called only when a PATCH .../scope request actually touches
    # zoom_in_mode) — a conversation already in Zoom-In mode when this flag
    # is turned off keeps that stored setting and keeps retrieving strictly
    # (never silently widened back to Prioritize/General without the user
    # explicitly turning it off), but no NEW conversation can enter Zoom-In
    # while the flag is off, and GET .../scope keeps reporting the true
    # persisted value regardless — same "backend enforces the boundary,
    # frontend only hides the entry point" split as folder_library_enabled/
    # conversation_scope_enabled above. True by default: pure SQL + the
    # exact same scoped-retrieval mechanism already shipped in Milestone 2/
    # 3, no new runtime dependency to justify shipping it off. Deliberately
    # named without an app-specific prefix, matching this project's other
    # ~30 unprefixed flags (see folder_library_enabled's docstring for why
    # an EDUM8_-prefixed name was considered and rejected).
    zoom_in_enabled: bool = True

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

    # --- Auth: local email/password credentials ---
    # Kill switch for POST /auth/register and POST /auth/login — separate
    # from OAuth provider configuration entirely (see
    # ProvidersResponse.local_auth_enabled), so an operator who wants
    # Google-only sign-in can disable local auth without touching any OAuth
    # setting. True by default: unlike a provider, local auth has no
    # external credentials to configure, so it works out of the box.
    auth_local_login_enabled: bool = True
    # Sliding-window limits for POST /auth/login and POST /auth/register
    # (see app/core/auth_rate_limiter.py) — deliberately separate settings
    # per route: login is attempted far more often in normal use (a typo'd
    # password) than registration, so it gets a shorter window and more
    # allowed attempts.
    auth_login_rate_limit_max_attempts: int = Field(default=10, ge=1, le=1000)
    auth_login_rate_limit_window_seconds: float = Field(default=300.0, ge=1.0, le=86_400.0)
    auth_register_rate_limit_max_attempts: int = Field(default=5, ge=1, le=1000)
    auth_register_rate_limit_window_seconds: float = Field(default=3600.0, ge=1.0, le=86_400.0)
    # Sliding-window limits for POST /auth/verify-email (token-guessing
    # brute force) and POST /auth/resend-verification (mail-bombing an
    # address) — see app/core/auth_rate_limiter.py, same DB-backed
    # mechanism as login/register above.
    auth_verify_rate_limit_max_attempts: int = Field(default=10, ge=1, le=1000)
    auth_verify_rate_limit_window_seconds: float = Field(default=900.0, ge=1.0, le=86_400.0)
    auth_resend_verification_rate_limit_max_attempts: int = Field(default=3, ge=1, le=1000)
    auth_resend_verification_rate_limit_window_seconds: float = Field(
        default=3600.0, ge=1.0, le=86_400.0
    )

    # --- Auth: email verification ---
    # Whether a newly-registered local account must confirm its email
    # before POST /auth/login will issue real tokens for it (see
    # app/core/verification_service.py). True by default — the
    # entire point of this feature; a self-hosted single-operator
    # deployment that doesn't want the friction may set this false.
    # Never affects OAuth accounts, which get their verified-email
    # status directly from the provider (see upsert_user_from_identity).
    auth_email_verification_required: bool = True

    # --- Email delivery (verification, and any future password-reset) ---
    # "console" (default) never actually delivers anything — it only logs
    # a subject/recipient line (see app/core/email_provider.py's
    # ConsoleEmailProvider) — and is hard-refused whenever
    # app_env=="production" by the validator below, so a misconfigured
    # production deploy can never silently ship "verification emails are
    # never delivered." Switch to "smtp" and fill in SMTP_* to send real
    # mail.
    email_provider: Literal["console", "smtp"] = "console"
    email_from_name: str = "EduM8"
    email_from_address: str = "no-reply@example.com"
    email_verification_token_ttl_minutes: int = Field(default=60, ge=1, le=1440)
    email_verification_resend_cooldown_seconds: int = Field(default=60, ge=1, le=3600)

    smtp_host: str = ""
    smtp_port: int = Field(default=587, ge=1, le=65535)
    smtp_username: str = ""
    smtp_password: str = ""
    smtp_use_tls: bool = True

    # Optional: a user id (UUID string) to backfill onto pre-existing,
    # unowned Qdrant points/documents from before per-user scoping existed
    # (see `python -m cli.documents adopt-legacy`). Left blank by default —
    # legacy documents are simply hidden (never exposed globally) until an
    # operator explicitly opts to assign them to one dev user.
    dev_legacy_owner_user_id: str = ""

    frontend_url: str = "http://localhost:8081"
    # This backend's own publicly-reachable base URL — needed to build an
    # absolute verification-email link (GET {backend_public_url}/auth/
    # verify-email?token=...). Not derivable from the incoming request
    # (Request.base_url) because this deployment's uvicorn runs without
    # --proxy-headers (see deploy/oracle/docker-compose.oracle.yml), so it
    # only ever sees Caddy's own loopback connection, never the real
    # public scheme/host Cloudflare + Caddy terminate for callers.
    backend_public_url: str = "http://localhost:8000"

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

    # --- RAG prompt shape (Oracle CPU-host prompt-prefill investigation)
    # — a live measurement found qwen3:8b prompt evaluation the dominant
    # cost of a chat turn (161.9s of a 198.2s total for a 2,640-token
    # prompt, ~16.3 tokens/second prefill throughput on this CPU-only ARM
    # host). Both settings below default to this codebase's original,
    # unchanged behavior; see app/core/prompt_builder.py and
    # app/core/context_preparation.py for what each variant actually
    # changes and why. Neither is a model change — same qwen3:8b, same
    # retrieval results, only the prompt's own text and chunk order.
    rag_prompt_variant: Literal["current", "compact"] = "current"
    rag_source_order: Literal["relevance", "stable"] = "relevance"

    # --- Evidence analysis / NLI shadow infrastructure (Milestone 11) ---
    # Master kill switch, checked FIRST by
    # app/core/evidence_eligibility.py's evidence_analysis_eligible()
    # before anything else — false means zero evidence-service calls,
    # zero eligibility computation cost beyond this one boolean read, for
    # every request. Milestone 11's own explicit PO instruction: this
    # milestone builds and validates the shadow infrastructure but must
    # NOT turn it on — this flag ships false, and stays false in
    # deploy/oracle/.env.oracle, until a human operator changes it after
    # reviewing this milestone's report (see the Milestone 11 report §25/
    # §28). Never redefine the default to true without that explicit,
    # separate decision.
    evidence_analysis_enabled: bool = False
    # "shadow" is the only mode with any implemented behavior in this
    # milestone (Milestone 11 §24 explicitly forbids implementing
    # "zoom_in_enforced" — see app/core/evidence_eligibility.py, which
    # treats that value identically to "off"). The enum value exists now
    # so a future milestone can add real behavior for it without another
    # schema migration.
    evidence_analysis_mode: Literal["off", "shadow", "zoom_in_enforced"] = "off"
    # Milestone 10 §37's approved starting value (5%) — irrelevant while
    # evidence_analysis_enabled is false, but validated (see the
    # model_validator below) so an operator who does flip the master
    # switch on can't also hand it a nonsensical rate by typo.
    evidence_analysis_sample_rate: float = Field(default=0.05, ge=0.0, le=1.0)
    # Internal Docker-network-only URL — see
    # deploy/oracle/docker-compose.oracle.yml's evidence-service block
    # (no host-published port; reachable only from the backend container
    # by its compose service name). The default matches that service
    # name/port for same-compose-stack use; overridden in .env.oracle only
    # if the service is ever renamed.
    evidence_service_url: str = "http://evidence-service:8100"
    # Milestone 10 §30's approved value — the BACKEND's own client-side
    # budget; the service's own internal timeout
    # (evidence-service/app/config.py's request_timeout_seconds) is set
    # slightly lower so the service's own overload/timeout response
    # reaches the client before this deadline would otherwise fire first.
    evidence_service_timeout_ms: int = Field(default=2500, ge=1)
    # --- Milestone 11.2: contention-aware shadow scheduling ---
    # Adopted for the initial shadow rollout specifically (Milestone 11.2
    # §25) — deliberately lower than the claim transformer's own 2-claim
    # structural capability (MULTI_CLAIM questions, see
    # app/core/claim_transformer.py). A 2-claim shadow job costs roughly
    # 2x the CPU time of a 1-claim one (two independent, sequential
    # evidence-service calls — see the Milestone 11.1 report §13/§22),
    # and this value directly controls that cost during the phase where
    # the goal is proving the scheduling approach is safe, not maximizing
    # coverage. A question producing more claims than this is bypassed
    # entirely (never partially analyzed) — see
    # app/core/evidence_shadow.py. Revisit upward only after the initial
    # phase's real data supports it (Milestone 11.1 §14 / Milestone 11.2
    # §25's own framing: "This can be revisited later").
    evidence_analysis_max_claims: int = Field(default=1, ge=1, le=2)
    # How long generation must be CONTINUOUSLY idle (host-wide — see
    # app/core/generation_activity.py) before a deferred shadow job is
    # allowed to start — reduces (but, per Milestone 11.2 §8/§9, can
    # never fully eliminate) the chance a new generation starts at almost
    # the exact moment NLI begins. Milestone 11.2 §7's controlled 0s/1s/2s
    # experiment; see that milestone's report for the measured
    # justification of this specific default.
    evidence_shadow_idle_grace_seconds: float = Field(default=1.0, ge=0.0, le=10.0)
    # A diagnostic shadow job that can't find a genuinely idle window
    # within this long is dropped outright (Milestone 11.2 §11) rather
    # than run late against stale diagnostic relevance — recorded as
    # `busy_drop`, never silently discarded without a metric.
    evidence_shadow_max_defer_seconds: float = Field(default=30.0, gt=0.0, le=300.0)

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


def refuse_dev_email_backend_in_production(settings: Settings) -> None:
    """Refuses to start the real application process with the
    non-delivering dev email backend in production — called from
    app/main.py's create_app(), mirrors app/api/routes_auth.py's
    `_dev_login_available` pattern (a plain runtime check tied to the
    actual app_env=="production" case, not a pydantic Settings-level
    constraint, which would also fire for every ad-hoc
    `Settings(app_env="production", ...)` built in tests for unrelated
    reasons elsewhere in this codebase — see tests/unit/api/
    test_routes_auth.py). A misconfigured *email* setting would otherwise
    silently leave every new local user permanently unable to verify
    their account — worse than a loud crash on boot. Deliberately a
    plain function (not itself decorated as a Settings validator) so it
    can be unit-tested (tests/unit/test_main.py) without importing
    app.main, which would otherwise trigger this exact check via its own
    module-level `app = create_app()`.
    """
    if settings.app_env == "production" and settings.email_provider == "console":
        raise RuntimeError(
            "EMAIL_PROVIDER=console (the non-delivering dev backend) is refused when "
            "APP_ENV=production. Set EMAIL_PROVIDER=smtp and configure SMTP_HOST/"
            "SMTP_USERNAME/SMTP_PASSWORD before deploying, or verification emails would "
            "silently never be delivered."
        )
