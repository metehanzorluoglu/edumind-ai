#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/lib/common.sh"

check_environment
print_header

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

BACKUP_ROOT="${BACKUP_ROOT:-$HOME/edumind-backups}"
BACKUP_PREFIX="edumind-backup"
TIMESTAMP="$(date '+%Y%m%d-%H%M%S')"
BACKUP_DIR="$BACKUP_ROOT/$BACKUP_PREFIX-$TIMESTAMP"

# Set KEEP_BACKUPS to a positive number to automatically remove old backups.
# Default 0 means that automatic deletion is disabled.
KEEP_BACKUPS="${KEEP_BACKUPS:-0}"

BACKUP_HELPER_IMAGE="${BACKUP_HELPER_IMAGE:-alpine:3.20}"

BACKEND_VOLUME="${BACKEND_VOLUME:-edumind-rpi5_backend-data}"
QDRANT_VOLUME="${QDRANT_VOLUME:-edumind-rpi5_qdrant-data}"
OLLAMA_VOLUME="${OLLAMA_VOLUME:-edumind-rpi5_ollama-data}"

SERVICES_STOPPED=false
BACKUP_COMPLETE=false

# ---------------------------------------------------------------------------
# Cleanup and recovery
# ---------------------------------------------------------------------------

restart_services() {
    if [[ "$SERVICES_STOPPED" == true ]]; then
        echo
        info "Restarting production services..."

        if compose up -d qdrant ollama backend frontend; then
            success "Production services restarted."
        else
            error "Production services could not be restarted automatically."
            error "Run: ./deploy/prod/scripts/prod-start.sh"
            return 1
        fi

        SERVICES_STOPPED=false
    fi
}

cleanup_on_exit() {
    local exit_code=$?

    if [[ "$SERVICES_STOPPED" == true ]]; then
        restart_services || true
    fi

    if [[ "$BACKUP_COMPLETE" != true && -d "$BACKUP_DIR" ]]; then
        warn "Removing incomplete backup directory:"
        warn "$BACKUP_DIR"
        rm -rf "$BACKUP_DIR"
    fi

    exit "$exit_code"
}

trap cleanup_on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

validate_positive_integer() {
    local value="$1"
    local name="$2"

    if ! [[ "$value" =~ ^[0-9]+$ ]]; then
        die "$name must be a non-negative integer. Received: $value"
    fi
}

validate_volume() {
    local volume="$1"

    if ! docker volume inspect "$volume" >/dev/null 2>&1; then
        die "Required Docker volume does not exist: $volume"
    fi
}

ensure_helper_image() {
    if docker image inspect "$BACKUP_HELPER_IMAGE" >/dev/null 2>&1; then
        return
    fi

    info "Downloading backup helper image: $BACKUP_HELPER_IMAGE"
    docker pull "$BACKUP_HELPER_IMAGE"
}

# ---------------------------------------------------------------------------
# Backup functions
# ---------------------------------------------------------------------------

backup_volume() {
    local volume="$1"
    local archive_name="$2"
    local archive_path="$BACKUP_DIR/$archive_name"

    info "Backing up volume: $volume"

    docker run --rm \
        --mount "type=volume,source=$volume,target=/source,readonly" \
        --mount "type=bind,source=$BACKUP_DIR,target=/backup" \
        "$BACKUP_HELPER_IMAGE" \
        sh -c "cd /source && tar -czf '/backup/$archive_name' ."

    if [[ ! -s "$archive_path" ]]; then
        die "Backup archive is missing or empty: $archive_path"
    fi

    success "Created $archive_name ($(du -h "$archive_path" | awk '{print $1}'))"
}

write_backup_metadata() {
    local metadata_file="$BACKUP_DIR/backup-info.txt"

    info "Collecting backup metadata..."

    {
        echo "EduMind AI Production Backup"
        echo "============================"
        echo
        echo "Backup timestamp: $(date --iso-8601=seconds 2>/dev/null || date)"
        echo "Backup directory: $BACKUP_DIR"
        echo "Hostname: $(hostname)"
        echo "User: $(id -un)"
        echo "Architecture: $(uname -m)"
        echo "Kernel: $(uname -srmo)"
        echo

        echo "Git"
        echo "---"
        echo "Repository: $REPO_ROOT"
        echo "Branch: $(git -C "$REPO_ROOT" branch --show-current 2>/dev/null || echo unknown)"
        echo "Commit: $(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
        echo "Commit short: $(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
        echo "Working tree:"
        git -C "$REPO_ROOT" status --short 2>/dev/null || echo "Unavailable"
        echo

        echo "Docker"
        echo "------"
        docker --version 2>/dev/null || true
        docker compose version 2>/dev/null || true
        echo
        echo "Compose project:"
        echo "edumind-rpi5"
        echo
        echo "Containers:"
        compose ps 2>/dev/null || true
        echo

        echo "Docker images"
        echo "-------------"
        compose images 2>/dev/null || true
        echo

        echo "Persistent volumes"
        echo "------------------"
        echo "$BACKEND_VOLUME"
        echo "$QDRANT_VOLUME"
        echo "$OLLAMA_VOLUME"
        echo

        echo "Ollama models"
        echo "-------------"
        compose exec -T ollama ollama list 2>/dev/null || \
            echo "Ollama model list unavailable while services are stopped."
        echo

        echo "Disk usage"
        echo "----------"
        df -h 2>/dev/null || true
        echo

        echo "Memory"
        echo "------"
        free -h 2>/dev/null || true
        echo

        if [[ -r /proc/device-tree/model ]]; then
            echo "Device"
            echo "------"
            tr -d '\0' </proc/device-tree/model
            echo
        fi
    } >"$metadata_file"

    success "Created backup-info.txt"
}

write_restore_instructions() {
    cat >"$BACKUP_DIR/restore-instructions.txt" <<EOF_RESTORE
EduMind AI Restore Instructions
================================

Backup:
$BACKUP_DIR

Archives:
- backend-data.tar.gz
- qdrant-data.tar.gz
- ollama-data.tar.gz

Before restoring:

1. Confirm that you selected the correct backup.
2. Verify its checksums:

   cd "$BACKUP_DIR"
   sha256sum -c SHA256SUMS

3. Stop the production services:

   cd "$REPO_ROOT"
   ./deploy/prod/scripts/prod-stop.sh

4. Restore using the production restore command once it is installed:

   ./deploy/prod/scripts/prod-restore.sh "$BACKUP_DIR"

5. Start and verify the deployment:

   ./deploy/prod/scripts/prod-start.sh
   ./deploy/prod/scripts/prod-healthcheck.sh

Never use docker compose down -v unless permanent volume deletion is intended.
EOF_RESTORE

    success "Created restore-instructions.txt"
}

snapshot_configuration() {
    info "Saving deployment configuration snapshots..."

    cp "$COMPOSE_FILE" "$BACKUP_DIR/docker-compose.prod.yml"

    if [[ -f "$PROD_DIR/.env.prod.example" ]]; then
        cp "$PROD_DIR/.env.prod.example" "$BACKUP_DIR/.env.prod.example"
    fi

    compose images >"$BACKUP_DIR/docker-images.txt" 2>/dev/null || true

    success "Configuration snapshots created."
}

generate_checksums() {
    info "Generating SHA-256 checksums..."

    (
        cd "$BACKUP_DIR"
        sha256sum \
            backend-data.tar.gz \
            qdrant-data.tar.gz \
            ollama-data.tar.gz \
            backup-info.txt \
            docker-images.txt \
            docker-compose.prod.yml \
            restore-instructions.txt \
            >SHA256SUMS

        if [[ -f ".env.prod.example" ]]; then
            sha256sum ".env.prod.example" >>SHA256SUMS
        fi

        sha256sum -c SHA256SUMS
    )

    success "All backup checksums verified."
}

apply_retention_policy() {
    if (( KEEP_BACKUPS == 0 )); then
        info "Automatic backup retention is disabled."
        return
    fi

    info "Keeping the newest $KEEP_BACKUPS backup(s)."

    mapfile -t backups < <(
        find "$BACKUP_ROOT" \
            -mindepth 1 \
            -maxdepth 1 \
            -type d \
            -name "${BACKUP_PREFIX}-*" \
            -printf '%T@ %p\n' \
            | sort -rn \
            | awk '{print $2}'
    )

    if (( ${#backups[@]} <= KEEP_BACKUPS )); then
        return
    fi

    for ((index = KEEP_BACKUPS; index < ${#backups[@]}; index++)); do
        warn "Removing old backup: ${backups[$index]}"
        rm -rf -- "${backups[$index]}"
    done
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

validate_positive_integer "$KEEP_BACKUPS" "KEEP_BACKUPS"

validate_volume "$BACKEND_VOLUME"
validate_volume "$QDRANT_VOLUME"
validate_volume "$OLLAMA_VOLUME"

ensure_helper_image

mkdir -p "$BACKUP_DIR"

info "Backup destination:"
echo "$BACKUP_DIR"
echo

# Capture information requiring running services before stopping them.
write_backup_metadata
snapshot_configuration
write_restore_instructions

warn "Temporarily stopping stateful services for a consistent backup..."
compose stop backend qdrant ollama
SERVICES_STOPPED=true

echo
backup_volume "$BACKEND_VOLUME" "backend-data.tar.gz"
backup_volume "$QDRANT_VOLUME" "qdrant-data.tar.gz"
backup_volume "$OLLAMA_VOLUME" "ollama-data.tar.gz"

restart_services

echo
info "Waiting for production services to recover..."

HEALTH_ATTEMPTS="${HEALTH_ATTEMPTS:-18}"
HEALTH_DELAY="${HEALTH_DELAY:-5}"

for ((attempt = 1; attempt <= HEALTH_ATTEMPTS; attempt++)); do
    if "$SCRIPTS_DIR/prod-healthcheck.sh" >/dev/null 2>&1; then
        success "Production services are healthy."
        break
    fi

    if (( attempt == HEALTH_ATTEMPTS )); then
        warn "Services restarted, but the health check did not pass in time."
        warn "Run: $SCRIPTS_DIR/prod-healthcheck.sh"
        break
    fi

    info "Health check attempt $attempt/$HEALTH_ATTEMPTS; retrying in ${HEALTH_DELAY}s..."
    sleep "$HEALTH_DELAY"
done

echo
generate_checksums

BACKUP_COMPLETE=true
apply_retention_policy

TOTAL_SIZE="$(du -sh "$BACKUP_DIR" | awk '{print $1}')"

echo
success "Production backup completed successfully."
echo
echo "Backup directory: $BACKUP_DIR"
echo "Total size:       $TOTAL_SIZE"
echo
echo "Verify later with:"
echo "  cd \"$BACKUP_DIR\" && sha256sum -c SHA256SUMS"
