#!/usr/bin/env bash
#
# Restarts the EduMind Oracle VM stack safely: recreates containers without
# ever deleting persistent volumes.
#
# Adapted from deploy/prod/scripts/prod-restart.sh — extended with an
# optional --build and a post-restart health check.

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/common.sh"

BUILD=false
RUN_HEALTHCHECK=true

usage() {
    cat <<EOF_USAGE
Usage:
  $(basename "$0") [options]

Recreates every Oracle container (docker compose up -d --force-recreate).
Named volumes are never touched by this operation.

Options:
  --build            Rebuild images before recreating containers
  --no-healthcheck   Recreate containers but skip the post-restart health check
  -h, --help         Show this help message

Examples:
  $(basename "$0")
  $(basename "$0") --build
EOF_USAGE
}

parse_arguments() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --build)
                BUILD=true
                shift
                ;;
            --no-healthcheck)
                RUN_HEALTHCHECK=false
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

main() {
    parse_arguments "$@"

    check_oracle_environment
    print_header "EduMind Oracle — Restart"

    info "Validating Oracle Compose configuration..."
    oracle_compose config --quiet \
        || die "docker compose config validation failed — fix $ORACLE_COMPOSE_FILE / $ORACLE_ENV_FILE before restarting."

    if [[ "$BUILD" == true ]]; then
        info "Rebuilding images and recreating the Oracle stack..."
        oracle_compose up -d --build --force-recreate
    else
        info "Recreating the Oracle stack (no rebuild — pass --build to force one)..."
        oracle_compose up -d --force-recreate
    fi

    echo
    oracle_compose ps
    echo

    if [[ "$RUN_HEALTHCHECK" == true ]]; then
        info "Waiting for all services to become healthy..."
        if wait_for_oracle_health "${HEALTH_ATTEMPTS:-30}" "${HEALTH_DELAY:-5}"; then
            success "Oracle stack restarted and healthy."
        else
            warn "Services were recreated, but did not all become healthy in time."
            warn "Run: $ORACLE_SCRIPTS_DIR/oracle-healthcheck.sh"
            exit 1
        fi
    else
        warn "Skipping post-restart health check (--no-healthcheck)."
        success "Oracle stack restart command completed."
    fi
}

main "$@"
