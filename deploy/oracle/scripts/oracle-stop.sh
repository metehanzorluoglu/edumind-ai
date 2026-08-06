#!/usr/bin/env bash
#
# Stops and removes the EduM8 Oracle VM containers and network, WITHOUT
# ever touching persistent volumes.
#
# Adapted from deploy/prod/scripts/prod-stop.sh. Never runs
# `docker compose down -v` — see common.sh / README for why.

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/common.sh"

ASSUME_YES=false

usage() {
    cat <<EOF_USAGE
Usage:
  $(basename "$0") [options]

Stops and removes the Oracle stack's containers and network
(docker compose down — WITHOUT -v). Named volumes
($ORACLE_BACKEND_VOLUME, $ORACLE_QDRANT_VOLUME, $ORACLE_OLLAMA_VOLUME)
are always preserved.

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

    check_oracle_environment
    print_header "EduM8 Oracle — Stop"

    warn "This will stop and remove all Oracle containers and the Oracle network."
    info "Persistent volumes are never removed by this script:"
    echo "  - $ORACLE_BACKEND_VOLUME"
    echo "  - $ORACLE_QDRANT_VOLUME"
    echo "  - $ORACLE_OLLAMA_VOLUME"

    confirm_yes_no "Proceed with stopping the Oracle stack?" "$ASSUME_YES"

    info "Stopping EduM8 Oracle services (docker compose down, no -v)..."
    oracle_compose down

    echo
    success "Oracle stack stopped."
    warn "Data volumes were PRESERVED: $ORACLE_BACKEND_VOLUME, $ORACLE_QDRANT_VOLUME, $ORACLE_OLLAMA_VOLUME"
    info "Start again with: $ORACLE_SCRIPTS_DIR/oracle-start.sh"
}

main "$@"
