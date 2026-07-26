#!/usr/bin/env bash
# rpi5-package.sh — host-side SCP-package builder.
#
# What this builds:
#   /tmp/edumind-rpi5-pkg-<UTC-TS>/
#     ├── rag-backend/                  (stripped of dev/test/caches/runtime state)
#     │   ├── app/
#     │   ├── cli/
#     │   ├── alembic/                  (incl. versions/0012_image_generation.py)
#     │   ├── alembic.ini
#     │   ├── entrypoint.sh             (used by the Dockerfile.rpi5)
#     │   ├── pyproject.toml
#     │   ├── .python-version
#     │   ├── README.md
#     │   └── scripts/                  (backup.sh, restore.sh, *.py)
#     ├── deploy/rpi5/
#     │   ├── docker-compose.rpi5.yml
#     │   ├── Dockerfile.rpi5
#     │   ├── .env.rpi5                 (must already exist — see rpi5-setup.sh)
#     │   ├── .env.rpi5.example         (kept for reference; .env wins)
#     │   └── scripts/                  (the helpers this package ships with)
#     └── PACKAGE_MANIFEST.txt          (file list + sha256 manifest of the tarball itself)
#
# The whole tree is then `tar -czf`-ed into:
#   /tmp/edumind-rpi5-pkg-<UTC-TS>/edumind-rpi5-pkg-<UTC-TS>.tar.gz
#
# Filename convention: `edumind-rpi5-pkg-YYYYMMDDTHHMMSSZ.tar.gz` with an
# uppercase-T + Z suffix (compact ISO-8601 UTC, filename-safe). The exact
# command & filename are printed at end-of-run for the user to copy/paste
# into their SCP / ssh commands.
#
# Stripped paths (NOT shipped):
#   - **Dev artifacts**: rag-backend/{.pytest_cache,.mypy_cache,.ruff_cache,.venv}/
#     at any depth, `__pycache__/`, `*.pyc`, `*.egg-info/`, `build/`,
#     `dist/`, `.coverage`, `*.tsbuildinfo`.
#   - **Tests**: rag-backend/tests/   (~1100 pytest cases; not needed on Pi)
#   - **Repo secrets**: any `.env`, `.env*.local`, `*.pem`, `*.key` at any depth
#     — `.env.rpi5` (which we'll *generate* from `.env.rpi5.example`) is
#     included explicitly; the developer's local `rag-backend/.env`
#     stays out.
#   - **Monorepo subprojects not on Pi**: top-level `app/`, `src/`,
#     `examples/`, `packages/`, `backend/`, `node_modules/`, `.expo/`,
#     `web-build/`, `expo-env.d.ts`, top-level `IMPLEMENTATION_PLAN.md`,
#     `eslint.config.js`, `app.json`, `eas.json`, `package-lock.json`.
#   - **Runtime state**: rag-backend/data/{raw,chat-attachments,
#     qdrant_storage,generated-images,app.db*,ingestion_registry.json} and
#     `rag-backend/backups/`. Note `data/metadata-template.csv` is a
#     committed file (kept; see rag-backend/.gitignore) — it ships so
#     operators can re-use it on first install.
#   - **OS / VCS junk**: `.DS_Store`, `.git/` (Q: git history is useful
#     for diff-debugging on-Pi; default: keep it).
#
# Override via the env var PACKAGE_ROOT (default: /tmp) if /tmp is small
# on the developer's machine.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

rpi5_require_cmd rsync tar python3 shasum find xargs

# Defensive: refuse to package without a setup-rendered env file. Without
# one the resulting container stack would have placeholders like
# `<PI_LAN_HOST>` in CORS_ORIGINS and JWT_SECRET=<SET_BY_SETUP_SH> — a
# pydantic validator would reject the latter, but CORS would silently
# allow every origin and a permissive default CORS means real users
# could have their browsers strip auth headers in production.
if [[ ! -f "${RPI5_DIR}/.env.rpi5" ]]; then
  rpi5_warn "no .env.rpi5 found at ${RPI5_DIR}/.env.rpi5"
  rpi5_warn "  run rpi5-setup.sh first to generate one from .env.rpi5.example."
  rpi5_die "missing env file — build aborted so we don't package a placeholder-filled env"
fi

# The host checkout's layout at $RPI5_DIR:
#   $RPI5_DIR/                         = deploy/rpi5/
#     ├── .env.rpi5.example            # template
#     └── .env.rpi5                    # generated
# The repo root is $RPI5_DIR's parent's parent:
REPO_ROOT="$(cd "${RPI5_DIR}/../.." && pwd)"

rpi5_info "REPO_ROOT resolved to: $REPO_ROOT"

# Verify we're actually sitting inside a sane repo.
if [[ ! -d "$REPO_ROOT/rag-backend" ]] || [[ ! -f "$REPO_ROOT/rag-backend/pyproject.toml" ]]; then
  rpi5_die "RPI5_DIR=$RPI5_DIR is not inside the EduMind AI repo (rag-backend/ not found)."
fi

# ----------------------------------------------------------------------------
# Build the staging dir
# ----------------------------------------------------------------------------

PACKAGE_ROOT="${PACKAGE_ROOT:-/tmp}"
UTC_TS="$(rpi5_utc_ts)"
# Package directory holds the *contents* that get tarred; the tarball lives
# in the same parent so it never ends up nested inside its own archive
# (which would trip GNU tar's recursion guard with a "Can't add archive
# to itself" warning). The operator copies the tarball via SCP and never
# needs the staging dir on the host after the build, but `rpi5-package.sh`
# keeps it around in case they want to inspect it / re-tar.
PACKAGE_DIR="${PACKAGE_ROOT}/edumind-rpi5-pkg-${UTC_TS}"
TARBALL="${PACKAGE_ROOT}/edumind-rpi5-pkg-${UTC_TS}.tar.gz"
MANIFEST="${PACKAGE_DIR}/PACKAGE_MANIFEST.txt"

if [[ -d "$PACKAGE_DIR" ]]; then
  rpi5_die "refusing to overwrite existing staging dir: $PACKAGE_DIR — rm it manually"
fi
if [[ -f "$TARBALL" ]]; then
  rpi5_die "refusing to overwrite existing tarball: $TARBALL — rm it manually"
fi

mkdir -p "$PACKAGE_DIR"

# ----- copy rag-backend, subtracting dev/test/caches/runtime-state -----

# rsync with a precise exclude list is the simplest tool here. We do NOT
# pass `--remove-source-files` — we never want to delete anything from the
# developer's checkout; we just want the package to skip the listed names.
rpi5_info "copying rag-backend/ into staging dir (excluding dev/test/runtime state) …"
rsync -a --prune-empty-dirs \
  --exclude='.pytest_cache/' \
  --exclude='.mypy_cache/' \
  --exclude='.ruff_cache/' \
  --exclude='.venv/' \
  --exclude='venv/' \
  --exclude='env/' \
  --exclude='__pycache__/' \
  --exclude='*.pyc' \
  --exclude='*.egg-info/' \
  --exclude='build/' \
  --exclude='dist/' \
  --exclude='.coverage' \
  --exclude='.tox/' \
  --exclude='tests/' \
  --exclude='data/raw/' \
  --exclude='data/chat-attachments/' \
  --exclude='data/qdrant_storage/' \
  --exclude='data/generated-images/' \
  --exclude='data/app.db' \
  --exclude='data/app.db-*' \
  --exclude='data/ingestion_registry.json' \
  --exclude='data/awsb_' \
  --exclude='data/wal_' \
  --exclude='data/test.db' \
  --exclude='backups/' \
  --exclude='evaluation/reports/' \
  --exclude='.env' \
  --exclude='.env.*' \
  --exclude='.env*.local' \
  --exclude='.venv/*' \
  "$REPO_ROOT/rag-backend/" "${PACKAGE_DIR}/rag-backend/"

# Confirm rag-backend is non-empty post-strip.
if ! find "$PACKAGE_DIR/rag-backend" -type f -name '*.py' | grep -q .; then
  rpi5_die "staged rag-backend/ appears empty after exclusions — refusing"
fi

# ----- copy deploy/rpi5/, including the generated .env.rpi5 + scripts -----

rpi5_info "copying deploy/rpi5/ into staging dir …"
rsync -a "$RPI5_DIR/" "${PACKAGE_DIR}/deploy/rpi5/"

# A second pass to remove anything we don't want stuck inside deploy/:
rm -rf "${PACKAGE_DIR}/deploy/rpi5/.env.rpi5.example.swp" \
       "${PACKAGE_DIR}/deploy/rpi5/.DS_Store" \
       2>/dev/null || true

# World-readable secrets would be a later-discovered liability if a
# later ssh / scp step left them group-readable. 0600 on the rendered
# env file (0644 on the example as documented below).
chmod 0600 "${PACKAGE_DIR}/deploy/rpi5/.env.rpi5"

# ----- emit the manifest with sorted file list + per-file sha256 -----

rpi5_info "computing manifest + tarball …"

( cd "$PACKAGE_DIR" && find . -type f | sort ) > "$MANIFEST"

# Add the sha256 of each file as a stable side-channel. We could embed
# this manifest *into* the tarball too, but writing it next to the
# tarball (and including it in the same archive path) keeps verification
# tractable on the Pi without needing a second tar to compare.
( cd "$PACKAGE_DIR" && find . -type f ! -name PACKAGE_MANIFEST.txt -print0 | sort -z \
    | xargs -0 shasum -a 256 >> "$MANIFEST" )

# Tarball. We use absolute source path so cd doesn't matter here;
# `-C "${PACKAGE_DIR}/.."` shifts into the staging dir's parent so
# the tar archive's root entry is `edumind-rpi5-pkg-<UTC-TS>/` (a
# self-named directory) rather than the loose staging dir.
tar -czf "$TARBALL" \
    -C "${PACKAGE_DIR}/.." \
    "$(basename "$PACKAGE_DIR")"

# Final sizes / checksums.
TARBALL_BYTES="$(stat -f %z "$TARBALL" 2>/dev/null || stat -c %s "$TARBALL")"
TARBALL_SHA="$(shasum -a 256 "$TARBALL" | awk '{print $1}')"

cat <<EOF

=================================================
  Built Pi deployment package.

  Staging dir:    $PACKAGE_DIR
  Tarball:        $TARBALL
  Tarball size:   $TARBALL_BYTES  bytes
  Tarball sha256: $TARBALL_SHA

  Manifest of staged contents: $MANIFEST  (file list + per-file sha256)

  Pipeline to deploy:

    # On the host:
    scp $TARBALL  $PI_HOST:~
    # Then on the Pi (via ssh):
    ssh $PI_HOST  'cd ~ && tar -xzf $(basename $TARBALL) --no-same-owner'
    #    ^ the flag --no-same-owner prevents the rare "user running ssh is
    #      uid 0 / different uid from the one who'll run docker" failure
    #      on extraction. The Pi-side extraction should never need root.
    ssh $PI_HOST  'cd ~/edumind-rpi5-pkg-${UTC_TS}/deploy/rpi5 && ./rpi5-models-download.sh && ./rpi5-start.sh && ./rpi5-healthcheck.sh'

  Or use the helper scripts instead of inline ssh invocations:
    rpi5-models-download.sh   # ssh + docker exec ollama ollama pull ...
    rpi5-start.sh             # ssh + docker compose up -d
    rpi5-healthcheck.sh       # ssh + sanity checks

  Cleanup the staging dir when you're done (it's not removed
  automatically so you can re-tar or diff if needed):
    rm -rf $PACKAGE_DIR
=================================================
EOF
