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
| backend | 8000 | `0.0.0.0:8000` | **Temporary testing port** — see [Security guidance](#security-guidance) |
| frontend | 80 | `0.0.0.0:8080` | **Temporary testing port** — see [Security guidance](#security-guidance) |
| qdrant | 6333 | `127.0.0.1:6333` | Loopback only — never exposed publicly |
| ollama | 11434 | *(not published)* | Reachable only from sibling containers on the compose network |

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
#    - <ORACLE_PUBLIC_IP> in CORS_ORIGINS / FRONTEND_URL / EXPO_PUBLIC_API_BASE_URL /
#      ALLOWED_AUTH_REDIRECT_URIS — your VM's public IP or domain
#    - OAuth client id/secret pairs, if you're enabling any provider

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

## Security guidance

This deployment is currently configured for **testing, not public production use**. Before treating it as production:

- **Dev login is temporary.** `AUTH_DEV_LOGIN_ENABLED` exists purely for testing without a configured OAuth provider. It is hard-refused whenever `APP_ENV=production` regardless of this flag (`app/api/routes_auth.py`) — but you must actually set `APP_ENV=production` for that gate to take effect, and you must configure at least one real OAuth provider first, or no one will be able to log in.
- **Production should use OAuth.** Fill in Google/Facebook/LinkedIn client id+secret in `.env.oracle` and update `ALLOWED_AUTH_REDIRECT_URIS` accordingly.
- **Ports 8000 and 8080 are temporary testing ports.** They are published directly on the host for initial setup and debugging convenience.
- **A final production deployment should expose only 80/443** through a reverse proxy (e.g. nginx, Caddy, or a cloud load balancer) in front of this stack, terminating TLS there — not by directly publishing 8000/8080 to the internet. Qdrant (6333) is already loopback-only and should stay that way.
- Never commit `.env.oracle` or `.env.oracle.before-optimization` — see [Git safety](#git-safety) below.

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
