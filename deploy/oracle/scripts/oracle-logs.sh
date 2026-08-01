#!/usr/bin/env bash
#
# Tails logs for the EduMind Oracle VM stack, all services by default.
#
# Adapted from deploy/prod/scripts/prod-logs.sh — extended with
# --tail/--no-follow/--timestamps flags and service-name validation.

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/common.sh"

SERVICE=""
TAIL_LINES="100"
FOLLOW=true
TIMESTAMPS=false

usage() {
    cat <<EOF_USAGE
Usage:
  $(basename "$0") [service] [options]

Follows logs for all Oracle services, or one named service.
Valid services: ${ORACLE_SERVICES[*]} backend-migrate

Options:
  --tail N         Show the last N lines before following (default: 100)
  --no-follow      Print the requested log lines and exit (no follow)
  --timestamps     Show timestamps on each log line
  -h, --help       Show this help message

Examples:
  $(basename "$0")
  $(basename "$0") backend
  $(basename "$0") backend --tail 200
  $(basename "$0") ollama --no-follow --timestamps
EOF_USAGE
}

parse_arguments() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --tail)
                [[ $# -ge 2 ]] || die "--tail requires a value"
                TAIL_LINES="$2"
                shift 2
                ;;
            --tail=*)
                TAIL_LINES="${1#*=}"
                shift
                ;;
            --no-follow)
                FOLLOW=false
                shift
                ;;
            --timestamps)
                TIMESTAMPS=true
                shift
                ;;
            -h|--help)
                usage
                exit 0
                ;;
            -*)
                die "Unknown option: $1 (see --help)"
                ;;
            *)
                if [[ -n "$SERVICE" ]]; then
                    die "Only one service may be specified (got '$SERVICE' and '$1')."
                fi
                SERVICE="$1"
                shift
                ;;
        esac
    done

    [[ "$TAIL_LINES" =~ ^[0-9]+$ ]] || die "--tail must be a non-negative integer, got: $TAIL_LINES"
}

validate_service() {
    [[ -z "$SERVICE" ]] && return 0
    oracle_service_exists "$SERVICE" \
        || die "Unknown service '$SERVICE'. Valid services: ${ORACLE_SERVICES[*]} backend-migrate"
}

main() {
    parse_arguments "$@"

    check_oracle_environment
    validate_service

    local -a compose_args=(logs "--tail=$TAIL_LINES")
    [[ "$FOLLOW" == true ]] && compose_args+=(--follow)
    [[ "$TIMESTAMPS" == true ]] && compose_args+=(--timestamps)
    [[ -n "$SERVICE" ]] && compose_args+=("$SERVICE")

    if [[ -n "$SERVICE" ]]; then
        info "Showing logs for service: $SERVICE (tail=$TAIL_LINES, follow=$FOLLOW)"
    else
        info "Showing logs for all services (tail=$TAIL_LINES, follow=$FOLLOW)"
    fi

    oracle_compose "${compose_args[@]}"
}

main "$@"
