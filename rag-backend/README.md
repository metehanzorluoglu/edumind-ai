# RAG Backend — Education Research Assistant

Local-first Retrieval-Augmented-Generation backend for a private collection of Q1/Q2 education
journal articles, practitioner articles, policy documents, reports, and curriculum documents.
Serves the Expo React Native (iOS/Android) app as its API layer.

Full architecture, hardware/model rationale, and design decisions live in
[`../IMPLEMENTATION_PLAN.md`](../IMPLEMENTATION_PLAN.md) — this README covers setup and day-to-day
commands only.

**Status:** Milestones 1–6 complete — full ingestion, chunking, embedding, retrieval, grounded
generation with citations, and the FastAPI layer are implemented and tested (see commit history
for the milestone-by-milestone record). Milestone 7 adds a TypeScript client SDK and Expo example
app in `../packages/education-assistant-client/` and `../examples/expo-education-assistant/`.
Milestone 8 adds real-corpus ingestion/management CLIs (`cli/ingest.py`, `cli/documents.py`,
`cli/privacy_scan.py`), an evaluation harness (`scripts/eval_retrieval.py`,
`scripts/eval_answers.py`, `scripts/calibrate_threshold.py` — see `../evaluation/README.md`),
env-driven retrieval configuration, and backup/restore scripts. **No real corpus has been
ingested yet** — `data/raw/` is empty and `RETRIEVAL_MIN_SCORE` stays disabled until a real
evaluation corpus calibrates it; see the milestone 8 completion report for what's pending.

Milestones V1–V4 add a full vision (image/PDF) experience on top of chat: a vision-capable Ollama
model (`qwen2.5vl:7b`), persistent multi-turn conversations with file attachments, model routing
between text and vision, resize/downscale optimization, a PDF page-preview endpoint, per-user rate
limiting, path-traversal-hardened attachment storage, and readable (never-a-stack-trace) error
messages for every Ollama/network failure mode. See "Vision & chat attachments" below.

## Stack

- **FastAPI** — API layer, serves the Expo app.
- **Ollama** (host process, not containerized) — runs `qwen3:8b` for generation,
  `mxbai-embed-large` for embeddings, and (milestone V1) `qwen2.5vl:7b` for vision/image
  understanding. Install separately; not managed by this project.
- **Qdrant** — vector store. Embedded/local mode by default (no Docker required).

## Prerequisites

- Python 3.13+ (this repo was built against 3.13.2)
- Ollama installed and running (`ollama serve`), with `qwen3:8b`, `mxbai-embed-large`, and
  `qwen2.5vl:7b` pulled — not required for milestone 1, only once the RAG/vision pipeline
  milestones land. Vision support can be disabled via `VISION_ENABLED=false` if you don't want to
  pull `qwen2.5vl:7b`.

## Setup

```bash
cd rag-backend
python3 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
cp .env.example .env
```

Edit `.env` and set a real `API_KEY` (a placeholder won't pass validation beyond the 8-character
minimum, but you should still replace it):

```bash
python -c "import secrets; print(secrets.token_urlsafe(32))"
```

## Run

```bash
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

```bash
curl http://localhost:8000/health
```

## LAN development access

To open the Expo web app from another device on the same Wi-Fi (not just
`localhost` on this machine), three things need to line up. Nothing below
is production configuration — it only affects `CORS_ORIGINS`,
`ALLOWED_AUTH_REDIRECT_URIS`, and cookie `Secure` behavior when
`APP_ENV=development`; production always forces `Secure` cookies regardless
(see `_cookie_secure_flag` in `app/api/routes_auth.py`).

1. **Backend binds to all interfaces** — already the default above
   (`--host 0.0.0.0`, also `Settings.host`'s default). Find your LAN IP with
   `ipconfig getifaddr en0` (macOS Wi-Fi) or `hostname -I` (Linux).

2. **Frontend dev server** — `expo start --web` already binds to all
   interfaces by default (Expo's default `--host` mode is `lan`), so no
   change is needed there; from `examples/expo-education-assistant/`:

   ```bash
   npx expo start --web --lan --port 8081
   # or: npm run web:lan
   ```

3. **CORS + OAuth redirect allowlist** — in `rag-backend/.env`, list every
   origin the frontend may be opened from (the browser sends whichever
   origin the page was actually loaded from):

   ```bash
   CORS_ORIGINS=http://localhost:8081,http://192.168.0.99:8081
   ALLOWED_AUTH_REDIRECT_URIS=expoeducationassistant://auth-callback,http://localhost:8081/auth-callback,http://192.168.0.99:8081/auth-callback
   ```

   Replace `192.168.0.99` with your own machine's LAN IP. Never use `*` for
   `CORS_ORIGINS` — CORS forbids combining a wildcard origin with
   `allow_credentials=True`, which the refresh-token cookie flow requires.

4. **Frontend API base URL** — set `EXPO_PUBLIC_API_BASE_URL` in
   `examples/expo-education-assistant/.env` (copy from `.env.example`) to
   the same LAN address, e.g. `http://192.168.0.99:8000`. A build with this
   set works both from `localhost:8081` on this machine and from
   `192.168.0.99:8081` on any other device, since "localhost" in a browser
   always means "this device" — never the LAN host. See
   `packages/education-assistant-client/docs/PHYSICAL_DEVICE_NETWORKING.md`
   for the full walkthrough, including native/physical-device setup.

Refresh-token cookies work over plain HTTP for LAN dev automatically:
outside `APP_ENV=production`, the cookie's `Secure` flag is only set when
the *request itself* arrived over HTTPS, so plain-HTTP LAN access still
gets a working cookie; in production, `Secure` is always forced regardless
of the request scheme. `SameSite=Lax` only restricts cross-*site* requests
(different registrable domain), not same-host-different-port ones, so a
browser on another LAN machine talking to `192.168.0.99:8081` /
`192.168.0.99:8000` sends/receives the cookie normally.

## API endpoints

All routes below require `Authorization: Bearer <API_KEY>` except `/health`. See
`app/api/routes_*.py` for full request/response schemas, or fetch the live OpenAPI schema from a
running server at `GET /openapi.json`.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | Liveness only — always 200 if the process is up. No auth required. |
| GET | `/health/ready` | Readiness — checks Ollama reachability, required model availability (`qwen3:8b`, `mxbai-embed-large`, and `qwen2.5vl:7b` when `VISION_ENABLED=true`), and Qdrant reachability. Response includes both the generic `models_available` dict and named `text_model_available` / `vision_model_available` / `embedding_model_available` booleans (`vision_model_available` is `null`, not `false`, when vision is disabled), plus `ollama_latency_ms` / `qdrant_latency_ms` (milestone V4 — round-trip time of the one probe call each service gets; `null` exactly when that service was unreachable). Always 200; check the `status` field (`"ready"` / `"not_ready"`), not the HTTP status code, to determine readiness. No auth required. |
| GET | `/status` | The same model/availability/latency fields as `/health/ready`, plus corpus stats (document/chunk counts) and the vision-enabled flag — powers the Expo app's Settings → Developer options screen. Requires auth, unlike `/health/ready`. |
| POST | `/search` | Retrieval-only, JSON response. |
| POST | `/chat` | Grounded RAG chat (text-only, no persisted history), Server-Sent Events stream (`token` / `sources` / `done` / `error` events). |
| POST | `/documents` | Multipart document upload; runs the full ingest → chunk → embed → store pipeline synchronously. |
| POST | `/documents/metadata-preview` | Extracts metadata from an uploaded file without ingesting it, so the frontend can show/edit it before committing. |
| GET | `/documents` | Paginated list of ingested documents. |
| DELETE | `/documents/{document_id}` | Deletes a document and its chunks. |
| POST | `/conversations` | Creates a new, empty conversation owned by the caller. |
| GET | `/conversations` | Paginated list of the caller's own conversations. |
| GET | `/conversations/{id}` | Full conversation detail — every message, its sources/citations, and attachment metadata. |
| PATCH | `/conversations/{id}` | Renames a conversation. |
| DELETE | `/conversations/{id}` | Deletes a conversation, its messages, and their attachments (files on disk included). |
| POST | `/conversations/{id}/messages` | Sends a message in a conversation and streams the reply (SSE). Accepts either a plain JSON body (text-only) or `multipart/form-data` (one or more file attachments — switches the request to the vision pipeline; see "Vision & chat attachments" below). Rate-limited per user (milestone V4). |
| GET | `/conversations/{id}/messages/{message_id}/attachments/{attachment_id}` | Streams one attachment's raw bytes back (auth-gated — the only way to view a sent image/PDF, since the backend never exposes a filesystem path). |
| GET | `/conversations/{id}/messages/{message_id}/attachments/{attachment_id}/preview?page=N` | Renders page `N` of a stored PDF attachment as a PNG (milestone V4) — powers the frontend's PDF page-preview lightbox without downloading the whole PDF client-side. 400s for a non-PDF attachment; 404s for a page beyond the PDF's page count. |
| GET/POST | `/auth/*` | OAuth login (Google/Facebook/LinkedIn), session exchange, refresh, logout, and a dev-only password-less login — see `app/api/routes_auth.py`. Not itself part of the V1–V4 vision work; documented here only for completeness. |

## Vision & chat attachments

### Architecture

```
                        ┌─────────────────────┐
                        │   Expo app (RN)      │
                        │  chat/new.tsx,        │
                        │  chat/[id].tsx         │
                        └──────────┬────────────┘
                                   │ POST .../messages
                                   │ (JSON or multipart)
                                   ▼
                  ┌──────────────────────────────────┐
                  │  routes_conversations.py          │
                  │  - rate limiter (per user)          │
                  │  - attachment validation             │
                  │  - model routing (text vs. vision)     │
                  └───────┬───────────────────┬───────────┘
                          │                   │
                text-only │                   │ has attachments
                          ▼                   ▼
                ┌──────────────────┐   ┌────────────────────────┐
                │  RagService        │   │  VisionService           │
                │  (retriever +       │   │  - validate/resize image │
                │   qwen3:8b)          │   │  - render PDF page(s)      │
                └──────────┬──────────┘   │  - qwen2.5vl:7b chat         │
                           │              └───────────┬─────────────────┘
                           │                          │
                           ▼                          ▼
                  ┌────────────────────────────────────────┐
                  │       ollama.Client (stream=True)         │
                  └───────────────────┬────────────────────────┘
                                      │ SSE: token / sources / done / error
                                      ▼
                        ConversationsRepository (SQLite)
                        AttachmentStorage (local disk)
                        QdrantVectorStore (corpus retrieval only)
```

`app/core/model_routing.py` decides text vs. vision per message: any attachment routes to
`VisionService`; otherwise the plain-text `RagService` path runs, exactly as it did before
milestone V1. Both pipelines share one error classifier (`app/core/ollama_errors.py`) so a model-
missing/timeout/OOM/connection failure produces the same wording regardless of which path hit it.

### Flow — sending a message with an attachment

1. Client picks an image or PDF; the SDK sends `multipart/form-data` to
   `POST /conversations/{id}/messages` with the file(s) and an optional page range (for a PDF).
2. The route checks the per-user rate limit, validates ownership of the conversation, then
   validates each attachment (`app/services/attachment_storage.py`: decodable image / real PDF,
   size limits, allowed MIME types — WEBP/HEIC gated by `CHAT_ATTACHMENT_ALLOW_HEIC`).
3. The user's message row is persisted first (so a retry with the same `client_message_id` can
   recognize a completed vs. partial attempt), then each attachment's bytes are written to disk
   and recorded. If a later file in a multi-file upload fails to write, every file already written
   in that same call is deleted before the error propagates (milestone V4 — no orphaned files).
4. `VisionService.render_attachments_to_images` turns the attachment(s) into a flat list of PNG/
   JPEG bytes: an image attachment contributes itself; a PDF contributes one rendered PNG per
   requested page (`render_pdf_pages`, 150 DPI). Every PNG/JPEG image — whether uploaded directly
   or rendered from a PDF — is then downscaled to `VISION_MAX_IMAGE_DIMENSION` (default 1568px on
   the longest side) if larger, which is the main latency win in milestone V4: a smaller request
   body and a smaller image both mean a faster vision-model forward pass. WEBP/HEIC images are
   passed through unresized (PyMuPDF can't decode either format to resize them).
5. The resulting image bytes + the user's text are sent to `qwen2.5vl:7b` via
   `ollama.Client.chat(..., stream=True)`; tokens stream back to the client as SSE events exactly
   like the text-only path.
6. If the client disconnects mid-stream, the abandoned generator's `GeneratorExit` (a
   `BaseException`, never caught by this code's `except VisionServiceError`) propagates all the
   way up — the assistant's reply is only ever persisted *after* the streaming loop completes, so
   an interrupted stream is guaranteed to never be saved as if it had finished. This is a property
   of the code's structure (yield inside the loop, persist only after), not a separate feature to
   maintain.

### Storage

- **Chat history** — SQLite via SQLAlchemy (`app/db/models_conversations.py`): `conversations`,
  `messages` (role, content, citations, streaming-safety fields), and `message_attachments`
  (mime, original filename, size, page count/range, and a `storage_key` — never a raw filesystem
  path — pointing into attachment storage).
- **Attachment files** — `app/services/attachment_storage.py` writes each attachment under
  `CHAT_ATTACHMENTS_DIR` (default `./data/chat_attachments`) as `{user_id}/{uuid}/{uuid}.{ext}`.
  Every read/write/delete resolves the final path and verifies it still falls under the
  configured root before touching disk (`_resolve_within_root`, milestone V4) — defense-in-depth
  against path traversal, even though every real caller only ever passes a storage key this class
  itself generated. Deleting a conversation or message deletes its attachment files too.
- **Corpus vectors** — unchanged from milestone 1–8: Qdrant (embedded/local by default), used only
  for retrieval-augmented text chat, never for vision. A vision message's attachments are never
  ingested into the corpus.

### Configuration

All vision/attachment/rate-limit settings below are validated at startup by `app/config.py`
alongside every other setting — see [`.env.example`](./.env.example) for the full list and
defaults.

| Variable | Purpose |
| --- | --- |
| `VISION_ENABLED` | Master switch. `false` makes any message with an attachment 400 immediately, and vision-model readiness/availability checks are skipped entirely. |
| `OLLAMA_VISION_MODEL` | Vision-capable model name (default `qwen2.5vl:7b`). |
| `VISION_REQUEST_TIMEOUT_SECONDS` | Per-request timeout for a vision chat call. |
| `VISION_MAX_IMAGE_DIMENSION` | Longest side (px) an image is downscaled to before being sent to the model (default 1568, range 256–4096) — milestone V4's main latency optimization. |
| `CHAT_ATTACHMENTS_DIR` | Root directory attachment files are written under. |
| `CHAT_ATTACHMENT_MAX_BYTES` / `CHAT_ATTACHMENT_MAX_PDF_PAGES` / `CHAT_ATTACHMENT_MAX_IMAGES_PER_MESSAGE` | Per-attachment and per-message limits, enforced before any file touches disk. |
| `CHAT_ATTACHMENT_ALLOW_HEIC` | Whether HEIC images are accepted (never resized either way — see Flow step 4). |
| `CHAT_RATE_LIMIT_MAX_REQUESTS` / `CHAT_RATE_LIMIT_WINDOW_SECONDS` | Per-user sliding-window limit on `POST .../messages` (default 20 requests / 60s) — milestone V4. In-memory, per-process (see Known limitations). |

## Development commands

```bash
ruff check .              # lint
ruff format .             # format
mypy --strict app/ cli/   # type-check (strict mode; tests are not mypy-checked)
pytest                    # run the test suite (a small live-Ollama-gated suite is excluded by default)
```

## Project layout

```
rag-backend/
├── app/
│   ├── main.py                # FastAPI app factory
│   ├── config.py               # pydantic-settings, env-driven configuration
│   ├── deps.py                  # FastAPI dependency-injection wiring (incl. rate limiter, attachment storage)
│   ├── logging_config.py        # structured logging setup
│   ├── api/                      # route modules (chat, search, documents, health, status, conversations, auth)
│   ├── core/                      # LLM/vision providers, retriever, rag_service, citations, readiness,
│   │                                 model_routing, ollama_errors, rate_limiter
│   ├── db/                         # SQLAlchemy models + repository for conversations/messages/attachments
│   ├── services/                    # attachment_storage.py, vision_service.py (resize/PDF-render/vision chat)
│   ├── ingestion/                    # document loaders, chunker
│   ├── vectorstore/                   # Qdrant client wrapper
│   └── schemas/                        # request/response pydantic models
├── cli/                                  # documents.py, ingest.py, privacy_scan.py — real-corpus management CLIs
├── scripts/                               # eval_retrieval.py, eval_answers.py, calibrate_threshold.py
├── tests/
│   ├── unit/                                # incl. unit/services/ (attachment storage, vision service)
│   ├── api/
│   ├── integration/                          # real in-memory Qdrant + fakes, plus a live-Ollama-gated suite
│   └── fixtures/                              # original fictional sample corpus + golden Q&A set
└── data/                                        # gitignored — raw documents, chat_attachments/, local Qdrant storage
```

## Environment variables

See [`.env.example`](./.env.example) for the full list with comments. All variables are validated
at startup by `app/config.py` (`pydantic-settings`) — the app refuses to start with a missing or
invalid `API_KEY`, an out-of-range port, or an unrecognized `LOG_LEVEL`/`QDRANT_MODE`.

## Known limitations (vision, milestones V1–V4)

- **Rate limiting is in-memory and per-process.** It resets on every restart and is not shared
  across multiple backend worker processes — an accepted tradeoff for a single-user/small-team
  local-first app (matching this project's existing "no extra infra" posture: embedded Qdrant,
  SQLite, a host Ollama process), not an oversight. A multi-worker deployment would need a shared
  store (e.g. Redis) instead.
- **No true upload-progress percentage.** The frontend shows an indeterminate "in progress"
  indicator while a message (with or without attachments) is sending/streaming, not a byte-level
  percentage — `fetch`'s request body upload progress isn't reliably observable across every
  runtime this app targets (web, iOS, Android), so a fake percentage was deliberately not built.
- **Zoom in the attachment lightbox is a discrete double-tap toggle (1x / 2.5x), not a continuous
  pinch gesture.** A real pinch gesture needs `react-native-gesture-handler`'s `GestureDetector`
  mounted under a `GestureHandlerRootView` at the app root, which this app doesn't set up today;
  adding that without a real device/simulator to verify it on was judged higher-risk than it was
  worth for this milestone.
- **OOM detection is best-effort.** Ollama has no dedicated status code or exception for an
  out-of-memory generation failure — `app/core/ollama_errors.py` only recognizes it via a keyword
  match on the error text Ollama happens to return. An OOM that doesn't match a known keyword still
  produces a clear (if generic) message, never a bare stack trace.
- **No real iOS/Android device or simulator testing was performed for this milestone** — validated
  via the backend's pytest suite, the SDK's vitest suite, the Expo app's jest suite (React Native
  Testing Library against jsdom, not a real engine), and manual browser testing only. Native-only
  behavior (the platform image-picker sheet, RN's `Image` `headers` source field, gesture
  timing) is exercised by mocks in tests, not a physical/simulated device.
