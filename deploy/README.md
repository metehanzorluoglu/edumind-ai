# EduMind AI Deployment Guide

This directory contains everything required to deploy, operate, maintain, and recover the EduMind AI backend.

```
deploy/
├── README.md
├── dev/
│   ├── docker-compose.dev.yml
│   ├── .env.dev.example
│   └── scripts/                 (future)
│
├── prod/
│   ├── docker-compose.prod.yml
│   ├── .env.prod.example
│   ├── scripts/
│   │   ├── lib/
│   │   │   └── common.sh
│   │   ├── prod-start.sh
│   │   ├── prod-stop.sh
│   │   ├── prod-restart.sh
│   │   ├── prod-status.sh
│   │   ├── prod-healthcheck.sh
│   │   ├── prod-logs.sh
│   │   ├── prod-backup.sh
│   │   ├── prod-restore.sh
│   │   └── prod-update.sh
│   │
│   └── README.md
│
├── rpi5/
│   ├── Dockerfile.rpi5
│   ├── docker-compose.rpi5.yml
│   ├── scripts/
│   └── RPI5.md
│
└── oracle/
    ├── docker-compose.oracle.yml
    ├── .env.oracle.example
    ├── scripts/
    │   ├── lib/
    │   │   └── common.sh
    │   ├── oracle-start.sh
    │   ├── oracle-stop.sh
    │   ├── oracle-restart.sh
    │   ├── oracle-status.sh
    │   ├── oracle-logs.sh
    │   ├── oracle-healthcheck.sh
    │   ├── oracle-backup.sh
    │   ├── oracle-restore.sh
    │   └── oracle-update.sh
    │
    └── README.md
```

---

# Overview

EduMind AI supports multiple deployment environments.

| Environment | Purpose | Docker Project |
|-------------|----------|----------------|
| Development | Local development and testing | `edumind-dev` |
| Production (Raspberry Pi) | Long-term deployment on Raspberry Pi 5 hardware | `edumind-rpi5` |
| Raspberry Pi Package | Deployment bundle for Raspberry Pi | `edumind-rpi5` |
| Oracle Cloud VM | Long-term deployment on Oracle VM.Standard.A1.Flex (ARM64, 4 OCPU, 24 GB RAM) | `edumind-oracle` |

---

# Deployment environments compared

| | `deploy/dev` | `deploy/rpi5` | `deploy/prod` | `deploy/oracle` |
|---|---|---|---|---|
| Purpose | Local development | Raspberry Pi 5 hardware deployment | Generic production compose (currently Pi-targeted) | Oracle Cloud VM.Standard.A1.Flex deployment |
| Docker Compose project | `edumind-dev` | `edumind-rpi5` | `edumind-rpi5` | `edumind-oracle` |
| Host profile | Developer laptop | 8 GB Raspberry Pi 5 | Same as rpi5 | 4 OCPU / 24 GB ARM64 Oracle VM |
| Models | Whatever's convenient for dev | `qwen3:4b` / `qwen2.5vl:3b` (fits 8 GB) | Same as rpi5 | `qwen3:8b` / `qwen2.5vl:7b` (fits 24 GB) |
| Operations scripts | — | `deploy/rpi5/scripts/` | `deploy/prod/scripts/` | `deploy/oracle/scripts/` |
| Full docs | — | `deploy/rpi5/RPI5.md` | (this file) | `deploy/oracle/README.md` |

**`deploy/prod/scripts/` operate on the `edumind-rpi5` Compose project (`deploy/prod/docker-compose.prod.yml` / `.env.prod`) and must never be used to control the Oracle deployment.** Always use `deploy/oracle/scripts/oracle-*.sh` for that — never `deploy/prod/scripts/prod-*.sh`.

This is not just a naming convention: `deploy/prod/docker-compose.prod.yml` (project `edumind-rpi5`) and `deploy/oracle/docker-compose.oracle.yml` (project `edumind-oracle`) declare the **exact same underlying volume and network names** (`edumind-rpi5_backend-data`, `edumind-rpi5_qdrant-data`, `edumind-rpi5_ollama-data`, `edumind-rpi5_net`) — deliberately, so the Oracle deployment inherits the original Pi data instead of starting empty. Docker volumes/networks are daemon-global, not project-scoped, so both compose files really do point at the same data. **Never run the `edumind-rpi5` and `edumind-oracle` stacks at the same time** — two independent sets of containers writing to the same SQLite file and the same Qdrant on-disk storage concurrently is a real data-corruption risk, not a hypothetical one. Treat them as alternative configurations for the same data, never as two simultaneously-active deployments.

---

# Architecture

```
                Browser
                   │
                   │
             Frontend (nginx)
                   │
                   ▼
            FastAPI Backend
           /       |        \
          /        |         \
    SQLite      Ollama     Qdrant
 Database       Models      Vectors
```

---

# Persistent Data

The following Docker volumes store all application data.

| Volume | Purpose |
|---------|---------|
| edumind-rpi5_backend-data | SQLite database, uploaded documents, application data |
| edumind-rpi5_qdrant-data | Vector database |
| edumind-rpi5_ollama-data | Downloaded LLM models |

These volumes are intentionally reused across deployments — both `deploy/prod` (Compose project `edumind-rpi5`) and `deploy/oracle` (Compose project `edumind-oracle`) declare these same volume names, so the Oracle deployment inherits existing data instead of starting empty. **Because of this, never run the `edumind-rpi5` and `edumind-oracle` stacks at the same time** — see [Deployment environments compared](#deployment-environments-compared) above.

Never remove them unless you intentionally want to erase all application data.

Never run

```bash
docker compose down -v
```

unless complete data removal is intended.

---

# Environment Files

Example files

```
.env.dev.example
.env.prod.example
```

Local files

```
.env.dev
.env.prod
```

The local files contain secrets and are ignored by Git.

Examples include

- JWT secret
- OAuth credentials
- API keys

---

# Daily Operations

Start

```bash
./deploy/prod/scripts/prod-start.sh
```

Stop

```bash
./deploy/prod/scripts/prod-stop.sh
```

Restart

```bash
./deploy/prod/scripts/prod-restart.sh
```

Status

```bash
./deploy/prod/scripts/prod-status.sh
```

Health Check

```bash
./deploy/prod/scripts/prod-healthcheck.sh
```

Logs (all)

```bash
./deploy/prod/scripts/prod-logs.sh
```

Logs (backend)

```bash
./deploy/prod/scripts/prod-logs.sh backend
```

---

# Health Monitoring

The health check verifies

- Docker containers
- Container health status
- Backend API
- Authentication endpoint
- Frontend availability

Successful execution ends with

```
All production health checks passed.
```

---

# Oracle VM Operations

Full detail: [`deploy/oracle/README.md`](oracle/README.md). Summary of every command:

| Action | Command |
|---|---|
| Start | `./deploy/oracle/scripts/oracle-start.sh` |
| Start (rebuild images) | `./deploy/oracle/scripts/oracle-start.sh --build` |
| Stop (volumes preserved) | `./deploy/oracle/scripts/oracle-stop.sh` |
| Restart | `./deploy/oracle/scripts/oracle-restart.sh` |
| Status dashboard | `./deploy/oracle/scripts/oracle-status.sh` |
| Health check | `./deploy/oracle/scripts/oracle-healthcheck.sh` |
| Logs (all, follow) | `./deploy/oracle/scripts/oracle-logs.sh` |
| Logs (one service) | `./deploy/oracle/scripts/oracle-logs.sh backend --tail 200` |
| Backup | `./deploy/oracle/scripts/oracle-backup.sh` |
| Backup (skip large Ollama volume) | `./deploy/oracle/scripts/oracle-backup.sh --skip-ollama` |
| Restore (validate only) | `./deploy/oracle/scripts/oracle-restore.sh <backup-dir> --dry-run` |
| Restore | `./deploy/oracle/scripts/oracle-restore.sh <backup-dir>` |
| Update (plan only) | `./deploy/oracle/scripts/oracle-update.sh --show-plan` |
| Update (dry run) | `./deploy/oracle/scripts/oracle-update.sh --dry-run` |
| Update | `./deploy/oracle/scripts/oracle-update.sh` |

Every `oracle-*.sh` script supports `--help`, uses `set -Eeuo pipefail`, works from any current working directory, never runs `docker compose down -v`, and never prints secret values. `oracle-status.sh` and `oracle-healthcheck.sh` both cover: container status, Docker health status, backend `/health` + `/health/ready`, `/auth/providers`, frontend `/health`, Ollama's loaded models (`ollama ps`), and — status only — host memory/swap, Docker disk usage, effective (non-secret) model configuration, and the current Git branch/commit. `oracle-healthcheck.sh` additionally verifies published ports, the `backend-migrate` job's exit code, and that all three configured models (`qwen3:8b`, `qwen2.5vl:7b`, `mxbai-embed-large`) are pulled — and exits non-zero if anything fails, unlike `oracle-status.sh` which never fails just because a service is still starting.

**Oracle backups, restores, and updates** follow the same shape as the production toolkit below (stop stateful services only when needed for consistency, checksum-verify immediately, always restart via trap-based error handling, retention-managed, rollback instructions on failure) with three Oracle-specific differences: a `--skip-ollama` flag on both backup and restore (the Ollama volume is large — every pulled model, commonly 10+ GB for this deployment), an `--online` flag on backup for zero-downtime snapshots, and a default retention of the newest **10** backups (`KEEP_BACKUPS=10`) rather than unlimited, given how much larger the Ollama volume is here.

**Current Oracle performance optimizations** (see `deploy/oracle/README.md` for the full evidence behind each):
`OLLAMA_MAX_LOADED_MODELS=2`, `OLLAMA_KEEP_ALIVE=30m`, `OLLAMA_NUM_PARALLEL=1`, an 18 GB Ollama memory limit with no CPU quota, `OLLAMA_THINKING_ENABLED=false`, `OLLAMA_NUM_PREDICT=512`, `EMBEDDING_BATCH_SIZE=32`, a 200-character chunk overlap (down from 450, validated by a retrieval-quality evaluation), and Nginx gzip + immutable static-asset caching.

**`deploy/prod/scripts/prod-*.sh` must never be used to control the Oracle deployment** — see [Deployment environments compared](#deployment-environments-compared).

---

# Frontend Operations

Full detail: [`deploy/frontend/README.md`](frontend/README.md).

The `deploy/frontend/` directory contains the frontend image recipe (`Dockerfile`, `nginx.conf` — Expo web static export served by nginx, published on test port **8080**) plus an operations toolkit that controls **only the `frontend` service** of the Oracle Compose stack (`edumind-oracle`, defined in `deploy/oracle/docker-compose.oracle.yml`).

```
deploy/frontend/
├── README.md
├── Dockerfile
├── nginx.conf
└── scripts/
    ├── lib/common.sh
    ├── frontend-start.sh
    ├── frontend-stop.sh
    ├── frontend-restart.sh
    ├── frontend-update.sh
    ├── frontend-logs.sh
    └── frontend-status.sh
```

| Action | Command |
|---|---|
| Start | `./deploy/frontend/scripts/frontend-start.sh` |
| Start (rebuild image) | `./deploy/frontend/scripts/frontend-start.sh --build` |
| Stop (frontend only) | `./deploy/frontend/scripts/frontend-stop.sh` |
| Restart (frontend only) | `./deploy/frontend/scripts/frontend-restart.sh` |
| Restart (rebuild image) | `./deploy/frontend/scripts/frontend-restart.sh --build` |
| Status dashboard | `./deploy/frontend/scripts/frontend-status.sh` |
| Logs (follow) | `./deploy/frontend/scripts/frontend-logs.sh` |
| Logs (options) | `./deploy/frontend/scripts/frontend-logs.sh --tail 200 --timestamps --since 10m` |
| Update (plan only) | `./deploy/frontend/scripts/frontend-update.sh --show-plan` |
| Update (dry run) | `./deploy/frontend/scripts/frontend-update.sh --dry-run` |
| Update | `./deploy/frontend/scripts/frontend-update.sh --yes` |

**These scripts never restart the Oracle backend, Ollama, Qdrant, or the `backend-migrate` job** — every container operation uses `frontend`-scoped Compose commands (`stop frontend`, `up -d --force-recreate --no-deps frontend`), never `docker compose down`, and never touches persistent volumes or networks. `frontend-update.sh` fetches and fast-forwards `UPDATE_REMOTE`/`UPDATE_BRANCH` (defaults `origin`/`main`), rebuilds only when frontend-related paths changed (`deploy/frontend/`, `examples/expo-education-assistant/`, `packages/education-assistant-client/` — or `--force-build`), verifies health at `http://127.0.0.1:8080/health` and `/`, and prints rollback instructions. `frontend-status.sh` reports container/image/health/restart-count/ports, HTTP + gzip + cache headers (hashed assets cached one year and immutable; `index.html` not immutable), CPU/memory, image size, Git branch/commit, working-tree drift in frontend paths, and whether the running image predates the latest frontend source change — and never fails just because the frontend is still starting.

Every `frontend-*.sh` script supports `--help`, uses `set -Eeuo pipefail`, works from any current working directory, and never prints secret values from `deploy/oracle/.env.oracle` (only `EXPO_PUBLIC_*` values are ever baked into the frontend — see the security guidance in [`deploy/frontend/README.md`](frontend/README.md)).

---

# Current Production Features

Current deployment includes

## Infrastructure

- Docker Compose
- Named Docker volumes
- Health checks
- Automatic restart policies
- Shared Docker network

---

## Backend

- FastAPI
- SQLite
- Alembic automatic migrations
- JWT authentication
- OAuth framework
- Streaming responses
- Image generation support
- Vision model support

---

## AI

Ollama hosts

- Qwen 3
- Qwen 2.5 VL
- MXBAI Embed

Automatic model unloading is enabled to reduce memory usage on Raspberry Pi.

---

## Vector Database

Qdrant provides

- semantic search
- embeddings
- document retrieval

---

## Operations Toolkit

Implemented

- Shared script library
- Status command
- Health check
- Start
- Stop
- Restart
- Logs

Planned

- Backup
- Restore
- Update
- Automatic cleanup

---

# Backup Strategy

Backups are stored in

```
~/edumind-backups/
```

Each backup contains

```
backend-data.tar.gz
qdrant-data.tar.gz
ollama-data.tar.gz
SHA256SUMS
```

Backups should always be created before

- major upgrades
- Docker image changes
- database migrations
- model updates

---

# Deployment Workflow

```
Develop
      │
      ▼
Development Environment
      │
      ▼
Git Commit
      │
      ▼
GitHub
      │
      ▼
Pull on Raspberry Pi
      │
      ▼
Backup
      │
      ▼
Update
      │
      ▼
Health Check
      │
      ▼
Production Ready
```

---

# Raspberry Pi

Detailed Raspberry Pi installation instructions are documented separately.

```
deploy/rpi5/RPI5.md
```

---

# Safety Rules

Never commit

```
.env.dev
.env.prod
.env.oracle
.env.oracle.before-optimization
```

Never delete

```
edumind-rpi5_backend-data
edumind-rpi5_qdrant-data
edumind-rpi5_ollama-data
```

(shared by `deploy/prod` and `deploy/oracle` — see [Persistent Data](#persistent-data))

Never execute

```bash
docker compose down -v
```

unless permanent data deletion is intended.

**Never use `deploy/prod/scripts/prod-*.sh` to control the Oracle deployment, and never run the `edumind-rpi5` and `edumind-oracle` Compose projects at the same time** — see [Deployment environments compared](#deployment-environments-compared).

Always verify

```bash
./deploy/prod/scripts/prod-healthcheck.sh       # after updating the Raspberry Pi / prod deployment
./deploy/oracle/scripts/oracle-healthcheck.sh   # after updating the Oracle deployment
```

after updating the respective deployment.

---

# Project Status

Current deployment status

- ✅ Development environment
- ✅ Production environment
- ✅ Raspberry Pi deployment
- ✅ Oracle Cloud VM deployment
- ✅ Docker Compose
- ✅ Health checks
- ✅ Automatic migrations
- ✅ Persistent storage
- ✅ Operations toolkit (production and Oracle)
- ✅ GitHub deployment
- ✅ Backup system (production and Oracle)
- ✅ Restore automation (production and Oracle)
- ✅ Update automation (production and Oracle)

Planned

- ⏳ GitHub Actions CI/CD
- ⏳ HTTPS
- ⏳ Reverse proxy
- ⏳ Monitoring dashboard