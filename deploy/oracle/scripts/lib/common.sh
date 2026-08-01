#!/usr/bin/env bash

#
# Shared library for EduMind Oracle VM operations scripts.
#
# Adapted from deploy/prod/scripts/lib/common.sh for the Oracle
# Cloud VM.Standard.A1.Flex deployment (deploy/oracle/). Every
# Oracle-specific path/name lives here so the oracle-*.sh scripts never
# hardcode them individually. Does NOT modify, source, or otherwise affect
# deploy/prod or deploy/rpi5 — this file is self-contained.
#
# Sourced, never executed directly:
#   SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
#   source "$SCRIPT_DIR/lib/common.sh"
#

set -Eeuo pipefail

################################################################################
# Paths — resolved from this file's own location (BASH_SOURCE), so every
# oracle-*.sh script works correctly regardless of the caller's current
# working directory.
################################################################################

ORACLE_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ORACLE_SCRIPTS_DIR="$(cd "$ORACLE_LIB_DIR/.." && pwd)"
ORACLE_DEPLOY_DIR="$(cd "$ORACLE_SCRIPTS_DIR/.." && pwd)"
REPO_ROOT="$(cd "$ORACLE_DEPLOY_DIR/../.." && pwd)"

################################################################################
# Compose configuration
################################################################################

ORACLE_COMPOSE_FILE="$ORACLE_DEPLOY_DIR/docker-compose.oracle.yml"
ORACLE_ENV_FILE="$ORACLE_DEPLOY_DIR/.env.oracle"
ORACLE_ENV_EXAMPLE_FILE="$ORACLE_DEPLOY_DIR/.env.oracle.example"
ORACLE_PROJECT_NAME="edumind-oracle"

# The Oracle compose project name is edumind-oracle, but the *volume* and
# *network* names underneath it are still the legacy edumind-rpi5_* names
# (see docker-compose.oracle.yml's `volumes:`/`networks:` blocks — they were
# deliberately carried over from the Raspberry Pi deployment so this project
# reuses existing data rather than starting from empty volumes). These are
# read from that file, not assumed; the values below match what is
# authoritatively declared there as of this toolkit's creation. Override any
# of them via environment variable if the compose file's volume names ever
# change.
ORACLE_BACKEND_VOLUME="${ORACLE_BACKEND_VOLUME:-edumind-rpi5_backend-data}"
ORACLE_QDRANT_VOLUME="${ORACLE_QDRANT_VOLUME:-edumind-rpi5_qdrant-data}"
ORACLE_OLLAMA_VOLUME="${ORACLE_OLLAMA_VOLUME:-edumind-rpi5_ollama-data}"
ORACLE_NETWORK_NAME="${ORACLE_NETWORK_NAME:-edumind-rpi5_net}"

# Default backup destination (task requirement): ~/edumind-backups/. Shared
# with deploy/prod's backups (same root) — the "edumind-oracle-backup-"
# prefix below is what keeps the two projects' backups distinguishable and
# independently manageable within that one root.
ORACLE_BACKUP_ROOT="${ORACLE_BACKUP_ROOT:-$HOME/edumind-backups}"
# shellcheck disable=SC2034  # used by oracle-backup.sh/oracle-restore.sh/oracle-update.sh, which source this file
ORACLE_BACKUP_PREFIX="edumind-oracle-backup"

BACKUP_HELPER_IMAGE="${BACKUP_HELPER_IMAGE:-alpine:3.20}"

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
    local title="${1:-EduMind Oracle VM Operations}"
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

# Full prerequisite validation for the Oracle deployment. Every oracle-*.sh
# script calls this before doing anything else.
check_oracle_environment() {
    require_command curl
    check_docker_available
    check_docker_daemon

    require_file "$ORACLE_COMPOSE_FILE" "Oracle Compose file"
    require_file "$ORACLE_ENV_FILE" "Oracle environment file (copy $ORACLE_ENV_EXAMPLE_FILE to .env.oracle and fill it in)"
}

################################################################################
# Docker Compose wrapper — always targets the Oracle compose file, env
# file, and project name explicitly, so it is never ambiguous which stack a
# command affects even if invoked alongside other compose projects.
################################################################################

oracle_compose() {
    docker compose \
        -f "$ORACLE_COMPOSE_FILE" \
        --env-file "$ORACLE_ENV_FILE" \
        --project-name "$ORACLE_PROJECT_NAME" \
        "$@"
}

################################################################################
# Service / container lookup
################################################################################

oracle_container_id() {
    local service="$1"
    oracle_compose ps -q "$service" 2>/dev/null || true
}

oracle_container_status() {
    local container_id="$1"
    docker inspect --format '{{.State.Status}}' "$container_id" 2>/dev/null || echo "missing"
}

oracle_container_health() {
    local container_id="$1"
    docker inspect \
        --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' \
        "$container_id" 2>/dev/null || echo "unknown"
}

# List of the long-running services this stack expects to be healthy.
# Deliberately excludes backend-migrate, a one-shot job checked separately
# (see oracle-healthcheck.sh's migration check).
ORACLE_SERVICES=(backend frontend qdrant ollama)

oracle_service_exists() {
    local service="$1"
    local candidate
    for candidate in "${ORACLE_SERVICES[@]}" backend-migrate; do
        [[ "$candidate" == "$service" ]] && return 0
    done
    return 1
}

################################################################################
# API endpoints
################################################################################

ORACLE_API_URL="${ORACLE_API_URL:-http://localhost:8000}"
ORACLE_FRONTEND_URL="${ORACLE_FRONTEND_URL:-http://localhost:8080}"

oracle_backend_health() {
    curl -fsS --connect-timeout 3 --max-time 10 "$ORACLE_API_URL/health"
}

oracle_backend_ready() {
    curl -fsS --connect-timeout 3 --max-time 10 "$ORACLE_API_URL/health/ready"
}

oracle_auth_providers() {
    curl -fsS --connect-timeout 3 --max-time 10 "$ORACLE_API_URL/auth/providers"
}

# The Oracle frontend (deploy/frontend/nginx.conf) serves a plain-text 200
# at /health — NOT /login (that endpoint doesn't exist on this static
# export). Confirmed against the actual nginx.conf in this repo, not
# assumed from deploy/prod's script.
oracle_frontend_health() {
    curl --fail --silent --show-error --connect-timeout 3 --max-time 10 \
        "$ORACLE_FRONTEND_URL/health" >/dev/null
}

oracle_ollama_ps() {
    oracle_compose exec -T ollama ollama ps
}

oracle_ollama_models() {
    oracle_compose exec -T ollama ollama list
}

################################################################################
# Waiting for health
################################################################################

# Polls oracle-healthcheck.sh until it passes or the attempt budget is
# exhausted. Silences the healthcheck's own output on all but the final
# attempt so callers (start/restart/backup/restore/update) don't spam the
# terminal with repeated full health reports while waiting.
wait_for_oracle_health() {
    local attempts="${1:-24}"
    local delay="${2:-5}"
    local attempt

    for ((attempt = 1; attempt <= attempts; attempt++)); do
        if "$ORACLE_SCRIPTS_DIR/oracle-healthcheck.sh" >/dev/null 2>&1; then
            return 0
        fi

        if (( attempt < attempts )); then
            info "Health check attempt $attempt/$attempts; retrying in ${delay}s..."
            sleep "$delay"
        fi
    done

    return 1
}

################################################################################
# Volumes
################################################################################

require_volume() {
    local volume="$1"
    docker volume inspect "$volume" >/dev/null 2>&1 \
        || die "Required Docker volume does not exist: $volume"
}

################################################################################
# Backup directory / checksum validation
################################################################################

verify_oracle_backup_directory() {
    local backup_dir="$1"
    local skip_ollama="${2:-false}"
    local required_archives=("backend-data.tar.gz" "qdrant-data.tar.gz")
    local archive

    [[ -d "$backup_dir" ]] || die "Backup directory does not exist: $backup_dir"
    [[ -f "$backup_dir/SHA256SUMS" ]] || die "SHA256SUMS is missing from backup: $backup_dir"

    if [[ "$skip_ollama" != true ]]; then
        required_archives+=("ollama-data.tar.gz")
    fi

    for archive in "${required_archives[@]}"; do
        [[ -s "$backup_dir/$archive" ]] \
            || die "Required backup archive is missing or empty: $archive"
    done

    verify_checksums "$backup_dir"
}

verify_checksums() {
    local backup_dir="$1"

    info "Verifying backup checksums in $backup_dir..."

    [[ -f "$backup_dir/SHA256SUMS" ]] || die "SHA256SUMS is missing from backup: $backup_dir"

    if ! (cd "$backup_dir" && sha256sum -c SHA256SUMS); then
        die "Backup checksum verification failed for: $backup_dir"
    fi

    success "Backup checksums verified."
}

restore_volume_archive() {
    local archive_path="$1"
    local target_volume="$2"
    local helper_image="${3:-$BACKUP_HELPER_IMAGE}"

    [[ -s "$archive_path" ]] || die "Restore archive is missing or empty: $archive_path"
    require_volume "$target_volume"

    local archive_dir archive_name
    archive_dir="$(cd "$(dirname "$archive_path")" && pwd)"
    archive_name="$(basename "$archive_path")"

    info "Restoring $archive_name -> $target_volume ..."

    # Ownership/permissions inside the archive are preserved by tar -xzf by
    # default (no --no-same-owner/--no-same-permissions flag is passed).
    docker run --rm \
        --mount "type=volume,source=$target_volume,target=/target" \
        --mount "type=bind,source=$archive_dir,target=/backup,readonly" \
        "$helper_image" \
        sh -eu -c "
            find /target -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
            tar -xzf '/backup/$archive_name' -C /target
        "

    success "Restored volume: $target_volume"
}

################################################################################
# Safe confirmation prompts
################################################################################

# confirm_phrase PROMPT_WORD ASSUME_YES
# Requires the operator to type an exact word (not just "y") before a
# destructive action proceeds — mirrors deploy/prod/scripts' RESTORE/UPDATE
# confirmation pattern. Returns 0 to proceed, dies otherwise.
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
# less-destructive confirmations (e.g. oracle-stop.sh).
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

# Never call `cat`/`env` on $ORACLE_ENV_FILE, and never echo the value of
# any variable read from it. Scripts in this toolkit only ever print KEY
# names (e.g. "OLLAMA_LLM_MODEL=qwen3:8b" is fine; JWT_SECRET's value is
# not) — see oracle-status.sh's "effective model configuration" section for
# the one place this matters most.
redact_notice() {
    echo "(value hidden — see $ORACLE_ENV_FILE directly if you need to inspect it)"
}
