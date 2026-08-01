#!/usr/bin/env bash
#
# Backs up the EduMind Oracle VM stack's persistent volumes and deployment
# metadata into a timestamped, checksummed backup directory.
#
# Adapted from deploy/prod/scripts/prod-backup.sh — same overall shape
# (stop stateful services -> tar each volume -> restart -> checksum),
# extended with --skip-ollama, --online, retention default of 10 (prod
# defaults to unlimited retention; Oracle backups include the much larger
# Ollama volume, so a default cap matters more here), and never backing up
# .env.oracle itself (only .env.oracle.example).

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/common.sh"

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

TIMESTAMP="$(date '+%Y%m%d-%H%M%S')"
BACKUP_DIR="$ORACLE_BACKUP_ROOT/$ORACLE_BACKUP_PREFIX-$TIMESTAMP"

# Default 10 (task requirement) — the Ollama volume alone is commonly
# 10+ GB (qwen3:8b + qwen2.5vl:7b + mxbai-embed-large), so unlimited
# retention (deploy/prod's default) fills disk far faster here.
KEEP_BACKUPS="${KEEP_BACKUPS:-10}"

SKIP_OLLAMA=false
ONLINE=false
ASSUME_YES=false

SERVICES_STOPPED=false
BACKUP_COMPLETE=false

usage() {
    cat <<EOF_USAGE
Usage:
  $(basename "$0") [options]

Backs up backend-data, qdrant-data, and ollama-data (unless --skip-ollama)
plus deployment metadata into a timestamped directory under:
  $ORACLE_BACKUP_ROOT

WARNING: the Ollama volume is large (all pulled models — commonly 10+ GB
for qwen3:8b + qwen2.5vl:7b + mxbai-embed-large). Backing it up takes real
time and disk space; use --skip-ollama to skip it (models can always be
re-pulled with 'ollama pull').

Options:
  --skip-ollama   Do not back up the Ollama model volume (it is large and
                  re-downloadable; every other backup content is unaffected)
  --online        Do not stop services first (faster, zero downtime, but the
                  volume snapshot may be slightly inconsistent if a write
                  happens mid-backup — default is to stop stateful services
                  first for a consistent snapshot)
  --yes           Skip interactive confirmation
  -h, --help      Show this help message

Environment overrides:
  KEEP_BACKUPS    Number of Oracle backups to retain; default 10 (0 disables
                  automatic retention)
  BACKUP_ROOT     Overridden via ORACLE_BACKUP_ROOT; default ~/edumind-backups

Examples:
  $(basename "$0")
  $(basename "$0") --skip-ollama
  $(basename "$0") --online --yes
  KEEP_BACKUPS=5 $(basename "$0")
EOF_USAGE
}

parse_arguments() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --skip-ollama)
                SKIP_OLLAMA=true
                shift
                ;;
            --online)
                ONLINE=true
                shift
                ;;
            --yes)
                ASSUME_YES=true
                shift
                ;;
            -h|--help)
                usage
                exit 0
                ;;
            *)
                die "Unknown option: $1 (see --help)"
                ;;
        esac
    done
}

# ---------------------------------------------------------------------------
# Cleanup / recovery — always restarts services, even on failure.
# ---------------------------------------------------------------------------

restart_stopped_services() {
    if [[ "$SERVICES_STOPPED" == true ]]; then
        echo
        info "Restarting Oracle services..."

        if oracle_compose up -d; then
            success "Oracle services restarted."
        else
            error "Oracle services could not be restarted automatically."
            error "Run: $ORACLE_SCRIPTS_DIR/oracle-start.sh"
            return 1
        fi

        SERVICES_STOPPED=false
    fi
}

cleanup_on_exit() {
    local exit_code=$?

    if [[ "$SERVICES_STOPPED" == true ]]; then
        restart_stopped_services || true
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
    local value="$1" name="$2"
    [[ "$value" =~ ^[0-9]+$ ]] || die "$name must be a non-negative integer. Received: $value"
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
    local volume="$1" archive_name="$2"
    local archive_path="$BACKUP_DIR/$archive_name"

    info "Backing up volume: $volume -> $archive_name"

    docker run --rm \
        --mount "type=volume,source=$volume,target=/source,readonly" \
        --mount "type=bind,source=$BACKUP_DIR,target=/backup" \
        "$BACKUP_HELPER_IMAGE" \
        sh -c "cd /source && tar -czf '/backup/$archive_name' ."

    [[ -s "$archive_path" ]] || die "Backup archive is missing or empty: $archive_path"

    success "Created $archive_name ($(du -h "$archive_path" | awk '{print $1}'))"
}

write_backup_metadata() {
    local metadata_file="$BACKUP_DIR/backup-info.txt"
    info "Collecting backup metadata..."

    {
        echo "EduMind AI Oracle VM Backup"
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
        echo "Branch: $(git_branch)"
        echo "Commit: $(git_commit)"
        echo "Commit short: $(git_commit_short)"
        echo "Working tree:"
        git -C "$REPO_ROOT" status --short 2>/dev/null || echo "Unavailable"
        echo

        echo "Docker"
        echo "------"
        docker --version 2>/dev/null || true
        docker compose version 2>/dev/null || true
        echo
        echo "Compose project: $ORACLE_PROJECT_NAME"
        echo
        echo "Containers:"
        oracle_compose ps 2>/dev/null || true
        echo

        echo "Docker images"
        echo "-------------"
        oracle_compose images 2>/dev/null || true
        echo

        echo "Persistent volumes"
        echo "------------------"
        echo "$ORACLE_BACKEND_VOLUME"
        echo "$ORACLE_QDRANT_VOLUME"
        if [[ "$SKIP_OLLAMA" == true ]]; then
            echo "$ORACLE_OLLAMA_VOLUME (SKIPPED — --skip-ollama)"
        else
            echo "$ORACLE_OLLAMA_VOLUME"
        fi
        echo

        echo "Ollama models"
        echo "-------------"
        oracle_ollama_models 2>/dev/null || echo "Ollama model list unavailable (container stopped or unreachable)."
        echo

        echo "Disk usage"
        echo "----------"
        df -h 2>/dev/null || true
        echo

        echo "Memory"
        echo "------"
        free -h 2>/dev/null || true
    } >"$metadata_file"

    success "Created backup-info.txt"
}

write_restore_instructions() {
    cat >"$BACKUP_DIR/restore-instructions.txt" <<EOF_RESTORE
EduMind AI Oracle VM Restore Instructions
==========================================

Backup:
$BACKUP_DIR

Archives in this backup:
- backend-data.tar.gz -> $ORACLE_BACKEND_VOLUME
- qdrant-data.tar.gz  -> $ORACLE_QDRANT_VOLUME
$([[ "$SKIP_OLLAMA" == true ]] && echo "- ollama-data.tar.gz  -> NOT INCLUDED (--skip-ollama was used)" || echo "- ollama-data.tar.gz  -> $ORACLE_OLLAMA_VOLUME")

Before restoring:

1. Confirm you selected the correct backup directory.
2. Verify its checksums:

   cd "$BACKUP_DIR"
   sha256sum -c SHA256SUMS

3. Validate the restore plan without changing anything:

   cd "$REPO_ROOT"
   ./deploy/oracle/scripts/oracle-restore.sh "$BACKUP_DIR" --dry-run

4. Run the real restore (creates its own pre-restore safety backup unless
   --skip-safety-backup is given):

   ./deploy/oracle/scripts/oracle-restore.sh "$BACKUP_DIR"

5. Verify:

   ./deploy/oracle/scripts/oracle-healthcheck.sh

Never use "docker compose down -v" — that deletes named volumes.
.env.oracle is never included in a backup and is never restored from one;
restoring only replaces volume DATA, never deployment configuration.
EOF_RESTORE

    success "Created restore-instructions.txt"
}

snapshot_configuration() {
    info "Saving deployment configuration snapshot..."

    cp "$ORACLE_COMPOSE_FILE" "$BACKUP_DIR/docker-compose.oracle.yml"

    # .env.oracle.example ONLY — .env.oracle holds real secrets (JWT_SECRET,
    # OAuth client secrets) and must never be copied into a backup.
    if [[ -f "$ORACLE_ENV_EXAMPLE_FILE" ]]; then
        cp "$ORACLE_ENV_EXAMPLE_FILE" "$BACKUP_DIR/.env.oracle.example"
    fi

    oracle_compose images >"$BACKUP_DIR/docker-images.txt" 2>/dev/null || true

    success "Configuration snapshot created (.env.oracle itself was NOT copied)."
}

generate_checksums() {
    info "Generating SHA-256 checksums..."

    (
        cd "$BACKUP_DIR"
        local files=(
            backend-data.tar.gz
            qdrant-data.tar.gz
            backup-info.txt
            docker-images.txt
            docker-compose.oracle.yml
            restore-instructions.txt
        )
        [[ "$SKIP_OLLAMA" == true ]] || files+=(ollama-data.tar.gz)
        [[ -f .env.oracle.example ]] && files+=(.env.oracle.example)

        sha256sum "${files[@]}" >SHA256SUMS
        sha256sum -c SHA256SUMS
    )

    success "All backup checksums verified immediately after creation."
}

apply_retention_policy() {
    if (( KEEP_BACKUPS == 0 )); then
        info "Automatic backup retention is disabled (KEEP_BACKUPS=0)."
        return
    fi

    info "Keeping the newest $KEEP_BACKUPS Oracle backup(s) in $ORACLE_BACKUP_ROOT."

    mapfile -t backups < <(
        find "$ORACLE_BACKUP_ROOT" \
            -mindepth 1 -maxdepth 1 -type d \
            -name "${ORACLE_BACKUP_PREFIX}-*" \
            -printf '%T@ %p\n' \
            | sort -rn \
            | awk '{print $2}'
    )

    if (( ${#backups[@]} <= KEEP_BACKUPS )); then
        return
    fi

    for ((index = KEEP_BACKUPS; index < ${#backups[@]}; index++)); do
        warn "Removing old Oracle backup: ${backups[$index]}"
        rm -rf -- "${backups[$index]}"
    done
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

main() {
    parse_arguments "$@"
    check_oracle_environment
    print_header "EduMind Oracle — Backup"

    validate_positive_integer "$KEEP_BACKUPS" "KEEP_BACKUPS"

    require_volume "$ORACLE_BACKEND_VOLUME"
    require_volume "$ORACLE_QDRANT_VOLUME"
    [[ "$SKIP_OLLAMA" == true ]] || require_volume "$ORACLE_OLLAMA_VOLUME"

    if [[ "$SKIP_OLLAMA" == true ]]; then
        warn "--skip-ollama: the Ollama model volume will NOT be backed up. Models can be re-pulled with 'ollama pull <model>' after a restore."
    else
        warn "The Ollama volume backup is large (all pulled models, commonly 10+ GB). This may take several minutes and needs that much free disk space in $ORACLE_BACKUP_ROOT."
    fi

    if [[ "$ONLINE" == true ]]; then
        warn "--online: services will NOT be stopped. The snapshot may be slightly inconsistent if a write happens mid-backup."
    else
        info "Stateful services (backend, qdrant$([[ "$SKIP_OLLAMA" == true ]] || echo ", ollama")) will be stopped briefly for a consistent snapshot."
    fi

    confirm_yes_no "Proceed with this Oracle backup?" "$ASSUME_YES"

    ensure_helper_image
    mkdir -p "$BACKUP_DIR"

    info "Backup destination: $BACKUP_DIR"
    echo

    # Capture information requiring running services before stopping them.
    write_backup_metadata
    snapshot_configuration
    write_restore_instructions

    if [[ "$ONLINE" != true ]]; then
        echo
        warn "Temporarily stopping stateful services for a consistent backup..."
        if [[ "$SKIP_OLLAMA" == true ]]; then
            oracle_compose stop backend qdrant
        else
            oracle_compose stop backend qdrant ollama
        fi
        SERVICES_STOPPED=true
    fi

    echo
    backup_volume "$ORACLE_BACKEND_VOLUME" "backend-data.tar.gz"
    backup_volume "$ORACLE_QDRANT_VOLUME" "qdrant-data.tar.gz"
    [[ "$SKIP_OLLAMA" == true ]] || backup_volume "$ORACLE_OLLAMA_VOLUME" "ollama-data.tar.gz"

    restart_stopped_services

    echo
    info "Waiting for Oracle services to become healthy again..."
    if wait_for_oracle_health "${HEALTH_ATTEMPTS:-18}" "${HEALTH_DELAY:-5}"; then
        success "Oracle services are healthy."
    else
        warn "Services restarted, but the health check did not pass in time."
        warn "Run: $ORACLE_SCRIPTS_DIR/oracle-healthcheck.sh"
    fi

    echo
    generate_checksums

    BACKUP_COMPLETE=true
    apply_retention_policy

    TOTAL_SIZE="$(du -sh "$BACKUP_DIR" | awk '{print $1}')"

    echo
    success "Oracle backup completed successfully."
    echo
    echo "Backup directory: $BACKUP_DIR"
    echo "Total size:       $TOTAL_SIZE"
    echo
    echo "Verify later with:"
    echo "  cd \"$BACKUP_DIR\" && sha256sum -c SHA256SUMS"
}

main "$@"
