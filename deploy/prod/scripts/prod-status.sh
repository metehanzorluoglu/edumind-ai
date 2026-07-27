#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/lib/common.sh"

check_environment

print_header

info "Docker Services"
echo
compose ps
echo

echo "------------------------------------------------------------"
echo

info "Backend Health"
if backend_health; then
    echo
else
    warn "Backend is not reachable."
fi

echo
echo "------------------------------------------------------------"
echo

info "Authentication"
if providers; then
    echo
else
    warn "Authentication endpoint is unavailable."
fi

echo
echo "------------------------------------------------------------"
echo

info "Frontend"

if frontend_health; then
    success "Frontend is reachable."
else
    warn "Frontend is not reachable."
fi
