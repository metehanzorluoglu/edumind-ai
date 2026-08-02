# EduMind Oracle VM Deployment

Operations guide for the EduMind Oracle Cloud deployment — Docker Compose project **`edumind-oracle`**.

---

## Purpose and supported host profile

This deployment targets:

| | |
|---|---|
| Shape | Oracle Cloud **VM.Standard.A1.Flex** |
| Architecture | **ARM64** |
| OCPUs | **4** |
| RAM | **24 GB** |

It reuses the Raspberry Pi 5 backend image (`deploy/rpi5/Dockerfile.rpi5`) and the frontend image (`deploy/frontend/Dockerfile`) — both are already ARM64 builds — but with Compose resource limits and Ollama tuning re-derived for this host's larger CPU/RAM budget instead of the Pi's 8 GB constraint. See [Current performance optimizations](#current-performance-optimizations) below for the specifics and the evidence behind each one.

This is **not** `deploy/prod` or `deploy/rpi5`. It is a separate, independent Compose project (`edumind-oracle`) with its own compose file, env file, and operations scripts. Nothing in this directory modifies or depends on those two.

---

## Architecture summary

```
                    Browser
                       │
                       ▼
              frontend (nginx, :8080)
                       │
                       ▼
              backend (FastAPI, :8000)
             /         |          \
            /          |           \
      SQLite        Ollama        Qdrant
   (backend-data   (ollama-data   (qdrant-data
     volume)         volume)        volume)
```

- **frontend** — Expo web export served by nginx (gzip + immutable static-asset caching).
- **backend** — FastAPI + uvicorn (2 workers), SQLite for app data, streams chat responses over SSE.
- **backend-migrate** — one-shot Alembic migration job; `backend` depends on it completing successfully before it starts.
- **ollama** — hosts the LLM/vision/embedding models.
- **qdrant** — vector store for retrieval.

All five services run on one internal Docker network and share the `edumind-oracle` Compose project.

---

## Service ports

| Service | Container port | Published as | Notes |
|---|---|---|---|
| backend | 8000 | `127.0.0.1:8000` | Loopback only — reached publicly via Caddy + Cloudflare at `https://api.edum8.us`, see [Authentication](#authentication) |
| frontend | 80 | `127.0.0.1:${FRONTEND_PORT:-8080}` | Loopback only — reached publicly via Caddy + Cloudflare at `https://edum8.us` |
| qdrant | 6333 | `127.0.0.1:6333` | Loopback only — never exposed publicly |
| ollama | 11434 | *(not published)* | Reachable only from sibling containers on the compose network |

Caddy and Cloudflare (both configured outside this repo) terminate HTTPS on 80/443 and reverse-proxy to the two loopback ports above. Nothing in `deploy/oracle/` configures Caddy or Cloudflare themselves.

---

## Prerequisites

- Docker Engine with the Compose v2 plugin (`docker compose version` must succeed)
- `curl`, `jq` (used by the operations scripts)
- A user able to run `docker` (in the `docker` group, or root)
- This repository cloned at `~/edumind-ai` (scripts resolve their own paths from their location, so any clone path works — `~/edumind-ai` is just what this guide assumes in examples)

Optional but recommended for script development/review: `shellcheck`.

---

## First-time installation

```bash
cd ~/edumind-ai

# 1. Create your real env file from the template (never edit the template in place)
cp deploy/oracle/.env.oracle.example deploy/oracle/.env.oracle

# 2. Fill in the placeholders in deploy/oracle/.env.oracle:
#    - JWT_SECRET        (python3 -c 'import secrets; print(secrets.token_urlsafe(32))')
#    - CORS_ORIGINS / FRONTEND_URL / EXPO_PUBLIC_API_BASE_URL / ALLOWED_AUTH_REDIRECT_URIS —
#      already set to edum8.us's production domains; change only if deploying under a
#      different domain — see the Authentication section for the exact values
#    - EMAIL_PROVIDER=smtp + SMTP_HOST/SMTP_USERNAME/SMTP_PASSWORD — REQUIRED before
#      APP_ENV=production; the backend refuses to start otherwise (verification emails
#      would silently never be delivered) — see "Email delivery (SMTP) setup"
#    - GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET, FACEBOOK_CLIENT_ID / FACEBOOK_CLIENT_SECRET,
#      LINKEDIN_CLIENT_ID / LINKEDIN_CLIENT_SECRET — only for the OAuth providers you want
#      to enable (local email/password sign-in needs no configuration — on by default)

# 3. Start the stack
./deploy/oracle/scripts/oracle-start.sh --build   # --build on first run (images don't exist yet)

# 4. Verify
./deploy/oracle/scripts/oracle-healthcheck.sh
```

`oracle-start.sh` starts `backend-migrate` (which applies every Alembic migration) before `backend` automatically — this is enforced by the Compose `depends_on: condition: service_completed_successfully` graph, not a separate manual step.

---

## Copying and configuring `.env.oracle`

- **Template:** `deploy/oracle/.env.oracle.example` — committed to Git, contains no real secrets, only placeholders.
- **Real file:** `deploy/oracle/.env.oracle` — **git-ignored**, holds real secrets, never committed, never printed by any script in this toolkit.
- Regenerate `.env.oracle` from the template any time you want to see what's changed: `diff deploy/oracle/.env.oracle.example deploy/oracle/.env.oracle` (do this locally — never pipe `.env.oracle` output anywhere that leaves your terminal).

---

## Daily operations

| Action | Command |
|---|---|
| Start | `./deploy/oracle/scripts/oracle-start.sh` |
| Start (rebuild images) | `./deploy/oracle/scripts/oracle-start.sh --build` |
| Stop (volumes preserved) | `./deploy/oracle/scripts/oracle-stop.sh` |
| Restart | `./deploy/oracle/scripts/oracle-restart.sh` |
| Status dashboard | `./deploy/oracle/scripts/oracle-status.sh` |
| Health check | `./deploy/oracle/scripts/oracle-healthcheck.sh` |
| Logs (all services, follow) | `./deploy/oracle/scripts/oracle-logs.sh` |
| Logs (Ollama, follow) | `./deploy/oracle/scripts/oracle-logs.sh ollama` |
| Logs (specific service) | `./deploy/oracle/scripts/oracle-logs.sh backend` |
| Logs (last 200 lines, then follow) | `./deploy/oracle/scripts/oracle-logs.sh backend --tail 200` |
| Logs (only new entries) | `./deploy/oracle/scripts/oracle-logs.sh backend --tail 0` |
| Logs (no follow) | `./deploy/oracle/scripts/oracle-logs.sh backend --no-follow` |
| Logs (with timestamps) | `./deploy/oracle/scripts/oracle-logs.sh backend --timestamps` |
| Logs (no follow, more lines) | `./deploy/oracle/scripts/oracle-logs.sh backend --tail 500 --no-follow` |
| Ollama performance logs (chat requests, prompt processing, generation, errors) | `./deploy/oracle/scripts/oracle-logs.sh ollama --tail 0 --timestamps \| grep --line-buffered -E 'POST.*api/chat\|prompt processing\|generation\|print_timing\|error'` |
| Prewarm the chat model | `./deploy/oracle/scripts/oracle-prewarm-model.sh --force` |

Every script supports `--help`. All scripts work from any working directory — they resolve their own location internally.

---

## Ollama model prewarm

`oracle-prewarm-model.sh` sends one minimal chat request (`think=false`, a
one-token completion, output discarded — never printed) to the configured
chat model (`OLLAMA_LLM_MODEL`) right after `oracle-start.sh`'s health check
passes, so the model is already loaded into Ollama's memory before the first
real user request arrives. On this CPU-only host, a cold `qwen3:8b` load
alone was measured at ~44s; without prewarming, whoever sends the first chat
message after a (re)start pays that cost inline (mitigated for *every* chat
request, cold-loaded or not, by the SSE progress events described below —
but prewarming removes the cold-load delay entirely for that first request).

- **Off by default.** Set `OLLAMA_PREWARM_ENABLED=true` in `.env.oracle` to
  enable it; `oracle-start.sh` then runs it automatically after every start,
  or skip that one run with `--no-prewarm`.
- **Never blocks startup.** A prewarm failure (model not pulled, Ollama
  unreachable, timeout) only logs a warning — `oracle-start.sh` still
  reports success as long as the health check itself passed. The app works
  identically either way; only the first request's latency differs.
- **Standalone use:** `oracle-prewarm-model.sh --force` runs it immediately
  regardless of the `.env.oracle` setting — useful right after `ollama pull`
  or when testing the timing difference below. `--timeout-seconds N`
  overrides the default 180s wait.
- Does **not** help a cold-load that happens later from inactivity —
  `OLLAMA_KEEP_ALIVE` (currently `30m`, see `docker-compose.oracle.yml`)
  still governs how long a loaded model stays resident between requests.

### Vision model prewarm

The same script also, independently, prewarms the vision model
(`OLLAMA_VISION_MODEL`) with a single tiny (1x1 pixel) synthetic image —
gated by its own flag, `OLLAMA_VISION_PREWARM_ENABLED=true` (or
`--vision-force` for a standalone run), and its own timeout
(`OLLAMA_VISION_PREWARM_TIMEOUT_SECONDS`, default 300s — vision cold-load
was measured noticeably slower than text's; see "Current performance
optimizations" below). Same guarantees as the text prewarm: off by
default, never blocks startup, output never printed.

One difference worth knowing before enabling it: because
`OLLAMA_MAX_LOADED_MODELS` defaults to 2, prewarming the vision model
*can* evict whichever model was just prewarmed by the text-model step
above (or vice versa, if the vision prewarm runs first and a real text
request evicts it later). `oracle-prewarm-model.sh` checks `ollama ps`
before and after its vision prewarm and prints an explicit `[WARN]` line
naming exactly what got evicted, if anything — it is never silent about
this. See "Model residency" below for whether raising
`OLLAMA_MAX_LOADED_MODELS` to 3 is appropriate for your traffic.

---

## Model residency

Ollama's `OLLAMA_MAX_LOADED_MODELS` (currently `2`, see
`docker-compose.oracle.yml`) caps how many models stay resident at once —
loading a model beyond that count evicts the least-recently-used one, even
if there's ample free memory. This deployment uses **three** distinct
models (`OLLAMA_LLM_MODEL`, `OLLAMA_VISION_MODEL`, `OLLAMA_EMBED_MODEL`),
so any conversation flow that needs two of them back-to-back with the
third already loaded (e.g. a vision message that also uses "my research
corpus", which needs the embedding model *and* the vision model) can
trigger an avoidable evict-and-reload cycle under the current limit.

Live measurements across two investigations (vision-attachment-timeout,
then a follow-up text/vision latency optimization pass) found:

| Models resident together | Combined memory | Fits under the 18GB Ollama limit? | Source |
|---|---|---|---|
| `qwen3:8b` + `qwen2.5vl:7b` | ~11.7GB | Yes, ~6.3GB headroom | prior measurement |
| `qwen3:8b` + `qwen2.5vl:3b` | 9.1GB | Yes, ~8.9GB headroom | measured directly |
| `qwen2.5vl:7b` + `qwen2.5vl:3b` | 9.0GB (11.0GB incl. overhead) | Yes | measured directly |
| All three + `mxbai-embed-large` (~0.7GB) | ~9.8-12.4GB | Yes, comfortably | arithmetic from above |

LRU eviction was directly observed multiple times: loading a 3rd distinct
model always evicts whichever of the other two was used least recently,
regardless of how much memory is actually free — a strict count limit,
not a memory-driven decision.

So the current default of 2 is a **model-count** limit, not one this
host's 18GB memory budget actually requires — raising
`OLLAMA_MAX_LOADED_MODELS` to `3` (via `.env.oracle`, now read by
`docker-compose.oracle.yml`) is supported by measurement for exactly this
deployment's three models. It was deliberately **left at 2** by both
investigations rather than changed, per each task's "do not change it
until measured" instruction — measuring is done twice now; changing it is
a call for whoever operates this deployment to make, since it depends on
your actual concurrent traffic pattern, not just raw memory arithmetic.
To apply it: uncomment `OLLAMA_MAX_LOADED_MODELS=3` in `.env.oracle` (see
`.env.oracle.example`) and run `oracle-restart.sh`.

`oracle-status.sh` reports the current value *and* (as of the latency
optimization pass) the Ollama container's actual resident memory via
`docker stats` — a real number to check the table above against, not
just the configured limit; `ollama ps` (via `oracle-logs.sh ollama` or
`docker compose exec ollama ollama ps`) shows what's resident at any
moment.

---

## Text RAG prompt-prefill

A live measurement (2,640-token real prompt) found **prompt evaluation**,
not decode, dominates a text chat turn's latency on this CPU-only ARM
host: 161.9s of a 198.2s total (81.7%) at ~16.3 tokens/second prefill
throughput, vs. decode's 3.56 tokens/second on 129 completion tokens — a
rounding error by comparison. Three contributing factors, and what
addresses each:

- **Prompt size** (~2,600-2,700 tokens/turn: a 2,600-character fixed
  system prompt + up to 8,000 characters of retrieved context at the
  default `RETRIEVAL_TOP_K=8`). A compact system prompt variant
  (`RAG_PROMPT_VARIANT=compact`, see `app/core/prompt_builder.py`) cuts
  the always-sent portion to 1,310 characters (49.6% smaller) by making
  the project-context-rule paragraph conditional (it was previously sent
  on every turn even without one) and tightening every section's wording
  — no rule was dropped, only reworded more compactly.
- **Retrieval context size.** `RETRIEVAL_TOP_K=3` + `CONTEXT_MAX_TOTAL_CHARS=3500`
  (down from 8/8000) cut one measured real prompt from 2,600 to 1,158
  tokens and its prompt-eval time from ~164s to **3.75s in a clean,
  uncontended run** — a far larger reduction than token count alone
  predicts. Quality was spot-checked (an insufficient-evidence question
  and a factual/citation question both answered correctly under this
  configuration) but not exhaustively re-validated against a full
  evaluation set.
- **No reliable cross-request prompt caching on this shared host.**
  Ollama's llama.cpp backend does have real slot-level KV-cache reuse
  (confirmed directly — an identical vision request repeated immediately
  completed prompt-eval in 0.22s instead of ~96s), but a text prompt
  repeated back to back on this production instance took 50.0s the
  second time, not near-zero — real concurrent traffic evicts the cached
  state unpredictably. A `RAG_SOURCE_ORDER=stable` option (sorts the
  final selected sources by identity instead of relevance rank, without
  ever changing *which* chunks are selected) is available and safe to
  enable, but its cache-reuse benefit should not be counted on.

Neither `RAG_PROMPT_VARIANT` nor `RAG_SOURCE_ORDER` nor the retrieval
values above were changed from their original defaults — all four are
documented, commented alternatives in `.env.oracle.example`, left for you
to apply.

---

## Health checks

`oracle-healthcheck.sh` checks, and exits non-zero if any fail:

- All four long-running containers (backend, frontend, qdrant, ollama) are running, with Docker health status `healthy` or `none` (not `unhealthy`/`starting`-stuck)
- `backend` `/health` and `/health/ready`
- `backend` `/auth/providers`
- `frontend` `/health`
- Backend (8000) and frontend (8080) published ports are actually accepting connections
- `backend-migrate` exited `0`
- The three configured models are pulled and available: `qwen3:8b`, `qwen2.5vl:7b`, `mxbai-embed-large`

Each failure line names the exact next command to run (`oracle-logs.sh <service>`, `ollama pull <model>`, etc.) rather than a bare error.

`oracle-status.sh` is the non-failing counterpart — a full dashboard (container status, both health endpoints, loaded Ollama models via `ollama ps`, host memory/swap, Docker disk usage, effective model configuration with secrets never shown, and the current Git branch/commit) that never exits non-zero just because something is still starting up.

---

## Backups

```bash
# Standard backup (stops backend/qdrant/ollama briefly for a consistent snapshot)
./deploy/oracle/scripts/oracle-backup.sh

# Skip the large Ollama model volume (models are re-pullable)
./deploy/oracle/scripts/oracle-backup.sh --skip-ollama

# Zero-downtime backup (services keep running; snapshot may be slightly inconsistent)
./deploy/oracle/scripts/oracle-backup.sh --online

# Non-interactive (for cron/automation)
./deploy/oracle/scripts/oracle-backup.sh --yes
```

Each backup, under `~/edumind-backups/edumind-oracle-backup-<timestamp>/`, contains:

- `backend-data.tar.gz`, `qdrant-data.tar.gz`, `ollama-data.tar.gz` (unless `--skip-ollama`)
- `docker-compose.oracle.yml` (configuration snapshot)
- `.env.oracle.example` (template only — **`.env.oracle` itself is never included**)
- `backup-info.txt` (Git branch/commit, Docker version, container/image list, disk/memory summary, Ollama model list)
- `docker-images.txt`
- `restore-instructions.txt`
- `SHA256SUMS` (verified immediately after the backup completes)

The Ollama volume is large (every pulled model — commonly 10+ GB for this deployment's three models); `oracle-backup.sh` warns about this explicitly before running. Retention defaults to the newest **10** Oracle backups (`KEEP_BACKUPS=10`; set `KEEP_BACKUPS=0` to disable pruning, or any other number to override).

---

## Restores

```bash
# Always dry-run first — validates checksums and shows the plan, changes nothing
./deploy/oracle/scripts/oracle-restore.sh ~/edumind-backups/edumind-oracle-backup-20260801-120000 --dry-run

# Real restore (creates its own pre-restore safety backup first, requires typing RESTORE)
./deploy/oracle/scripts/oracle-restore.sh ~/edumind-backups/edumind-oracle-backup-20260801-120000

# Restore everything except the Ollama volume (leave currently-pulled models alone)
./deploy/oracle/scripts/oracle-restore.sh ~/edumind-backups/edumind-oracle-backup-20260801-120000 --skip-ollama
```

- `.env.oracle` is **never** restored from a backup — only volume data changes; your live deployment configuration is untouched.
- A pre-restore safety backup is created automatically unless `--skip-safety-backup` is passed — if anything goes wrong, the failure message prints the exact rollback command using that safety backup's path.
- Volume contents are only ever replaced as part of the restore operation itself (each target volume's contents are cleared immediately before extracting the archive into it) — no volume is ever deleted outright, and no volume outside the ones the restore explicitly targets is touched.

---

## Updates

```bash
./deploy/oracle/scripts/oracle-update.sh --show-plan   # see what would change, no side effects at all
./deploy/oracle/scripts/oracle-update.sh --dry-run      # fetches from Git, still changes nothing else
./deploy/oracle/scripts/oracle-update.sh                # real update: backup -> pull -> migrate -> deploy -> health check
./deploy/oracle/scripts/oracle-update.sh --force-build   # rebuild images even if no Dockerfile/lockfile changed
./deploy/oracle/scripts/oracle-update.sh --pull-only     # update the Git checkout only, don't touch containers
```

`oracle-update.sh` requires a clean working tree on `main` (override with `UPDATE_BRANCH`/`UPDATE_REMOTE`), refuses to deploy anything that isn't a fast-forward, automatically decides whether an image rebuild is required (any changed `Dockerfile*`, `docker-compose*.yml`, or dependency lockfile triggers one), creates a verified backup first (skip with `--skip-backup`), and prints exact rollback instructions — both the previous Git commit and the pre-update backup's restore command — if the post-update health check fails.

---

## Persistent volumes

| Volume (real name, from `docker-compose.oracle.yml`) | Purpose |
|---|---|
| `edumind-rpi5_backend-data` | SQLite database, uploaded documents, chat attachments |
| `edumind-rpi5_qdrant-data` | Vector store |
| `edumind-rpi5_ollama-data` | Downloaded Ollama models |

These names are **not** a typo — the Oracle Compose project is named `edumind-oracle`, but its volumes intentionally reuse the original Raspberry Pi 5 volume names so this deployment inherits existing data rather than starting empty. Every script in this toolkit reads these from `docker-compose.oracle.yml`-derived defaults (overridable via `ORACLE_BACKEND_VOLUME`/`ORACLE_QDRANT_VOLUME`/`ORACLE_OLLAMA_VOLUME`), never assumes them blindly.

**Critical:** `deploy/prod/docker-compose.prod.yml` (Compose project `edumind-rpi5`) declares these exact same volume and network names. Docker volumes are daemon-global, not project-scoped, so the `edumind-rpi5` and `edumind-oracle` Compose projects are two different sets of containers pointed at the literal same data. **Never run both stacks at the same time** — concurrent writers to the same SQLite file and the same Qdrant storage directory is a real corruption risk. Use only `deploy/oracle/scripts/oracle-*.sh` here; never `deploy/prod/scripts/prod-*.sh`.

**Never run `docker compose down -v`.** No script in this toolkit ever does. `oracle-stop.sh` prints an explicit reminder that volumes were preserved every time it runs.

---

## Model configuration

| Setting | Value | Purpose |
|---|---|---|
| `OLLAMA_LLM_MODEL` | `qwen3:8b` | Text chat generation |
| `OLLAMA_VISION_MODEL` | `qwen2.5vl:7b` | Image/PDF-page understanding |
| `OLLAMA_EMBED_MODEL` | `mxbai-embed-large` | Retrieval embeddings |

Larger than the Raspberry Pi 5 config's `qwen3:4b` / `qwen2.5vl:3b` pair — this host's 24 GB RAM and 4 OCPUs support the full-size models directly; see the next section for how their resource envelope is tuned.

---

## Current performance optimizations

These came out of a full performance investigation and a series of targeted, measured changes — each one below is currently live in `docker-compose.oracle.yml` / `.env.oracle`, not aspirational.

| Setting | Value | Why |
|---|---|---|
| `OLLAMA_MAX_LOADED_MODELS` | `2` (overridable — see "Model residency" below) | The original config (inherited from the Pi's 8 GB budget) allowed only 1 loaded model, forcing a full model reload (measured: **~108 seconds**) every time a chat turn's embedding step and generation step used different models. `2` lets the LLM and embedding model stay resident together — though a later measurement (the vision-attachment-timeout investigation) found all *three* of this deployment's models fit comfortably within the 18GB memory limit together, meaning `3` is measured-safe for memory but was deliberately left as an opt-in, not a new default. |
| `OLLAMA_KEEP_ALIVE` | `30m` | Keeps models resident across the idle gaps between requests, reducing cold-reload frequency. |
| `OLLAMA_NUM_PARALLEL` | `1` | Serializes Ollama requests — appropriate for this CPU-only host, where concurrent generations would only contend for the same limited compute. |
| Ollama memory limit | `18g` | Raised from the Pi's `6g` — this host has 24 GB total; 18 GB gives Ollama enough headroom to hold multiple full-size models without the container-level thrashing the old 6 GB limit caused. |
| Ollama CPU quota | *(none)* | Removed — the inherited Pi-era `cpus: "3"` cap was measured throttling the container in **63.7% of CFS scheduling periods** during inference. Uncapped, the container can use all 4 host OCPUs when needed. |
| `OLLAMA_THINKING_ENABLED` | `false` | qwen3's hidden "thinking" trace was measured contributing ~120 hidden tokens to a one-sentence answer. Off by default; see `app/core/llm_provider.py`. |
| `OLLAMA_NUM_PREDICT` | `512` | Neither Ollama nor qwen3:8b's Modelfile capped completion length by default — generation was bounded only by the context window. 512 is generous for a citation-grounded answer while bounding the worst case. |
| `EMBEDDING_BATCH_SIZE` | `32` | Raised from a hardcoded `8`. Measured: batching barely speeds up per-item embedding time on this CPU-only host (~5-8%, not a multiple) — the benefit is fewer HTTP round-trips, and 32 matches Ollama's own internal batch ceiling exactly. |
| Chunk overlap | `200` chars (down from `450`) | A retrieval-quality evaluation (`scripts/eval_retrieval.py`, two isolated temp Qdrant collections, one real 2-document corpus, 16 questions including 10 boundary-sensitive ones reviewed manually) found **zero measurable Recall/MRR regression** between 450 and 200 — the real cross-page information-split failures that do exist are unaffected by this parameter either way. See `app/ingestion/chunker.py`'s `DEFAULT_CHUNK_OVERLAP_CHARS`. |
| Nginx gzip + immutable caching | on | `deploy/frontend/nginx.conf` gzips text/JS/CSS/font responses and serves hashed static assets (`js/css/fonts/images`) with `Cache-Control: public, immutable` + a 1-year `expires`. |
| SSE progress events | always on | The chat stream now sends `connected` / `retrieving` / `processing_context` / `loading_model` / `generating` status events before the first answer token, so the frontend shows real status instead of an indefinite "Connecting…" spinner while a cold model load (~44s measured) or a long prompt evaluation (155s+ measured past 2,560 tokens) is in progress. See `app/schemas/chat.py`'s `ChatProgressEvent`. |
| `OLLAMA_PREWARM_ENABLED` | `false` | Optional: preloads the chat model at startup so the *first* post-restart chat request skips the cold-load cost too. See "Ollama model prewarm" above. |
| `VISION_REQUEST_TIMEOUT_SECONDS` | `300` (raised from `180`) | The direct fix for this deployment's "model did not respond in time" vision-attachment production error: a live measurement found `qwen2.5vl:7b` prompt-evaluation alone taking **114-232+ seconds even fully warm** for a single modest image — already past the old 180s default before any cold-load time. See `app/config.py`'s `vision_request_timeout_seconds` docstring. |
| `VISION_GENERATION_TIMEOUT_SECONDS` | `60` (new) | A separate, materially tighter budget for a stall *after* generation has already started — enforced independently of the above via `asyncio.wait_for()` around each streamed chunk (`app/services/vision_service.py`), which is why the vision pipeline now uses `ollama.AsyncClient` instead of the sync client the text pipeline still uses. |
| `VISION_MAX_IMAGE_DIMENSION` | `1024` (lowered from `1568`) | The same measurement found prompt-eval time tracks vision-token count, which tracks decoded pixel count, not file size/format — a 640x360 image measured ~114s vs. a 1568-capped ~1568x882 image at ~232s. 1024 cuts worst-case pixel area by more than half while remaining legible for document text/screenshot UI. |
| Vision safety limits | new | `VISION_MAX_IMAGE_PIXELS`/`VISION_MAX_TOTAL_PIXELS`/`VISION_MAX_PROMPT_CHARS` — rejected with a clear error *before* ever calling Ollama, not measured/tuned individually but set to generous, unlikely-to-trigger-normally values. See `.env.oracle.example`. |
| Vision SSE progress events + profiling metrics | always on | The vision path previously sent *nothing* to the client until the first answer token (or an error) — now mirrors the text path's `connected`/`retrieving`/`processing_context`/`loading_model`/`generating` events, plus (`PERFORMANCE_PROFILING=true`) `vision_model_load_ms`/`vision_prompt_eval_ms`/`vision_completion_tokens`/`vision_decode_tokens_per_second`/`vision_time_to_first_token_ms`/`vision_total_ms`. See `app/api/routes_conversations.py`'s `_stream_vision_reply`. |
| Vision error classification | always on | A vision failure's `ChatErrorEvent` now carries a backend-only `error_category` (`model_load_or_prompt_eval_timeout`, `generation_timeout`, `request_too_large`, `too_many_pages`, `preprocessing_failure`, `ollama_unavailable`) alongside the existing human-readable `message` — see `app/core/errors.py`'s `VisionErrorCategory`. |
| `OLLAMA_VISION_PREWARM_ENABLED` | `false` | Optional: preloads the vision model at startup, independent of the text prewarm above. See "Vision model prewarm" above. |

---

## Authentication

Production authentication for `https://edum8.us` — local email/password (with mandatory email verification) and three OAuth providers (Google, Facebook, LinkedIn), sharing one JWT + refresh-token session architecture underneath. See `app/api/routes_auth.py`, `app/core/auth_service.py`, `app/core/oauth_providers.py`, `app/core/password_hashing.py`, `app/core/password_policy.py`, `app/core/verification_service.py`, `app/core/email_provider.py`, `app/core/auth_rate_limiter.py`.

### Architecture

- **Tokens:** a short-lived JWT access token (`JWT_ACCESS_TTL_MINUTES`, default 60 min) plus an opaque, hashed-at-rest refresh token (`REFRESH_TOKEN_TTL_DAYS`, default 30 days) stored in an HttpOnly cookie on web and `expo-secure-store` on native. Refresh is rotate-on-use: presenting an already-used refresh token is treated as theft and revokes every session for that user.
- **Local and OAuth logins converge on the same `TokenResponse` shape and the same `sessions` table** — there is exactly one session/token system in this app, not two parallel ones.
- **`users.password_hash` is nullable** — a user may have a password, one or more linked OAuth accounts (`oauth_accounts`), or both. OAuth account linking only ever merges into an existing user when the identity's email is *provider-verified*; an unverified email that collides with an existing address is refused (`auth_error=email_conflict` redirect), never silently merged and never a raw server error. Linking a verified OAuth identity onto an existing, previously-unverified local account also marks that account `email_verified` — see "Email verification lifecycle" below.
- **A newly-registered local account cannot sign in until it verifies its email** (`AUTH_EMAIL_VERIFICATION_REQUIRED=true`, the default) — `POST /auth/register` issues no tokens for that case; `POST /auth/login` refuses a correct password with `403 email_verification_required` until the account verifies.

### Required auth environment variables

Set in `deploy/oracle/.env.oracle` — real secrets, git-ignored, never committed (see "Copying and configuring `.env.oracle`" above):

| Variable | Purpose | Default |
|---|---|---|
| `JWT_SECRET` | Signs access tokens. Generate with `python3 -c 'import secrets; print(secrets.token_urlsafe(32))'`. | *(required, min 16 chars)* |
| `JWT_ACCESS_TTL_MINUTES` | Access token lifetime. | `60` |
| `REFRESH_TOKEN_TTL_DAYS` | Refresh token lifetime. | `30` |
| `AUTH_LOCAL_LOGIN_ENABLED` | Kill switch for `POST /auth/register` / `POST /auth/login`. | `true` |
| `AUTH_LOGIN_RATE_LIMIT_MAX_ATTEMPTS` / `_WINDOW_SECONDS` | Login throttling — see "Rate limiting" below. | `10` / `300` |
| `AUTH_REGISTER_RATE_LIMIT_MAX_ATTEMPTS` / `_WINDOW_SECONDS` | Registration throttling. | `5` / `3600` |
| `AUTH_VERIFY_RATE_LIMIT_MAX_ATTEMPTS` / `_WINDOW_SECONDS` | `GET /auth/verify-email` throttling (per-IP; protects against token-guessing). | `10` / `900` |
| `AUTH_RESEND_VERIFICATION_RATE_LIMIT_MAX_ATTEMPTS` / `_WINDOW_SECONDS` | `POST /auth/resend-verification` throttling. | `3` / `3600` |
| `AUTH_EMAIL_VERIFICATION_REQUIRED` | Whether local accounts must verify before signing in. | `true` |
| `EMAIL_PROVIDER` | `console` (never delivers, refused in production) or `smtp` (real delivery). | `console` |
| `EMAIL_FROM_NAME` / `EMAIL_FROM_ADDRESS` | Verification email's From header. | `EduM8` / `no-reply@example.com` |
| `EMAIL_VERIFICATION_TOKEN_TTL_MINUTES` | How long a verification link stays valid. | `60` |
| `EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS` | Minimum gap between resends for one account. | `60` |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USERNAME` / `SMTP_PASSWORD` / `SMTP_USE_TLS` | Required when `EMAIL_PROVIDER=smtp` — see "Email delivery (SMTP) setup" below. | blank / `587` / blank / blank / `true` |
| `BACKEND_PUBLIC_URL` | This backend's own public URL, used to build verification links. | `https://api.edum8.us` |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REDIRECT_URI` | Enables "Continue with Google" — see setup below. | blank (disabled) |
| `FACEBOOK_CLIENT_ID` / `FACEBOOK_CLIENT_SECRET` / `FACEBOOK_REDIRECT_URI` | Enables "Continue with Facebook" — see setup below. | blank (disabled) |
| `LINKEDIN_CLIENT_ID` / `LINKEDIN_CLIENT_SECRET` / `LINKEDIN_REDIRECT_URI` | Enables "Continue with LinkedIn" — see setup below. | blank (disabled) |
| `ALLOWED_AUTH_REDIRECT_URIS` | Allowlisted app-side redirect targets for `GET /auth/{provider}/authorize`. | `expoeducationassistant://auth-callback,https://edum8.us/auth-callback` |
| `AUTH_DEV_LOGIN_ENABLED` | Dev-only test login. Hard-refused whenever `APP_ENV=production`, regardless of this flag. | `false` |
| `FRONTEND_URL` | The canonical frontend — see below. | `https://edum8.us` |
| `CORS_ORIGINS` | Exact-match allowlist, no wildcards. | `https://edum8.us,https://www.edum8.us,https://app.edum8.us` |

### Local authentication

`POST /auth/register` and `POST /auth/login` need no external configuration to be *usable* — on by default (`AUTH_LOCAL_LOGIN_ENABLED=true`), independent of whether any OAuth provider is configured. `GET /auth/providers` reports this separately from the OAuth `providers` list (`local_auth_enabled: true/false`) specifically so the frontend never mistakes "no OAuth providers configured" for "no way to sign in at all" — that conflation was the original bug this feature fixes. Actually *delivering* verification email does need `EMAIL_PROVIDER=smtp` configured — see below.

- **Password policy** (`app/core/password_policy.py`, one shared module used by registration and any future password-change/reset route): 12-128 characters; at least one uppercase letter, one lowercase letter, one digit, and one symbol; rejects passwords that are entirely one repeated character or one ascending/descending run (e.g. `aaaaaaaaaaaa`, `abcdefghijkl`); rejects a small curated denylist of common/formulaic passwords (`12345678`, `password123`, `Password123!`, `qwerty123`, `letmein`, `admin123`, `welcome123`, and their close variants — never checked against a third-party service); rejects a password containing the user's full normalized email, its local-part (when ≥4 characters), or their display name (word parts ≥3 characters). Every violated rule is reported at once (not just the first) so the frontend's live checklist can show the complete picture.
- **Password hashing:** Argon2id via `argon2-cffi`, library-default parameters (time_cost=3, memory_cost=64 MiB, parallelism=4) — no custom cryptography. Verification is constant-time via the library itself; an unknown email and a wrong password both take the same code path (a fixed dummy-hash comparison) so response timing can't be used to enumerate accounts. Password hashes are never included in any API response and never logged. Both `hash_password`/`verify_password` also defensively reject an over-length input themselves (128 chars), independent of the policy check, bounding worst-case Argon2 CPU cost against a malicious oversized input.
- **Account linking:** registering with an email that already belongs to an OAuth-only user attaches the new password to that same account (no duplicate user row); registering with an email that already has a password returns `409 Conflict`. Email/password normalization (`.strip().lower()`) is centralized in `app/core/email_normalization.py` and used identically by registration, login, and OAuth linking.
- **Password-reset status: still not implemented as a self-service flow.** This deployment now has real email delivery (for verification — see below), which makes a reset flow feasible to add later using the same single-use-hashed-token pattern verification already uses, but it has not been built. The login screen's "Forgot password?" link shows a clear, honest "not available yet — contact your administrator" message; there is no broken route or dead link behind it.

### Email verification lifecycle

A newly-registered local account is created unverified. `POST /auth/register` (when `AUTH_EMAIL_VERIFICATION_REQUIRED=true`, the default) issues a single-use, hashed, time-limited token (`email_verification_tokens` table — only a SHA-256 hash of the token is ever stored, mirroring `sessions.refresh_token_hash`), emails a link (`GET {BACKEND_PUBLIC_URL}/auth/verify-email?token=...`), and returns a generic success message — no tokens, no session yet.

- Clicking the link redeems the token server-side, marks `users.email_verified`/`email_verified_at`, and redirects the browser to `{FRONTEND_URL}/verify-email?status=success|invalid|expired|already_used`.
- `POST /auth/login` with correct credentials for a still-unverified account returns `403` with the stable code `email_verification_required` (never a full sentence, so the frontend can branch on it reliably) and issues no tokens.
- `POST /auth/resend-verification` always returns the same generic response regardless of whether the address is registered, already verified, or OAuth-only — never reveals account existence. A new token revokes every previously-issued, still-active token for that user. Protected by both a request-rate limit and a separate per-account cooldown (`EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS`).
- **Pre-existing accounts (migration `0016_email_verification`):** an OAuth-verified user is backfilled `email_verified_at = created_at`; a local account that predates this feature is grandfathered to verified (also backfilled) rather than being unexpectedly locked out — see "Migration instructions" below.
- Linking a **provider-verified** OAuth identity onto an existing (possibly still-unverified) local account also marks that account verified — a provider vouching for the address is treated the same as clicking the local verification link.

### Email delivery (SMTP) setup

`EMAIL_PROVIDER=console` (the default) never actually sends anything — safe for local development, but **hard-refused at backend startup whenever `APP_ENV=production`** (`app/config.py::refuse_dev_email_backend_in_production`, called from `app/main.py`): the process will not start until `EMAIL_PROVIDER=smtp` and the `SMTP_*` values are filled in. This is deliberate — a misconfigured email setting would otherwise silently leave every new user permanently unable to verify their account.

1. Choose an SMTP provider (e.g. your registrar's mail service, or a transactional-email provider's SMTP endpoint) capable of sending from `no-reply@edum8.us` (or whatever `EMAIL_FROM_ADDRESS` you configure).
2. Fill in `.env.oracle`:
   ```
   EMAIL_PROVIDER=smtp
   EMAIL_FROM_NAME=EduM8
   EMAIL_FROM_ADDRESS=no-reply@edum8.us
   SMTP_HOST=<your provider's SMTP host>
   SMTP_PORT=587
   SMTP_USERNAME=<your SMTP username>
   SMTP_PASSWORD=<your SMTP password>
   SMTP_USE_TLS=true
   ```
3. **DNS records for deliverability** — add these for the domain `EMAIL_FROM_ADDRESS` uses (typically `edum8.us`), values as provided by your SMTP provider:
   - **SPF** (TXT on the root domain): authorizes your SMTP provider's servers to send as `edum8.us`, e.g. `v=spf1 include:<provider's SPF include> ~all`.
   - **DKIM** (TXT on a provider-specific selector subdomain, e.g. `<selector>._domainkey.edum8.us`): the provider's public signing key.
   - **DMARC** (TXT on `_dmarc.edum8.us`): a policy such as `v=DMARC1; p=quarantine; rua=mailto:<an address you monitor>`.
   Exact record names/values are provider-specific — follow your SMTP provider's own domain-verification instructions; the three record *types* above are what every provider will ask you to add.
4. Restart the backend (see [Daily operations](#daily-operations)).

Never commit `SMTP_PASSWORD` (or any `.env.oracle` value) — see "Which secrets must never be committed" below.

### Rate limiting

`POST /auth/login`, `POST /auth/register`, `GET /auth/verify-email`, and `POST /auth/resend-verification` are all protected by a **database-backed** sliding-window limiter (`app/core/auth_rate_limiter.py`), not the in-memory `app/core/rate_limiter.py` used for chat — this deployment runs `--workers 2` (`docker-compose.oracle.yml`), and an in-memory counter would silently under-count across workers. The limiter stores only a SHA-256 hash of `(route, "ip"|"email", identifier)` — never a raw email address or IP — in the `auth_rate_limit_hits` table, checked and pruned via short, indexed transactions.

- **Scope: combined per-IP and per-email** for login/register/resend; **per-IP only** for verify-email (no account is known until the token is looked up). Either bucket being full is enough to reject; a single caller hammering one account from many IPs, or one IP spraying many accounts, are both stopped.
- **Response:** `429 Too Many Requests` with a `Retry-After` header (seconds), and one generic message regardless of which bucket tripped or whether the target account exists — rate-limit behavior never reveals account existence.
- **Defaults:** login 10/5min; registration 5/hour; verify-email 10/15min; resend-verification 3/hour (all overridable — see the env var table above).

### Google OAuth setup

1. In the [Google Cloud Console](https://console.cloud.google.com/) → APIs & Services → Credentials, create an OAuth 2.0 Client ID of type "Web application".
2. **Authorized JavaScript origins:** add exactly
   ```
   https://edum8.us
   ```
3. **Authorized redirect URI:** add exactly
   ```
   https://api.edum8.us/auth/google/callback
   ```
4. **Scopes:** `openid email profile` (already hardcoded in `app/core/oauth_providers.py` — nothing to configure on the app side beyond enabling the consent screen for these).
5. Copy the generated Client ID and Client Secret into `.env.oracle`:
   ```
   GOOGLE_CLIENT_ID=<your client id>
   GOOGLE_CLIENT_SECRET=<your client secret>
   GOOGLE_REDIRECT_URI=https://api.edum8.us/auth/google/callback
   ```
6. Restart the backend for the new values to take effect (see [Daily operations](#daily-operations)).

`GET /auth/providers` reports Google as enabled only once `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REDIRECT_URI` are **all** non-empty (`app/core/oauth_providers.py::get_provider_config`) — a partially-filled-in provider is treated identically to an unconfigured one, never a broken half-state. The client secret is read server-side only and never returned by any API response.

PKCE (S256), server-side `state` validation, and OIDC `nonce` verification (the returned Google `id_token`'s `nonce` claim is checked against the value sent at authorize time) are all enforced on every login. The one-time `auth_code` handed back to the frontend is redeemed exactly once, expires after 60 seconds, and access/refresh tokens are never placed in a URL — they're returned only from `POST /auth/session/exchange`'s JSON body. Google's `email_verified` claim is trusted directly for account-linking decisions.

### Facebook OAuth setup

1. In [Facebook for Developers](https://developers.facebook.com/) → My Apps, create an app (type "Consumer" or "Business", whichever your Facebook account offers) and add the "Facebook Login" product.
2. Under Facebook Login → Settings, **Valid OAuth Redirect URIs:** add exactly
   ```
   https://api.edum8.us/auth/facebook/callback
   ```
3. **Scopes:** `email public_profile` (already hardcoded in `app/core/oauth_providers.py`).
4. Copy the App ID and App Secret into `.env.oracle`:
   ```
   FACEBOOK_CLIENT_ID=<your app id>
   FACEBOOK_CLIENT_SECRET=<your app secret>
   FACEBOOK_REDIRECT_URI=https://api.edum8.us/auth/facebook/callback
   ```
5. Move the app out of "Development" mode (App Review) once ready for real users to sign in — a Development-mode app only allows logins from accounts with a role on the app (admins/developers/testers).
6. Restart the backend.

Facebook's Graph API only ever returns an `email` field for an account with a confirmed address, and only when the user actually granted the `email` permission — there is no separate "verified" flag to check, so this app treats *presence* of the field as the verification signal (`app/core/oauth_providers.py::_facebook_identity`).

### LinkedIn OAuth setup

Uses LinkedIn's current OpenID Connect flow (`/oauth/v2/accessToken` + `/v2/userinfo`), not LinkedIn's older, now-deprecated API surface.

1. In the [LinkedIn Developer Portal](https://www.linkedin.com/developers/apps), create an app and add the "Sign In with LinkedIn using OpenID Connect" product.
2. Under Auth, **Authorized redirect URLs for your app:** add exactly
   ```
   https://api.edum8.us/auth/linkedin/callback
   ```
3. **Scopes:** `openid profile email` (already hardcoded in `app/core/oauth_providers.py` — matches what the OpenID Connect product grants by default).
4. Copy the Client ID and Client Secret into `.env.oracle`:
   ```
   LINKEDIN_CLIENT_ID=<your client id>
   LINKEDIN_CLIENT_SECRET=<your client secret>
   LINKEDIN_REDIRECT_URI=https://api.edum8.us/auth/linkedin/callback
   ```
5. Restart the backend.

LinkedIn's `/v2/userinfo` response includes an OIDC `email_verified` claim, which this app trusts directly (`app/core/oauth_providers.py::_linkedin_identity`) — the same trust level as Google's own `email_verified` claim.

### Canonical frontend and alternate frontend handling

`https://edum8.us` is the **canonical** frontend — it's the one origin OAuth completes against (`ALLOWED_AUTH_REDIRECT_URIS`, `FRONTEND_URL`) and the one every post-login/post-registration redirect resolves to. `https://app.edum8.us` is an **alternate** frontend origin: it's allowed to call the API (listed in `CORS_ORIGINS`) so it can use local email/password sign-in and an already-established session, but it is deliberately **not** in `ALLOWED_AUTH_REDIRECT_URIS` — Google sign-in started from `app.edum8.us` is not supported unless that changes. Keeping exactly one OAuth redirect surface is a deliberate simplification, not an oversight.

### Migration instructions

Two Alembic migrations back this feature set, both run automatically — `oracle-start.sh` and `oracle-update.sh` run `backend-migrate` (applies every pending migration) before `backend` starts, via the Compose `depends_on: condition: service_completed_successfully` graph; there is no separate manual migration step.

- **`0015_local_auth_credentials`** — nullable `users.password_hash` + new `auth_rate_limit_hits` table. Existing rows get `password_hash = NULL` ("OAuth-only, no local password").
- **`0016_email_verification`** — nullable `users.email_verified_at` + new `email_verification_tokens` table, plus a data backfill: an already-`email_verified` user (OAuth) gets `email_verified_at` backfilled to `created_at`; a **pre-existing local (password) account is grandfathered to verified** (also backfilled to `created_at`) rather than being unexpectedly locked out by a feature that didn't exist when it registered — see the migration file's own docstring for the full policy writeup. Every new local account created *after* this migration follows the real flow (unverified until confirmed).

Downgrading either migration (`alembic downgrade -1`, repeatable) drops the new column(s)/table(s) it added — **any password set, or verification-token history, created after upgrading is lost on downgrade**; this is each migration's one irreversible aspect. Every other table and row is unaffected by either direction.

### Verification commands

```bash
# Confirm the backend is actually serving the new routes
curl -s https://api.edum8.us/auth/providers | jq
#  -> {"providers": [...], "dev_login_enabled": false, "local_auth_enabled": true}

# Confirm local registration works end to end (expect email_verification_required: true)
curl -s -X POST https://api.edum8.us/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"smoke-test@example.com","password":"Str0ng!Passphrase#1"}' | jq

# Confirm login is refused before verification (expect 403, "email_verification_required")
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://api.edum8.us/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"smoke-test@example.com","password":"Str0ng!Passphrase#1"}'

# Confirm resend never reveals account existence (expect 200, identical response either way)
curl -s -X POST https://api.edum8.us/auth/resend-verification \
  -H 'Content-Type: application/json' -d '{"email":"smoke-test@example.com"}' | jq
curl -s -X POST https://api.edum8.us/auth/resend-verification \
  -H 'Content-Type: application/json' -d '{"email":"definitely-not-registered@example.com"}' | jq

# After clicking the emailed link (or extracting the token from a test
# EMAIL_PROVIDER=console log line in a non-production environment),
# confirm verify-email redirects with status=success:
curl -sI "https://api.edum8.us/auth/verify-email?token=<token>" | grep -i location

# Confirm login now succeeds
curl -s -X POST https://api.edum8.us/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"smoke-test@example.com","password":"Str0ng!Passphrase#1"}' | jq

# Confirm dev-login is refused in production (expect 404)
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://api.edum8.us/auth/dev-login \
  -H 'Content-Type: application/json' -d '{"email":"x@example.com"}'
```

### How to test email verification

With `EMAIL_PROVIDER=console` (non-production only), the verification link is logged, never sent — check `oracle-logs.sh backend` right after registering for a `[dev email backend] would send ...` line, and separately confirm the app never actually delivered mail. With `EMAIL_PROVIDER=smtp` configured for real, register with an address you control, confirm the email arrives (check spam too — this is exactly what SPF/DKIM/DMARC above reduce the risk of), click the link, and confirm it lands on `https://edum8.us/verify-email?status=success`.

### Manual browser test checklist

**Local registration and verification:**
- [ ] Visit `https://edum8.us/login` — the email/password form is visible immediately (never the old "No sign-in providers are configured" dead end).
- [ ] Select "Create account", enter a weak password (e.g. `12345678`) — rejected with a clear explanation, live checklist shown.
- [ ] Enter a strong password meeting every checklist item, submit — lands on `/check-email`, showing a masked version of the address.
- [ ] Attempt to sign in before verifying — denied, with a "Resend verification email" action offered.
- [ ] Open the verification link (from the real email, or the console-logged URL in non-production) — lands on `/verify-email` showing success.
- [ ] Sign in — lands on `/chat`.
- [ ] Refresh the browser — session persists (silent refresh), no forced re-login.
- [ ] Log out — redirected to `/login`, and protected routes (`/chat`, `/documents`, etc.) redirect back to `/login` if visited directly while signed out.
- [ ] Attempt sign-in with a wrong password → generic "Invalid email or password", not "account not found" or anything that confirms the address is registered.
- [ ] Click "Forgot password?" → shows the "not available yet" notice, no broken link, no crash.

**OAuth (repeat for each configured provider — Google, Facebook, LinkedIn):**
- [ ] The provider's button is visible only when that provider is fully configured.
- [ ] Clicking it begins authorization and completes successfully, returning to `https://edum8.us` with a valid session — never a token visible in the URL bar.
- [ ] Refresh works; logout works.
- [ ] Cancelling/denying the provider's consent screen produces a friendly in-app error, not a crash or a raw provider error.

### Rollback instructions

Application code: `oracle-update.sh` prints the exact previous Git commit and pre-update backup restore command if the post-update health check fails — see [Updates](#updates). To roll back manually: `git checkout <previous-commit>` in `~/edumind-ai`, then `./deploy/oracle/scripts/oracle-start.sh --build`.

Database: `alembic downgrade -1` inside the backend container reverts the most recent migration (`0016_email_verification`); run it twice to also revert `0015_local_auth_credentials` (see "Migration instructions" above for what's lost each time). For a full point-in-time rollback, use `oracle-restore.sh` — see [Restores](#restores).

### Which secrets must never be committed

`deploy/oracle/.env.oracle` itself is git-ignored and must never be committed (see "Copying and configuring `.env.oracle`" above). Within it, treat these as real secrets: `JWT_SECRET`, `GOOGLE_CLIENT_SECRET`, `FACEBOOK_CLIENT_SECRET`, `LINKEDIN_CLIENT_SECRET`, `SMTP_PASSWORD`. None of these are ever logged, returned by any API response, or written anywhere by this codebase — if you ever see one in a log line, that's a bug, not expected behavior.

### Security notes

- No dev login, no mock authentication, and no hardcoded credentials anywhere in this path — `AUTH_DEV_LOGIN_ENABLED` is hard-refused whenever `APP_ENV=production` regardless of its own value. `EMAIL_PROVIDER=console` (the non-delivering dev backend) is likewise hard-refused at startup whenever `APP_ENV=production`.
- No wildcard CORS origins; `CORS_ORIGINS` is an exact-match allowlist.
- No open redirects: `GET /auth/{provider}/authorize`'s `redirect_uri` and every post-login destination are checked against `ALLOWED_AUTH_REDIRECT_URIS`, never taken from an arbitrary caller-supplied value.
- Access and refresh tokens are never placed in a URL, ever — only in JSON response bodies, an HttpOnly cookie (web), or `expo-secure-store` (native). The one exception anywhere in this feature is the verification token in `GET /auth/verify-email?token=...`, which is exactly the short-lived, single-use, non-session credential the constraints explicitly carve out room for (an email link has no other transport) — it is immediately consumed and never re-usable.
- Password hashes, raw passwords, refresh tokens, and verification tokens are never logged. `EMAIL_PROVIDER=console`'s dev backend logs only a subject/recipient line, never the message body (which carries the verification link).
- Refresh-token rotation and reuse (theft) detection, and PKCE/state/nonce for OAuth, are unchanged from the pre-existing implementation this work builds on — see "Architecture" above.
- Password reset remains unimplemented (see "Local authentication" above) — not a regression, a scope boundary this task's own instructions explicitly allow.

---

## Disaster recovery workflow

```
Incident detected
      │
      ▼
oracle-status.sh / oracle-healthcheck.sh   (assess what's actually broken)
      │
      ▼
oracle-logs.sh <service> --tail 200 --no-follow   (find the root cause)
      │
      ├── Config/code issue → fix, then oracle-restart.sh
      │
      └── Data corruption / bad restore / failed update
                │
                ▼
          Find the right backup: ls -1t ~/edumind-backups/edumind-oracle-backup-*
                │
                ▼
          oracle-restore.sh <backup-dir> --dry-run   (verify checksums + plan)
                │
                ▼
          oracle-restore.sh <backup-dir>   (creates its own safety backup first)
                │
                ▼
          oracle-healthcheck.sh   (confirm recovery)
```

If a health check still fails after a restore, the restore script's own output tells you exactly which pre-restore safety backup to roll back to and prints the exact command.

---

## Troubleshooting

| Symptom | Likely cause / first step |
|---|---|
| `oracle-start.sh` hangs waiting for health | `oracle-logs.sh <service> --no-follow --tail 100` — usually Ollama still pulling/loading a model on first start |
| `backend-migrate` container missing entirely | Already ran and was pruned after a previous successful start — not itself a failure; `oracle-healthcheck.sh` treats it as a warning, not a failure, in that case |
| `models NOT available` in healthcheck | `docker compose -f deploy/oracle/docker-compose.oracle.yml --env-file deploy/oracle/.env.oracle exec ollama ollama pull <model>` |
| Backend `/health/ready` returns `not_ready` | Check `ollama_reachable`/`qdrant_reachable`/`models_available` in the JSON body — `oracle-status.sh` prints it directly |
| `oracle-update.sh` refuses with "uncommitted changes" | Commit, stash, or discard local changes in `~/edumind-ai` first — updates only ever fast-forward a clean tree |
| `oracle-backup.sh`/`oracle-restore.sh` says a volume doesn't exist | Confirm `docker volume ls | grep edumind-rpi5` — if the stack was never started, the volumes don't exist yet; run `oracle-start.sh` first |
| Frontend loads but API calls fail (CORS) | `CORS_ORIGINS` / `EXPO_PUBLIC_API_BASE_URL` in `.env.oracle` don't match the URL you're actually browsing from |

---

## Command examples

```bash
# First-time setup
cp deploy/oracle/.env.oracle.example deploy/oracle/.env.oracle
$EDITOR deploy/oracle/.env.oracle
./deploy/oracle/scripts/oracle-start.sh --build

# Daily
./deploy/oracle/scripts/oracle-status.sh
./deploy/oracle/scripts/oracle-logs.sh backend

# Before a risky change
./deploy/oracle/scripts/oracle-backup.sh

# Deploying new code
./deploy/oracle/scripts/oracle-update.sh --show-plan
./deploy/oracle/scripts/oracle-update.sh

# Something broke after an update
./deploy/oracle/scripts/oracle-restore.sh ~/edumind-backups/edumind-oracle-backup-<timestamp> --dry-run
./deploy/oracle/scripts/oracle-restore.sh ~/edumind-backups/edumind-oracle-backup-<timestamp>
```
