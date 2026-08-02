#!/usr/bin/env bash
#
# Starts the EduMind frontend service (and only the dependencies it
# declares) within the edumind-oracle Compose project.
#
# Adapted from deploy/oracle/scripts/oracle-start.sh, narrowed to the
# frontend service: never rebuilds unless --build is given, never recreates
# already-running dependency containers (backend, Ollama, Qdrant, the
# one-shot backend-migrate job), and verifies the frontend's own /health
# and / endpoints after start (skippable with --no-healthcheck).

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

Starts the '$FRONTEND_SERVICE' service (project: $FRONTEND_PROJECT_NAME) and
the dependencies it declares. Already-running services are left untouched —
this never restarts the backend, Ollama, or Qdrant without cause. Never
rebuilds images unless --build is given.

Options:
  --build            Build the frontend image before starting (docker compose up -d --build frontend)
  --no-healthcheck   Start the service but skip the post-start health check
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

validate_compose_config() {
    info "Validating Compose configuration..."
    frontend_compose config --quiet \
        || die "docker compose config validation failed — fix $FRONTEND_COMPOSE_FILE / $FRONTEND_ENV_FILE before starting."
    success "Compose configuration is valid."
}

wait_for_container_running() {
    local attempts="${1:-12}"
    local delay="${2:-5}"
    local attempt container_id status

    for ((attempt = 1; attempt <= attempts; attempt++)); do
        container_id="$(frontend_container_id)"
        if [[ -n "$container_id" ]]; then
            status="$(frontend_container_status "$container_id")"
            if [[ "$status" == "running" ]]; then
                success "Frontend container is running: $(frontend_container_name "$container_id")"
                return 0
            fi
        fi

        if (( attempt < attempts )); then
            info "Waiting for the frontend container to start (attempt $attempt/$attempts, status: ${status:-absent})..."
            sleep "$delay"
        fi
    done

    return 1
}

start_frontend() {
    # `up -d frontend` lets Compose resolve the service's own depends_on
    # chain (backend -> qdrant/ollama/backend-migrate) and starts whatever
    # in that chain is not already running — without recreating anything
    # that is. That is exactly "the frontend and required dependencies".
    if [[ "$BUILD" == true ]]; then
        info "Building the frontend image and starting the frontend service (this can take a while)..."
        frontend_compose up -d --build "$FRONTEND_SERVICE"
    else
        info "Starting the frontend service (no rebuild — pass --build to force one)..."
        frontend_compose up -d "$FRONTEND_SERVICE"
    fi
}

main() {
    parse_arguments "$@"

    check_frontend_environment
    print_header "EduMind Frontend — Start"

    validate_compose_config
    start_frontend

    echo
    frontend_compose ps "$FRONTEND_SERVICE"
    echo

    if ! wait_for_container_running "${CONTAINER_WAIT_ATTEMPTS:-12}" "${CONTAINER_WAIT_DELAY:-5}"; then
        warn "The frontend container did not reach the running state in time."
        warn "Check logs: $FRONTEND_SCRIPTS_DIR/frontend-logs.sh --no-follow"
        exit 1
    fi

    if [[ "$RUN_HEALTHCHECK" == true ]]; then
        info "Waiting for the frontend to become healthy at $FRONTEND_URL (/health and /)..."
        if wait_for_frontend_health "${HEALTH_ATTEMPTS:-24}" "${HEALTH_DELAY:-5}"; then
            success "Frontend started and healthy at $FRONTEND_URL"
        else
            warn "The frontend container is running, but $FRONTEND_URL/health or $FRONTEND_URL/ did not respond in time."
            warn "Check logs: $FRONTEND_SCRIPTS_DIR/frontend-logs.sh --no-follow"
            exit 1
        fi
    else
        warn "Skipping post-start health check (--no-healthcheck)."
        success "Frontend start command completed."
    fi
}

main "$@"
