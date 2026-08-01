#!/usr/bin/env bash
#
# Restores the EduMind Oracle VM stack's persistent volumes from a backup
# created by oracle-backup.sh.
#
# Adapted from deploy/prod/scripts/prod-restore.sh — extended with
# --skip-ollama and explicit rollback instructions on failure. Never
# restores .env.oracle (only volume data is restored; deployment
# configuration is left untouched).

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/common.sh"

BACKUP_DIR=""
DRY_RUN=false
ASSUME_YES=false
SKIP_SAFETY_BACKUP=false
SKIP_OLLAMA=false

SERVICES_STOPPED=false
RESTORE_COMPLETE=false
SAFETY_BACKUP_DIR=""

usage() {
    cat <<EOF_USAGE
Usage:
  $(basename "$0") BACKUP_DIRECTORY [options]

Restores backend-data and qdrant-data (and ollama-data, unless
--skip-ollama or the backup doesn't include it) from a backup created by
oracle-backup.sh. .env.oracle is NEVER restored — only volume data changes.

Options:
  --dry-run               Validate and show the restore plan; change nothing
  --yes                   Skip interactive confirmation
  --skip-safety-backup    Do not create a pre-restore rollback backup
  --skip-ollama           Do not restore the Ollama volume even if present
                          in the backup (leaves current models untouched)
  -h, --help              Show this help message

Examples:
  $(basename "$0") ~/edumind-backups/edumind-oracle-backup-20260801-120000 --dry-run
  $(basename "$0") ~/edumind-backups/edumind-oracle-backup-20260801-120000
  $(basename "$0") ~/edumind-backups/edumind-oracle-backup-20260801-120000 --yes --skip-ollama
EOF_USAGE
}

restart_after_failure() {
    if [[ "$SERVICES_STOPPED" == true ]]; then
        echo
        warn "Attempting to restart Oracle services after failure..."

        if oracle_compose up -d; then
            SERVICES_STOPPED=false
            success "Oracle services restarted."
        else
            error "Oracle services could not be restarted automatically."
            error "Run: $ORACLE_SCRIPTS_DIR/oracle-start.sh"
        fi
    fi
}

print_rollback_instructions() {
    echo
    error "Restore did not complete successfully."
    if [[ -n "$SAFETY_BACKUP_DIR" ]]; then
        error "A pre-restore safety backup was created before any data was touched:"
        error "  $SAFETY_BACKUP_DIR"
        error "Roll back to the pre-restore state with:"
        error "  $ORACLE_SCRIPTS_DIR/oracle-restore.sh '$SAFETY_BACKUP_DIR' --yes --skip-safety-backup"
    else
        error "No pre-restore safety backup was created for this run (--skip-safety-backup was used)."
        error "If you have any earlier backup, restore from it instead:"
        error "  $ORACLE_SCRIPTS_DIR/oracle-restore.sh <earlier-backup-dir>"
    fi
    error "Then verify with: $ORACLE_SCRIPTS_DIR/oracle-healthcheck.sh"
}

cleanup_on_exit() {
    local exit_code=$?

    if [[ "$RESTORE_COMPLETE" != true ]]; then
        restart_after_failure || true
        if [[ $exit_code -ne 0 ]]; then
            print_rollback_instructions
        fi
    fi

    exit "$exit_code"
}

trap cleanup_on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

parse_arguments() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --dry-run)
                DRY_RUN=true
                shift
                ;;
            --yes)
                ASSUME_YES=true
                shift
                ;;
            --skip-safety-backup)
                SKIP_SAFETY_BACKUP=true
                shift
                ;;
            --skip-ollama)
                SKIP_OLLAMA=true
                shift
                ;;
            -h|--help)
                usage
                exit 0
                ;;
            -*)
                die "Unknown option: $1 (see --help)"
                ;;
            *)
                [[ -z "$BACKUP_DIR" ]] || die "Only one backup directory may be specified."
                BACKUP_DIR="$1"
                shift
                ;;
        esac
    done

    if [[ -z "$BACKUP_DIR" ]]; then
        usage
        exit 1
    fi

    BACKUP_DIR="$(cd "$BACKUP_DIR" 2>/dev/null && pwd)" \
        || die "Backup directory does not exist: $BACKUP_DIR"
}

backup_includes_ollama() {
    [[ -s "$BACKUP_DIR/ollama-data.tar.gz" ]]
}

show_restore_plan() {
    echo
    info "Restore source"
    echo "  $BACKUP_DIR"

    echo
    info "Restore targets"
    printf '  %-24s -> %s\n' "backend-data.tar.gz" "$ORACLE_BACKEND_VOLUME"
    printf '  %-24s -> %s\n' "qdrant-data.tar.gz" "$ORACLE_QDRANT_VOLUME"

    if [[ "$SKIP_OLLAMA" == true ]]; then
        printf '  %-24s -> %s\n' "ollama-data.tar.gz" "SKIPPED (--skip-ollama)"
    elif backup_includes_ollama; then
        printf '  %-24s -> %s\n' "ollama-data.tar.gz" "$ORACLE_OLLAMA_VOLUME"
    else
        printf '  %-24s -> %s\n' "ollama-data.tar.gz" "NOT IN BACKUP — will be left untouched"
    fi

    echo
    warn ".env.oracle is NEVER restored — only the volumes listed above are replaced."
    echo
    warn "This operation will PERMANENTLY OVERWRITE the current contents of the volume(s) above."

    if [[ "$SKIP_SAFETY_BACKUP" == true ]]; then
        warn "Automatic pre-restore safety backup is DISABLED (--skip-safety-backup)."
    else
        info "A pre-restore safety backup will be created before any data is modified."
    fi
}

confirm_restore() {
    confirm_phrase "RESTORE" "$ASSUME_YES"
}

create_pre_restore_backup() {
    if [[ "$SKIP_SAFETY_BACKUP" == true ]]; then
        warn "Skipping pre-restore safety backup (--skip-safety-backup)."
        return
    fi

    echo
    info "Creating pre-restore safety backup..."

    local backup_args=(--yes)
    [[ "$SKIP_OLLAMA" == true ]] || backup_includes_ollama || backup_args+=(--skip-ollama)

    KEEP_BACKUPS="${KEEP_BACKUPS:-10}" "$ORACLE_SCRIPTS_DIR/oracle-backup.sh" "${backup_args[@]}"

    SAFETY_BACKUP_DIR="$(
        find "$ORACLE_BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d \
            -name "${ORACLE_BACKUP_PREFIX}-*" -printf '%T@ %p\n' 2>/dev/null \
            | sort -rn | head -n1 | cut -d' ' -f2-
    )"

    [[ -n "$SAFETY_BACKUP_DIR" ]] || die "Safety backup completed, but its directory could not be identified."

    success "Pre-restore safety backup: $SAFETY_BACKUP_DIR"
}

validate_restore_environment() {
    require_volume "$ORACLE_BACKEND_VOLUME"
    require_volume "$ORACLE_QDRANT_VOLUME"
    [[ "$SKIP_OLLAMA" == true ]] || require_volume "$ORACLE_OLLAMA_VOLUME"

    if ! docker image inspect "$BACKUP_HELPER_IMAGE" >/dev/null 2>&1; then
        info "Downloading restore helper image: $BACKUP_HELPER_IMAGE"
        docker pull "$BACKUP_HELPER_IMAGE"
    fi
}

stop_restore_services() {
    echo
    warn "Stopping Oracle services..."
    oracle_compose stop frontend backend qdrant ollama
    SERVICES_STOPPED=true
    success "Oracle services stopped."
}

restore_all_volumes() {
    echo
    restore_volume_archive "$BACKUP_DIR/backend-data.tar.gz" "$ORACLE_BACKEND_VOLUME" "$BACKUP_HELPER_IMAGE"
    restore_volume_archive "$BACKUP_DIR/qdrant-data.tar.gz" "$ORACLE_QDRANT_VOLUME" "$BACKUP_HELPER_IMAGE"

    if [[ "$SKIP_OLLAMA" == true ]]; then
        info "Skipping ollama-data restore (--skip-ollama) — current Ollama volume left untouched."
    elif backup_includes_ollama; then
        restore_volume_archive "$BACKUP_DIR/ollama-data.tar.gz" "$ORACLE_OLLAMA_VOLUME" "$BACKUP_HELPER_IMAGE"
    else
        info "Backup does not include ollama-data.tar.gz — current Ollama volume left untouched."
    fi
}

start_and_verify() {
    echo
    info "Starting restored Oracle stack..."
    oracle_compose up -d
    SERVICES_STOPPED=false

    echo
    info "Waiting for restored services to become healthy..."
    if wait_for_oracle_health "${HEALTH_ATTEMPTS:-24}" "${HEALTH_DELAY:-5}"; then
        success "Restored Oracle stack is healthy."
        return
    fi

    error "Restore completed, but the health check did not pass."
    error "Run: $ORACLE_SCRIPTS_DIR/oracle-healthcheck.sh"
    return 1
}

main() {
    parse_arguments "$@"
    check_oracle_environment
    print_header "EduMind Oracle — Restore"

    verify_oracle_backup_directory "$BACKUP_DIR" "$SKIP_OLLAMA"
    validate_restore_environment
    show_restore_plan

    if [[ "$DRY_RUN" == true ]]; then
        echo
        success "Dry run completed. No data was modified."
        exit 0
    fi

    confirm_restore
    create_pre_restore_backup
    stop_restore_services
    restore_all_volumes
    start_and_verify

    RESTORE_COMPLETE=true

    echo
    success "Oracle restore completed successfully."
    echo
    echo "Restore source: $BACKUP_DIR"
    [[ -n "$SAFETY_BACKUP_DIR" ]] && echo "Pre-restore safety backup: $SAFETY_BACKUP_DIR"
}

main "$@"
