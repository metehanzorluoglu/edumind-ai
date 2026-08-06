#!/usr/bin/env bash

#
# Common library for EduM8 production management scripts.
#

set -euo pipefail

################################################################################
# Directories
################################################################################

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# common.sh is located in deploy/prod/scripts/lib/
LIB_DIR="$SCRIPT_DIR"
SCRIPTS_DIR="$(cd "$LIB_DIR/.." && pwd)"
PROD_DIR="$(cd "$SCRIPTS_DIR/.." && pwd)"
REPO_ROOT="$(cd "$PROD_DIR/../.." && pwd)"

################################################################################
# Compose configuration
################################################################################

COMPOSE_FILE="$PROD_DIR/docker-compose.prod.yml"
ENV_FILE="$PROD_DIR/.env.prod"

################################################################################
# Colors
################################################################################

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

################################################################################
# Logging
################################################################################

info() {
    echo -e "${BLUE}[INFO]${NC} $*"
}

success() {
    echo -e "${GREEN}[OK]${NC} $*"
}

warn() {
    echo -e "${YELLOW}[WARN]${NC} $*"
}

error() {
    echo -e "${RED}[ERROR]${NC} $*" >&2
}

die() {
    error "$*"
    exit 1
}

################################################################################
# Checks
################################################################################

require_command() {
    command -v "$1" >/dev/null 2>&1 || die "Missing command: $1"
}

check_environment() {
    
    require_command docker
    require_command curl

    [[ -f "$COMPOSE_FILE" ]] \
        || die "Compose file not found: $COMPOSE_FILE"

    [[ -f "$ENV_FILE" ]] \
        || die "Environment file not found: $ENV_FILE"

    docker info >/dev/null 2>&1 \
        || die "Docker daemon is not running."
}

################################################################################
# Docker compose wrapper
################################################################################

compose() {
    docker compose \
        -f "$COMPOSE_FILE" \
        --env-file "$ENV_FILE" \
        "$@"
}

################################################################################
# API endpoints
################################################################################

API_URL="http://localhost:8000"
FRONTEND_URL="http://localhost:8080"

################################################################################
# Health helpers
################################################################################

backend_health() {
    curl -fsS "$API_URL/health"
}

providers() {
    curl -fsS "$API_URL/auth/providers"
}

frontend_health() {
    curl \
        --fail \
        --silent \
        --show-error \
        --head \
        --connect-timeout 3 \
        --max-time 10 \
        "$FRONTEND_URL/login" \
        >/dev/null
}

################################################################################
# Header
################################################################################

print_header() {
    echo
    echo "============================================================"
    echo " EduM8 Production Operations"
    echo "============================================================"
    echo
}

# ---------------------------------------------------------------------------
# Shared production operations helpers
# ---------------------------------------------------------------------------

start_services() {
    info "Starting production services..."
    compose up -d
}

stop_services() {
    info "Stopping production services..."
    compose stop frontend backend qdrant ollama
}

recreate_services() {
    info "Recreating production services..."
    compose up -d --force-recreate
}

wait_for_health() {
    local attempts="${1:-18}"
    local delay="${2:-5}"
    local attempt

    for ((attempt = 1; attempt <= attempts; attempt++)); do
        if "$SCRIPTS_DIR/prod-healthcheck.sh" >/dev/null 2>&1; then
            return 0
        fi

        if (( attempt < attempts )); then
            info "Health check attempt $attempt/$attempts; retrying in ${delay}s..."
            sleep "$delay"
        fi
    done

    return 1
}

require_volume() {
    local volume="$1"

    if ! docker volume inspect "$volume" >/dev/null 2>&1; then
        die "Required Docker volume does not exist: $volume"
    fi
}

verify_backup_directory() {
    local backup_dir="$1"
    local required_archives=(
        "backend-data.tar.gz"
        "qdrant-data.tar.gz"
        "ollama-data.tar.gz"
    )
    local archive

    [[ -d "$backup_dir" ]] ||
        die "Backup directory does not exist: $backup_dir"

    [[ -f "$backup_dir/SHA256SUMS" ]] ||
        die "SHA256SUMS is missing from backup: $backup_dir"

    for archive in "${required_archives[@]}"; do
        [[ -s "$backup_dir/$archive" ]] ||
            die "Required backup archive is missing or empty: $archive"
    done

    info "Verifying backup checksums..."

    if ! (
        cd "$backup_dir"
        sha256sum -c SHA256SUMS
    ); then
        die "Backup checksum verification failed."
    fi

    success "Backup checksums verified."
}

restore_volume_archive() {
    local archive_path="$1"
    local target_volume="$2"
    local helper_image="${3:-alpine:3.20}"

    [[ -s "$archive_path" ]] ||
        die "Restore archive is missing or empty: $archive_path"

    require_volume "$target_volume"

    local archive_dir
    local archive_name

    archive_dir="$(cd "$(dirname "$archive_path")" && pwd)"
    archive_name="$(basename "$archive_path")"

    info "Restoring $archive_name to $target_volume..."

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

git_commit() {
    git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null ||
        echo "unknown"
}

git_branch() {
    git -C "$REPO_ROOT" branch --show-current 2>/dev/null ||
        echo "unknown"
}

ollama_models() {
    compose exec -T ollama ollama list
}
