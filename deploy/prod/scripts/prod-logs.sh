#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/lib/common.sh"

check_environment
print_header

SERVICE="${1:-}"
TAIL_LINES="${TAIL_LINES:-100}"

if [[ -n "$SERVICE" ]]; then
    info "Following logs for service: $SERVICE"
    compose logs --follow --tail="$TAIL_LINES" "$SERVICE"
else
    info "Following logs for all services"
    compose logs --follow --tail="$TAIL_LINES"
fi
