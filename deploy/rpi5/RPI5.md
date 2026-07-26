# Raspberry Pi 5 deployment — EduMind RAG backend

This directory lays out a self-contained Docker Compose deployment of the
**rag-backend** (FastAPI + Ollama + Qdrant) onto a Raspberry Pi 5 (8 GB).

The other subprojects (the Expo app under `examples/`, the JS SDK under
`packages/`, the Node `backend/`) are *not* part of this deployment — they're
run on the developer's machine and consume the Pi's API over the LAN.

## What's in here

| File / dir | Purpose |
|---|---|
| `Dockerfile.rpi5` | ARM64 backend image (multi-stage, non-root, runtime-only deps). |
| `docker-compose.rpi5.yml` | Three services + one init service: `ollama`, `qdrant`, `backend-migrate` (one-shot alembic), `backend`. Named volumes for persistent state. |
| `.env.rpi5.example` | Template for the runtime env file. **Copy to `.env.rpi5` and fill in `<PI_LAN_HOST>` + `<SET_BY_SETUP_SH>`** — `rpi5-setup.sh` does this automatically. |
| `scripts/lib/common.sh` | Shared shell helpers (`rpi5_log`, `rpi5_die`, SSH wrapper, UTC timestamps). |
| `scripts/rpi5-setup.sh` | Interactive host-side first-time config — generates JWT_SECRET, prompts for Pi host / dir / LAN IP, writes `.env.rpi5`, verifies the Pi is arm64 + Docker-equipped. |
| `scripts/rpi5-package.sh` | Builds the SCP-ready tarball at `/tmp/edumind-rpi5-pkg-<UTC-TS>/`, strips dev/test/caches/runtime state. Prints exact filename + sha256 + size. |
| `scripts/rpi5-start.sh` | SSH + `docker compose pull && build && up -d`. |
| `scripts/rpi5-stop.sh` | SSH + `docker compose down`. Volumes preserved. |
| `scripts/rpi5-models-download.sh` | SSH + `docker compose exec ollama ollama pull …` for the three pinned tags. |
| `scripts/rpi5-healthcheck.sh` | SSH + curl on `/health/ready`, parses JSON, exit-code reflects readiness. |
| `scripts/rpi5-logs.sh` | SSH + `docker compose logs -f` (pass service name as $1 for one service). |
| `scripts/rpi5-backup.sh` | Snapshot `-t data|qdrant|ollama` named volumes to a host-side tarball via a transient alpine container. |
| `scripts/rpi5-build.sh` | **Optional** host-side cross-build via `docker buildx` (Apple Silicon native; Intel uses QEMU). Defaults to building on Pi natively — this script exists for advanced setups. |

## Required Pi host preparation (one-time)

The Pi must:
- Run Raspberry Pi OS Bookworm 64-bit (or any Debian 12+ aarch64).
- Have Docker Engine 25+ and `docker-compose-plugin` v2+ installed.
  - Bookworm install: `sudo apt-get update && sudo apt-get install -y docker.io docker-compose-plugin`.
  - Add yourself to the `docker` group so rootless ssh works:
    `sudo usermod -aG docker $USER && sudo systemctl restart docker`.
- Have a working SSH key-authenticated login for `$PI_HOST`.
- Have inbound TCP 8000 accessible from the LAN the Expo app is on
  (router/NAT dependent; the Pi's host firewall defaults allow it).

`rpi5-setup.sh` verifies the Pi is aarch64 + has docker compose before
generating any state.

## Deploy workflow on the host

```bash
# 1. Configure (host-side) — generates .env.rpi5, prints the JWT_SECRET once.
deploy/rpi5/scripts/rpi5-setup.sh

# 2. Build the SCP tarball at /tmp/edumind-rpi5-pkg-<UTC-TS>/
deploy/rpi5/scripts/rpi5-package.sh

# 3. SCP to the Pi (the package script prints the exact filename).
scp /tmp/edumind-rpi5-pkg-<UTC-TS>/edumind-rpi5-pkg-<UTC-TS>.tar.gz "$PI_HOST:~/"

# 4. SSH extract on the Pi.
ssh "$PI_HOST" "cd ~ && tar -xzf edumind-rpi5-pkg-<UTC-TS>.tar.gz"

# 5. Bring the stack up on the Pi (does pull + build + up -d).
deploy/rpi5/scripts/rpi5-start.sh

# 6. Pull the three Ollama models from the Pi.
deploy/rpi5/scripts/rpi5-models-download.sh

# 7. Sanity check.
deploy/rpi5/scripts/rpi5-healthcheck.sh
```

After step 7 succeeds, the backend is reachable at `http://<PI_LAN_HOST>:8000`
on the LAN, and the Expo app on any device on the same Wi-Fi can point
`EXPO_PUBLIC_API_BASE_URL` at it.

## Day-to-day operations

| Need | Command |
|---|---|
| Tail logs | `deploy/rpi5/scripts/rpi5-logs.sh` (or `rpi5-logs.sh backend` to follow one) |
| Stop stack (keep data) | `deploy/rpi5/scripts/rpi5-stop.sh` |
| Restart | `rpi5-stop.sh && rpi5-start.sh` |
| Backup data + qdrant volumes | `rpi5-backup.sh` — produces `rpi5-data-*.tgz` and `rpi5-qdrant-*.tgz` in cwd |
| Wipe state (DESTRUCTIVE) | `ssh $PI_HOST 'docker volume rm edumind-rpi5_{backend,qdrant,ollama}-data'` |

## Update workflow (after rag-backend source changes)

```bash
# Re-package + SCP + restart:
deploy/rpi5/scripts/rpi5-package.sh
scp /tmp/edumind-rpi5-pkg-<UTC-TS>/edumind-rpi5-pkg-<UTC-TS>.tar.gz "$PI_HOST:~/"
ssh "$PI_HOST" 'cd ~/edumind-rpi5-pkg-<UTC-TS> && \
  docker compose -p edumind-rpi5 -f docker-compose.rpi5.yml build'
deploy/rpi5/scripts/rpi5-stop.sh
deploy/rpi5/scripts/rpi5-start.sh
deploy/rpi5/scripts/rpi5-healthcheck.sh
```

The Pi's `docker compose build` rebuilds the local `edumind-rpi5-backend`
image. Existing volumes survive (so sqlite db + chat attachments +
qdrant storage + ollama models all carry through).

## Rolling back

If a deployment is bad, rolling back means redeploying the previous tarball's
`rag-backend/` + restarting the stack. Named volumes (data / qdrant) survive
across redeployments because they're mounted, not image-content.

If everything goes sideways:

```bash
ssh "$PI_HOST" 'cd ~/edumind-rpi5-pkg-<UTC-TS> && \
  docker compose -p edumind-rpi5 -f docker-compose.rpi5.yml down'
ssh "$PI_HOST" 'docker system prune --volumes'  # CAUTION: erases ALL
                                                     volumes on the host
```

`docker system prune --volumes` is irreversible. Run only when the operator
is okay rebuilding from scratch (model re-download required).

## Operational assumptions baked in (and how to verify them)

1. **Pi 5 is aarch64.** Verified live by `rpi5-setup.sh`'s `uname -m` call.
2. **Docker + compose plugin installed.** Same script's `docker compose version` check.
3. **Ollama 0.x + qdrant v1.x reach each other under their compose-internal DNS names** (`ollama`, `qdrant`). Baked into the compose file's `networks:`. The backend's `OLLAMA_BASE_URL=http://ollama:11434`, `QDRANT_URL=http://qdrant:6333` resolve via Docker's internal DNS.
4. **`qwen3:4b`, `qwen2.5vl:3b`, `mxbai-embed-large` are exactly the published Ollama tags.** If the operator wants different tags, edit `rpi5-models-download.sh` and update `.env.rpi5` — those are the two single-source-of-truth files.
5. **`mxbai-embed-large` (not a different embedding model).** The Qdrant collection is built with a fixed vector size (1024) hardcoded into `app/core/embedding_provider.py:MXBAI_EMBED_LARGE_DIMENSIONS`. Swapping embeddings requires re-ingesting the corpus from scratch. Keeping `mxbai-embed-large` is the only safe option.
6. **`IMAGE_GENERATION_ENABLED=false`.** Means `x/flux2-klein` is **not** pulled — saves ~5 GB of disk. The frontend auto-hides image-gen UI via the centralized `FeatureFlags` provider (see `examples/expo-education-assistant/lib/FeatureFlags.tsx`). Setting the flag to `true` is opt-in: change `.env.rpi5` + add `x/flux2-klein` to `rpi5-models-download.sh`.
7. **Alembic is the schema source-of-truth.** The dedicated `backend-migrate` one-shot service runs `alembic upgrade head` against the persistent `/data/app.db` (mounted from the `edumind-rpi5_backend-data` volume) before the backend starts (compose `depends_on: service_completed_successfully`). On a fresh volume, this creates every table; on subsequent restarts it's an idempotent no-op.
8. **SSH host key is on the user's `$HOME/.ssh/known_hosts`.** Standard ssh client behavior. `RPI5_SSH_OPTS` env var can override (e.g., `-o StrictHostKeyChecking=no -i ~/.ssh/id_rsa_example`) if needed — none of the scripts pass per-host commands without checking exit codes.

## Files added and *not* added

**Added** (entirely new, no existing files modified):

```
deploy/rpi5/
├── Dockerfile.rpi5
├── docker-compose.rpi5.yml
├── .env.rpi5.example
├── RPI5.md  (this file)
└── scripts/
    ├── lib/common.sh
    ├── rpi5-setup.sh
    ├── rpi5-package.sh
    ├── rpi5-build.sh
    ├── rpi5-start.sh
    ├── rpi5-stop.sh
    ├── rpi5-models-download.sh
    ├── rpi5-healthcheck.sh
    ├── rpi5-logs.sh
    └── rpi5-backup.sh
```

Plus one non-modifying new file:

```
rag-backend/entrypoint.sh         (used by Dockerfile.rpi5 only; not part of
                                   local-dev workflow (uvicorn / pytest directly)
                                   and not invoked from rag-backend/scripts/*)
```

**Not modified** (intentionally — the spec said leave local-dev alone):
- `rag-backend/{app,cli,alembic,tests,scripts}` (zero edits).
- `rag-backend/{pyproject.toml,alembic.ini,.env,.env.example,.gitignore,README.md}` (zero edits).
- Top-level `.gitignore`, `.env`, `package.json`, `app.json`, the Expo
  app under `src/` and `app/`, the JS backend under `backend/`, the
  SDK under `packages/`, and any other monorepo subprojects.
