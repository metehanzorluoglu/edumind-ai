#!/usr/bin/env bash

#
# Shared library for EduM8 frontend deployment operations scripts.
#
# Adapted from deploy/oracle/scripts/lib/common.sh for frontend-only
# operations (deploy/frontend/). Controls ONLY the `frontend` service of
# the Oracle Compose stack — never the backend, Ollama, Qdrant, or the
# one-shot backend-migrate job. Does NOT modify, source, or otherwise
# affect deploy/oracle/scripts, deploy/prod, or deploy/rpi5 — this file is
# self-contained.
#
# Sourced, never executed directly:
#   SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
#   source "$SCRIPT_DIR/lib/common.sh"
#

set -Eeuo pipefail

################################################################################
# Paths — resolved from this file's own location (BASH_SOURCE), so every
# frontend-*.sh script works correctly regardless of the caller's current
# working directory.
################################################################################

FRONTEND_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FRONTEND_SCRIPTS_DIR="$(cd "$FRONTEND_LIB_DIR/.." && pwd)"
FRONTEND_DEPLOY_DIR="$(cd "$FRONTEND_SCRIPTS_DIR/.." && pwd)"
REPO_ROOT="$(cd "$FRONTEND_DEPLOY_DIR/../.." && pwd)"

################################################################################
# Compose configuration — the frontend service is defined in the Oracle
# stack's Compose file (deploy/oracle/), so every command here targets that
# file, its env file, and the edumind-oracle project name explicitly. These
# scripts only ever act on the `frontend` service within that project.
################################################################################

FRONTEND_COMPOSE_FILE="${FRONTEND_COMPOSE_FILE:-$REPO_ROOT/deploy/oracle/docker-compose.oracle.yml}"
FRONTEND_ENV_FILE="${FRONTEND_ENV_FILE:-$REPO_ROOT/deploy/oracle/.env.oracle}"
FRONTEND_PROJECT_NAME="${FRONTEND_PROJECT_NAME:-edumind-oracle}"
FRONTEND_SERVICE="${FRONTEND_SERVICE:-frontend}"

# The conventional container name Compose gives the frontend service in
# this project. Used only as a fallback / human-facing label — live
# operations always resolve the real container id via `compose ps -q`
# (see frontend_container_id), which stays correct even if Compose's
# naming convention changes.
FRONTEND_CONTAINER_NAME="${FRONTEND_CONTAINER_NAME:-edumind-oracle-frontend-1}"

################################################################################
# Public test URL — port 8080 is the temporary testing port published by
# docker-compose.oracle.yml ("${FRONTEND_PORT:-8080}:80"). If FRONTEND_PORT
# is set in the env file, prefer it so health checks hit whatever is
# actually published. FRONTEND_URL wins over both when set explicitly.
# (FRONTEND_PORT is a plain port number — never a secret — which is why it
# is the one value this library reads out of the env file; see
# redact_notice() for the general rule.)
################################################################################

frontend_env_value() {
    local key="$1"
    grep -E "^${key}=" "$FRONTEND_ENV_FILE" 2>/dev/null | tail -n1 | cut -d'=' -f2- || true
}

FRONTEND_PORT_EFFECTIVE="${FRONTEND_PORT:-$(frontend_env_value FRONTEND_PORT)}"
FRONTEND_PORT_EFFECTIVE="${FRONTEND_PORT_EFFECTIVE:-8080}"
FRONTEND_URL="${FRONTEND_URL:-http://127.0.0.1:$FRONTEND_PORT_EFFECTIVE}"

################################################################################
# Frontend-related source paths — what a frontend rebuild actually depends
# on (see deploy/frontend/Dockerfile's build stages). Used by
# frontend-update.sh to decide whether a pull even concerns the frontend,
# and by frontend-status.sh to report working-tree drift.
################################################################################

# shellcheck disable=SC2034  # used by frontend-update.sh/frontend-status.sh, which source this file
FRONTEND_SOURCE_PATHS=(
    "deploy/frontend"
    "examples/expo-education-assistant"
    "packages/education-assistant-client"
)

################################################################################
# Colors
################################################################################

if [[ -t 1 ]]; then
    RED='\033[0;31m'
    GREEN='\033[0;32m'
    YELLOW='\033[1;33m'
    BLUE='\033[0;34m'
    NC='\033[0m'
else
    RED=''
    GREEN=''
    YELLOW=''
    BLUE=''
    NC=''
fi

################################################################################
# Logging — [INFO] / [OK] / [WARN] / [ERROR]
################################################################################

info() {
    echo -e "${BLUE}[INFO]${NC} $*"
}

success() {
    echo -e "${GREEN}[OK]${NC} $*"
}

ok() {
    success "$@"
}

warn() {
    echo -e "${YELLOW}[WARN]${NC} $*" >&2
}

error() {
    echo -e "${RED}[ERROR]${NC} $*" >&2
}

# Clean failure handling: every script's fatal-error exit goes through this
# one function, so failures always look the same and always exit non-zero.
die() {
    error "$*"
    exit 1
}

print_header() {
    local title="${1:-EduM8 Frontend Operations}"
    echo
    echo "============================================================"
    echo " $title"
    echo "============================================================"
    echo
}

print_section() {
    echo
    echo "------------------------------------------------------------"
    echo " $*"
    echo "------------------------------------------------------------"
}

################################################################################
# Prerequisite / path checks
################################################################################

require_command() {
    command -v "$1" >/dev/null 2>&1 || die "Missing required command: $1"
}

require_file() {
    local path="$1"
    local label="${2:-file}"
    [[ -f "$path" ]] || die "Required $label not found: $path"
}

require_dir() {
    local path="$1"
    local label="${2:-directory}"
    [[ -d "$path" ]] || die "Required $label not found: $path"
}

check_docker_available() {
    require_command docker

    docker compose version >/dev/null 2>&1 \
        || die "Docker Compose v2 plugin is not available ('docker compose version' failed)."
}

check_docker_daemon() {
    docker info >/dev/null 2>&1 \
        || die "Docker daemon is not reachable. Is Docker running, and does $(id -un) have permission to use it?"
}

# Verifies the `frontend` service is actually declared in the Compose file
# (guards against pointing FRONTEND_COMPOSE_FILE at a stack that has no
# frontend service). Read from the file via `compose config`, not assumed.
check_frontend_service_defined() {
    frontend_compose config --services 2>/dev/null | grep -qx "$FRONTEND_SERVICE" \
        || die "Service '$FRONTEND_SERVICE' is not defined in $FRONTEND_COMPOSE_FILE."
}

# Full prerequisite validation for frontend operations. Every
# frontend-*.sh script calls this before doing anything else.
check_frontend_environment() {
    require_command curl
    check_docker_available
    check_docker_daemon

    require_file "$FRONTEND_COMPOSE_FILE" "Oracle Compose file (defines the frontend service)"
    require_file "$FRONTEND_ENV_FILE" "Oracle environment file"

    check_frontend_service_defined
}

################################################################################
# Docker Compose wrapper — always targets the Oracle compose file, env
# file, and project name explicitly, so it is never ambiguous which stack a
# command affects even if invoked alongside other compose projects.
################################################################################

frontend_compose() {
    docker compose \
        -f "$FRONTEND_COMPOSE_FILE" \
        --env-file "$FRONTEND_ENV_FILE" \
        --project-name "$FRONTEND_PROJECT_NAME" \
        "$@"
}

################################################################################
# Service / container lookup
################################################################################

# Authoritative container id for the frontend service (empty if it has
# never been created). Falls back to the conventional container name only
# if `compose ps` cannot resolve it.
frontend_container_id() {
    local id
    id="$(frontend_compose ps -q "$FRONTEND_SERVICE" 2>/dev/null || true)"
    if [[ -z "$id" ]] && docker inspect "$FRONTEND_CONTAINER_NAME" >/dev/null 2>&1; then
        id="$(docker inspect --format '{{.Id}}' "$FRONTEND_CONTAINER_NAME" 2>/dev/null || true)"
    fi
    echo "$id"
}

frontend_container_name() {
    local container_id="$1"
    docker inspect --format '{{.Name}}' "$container_id" 2>/dev/null | sed 's|^/||' || echo "unknown"
}

frontend_container_status() {
    local container_id="$1"
    docker inspect --format '{{.State.Status}}' "$container_id" 2>/dev/null || echo "missing"
}

frontend_container_health() {
    local container_id="$1"
    docker inspect \
        --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' \
        "$container_id" 2>/dev/null || echo "unknown"
}

################################################################################
# Frontend health — nginx serves a plain-text 200 at /health (see
# deploy/frontend/nginx.conf) and the SPA itself at /. Both are checked:
# /health proves nginx is up, / proves the exported app is actually being
# served. Never prints response bodies that could embed build-time
# configuration beyond public URLs.
################################################################################

frontend_health_endpoint() {
    curl --fail --silent --show-error --connect-timeout 3 --max-time 10 \
        "$FRONTEND_URL/health" >/dev/null
}

frontend_root_reachable() {
    curl --fail --silent --output /dev/null --connect-timeout 3 --max-time 10 \
        "$FRONTEND_URL/"
}

# Polls the frontend's own endpoints until both pass or the attempt budget
# is exhausted. Called by start/restart/update after (re)creating the
# container; never touches any other service's health.
wait_for_frontend_health() {
    local attempts="${1:-24}"
    local delay="${2:-5}"
    local attempt

    for ((attempt = 1; attempt <= attempts; attempt++)); do
        if frontend_health_endpoint && frontend_root_reachable; then
            return 0
        fi

        if (( attempt < attempts )); then
            info "Frontend health check attempt $attempt/$attempts; retrying in ${delay}s..."
            sleep "$delay"
        fi
    done

    return 1
}

################################################################################
# Safe confirmation prompts
################################################################################

# confirm_phrase PROMPT_WORD ASSUME_YES
# Requires the operator to type an exact word (not just "y") before a
# mutating action proceeds — mirrors deploy/oracle/scripts' confirmation
# pattern. Returns 0 to proceed, dies otherwise.
confirm_phrase() {
    local phrase="$1"
    local assume_yes="${2:-false}"

    if [[ "$assume_yes" == true ]]; then
        warn "Confirmation skipped because --yes was provided."
        return 0
    fi

    if [[ ! -t 0 ]]; then
        die "Refusing to proceed without confirmation: no interactive terminal attached. Re-run with --yes if this is intentional."
    fi

    echo
    read -r -p "Type $phrase to continue: " confirmation
    [[ "$confirmation" == "$phrase" ]] || die "Aborted: confirmation did not match '$phrase'."
}

# confirm_yes_no PROMPT ASSUME_YES — a lighter-weight y/N prompt for
# less-destructive confirmations (e.g. frontend-stop.sh).
confirm_yes_no() {
    local prompt="$1"
    local assume_yes="${2:-false}"

    if [[ "$assume_yes" == true ]]; then
        return 0
    fi

    if [[ ! -t 0 ]]; then
        die "Refusing to proceed without confirmation: no interactive terminal attached. Re-run with --yes if this is intentional."
    fi

    local reply
    read -r -p "$prompt [y/N] " reply
    [[ "$reply" =~ ^[Yy]$ ]] || die "Aborted."
}

################################################################################
# Git metadata
################################################################################

git_commit() {
    git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo "unknown"
}

git_commit_short() {
    git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo "unknown"
}

git_branch() {
    git -C "$REPO_ROOT" branch --show-current 2>/dev/null || echo "unknown"
}

################################################################################
# Secrets safety
################################################################################

# Never call `cat`/`env` on $FRONTEND_ENV_FILE, and never echo the value of
# any variable read from it. The one exception is FRONTEND_PORT — a plain
# port number, not a secret — read by FRONTEND_PORT_EFFECTIVE above. Only
# EXPO_PUBLIC_* values are safe to bake into the frontend at all (they
# ship to browsers); everything else in that file is backend-only and must
# never appear in these scripts' output.
redact_notice() {
    echo "(value hidden — see $FRONTEND_ENV_FILE directly if you need to inspect it)"
}
