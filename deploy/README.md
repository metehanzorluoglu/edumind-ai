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
└── rpi5/
    ├── Dockerfile.rpi5
    ├── docker-compose.rpi5.yml
    ├── scripts/
    └── RPI5.md
```

---

# Overview

EduMind AI supports multiple deployment environments.

| Environment | Purpose | Docker Project |
|-------------|----------|----------------|
| Development | Local development and testing | `edumind-dev` |
| Production | Long-term deployment | `edumind-rpi5` |
| Raspberry Pi Package | Deployment bundle for Raspberry Pi | `edumind-rpi5` |

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

These volumes are intentionally reused across deployments.

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
```

Never delete

```
edumind-rpi5_backend-data
edumind-rpi5_qdrant-data
edumind-rpi5_ollama-data
```

Never execute

```bash
docker compose down -v
```

unless permanent data deletion is intended.

Always verify

```bash
./deploy/prod/scripts/prod-healthcheck.sh
```

after updating the production deployment.

---

# Project Status

Current deployment status

- ✅ Development environment
- ✅ Production environment
- ✅ Raspberry Pi deployment
- ✅ Docker Compose
- ✅ Health checks
- ✅ Automatic migrations
- ✅ Persistent storage
- ✅ Operations toolkit
- ✅ GitHub deployment
- ✅ Backup system

Planned

- ⏳ Backup automation
- ⏳ Restore automation
- ⏳ Update automation
- ⏳ GitHub Actions CI/CD
- ⏳ HTTPS
- ⏳ Reverse proxy
- ⏳ Monitoring dashboard