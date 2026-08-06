#!/usr/bin/env bash
#
# Comprehensive health check for the EduM8 Oracle VM stack.
#
# Adapted from deploy/prod/scripts/prod-healthcheck.sh — extended with
# published-port checks, migration-completion verification, and configured
# Ollama model availability. Exits non-zero if anything is unhealthy, with
# concise, actionable error messages (never a bare stack trace).

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/common.sh"

usage() {
    cat <<EOF_USAGE
Usage:
  $(basename "$0") [options]

Checks container status, Docker health, backend/frontend HTTP endpoints,
published ports, the backend-migrate job, and configured Ollama model
availability. Prints a report and exits non-zero if anything failed.

Options:
  -h, --help    Show this help message
EOF_USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
    usage
    exit 0
fi

FAILURES=0
fail() {
    error "$*"
    FAILURES=$((FAILURES + 1))
}

check_environment_quiet() {
    # A lighter check than check_oracle_environment: healthcheck should
    # itself report a clear failure rather than dying on a missing
    # prerequisite, since callers (oracle-start.sh etc.) treat a non-zero
    # exit here as "not healthy yet", not as a hard crash.
    require_command curl
    require_command docker
    require_command jq
    docker compose version >/dev/null 2>&1 || die "Docker Compose v2 plugin is not available."
    require_file "$ORACLE_COMPOSE_FILE" "Oracle Compose file"
    require_file "$ORACLE_ENV_FILE" "Oracle environment file"
    docker info >/dev/null 2>&1 || die "Docker daemon is not reachable."
}

################################################################################
# 1. Container running + Docker health status
################################################################################

check_container() {
    local service="$1"
    local container_id
    container_id="$(oracle_container_id "$service")"

    if [[ -z "$container_id" ]]; then
        fail "$service: container does not exist. Run: $ORACLE_SCRIPTS_DIR/oracle-start.sh"
        return
    fi

    local status health
    status="$(oracle_container_status "$container_id")"
    health="$(oracle_container_health "$container_id")"

    if [[ "$status" != "running" ]]; then
        fail "$service: not running (status=$status). Check: $ORACLE_SCRIPTS_DIR/oracle-logs.sh $service"
        return
    fi

    case "$health" in
        healthy|none)
            success "$service: running (health=$health)"
            ;;
        starting)
            warn "$service: still starting (health=starting) — not yet a failure, retry shortly."
            ;;
        unhealthy)
            fail "$service: unhealthy. Check: $ORACLE_SCRIPTS_DIR/oracle-logs.sh $service --tail 50"
            ;;
        *)
            warn "$service: unknown health state '$health'."
            ;;
    esac
}

################################################################################
# 2. Backend / frontend HTTP endpoints
################################################################################

check_http_endpoints() {
    if oracle_backend_health >/dev/null 2>&1; then
        success "backend /health: reachable"
    else
        fail "backend /health: unreachable. Check: $ORACLE_SCRIPTS_DIR/oracle-logs.sh backend --tail 50"
    fi

    local ready_json
    if ready_json="$(oracle_backend_ready 2>/dev/null)"; then
        local ready_status
        ready_status="$(echo "$ready_json" | jq -r '.status // "unknown"')"
        if [[ "$ready_status" == "ready" ]]; then
            success "backend /health/ready: ready"
        else
            fail "backend /health/ready: status=$ready_status (Ollama/Qdrant/model not fully ready yet)"
        fi
    else
        fail "backend /health/ready: unreachable."
    fi

    if oracle_auth_providers >/dev/null 2>&1; then
        success "backend /auth/providers: reachable"
    else
        fail "backend /auth/providers: unreachable."
    fi

    if oracle_frontend_health >/dev/null 2>&1; then
        success "frontend /health: reachable"
    else
        fail "frontend /health: unreachable. Check: $ORACLE_SCRIPTS_DIR/oracle-logs.sh frontend --tail 50"
    fi

    echo "$ready_json" > /tmp/.oracle-healthcheck-ready.json 2>/dev/null || true
}

################################################################################
# 3. Published ports
################################################################################

check_published_port() {
    local service="$1"
    local container_port="$2"
    local label="$3"

    local mapping
    mapping="$(oracle_compose port "$service" "$container_port" 2>/dev/null || true)"

    if [[ -z "$mapping" ]]; then
        fail "$label: no published port mapping found for $service:$container_port."
        return
    fi

    local host_port="${mapping##*:}"

    # The TCP probe (open+immediately close fd 3) runs entirely inside this
    # subshell, so there is nothing left to close in the parent shell
    # afterward regardless of which branch runs.
    if (exec 3<>"/dev/tcp/127.0.0.1/$host_port") 2>/dev/null; then
        success "$label: port $host_port is accepting connections"
    else
        fail "$label: port $host_port is not accepting connections (mapping: $mapping)"
    fi
}

################################################################################
# 4. backend-migrate completion
################################################################################

check_migration() {
    local container_id
    container_id="$(oracle_container_id backend-migrate)"

    if [[ -z "$container_id" ]]; then
        warn "backend-migrate: no container found (may have been pruned after a prior successful run; not a failure by itself)."
        return
    fi

    local exit_code
    exit_code="$(docker inspect --format '{{.State.ExitCode}}' "$container_id" 2>/dev/null || echo "unknown")"
    local status
    status="$(oracle_container_status "$container_id")"

    if [[ "$status" == "running" ]]; then
        warn "backend-migrate: still running — migrations in progress."
        return
    fi

    if [[ "$exit_code" == "0" ]]; then
        success "backend-migrate: completed successfully (exit 0)"
    else
        fail "backend-migrate: exited with code $exit_code. Check: $ORACLE_SCRIPTS_DIR/oracle-logs.sh backend-migrate --no-follow"
    fi
}

################################################################################
# 5. Configured Ollama models available
################################################################################

REQUIRED_MODELS=("qwen3:8b" "qwen2.5vl:7b" "mxbai-embed-large")

check_models() {
    local ready_json=""
    [[ -f /tmp/.oracle-healthcheck-ready.json ]] && ready_json="$(cat /tmp/.oracle-healthcheck-ready.json)"
    rm -f /tmp/.oracle-healthcheck-ready.json 2>/dev/null || true

    local ollama_list
    if ! ollama_list="$(oracle_ollama_models 2>/dev/null)"; then
        fail "Could not list Ollama models (is the ollama container healthy?)."
        return
    fi

    local model available_in_ready
    for model in "${REQUIRED_MODELS[@]}"; do
        if grep -qF "$model" <<<"$ollama_list"; then
            success "model available: $model"
        else
            fail "model NOT available: $model — run: docker compose -f $ORACLE_COMPOSE_FILE --env-file $ORACLE_ENV_FILE exec ollama ollama pull $model"
            continue
        fi

        if [[ -n "$ready_json" ]]; then
            available_in_ready="$(echo "$ready_json" | jq -r --arg m "$model" '.models_available[$m] // empty')"
            if [[ "$available_in_ready" == "false" ]]; then
                warn "$model is pulled but backend readiness reports it unavailable — check OLLAMA_BASE_URL/model name spelling in .env.oracle."
            fi
        fi
    done
}

################################################################################
# Main
################################################################################

main() {
    check_environment_quiet
    print_header "EduM8 Oracle — Health Check"

    print_section "Containers"
    for service in "${ORACLE_SERVICES[@]}"; do
        check_container "$service"
    done

    print_section "HTTP endpoints"
    check_http_endpoints

    print_section "Published ports"
    check_published_port backend 8000 "backend:8000"
    check_published_port frontend 80 "frontend:8080"

    print_section "Database migration"
    check_migration

    print_section "Configured Ollama models"
    check_models

    echo
    if (( FAILURES > 0 )); then
        die "Health check failed with $FAILURES issue(s). See messages above for exact next steps."
    fi

    success "All Oracle health checks passed."
}

main "$@"
