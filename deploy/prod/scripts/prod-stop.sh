#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/lib/common.sh"

check_environment
print_header

warn "Stopping EduMind production services without deleting volumes..."
compose down

success "Production stack stopped. Persistent volumes were preserved."
