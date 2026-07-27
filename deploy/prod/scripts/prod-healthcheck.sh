#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/lib/common.sh"

check_environment
print_header

FAILURES=0

check_service() {
    local service="$1"
    local container_id
    local status
    local health

    container_id="$(compose ps -q "$service")"

    if [[ -z "$container_id" ]]; then
        error "$service container does not exist."
        FAILURES=$((FAILURES + 1))
        return
    fi

    status="$(docker inspect \
        --format '{{.State.Status}}' \
        "$container_id")"

    health="$(docker inspect \
        --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' \
        "$container_id")"

    if [[ "$status" != "running" ]]; then
        error "$service is not running. Status: $status"
        FAILURES=$((FAILURES + 1))
        return
    fi

    if [[ "$health" == "unhealthy" ]]; then
        error "$service is unhealthy."
        FAILURES=$((FAILURES + 1))
        return
    fi

    if [[ "$health" == "starting" ]]; then
        warn "$service health check is still starting."
        return
    fi

    success "$service is running; health=$health"
}

info "Checking containers"
check_service backend
check_service frontend
check_service qdrant
check_service ollama

echo
info "Checking backend API"

if backend_health >/dev/null; then
    success "Backend API is reachable."
else
    error "Backend API health check failed."
    FAILURES=$((FAILURES + 1))
fi

echo
info "Checking authentication endpoint"

if providers >/dev/null; then
    success "Authentication endpoint is reachable."
else
    error "Authentication endpoint check failed."
    FAILURES=$((FAILURES + 1))
fi

echo
info "Checking frontend"

if frontend_health; then
    success "Frontend is reachable."
else
    error "Frontend health check failed."
    FAILURES=$((FAILURES + 1))
fi

echo
if (( FAILURES > 0 )); then
    die "Health check failed with $FAILURES error(s)."
fi

success "All production health checks passed."
