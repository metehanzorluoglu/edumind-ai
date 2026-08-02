#!/usr/bin/env bash
#
# Stops ONLY the EduMind frontend container — never the backend, Ollama,
# Qdrant, or the migration job, and never via `docker compose down`.
#
# Adapted from deploy/oracle/scripts/oracle-stop.sh, narrowed from a full
# stack down (containers + network) to a single-service stop: `docker
# compose stop frontend` leaves every other container, all networks, and
# all named volumes exactly as they are.

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

ASSUME_YES=false

usage() {
    cat <<EOF_USAGE
Usage:
  $(basename "$0") [options]

Stops the '$FRONTEND_SERVICE' container only (docker compose stop frontend).
The backend, Ollama, Qdrant, the Docker network, and all persistent
volumes are left running/untouched. Never runs 'docker compose down' and
never removes volumes or networks.

Options:
  --yes         Skip interactive confirmation
  -h, --help    Show this help message

Examples:
  $(basename "$0")
  $(basename "$0") --yes
EOF_USAGE
}

parse_arguments() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
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

main() {
    parse_arguments "$@"

    check_frontend_environment
    print_header "EduMind Frontend — Stop"

    info "This stops ONLY the '$FRONTEND_SERVICE' container. Not affected:"
    echo "  - backend, backend-migrate, ollama, qdrant (keep running)"
    echo "  - Docker networks and all persistent volumes"

    confirm_yes_no "Proceed with stopping the frontend service?" "$ASSUME_YES"

    info "Stopping the frontend service (docker compose stop $FRONTEND_SERVICE)..."
    frontend_compose stop "$FRONTEND_SERVICE"

    echo
    success "Frontend service stopped."
    info "Backend/Ollama/Qdrant were not touched. Start again with: $FRONTEND_SCRIPTS_DIR/frontend-start.sh"
}

main "$@"
