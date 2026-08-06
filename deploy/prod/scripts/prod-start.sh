#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/lib/common.sh"

check_environment
print_header

info "Starting EduM8 production services..."
compose up -d

echo
compose ps

success "Production stack started."
