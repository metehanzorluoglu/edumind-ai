# EduM8 Frontend Deployment Operations

Operations toolkit for the EduM8 **frontend service only**: start, stop,
restart, update, status, and logs for the nginx-served Expo web export that
runs inside the Oracle VM Compose stack.

These scripts control **only** the `frontend` service. They never restart the
backend, Ollama, Qdrant, or the one-shot `backend-migrate` job, and they never
touch persistent volumes or Docker networks.

## Relationship to `deploy/oracle/docker-compose.oracle.yml`

The frontend service is **defined** in
[`deploy/oracle/docker-compose.oracle.yml`](../oracle/docker-compose.oracle.yml)
(service `frontend`, project name `edumind-oracle`, environment file
[`deploy/oracle/.env.oracle`](../oracle/.env.oracle)). This directory provides
the frontend's image recipe (`Dockerfile`, `nginx.conf`) plus an operations
toolkit that targets that one service within the Oracle Compose project. The
Oracle stack toolkit (`deploy/oracle/scripts/`) manages the whole stack; this
toolkit manages one service of it.

## Architecture

```
Browser ──> :8080 (temporary test port) ──> nginx (frontend container, :80)
                                              ├── /health          → plain-text 200 "healthy"
                                              ├── /_expo/static/*  → hashed assets, 1y immutable cache, gzip
                                              └── everything else  → try_files SPA fallback to /index.html
```

- **Expo web static export** — `examples/expo-education-assistant` is exported
  with `npx expo export --platform web` at image build time. The only
  build-time configuration is `EXPO_PUBLIC_API_BASE_URL` (a public value, baked
  into the JS bundle — see Security guidance below).
- **Nginx** (`nginx:1.27-alpine`) serves the static export with gzip, immutable
  long-lived caching for hashed assets, and an SPA fallback.
- **Published test port 8080** — Compose maps `"${FRONTEND_PORT:-8080}:80"`.
  Port 8080 is temporary for testing; see Security guidance for production.

## File structure

```
deploy/frontend/
├── README.md                  ← this file
├── Dockerfile                 ← multi-stage: SDK build → Expo web export → nginx
├── nginx.conf                 ← SPA fallback, /health, gzip, immutable asset cache
└── scripts/
    ├── lib/
    │   └── common.sh          ← shared helpers (paths, Compose wrapper, health, logging)
    ├── frontend-start.sh      ← start the frontend service (+ declared dependencies)
    ├── frontend-stop.sh       ← stop ONLY the frontend container
    ├── frontend-restart.sh    ← recreate ONLY the frontend container (--build optional)
    ├── frontend-update.sh     ← Git fast-forward + conditional frontend rebuild
    ├── frontend-logs.sh       ← follow/tail frontend container logs
    └── frontend-status.sh     ← full frontend dashboard (HTTP, gzip, cache, git)
```

## Prerequisites

- Docker Engine with the Docker Compose v2 plugin (`docker compose version`)
- Docker daemon reachable by the current user (`docker info`)
- `curl` (health checks)
- `deploy/oracle/.env.oracle` present and filled in (copy of
  `deploy/oracle/.env.oracle.example`) — it defines `EXPO_PUBLIC_API_BASE_URL`
  and optionally `FRONTEND_PORT`
- Git (only for `frontend-update.sh` / Git sections of `frontend-status.sh`)

All scripts use `set -Eeuo pipefail`, work from **any** current working
directory (paths are resolved from each script's own location), support
`--help`, log with `[INFO]`/`[OK]`/`[WARN]`/`[ERROR]`, and never print secret
values from `.env.oracle`.

## First-time setup

```bash
# 1. Ensure the Oracle environment file exists (backend + frontend share it)
cp deploy/oracle/.env.oracle.example deploy/oracle/.env.oracle
#    edit it: at minimum EXPO_PUBLIC_API_BASE_URL (public API URL baked into
#    the frontend) and optionally FRONTEND_PORT (default 8080)

# 2. Build and start the frontend (Compose builds the image on first start;
#    dependencies the frontend declares — the backend chain — start too if
#    not already running)
./deploy/frontend/scripts/frontend-start.sh --build
```

## Build process

`deploy/frontend/Dockerfile` is a three-stage build:

1. **SDK** — installs and builds `packages/education-assistant-client`
   (`npm ci && npm run build`), verifying `dist/index.js`/`dist/index.d.ts`.
2. **Expo export** — installs the app's dependencies, then
   `npx expo export --platform web` with `ARG EXPO_PUBLIC_API_BASE_URL`
   (supplied from `.env.oracle` via the Compose `build.args`).
3. **nginx** — copies `deploy/frontend/nginx.conf` and the exported `dist/`
   into `nginx:1.27-alpine`, with a container `HEALTHCHECK` on `/health`.

The build context is the repository root (`../..` in the Compose file), so a
rebuild picks up changes in `deploy/frontend/`,
`examples/expo-education-assistant/`, and `packages/education-assistant-client/`.

## Commands

### Start

```bash
./deploy/frontend/scripts/frontend-start.sh
```

Start with rebuild:

```bash
./deploy/frontend/scripts/frontend-start.sh --build
```

Validates Docker, Compose, the Compose file, and the env file; validates the
Compose configuration (`docker compose config --quiet`); starts the frontend
service and the dependencies it declares (already-running services are left
untouched); waits for the container to be running; then checks
`http://127.0.0.1:8080/health` and `http://127.0.0.1:8080/`. Flags:
`--build`, `--no-healthcheck`, `--help`.

### Stop

```bash
./deploy/frontend/scripts/frontend-stop.sh
```

Stops **only** the frontend container (`docker compose stop frontend`). The
backend, Ollama, Qdrant, networks, and volumes are untouched. Never runs
`docker compose down` and never removes volumes or networks. Flags: `--yes`,
`--help`.

### Restart

```bash
./deploy/frontend/scripts/frontend-restart.sh
```

Restart with rebuild:

```bash
./deploy/frontend/scripts/frontend-restart.sh --build
```

Recreates only the frontend container
(`docker compose up -d --force-recreate --no-deps frontend`); with `--build`
the frontend image is rebuilt first. `--no-deps` guarantees dependency
containers are never restarted. Runs the frontend health check afterward
unless `--no-healthcheck`. Flags: `--build`, `--no-healthcheck`, `--help`.

### Update

Update plan:

```bash
./deploy/frontend/scripts/frontend-update.sh --show-plan
```

Dry-run update:

```bash
./deploy/frontend/scripts/frontend-update.sh --dry-run
```

Deploy update:

```bash
./deploy/frontend/scripts/frontend-update.sh --yes
```

Refuses to run on a dirty working tree (or wrong branch) unless `--force` is
given; fetches `UPDATE_REMOTE`/`UPDATE_BRANCH` (defaults `origin`/`main`);
shows current commit, target commit, and the frontend-related changed files
(paths under `deploy/frontend/`, `examples/expo-education-assistant/`,
`packages/education-assistant-client/`); prints "no frontend rebuild
necessary" when nothing frontend-related changed; pulls only after
confirmation (type `UPDATE`) unless `--yes`; rebuilds and recreates only the
frontend container (`--no-deps` — backend/Ollama/Qdrant/migrations are never
restarted); validates Compose before deploying; runs health checks afterward;
and prints rollback instructions using the previous commit
(`git reset --hard <previous>` + `frontend-restart.sh --build`).
Flags: `--dry-run`, `--yes`, `--force`, `--force-build`, `--pull-only`,
`--show-plan`, `--help`.

### Status

```bash
./deploy/frontend/scripts/frontend-status.sh
```

Shows the frontend Compose status; container ID/name; image name; container
health status; restart count; published ports; `/health` result; root-page
HTTP status; response headers for `/`; gzip status (`Content-Encoding`) and
`Cache-Control` for a hashed JavaScript asset (when one can be identified in
the served `index.html`); index.html cache headers (which must **not** be
immutable); container CPU/memory usage (`docker stats`); image size; current
Git branch/commit; whether frontend-related source files differ from the
current commit; and — where determinable — whether the running image was
built before or after the latest frontend source change. Never fails just
because the frontend is still starting (always exits 0).

### Logs

```bash
./deploy/frontend/scripts/frontend-logs.sh
```

Follows frontend logs by default. Flags: `--tail N` (0 = full available log),
`--no-follow`, `--timestamps`, `--since DURATION` (e.g. `10m`), `--help`.

Examples:

```bash
./deploy/frontend/scripts/frontend-logs.sh --tail 200
./deploy/frontend/scripts/frontend-logs.sh --tail 0 --timestamps
./deploy/frontend/scripts/frontend-logs.sh --no-follow
./deploy/frontend/scripts/frontend-logs.sh --since 10m
```

Errors clearly if the frontend container does not exist or is not running.

## Health checks

- **Endpoint**: `GET /health` → HTTP 200, body `healthy` (nginx `return 200`,
  `access_log off`) — proves nginx is serving.
- **Root page**: `GET /` → HTTP 200 — proves the exported app is deployed.
- **Container**: the image carries a Docker `HEALTHCHECK`
  (`wget -qO- http://127.0.0.1/health`) visible via `docker inspect` /
  `frontend-status.sh`.
- `frontend-start.sh`, `frontend-restart.sh`, and `frontend-update.sh` poll
  `/health` **and** `/` after (re)creating the container (24 attempts × 5s by
  default; override with `HEALTH_ATTEMPTS` / `HEALTH_DELAY`).

## Gzip verification

```bash
curl -sI -H 'Accept-Encoding: gzip' \
  "http://127.0.0.1:8080$(curl -s http://127.0.0.1:8080/ | grep -oE '_expo/static/js/[^"]+\.js' | head -1)"
```

Expect `Content-Encoding: gzip` (nginx `gzip on`, level 6, min length 1024,
covering `application/javascript`, `text/css`, JSON, SVG, fonts).
`frontend-status.sh` performs this check automatically.

## Immutable cache verification

```bash
# Hashed asset: 1-year, immutable
curl -sI http://127.0.0.1:8080/_expo/static/js/web/<hashed>.js | grep -i cache-control
#  → Cache-Control: public, immutable   (+ Expires ~1 year)

# index.html: must NOT be immutable (SPA entry point must be revalidated)
curl -sI http://127.0.0.1:8080/ | grep -i cache-control
```

Hashed assets (`js|css|woff2?|ttf|otf|svg|png|jpg|jpeg|gif|webp|ico`) get
`expires 1y` + `Cache-Control: public, immutable`; `index.html` falls through
to the SPA `location /` block and is **not** marked immutable, so browsers
always pick up a new deployment's entry point.

## Troubleshooting

- **Port 8080 not reachable** — verify the published port with
  `frontend-status.sh` (Published ports section) or
  `docker port edumind-oracle-frontend-1`; check `FRONTEND_PORT` in
  `.env.oracle`; confirm something else isn't bound to 8080
  (`ss -ltnp | grep 8080`).
- **Frontend container not running** —
  `./deploy/frontend/scripts/frontend-logs.sh --no-follow` for the last logs,
  then `./deploy/frontend/scripts/frontend-start.sh`. Note the frontend
  `depends_on: backend (service_healthy)` — if the backend is unhealthy the
  frontend will not start; check `./deploy/oracle/scripts/oracle-status.sh`.
- **Stale cached frontend** — confirm the image is newer than the latest
  frontend commit (`frontend-status.sh` → "Image freshness vs frontend
  source"), then `./deploy/frontend/scripts/frontend-restart.sh --build`.
- **Gzip missing** — confirm the request sends `Accept-Encoding: gzip` and
  the asset is ≥1024 bytes (`gzip_min_length`); check that
  `deploy/frontend/nginx.conf` is what the image actually contains (rebuild
  with `frontend-restart.sh --build` after editing it).
- **Wrong backend API URL baked into the frontend** — `EXPO_PUBLIC_API_BASE_URL`
  is baked at **build time**; changing `.env.oracle` alone does nothing until
  you rebuild: `./deploy/frontend/scripts/frontend-restart.sh --build`.
- **Browser showing old static assets** — hashed assets are cached for one
  year (by design); the entry point `index.html` is not immutable, so a
  hard-reload of `/` fetches the new bundle references. If still stale,
  verify `index.html` serves without an immutable `Cache-Control`.
- **Build failures** — run the build directly for full output:
  `docker compose -f deploy/oracle/docker-compose.oracle.yml --env-file deploy/oracle/.env.oracle --project-name edumind-oracle build frontend`.
  Common causes: lockfile drift (`npm ci` fails — commit updated
  `package-lock.json` files), registry/network issues, or the SDK
  `dist` verification step failing.
- **Frontend healthy but login/chat unavailable** — that is a backend
  problem, not a frontend one:
  `curl http://127.0.0.1:8000/health` and
  `./deploy/oracle/scripts/oracle-status.sh`. Frontend scripts never restart
  the backend on purpose — use the Oracle toolkit for the full stack.

## Security guidance

- **Port 8080 is temporary** — it exists for testing only.
- **Final production should expose the frontend through 80/443** behind a
  reverse proxy (the container itself keeps listening on 80 internally).
- **Use HTTPS and a real domain** in production; terminate TLS at the proxy.
- **Do not expose environment secrets in frontend builds** — anything in the
  JS bundle is public. Only `EXPO_PUBLIC_*` values are safe for frontend
  embedding; `JWT_SECRET`, OAuth client secrets, database URLs, etc. must
  never be referenced by frontend code.
- **Production API access should eventually be routed through a reverse
  proxy** (same origin as the frontend) rather than exposing the backend
  port directly.
