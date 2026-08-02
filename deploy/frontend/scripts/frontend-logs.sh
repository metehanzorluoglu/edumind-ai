#!/usr/bin/env bash
#
# Shows logs for the EduMind frontend container only — follows by default.
#
# Adapted from deploy/oracle/scripts/oracle-logs.sh, narrowed to the single
# frontend service (no service argument) and extended with --since.

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

TAIL_LINES="100"
FOLLOW=true
TIMESTAMPS=false
SINCE=""

usage() {
    cat <<EOF_USAGE
Usage:
  $(basename "$0") [options]

Follows logs for the '$FRONTEND_SERVICE' service ($FRONTEND_CONTAINER_NAME).

Options:
  --tail N         Show the last N lines before following (default: 100;
                   0 shows the full available log)
  --no-follow      Print the requested log lines and exit (no follow)
  --timestamps     Show timestamps on each log line
  --since DURATION Only show logs newer than a duration (e.g. 10m, 1h30m)
  -h, --help       Show this help message

Examples:
  $(basename "$0")
  $(basename "$0") --tail 200
  $(basename "$0") --tail 0 --timestamps
  $(basename "$0") --no-follow
  $(basename "$0") --since 10m
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
            --since)
                [[ $# -ge 2 ]] || die "--since requires a value"
                SINCE="$2"
                shift 2
                ;;
            --since=*)
                SINCE="${1#*=}"
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

    [[ "$TAIL_LINES" =~ ^[0-9]+$ ]] || die "--tail must be a non-negative integer, got: $TAIL_LINES"
}

require_frontend_container() {
    local container_id status
    container_id="$(frontend_container_id)"

    if [[ -z "$container_id" ]]; then
        die "No '$FRONTEND_SERVICE' container exists in project '$FRONTEND_PROJECT_NAME'. Start it with: $FRONTEND_SCRIPTS_DIR/frontend-start.sh"
    fi

    status="$(frontend_container_status "$container_id")"
    if [[ "$status" != "running" ]]; then
        die "The frontend container ($(frontend_container_name "$container_id")) is not running (status: $status). Start it with: $FRONTEND_SCRIPTS_DIR/frontend-start.sh"
    fi
}

main() {
    parse_arguments "$@"

    check_frontend_environment
    require_frontend_container

    local -a compose_args=(logs "--tail=$TAIL_LINES")
    [[ "$FOLLOW" == true ]] && compose_args+=(--follow)
    [[ "$TIMESTAMPS" == true ]] && compose_args+=(--timestamps)
    [[ -n "$SINCE" ]] && compose_args+=(--since "$SINCE")
    compose_args+=("$FRONTEND_SERVICE")

    info "Showing logs for service: $FRONTEND_SERVICE (tail=$TAIL_LINES, follow=$FOLLOW${SINCE:+, since=$SINCE})"

    frontend_compose "${compose_args[@]}"
}

main "$@"
