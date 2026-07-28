#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/lib/common.sh"

check_environment
print_header

BACKUP_DIR=""
ASSUME_YES=false
DRY_RUN=false
SKIP_PRE_RESTORE_BACKUP=false
BACKUP_HELPER_IMAGE="${BACKUP_HELPER_IMAGE:-alpine:3.20}"

BACKEND_VOLUME="${BACKEND_VOLUME:-edumind-rpi5_backend-data}"
QDRANT_VOLUME="${QDRANT_VOLUME:-edumind-rpi5_qdrant-data}"
OLLAMA_VOLUME="${OLLAMA_VOLUME:-edumind-rpi5_ollama-data}"

SERVICES_STOPPED=false
RESTORE_COMPLETE=false

usage() {
    cat <<EOF_USAGE
Usage:
  $(basename "$0") BACKUP_DIRECTORY [options]

Options:
  --dry-run                  Validate and display the restore plan only
  --yes                      Skip interactive confirmation
  --skip-pre-restore-backup  Do not create a rollback backup
  -h, --help                 Show this help message

Examples:
  $(basename "$0") ~/edumind-backups/edumind-backup-20260727-155301

  $(basename "$0") \
    ~/edumind-backups/edumind-backup-20260727-155301 \
    --dry-run

  $(basename "$0") \
    ~/edumind-backups/edumind-backup-20260727-155301 \
    --yes
EOF_USAGE
}

restart_after_failure() {
    if [[ "$SERVICES_STOPPED" == true ]]; then
        echo
        warn "Attempting to restart production services..."

        if start_services; then
            SERVICES_STOPPED=false
            success "Production services restarted."
        else
            error "Production services could not be restarted automatically."
            error "Run: $SCRIPTS_DIR/prod-start.sh"
        fi
    fi
}

cleanup_on_exit() {
    local exit_code=$?

    if [[ "$RESTORE_COMPLETE" != true ]]; then
        restart_after_failure || true
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
            --skip-pre-restore-backup)
                SKIP_PRE_RESTORE_BACKUP=true
                shift
                ;;
            -h|--help)
                usage
                exit 0
                ;;
            -*)
                die "Unknown option: $1"
                ;;
            *)
                if [[ -n "$BACKUP_DIR" ]]; then
                    die "Only one backup directory may be specified."
                fi

                BACKUP_DIR="$1"
                shift
                ;;
        esac
    done

    [[ -n "$BACKUP_DIR" ]] || {
        usage
        exit 1
    }

    BACKUP_DIR="$(cd "$BACKUP_DIR" 2>/dev/null && pwd)" ||
        die "Backup directory does not exist: $BACKUP_DIR"
}

show_restore_plan() {
    echo
    info "Restore source"
    echo "$BACKUP_DIR"

    echo
    info "Restore targets"
    printf '%-28s -> %s\n' \
        "backend-data.tar.gz" "$BACKEND_VOLUME"
    printf '%-28s -> %s\n' \
        "qdrant-data.tar.gz" "$QDRANT_VOLUME"
    printf '%-28s -> %s\n' \
        "ollama-data.tar.gz" "$OLLAMA_VOLUME"

    echo
    warn "This operation will overwrite the current production data."

    if [[ "$SKIP_PRE_RESTORE_BACKUP" == true ]]; then
        warn "Automatic pre-restore backup is disabled."
    else
        info "A rollback backup will be created before data is modified."
    fi
}

confirm_restore() {
    if [[ "$ASSUME_YES" == true ]]; then
        warn "Confirmation skipped because --yes was provided."
        return
    fi

    echo
    echo "Type RESTORE to continue:"
    read -r confirmation

    if [[ "$confirmation" != "RESTORE" ]]; then
        die "Restore cancelled."
    fi
}

create_pre_restore_backup() {
    if [[ "$SKIP_PRE_RESTORE_BACKUP" == true ]]; then
        warn "Skipping pre-restore backup."
        return
    fi

    echo
    info "Creating pre-restore rollback backup..."

    KEEP_BACKUPS=0 \
        "$SCRIPTS_DIR/prod-backup.sh"

    success "Pre-restore rollback backup completed."
}

validate_restore_environment() {
    require_volume "$BACKEND_VOLUME"
    require_volume "$QDRANT_VOLUME"
    require_volume "$OLLAMA_VOLUME"

    if ! docker image inspect "$BACKUP_HELPER_IMAGE" >/dev/null 2>&1; then
        info "Downloading restore helper image: $BACKUP_HELPER_IMAGE"
        docker pull "$BACKUP_HELPER_IMAGE"
    fi
}

stop_restore_services() {
    echo
    warn "Stopping production services..."

    compose stop frontend backend qdrant ollama
    SERVICES_STOPPED=true

    success "Production services stopped."
}

restore_all_volumes() {
    echo
    restore_volume_archive \
        "$BACKUP_DIR/backend-data.tar.gz" \
        "$BACKEND_VOLUME" \
        "$BACKUP_HELPER_IMAGE"

    restore_volume_archive \
        "$BACKUP_DIR/qdrant-data.tar.gz" \
        "$QDRANT_VOLUME" \
        "$BACKUP_HELPER_IMAGE"

    restore_volume_archive \
        "$BACKUP_DIR/ollama-data.tar.gz" \
        "$OLLAMA_VOLUME" \
        "$BACKUP_HELPER_IMAGE"
}

start_and_verify() {
    echo
    info "Starting restored production stack..."

    start_services
    SERVICES_STOPPED=false

    echo
    info "Waiting for restored services to become healthy..."

    if wait_for_health \
        "${HEALTH_ATTEMPTS:-24}" \
        "${HEALTH_DELAY:-5}"; then
        success "Restored production stack is healthy."
        return
    fi

    error "Restore completed, but the health check did not pass."
    error "Run: $SCRIPTS_DIR/prod-healthcheck.sh"
    return 1
}

main() {
    parse_arguments "$@"

    verify_backup_directory "$BACKUP_DIR"
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
    success "Production restore completed successfully."
    echo
    echo "Restore source: $BACKUP_DIR"
}

main "$@"
