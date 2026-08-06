#!/usr/bin/env bash
#
# Recreates ONLY the EduM8 frontend container — backend, Ollama, Qdrant,
# networks, and volumes are preserved.
#
# Adapted from deploy/oracle/scripts/oracle-restart.sh, narrowed to the
# frontend service via `up -d --force-recreate --no-deps frontend`: the
# --no-deps flag is what guarantees dependency containers are never
# restarted as a side effect.

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

BUILD=false
RUN_HEALTHCHECK=true

usage() {
    cat <<EOF_USAGE
Usage:
  $(basename "$0") [options]

Recreates the '$FRONTEND_SERVICE' container (docker compose up -d
--force-recreate --no-deps frontend). With --build, rebuilds the frontend
image first. Dependency containers (backend, Ollama, Qdrant), networks,
and volumes are never touched.

Options:
  --build            Rebuild the frontend image, then recreate the container
  --no-healthcheck   Recreate the container but skip the post-restart health check
  -h, --help         Show this help message

Examples:
  $(basename "$0")
  $(basename "$0") --build
  $(basename "$0") --no-healthcheck
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

    check_frontend_environment
    print_header "EduM8 Frontend — Restart"

    info "Validating Compose configuration..."
    frontend_compose config --quiet \
        || die "docker compose config validation failed — fix $FRONTEND_COMPOSE_FILE / $FRONTEND_ENV_FILE before restarting."

    # --no-deps is the safety guarantee here: Compose recreates exactly the
    # frontend container and leaves every dependency container alone, even
    # though `frontend` declares depends_on: backend.
    if [[ "$BUILD" == true ]]; then
        info "Rebuilding the frontend image and recreating the frontend container..."
        frontend_compose up -d --build --force-recreate --no-deps "$FRONTEND_SERVICE"
    else
        info "Recreating the frontend container (no rebuild — pass --build to force one)..."
        frontend_compose up -d --force-recreate --no-deps "$FRONTEND_SERVICE"
    fi

    echo
    frontend_compose ps "$FRONTEND_SERVICE"
    echo

    if [[ "$RUN_HEALTHCHECK" == true ]]; then
        info "Waiting for the frontend to become healthy at $FRONTEND_URL (/health and /)..."
        if wait_for_frontend_health "${HEALTH_ATTEMPTS:-24}" "${HEALTH_DELAY:-5}"; then
            success "Frontend restarted and healthy at $FRONTEND_URL"
        else
            warn "The frontend container was recreated, but $FRONTEND_URL/health or $FRONTEND_URL/ did not respond in time."
            warn "Check logs: $FRONTEND_SCRIPTS_DIR/frontend-logs.sh --no-follow"
            exit 1
        fi
    else
        warn "Skipping post-restart health check (--no-healthcheck)."
        success "Frontend restart command completed."
    fi
}

main "$@"
