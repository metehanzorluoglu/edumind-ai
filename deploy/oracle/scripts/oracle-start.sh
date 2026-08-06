#!/usr/bin/env bash
#
# Starts the complete EduM8 Oracle VM stack (project: edumind-oracle).
#
# Adapted from deploy/prod/scripts/prod-start.sh — extended with Compose
# config validation, an optional --build, a mandatory post-start health
# check (skippable with --no-healthcheck), and an optional post-health-check
# Ollama model prewarm (see oracle-prewarm-model.sh — the text-model
# prewarm only runs when OLLAMA_PREWARM_ENABLED=true, and the vision-model
# prewarm only when OLLAMA_VISION_PREWARM_ENABLED=true, both independently,
# in .env.oracle; skippable together with --no-prewarm). Does not touch
# deploy/prod or deploy/rpi5.

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/common.sh"

BUILD=false
RUN_HEALTHCHECK=true
RUN_PREWARM=true

usage() {
    cat <<EOF_USAGE
Usage:
  $(basename "$0") [options]

Starts the Oracle stack (frontend, backend, qdrant, ollama) and its
one-shot backend-migrate job, then waits for every service to report
healthy. Never rebuilds images unless --build is given.

Options:
  --build            Build images before starting (docker compose up -d --build)
  --no-healthcheck   Start services but skip the post-start health check
  --no-prewarm       Skip the post-health-check Ollama model prewarm, even if
                     OLLAMA_PREWARM_ENABLED=true in .env.oracle
  -h, --help         Show this help message

Examples:
  $(basename "$0")
  $(basename "$0") --build
  $(basename "$0") --no-healthcheck
  $(basename "$0") --no-prewarm
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
            --no-prewarm)
                RUN_PREWARM=false
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
    info "Validating Oracle Compose configuration..."
    oracle_compose config --quiet \
        || die "docker compose config validation failed — fix $ORACLE_COMPOSE_FILE / $ORACLE_ENV_FILE before starting."
    success "Compose configuration is valid."
}

start_stack() {
    # backend-migrate (alembic upgrade head) is a one-shot service that
    # `backend` depends on with `condition: service_completed_successfully`
    # (see docker-compose.oracle.yml) — `compose up -d` already runs it to
    # completion, waits for it to exit 0, and only then starts backend. No
    # separate migration step is needed or safer than relying on that
    # dependency graph.
    if [[ "$BUILD" == true ]]; then
        info "Building images and starting the Oracle stack (this can take a while on first run)..."
        oracle_compose up -d --build
    else
        info "Starting the Oracle stack (no rebuild — pass --build to force one)..."
        oracle_compose up -d
    fi
}

main() {
    parse_arguments "$@"

    check_oracle_environment
    print_header "EduM8 Oracle — Start"

    validate_compose_config
    start_stack

    echo
    oracle_compose ps
    echo

    if [[ "$RUN_HEALTHCHECK" == true ]]; then
        info "Waiting for all services to become healthy..."
        if wait_for_oracle_health "${HEALTH_ATTEMPTS:-30}" "${HEALTH_DELAY:-5}"; then
            success "Oracle stack started and healthy."
        else
            warn "Services were started, but did not all become healthy in time."
            warn "Run: $ORACLE_SCRIPTS_DIR/oracle-healthcheck.sh"
            exit 1
        fi
    else
        warn "Skipping post-start health check (--no-healthcheck)."
        success "Oracle stack start command completed."
    fi

    if [[ "$RUN_PREWARM" == true ]]; then
        # Never fatal: a prewarm failure only produces a warning here — see
        # oracle-prewarm-model.sh's own module doc for why. It is itself a
        # no-op (exits 0 immediately) unless OLLAMA_PREWARM_ENABLED=true in
        # .env.oracle, so this call is safe to leave unconditional.
        "$ORACLE_SCRIPTS_DIR/oracle-prewarm-model.sh" \
            || warn "Model prewarm did not complete — the first real chat request will be slower (see above)."
    else
        info "Skipping Ollama model prewarm (--no-prewarm)."
    fi
}

main "$@"
