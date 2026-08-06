#!/usr/bin/env bash
#
# Displays a full status dashboard for the EduM8 frontend service.
#
# Adapted from deploy/oracle/scripts/oracle-status.sh, focused entirely on
# the frontend: container/image/health details, HTTP checks against the
# published test port (including gzip and cache headers for a hashed JS
# asset when one can be identified), resource usage, and Git freshness
# relative to the built image. A frontend that is still starting is
# reported, never treated as a fatal error — this script always exits 0.

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

usage() {
    cat <<EOF_USAGE
Usage:
  $(basename "$0") [options]

Shows the frontend container's Compose status, image, health, restart
count, ports, HTTP checks (/health, /, response headers, gzip + cache
headers for a JavaScript asset), CPU/memory usage, image size, the current
Git branch/commit, working-tree drift in frontend-related paths, and
whether the running image predates the latest frontend source change.
Never fails just because the frontend is still starting.

Options:
  -h, --help    Show this help message
EOF_USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
    usage
    exit 0
fi

CONTAINER_ID=""
IMAGE_NAME=""

print_container_details() {
    print_section "Docker Compose service"
    frontend_compose ps "$FRONTEND_SERVICE" || warn "Could not list the Compose service."

    print_section "Container"
    CONTAINER_ID="$(frontend_container_id)"
    if [[ -z "$CONTAINER_ID" ]]; then
        warn "No '$FRONTEND_SERVICE' container exists in project '$FRONTEND_PROJECT_NAME'."
        info "Start it with: $FRONTEND_SCRIPTS_DIR/frontend-start.sh"
        return
    fi

    local status health restart_count
    status="$(frontend_container_status "$CONTAINER_ID")"
    health="$(frontend_container_health "$CONTAINER_ID")"
    restart_count="$(docker inspect --format '{{.RestartCount}}' "$CONTAINER_ID" 2>/dev/null || echo "unknown")"
    IMAGE_NAME="$(docker inspect --format '{{.Config.Image}}' "$CONTAINER_ID" 2>/dev/null || echo "unknown")"

    printf '  %-24s %s\n' "Container ID" "${CONTAINER_ID:0:12}"
    printf '  %-24s %s\n' "Container name" "$(frontend_container_name "$CONTAINER_ID")"
    printf '  %-24s %s\n' "Image" "$IMAGE_NAME"
    printf '  %-24s %s\n' "State" "$status"
    printf '  %-24s %s\n' "Health" "$health"
    printf '  %-24s %s\n' "Restart count" "$restart_count"

    echo
    echo "  Published ports:"
    docker port "$CONTAINER_ID" 2>/dev/null | sed 's/^/    /' || warn "  Could not read published ports."
}

print_http_checks() {
    print_section "Frontend HTTP checks ($FRONTEND_URL)"

    if frontend_health_endpoint; then
        success "/health responded (200)."
    else
        warn "/health is not reachable yet."
    fi

    local root_code
    root_code="$(curl --silent --output /dev/null --write-out '%{http_code}' \
        --connect-timeout 3 --max-time 10 "$FRONTEND_URL/" 2>/dev/null || echo "000")"
    if [[ "$root_code" == "200" ]]; then
        success "/ responded with HTTP $root_code."
    else
        warn "/ responded with HTTP $root_code (frontend still starting, or not published on this port?)."
    fi

    echo
    echo "  Response headers for /:"
    curl --silent --head --connect-timeout 3 --max-time 10 "$FRONTEND_URL/" 2>/dev/null \
        | sed 's/^/    /' || warn "  Could not fetch headers for /."
}

print_asset_cache_checks() {
    print_section "Static asset gzip + cache verification"

    local html asset
    html="$(curl --silent --connect-timeout 3 --max-time 10 "$FRONTEND_URL/" 2>/dev/null || true)"
    if [[ -z "$html" ]]; then
        warn "Could not fetch the root page — skipping asset checks."
        return
    fi

    # Expo web exports reference hashed bundles under /_expo/static/js/.
    # Take the first one found; the exact hash changes on every build.
    asset="$(grep -oE '_expo/static/js/[^"'"'"' ]+\.js' <<<"$html" | head -n1 || true)"
    if [[ -z "$asset" ]]; then
        warn "No JavaScript asset reference found in index.html — skipping gzip verification."
        return
    fi

    info "Checking asset: /$asset"

    local headers encoding cache
    headers="$(curl --silent --head --connect-timeout 3 --max-time 10 \
        --header 'Accept-Encoding: gzip' "$FRONTEND_URL/$asset" 2>/dev/null || true)"
    if [[ -z "$headers" ]]; then
        warn "Could not fetch headers for the asset."
        return
    fi

    encoding="$(grep -i '^content-encoding:' <<<"$headers" | head -n1 || true)"
    # nginx sends TWO Cache-Control headers here — max-age from `expires 1y`
    # and "public, immutable" from add_header (see nginx.conf) — so all of
    # them must be inspected, not just the first.
    cache="$(grep -i '^cache-control:' <<<"$headers" || true)"

    if [[ -n "$encoding" ]]; then
        success "gzip active for the JS asset ($encoding)."
    else
        warn "No Content-Encoding header on the JS asset — gzip may not be applied."
    fi

    if [[ -n "$cache" ]]; then
        while IFS= read -r line; do
            printf '    %s\n' "$line"
        done <<<"$cache"
        if grep -qi 'immutable' <<<"$cache"; then
            success "Immutable long-lived caching is set for the hashed asset."
        else
            warn "Cache-Control on the hashed asset is not immutable."
        fi
    else
        warn "No Cache-Control header on the hashed asset."
    fi

    echo
    echo "  index.html cache headers (must NOT be immutable):"
    curl --silent --head --connect-timeout 3 --max-time 10 "$FRONTEND_URL/" 2>/dev/null \
        | grep -i '^cache-control:' | sed 's/^/    /' \
        || echo "    (no Cache-Control header on index.html — browser-default caching applies)"
}

print_resource_usage() {
    print_section "Resource usage"
    [[ -z "$CONTAINER_ID" ]] && { warn "No frontend container — skipping."; return; }

    docker stats --no-stream --format \
        'table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}' \
        "$CONTAINER_ID" 2>/dev/null || warn "Could not read container stats."

    if [[ -n "$IMAGE_NAME" && "$IMAGE_NAME" != "unknown" ]]; then
        local image_id size_bytes
        image_id="$(docker image inspect --format '{{.Id}}' "$IMAGE_NAME" 2>/dev/null || true)"
        if [[ -n "$image_id" ]]; then
            size_bytes="$(docker image inspect --format '{{.Size}}' "$image_id" 2>/dev/null || true)"
            if [[ -n "$size_bytes" ]]; then
                printf '  %-24s %s\n' "Image size" "$(numfmt --to=iec --suffix=B "$size_bytes" 2>/dev/null || echo "$size_bytes bytes")"
            fi
        fi
    fi
}

print_git_status() {
    print_section "Git"
    printf '  %-24s %s\n' "Branch" "$(git_branch)"
    printf '  %-24s %s\n' "Commit" "$(git_commit_short)"

    echo
    echo "  Frontend-related working-tree drift vs the current commit:"
    local drift
    drift="$(git -C "$REPO_ROOT" status --porcelain -- "${FRONTEND_SOURCE_PATHS[@]}" 2>/dev/null || true)"
    if [[ -n "$drift" ]]; then
        warn "Frontend source files differ from the current commit:"
        while IFS= read -r line; do
            printf '    %s\n' "$line"
        done <<<"$drift"
    else
        success "No uncommitted changes in frontend-related paths."
    fi
}

# Compares the running image's creation time with the commit date of the
# most recent commit that touched a frontend-related path. Only committed
# history is considered (working-tree file mtimes are not authoritative in
# a checkout). Reported best-effort — "unknown" whenever either side cannot
# be determined.
print_image_freshness() {
    print_section "Image freshness vs frontend source"
    [[ -z "$CONTAINER_ID" || -z "$IMAGE_NAME" || "$IMAGE_NAME" == "unknown" ]] \
        && { warn "No running frontend image to compare."; return; }

    local image_created_iso image_epoch source_epoch source_iso
    image_created_iso="$(docker image inspect --format '{{.Created}}' "$IMAGE_NAME" 2>/dev/null || true)"
    image_epoch="$(date -d "$image_created_iso" +%s 2>/dev/null || true)"
    source_iso="$(git -C "$REPO_ROOT" log -1 --format=%cI -- "${FRONTEND_SOURCE_PATHS[@]}" 2>/dev/null || true)"
    source_epoch="$(date -d "$source_iso" +%s 2>/dev/null || true)"

    if [[ -z "$image_epoch" || -z "$source_epoch" ]]; then
        warn "Could not determine both timestamps image creation (${image_created_iso:-unknown}) and latest frontend commit (${source_iso:-unknown}) — comparison not possible."
        return
    fi

    printf '  %-24s %s\n' "Image built" "$image_created_iso"
    printf '  %-24s %s\n' "Latest frontend commit" "$source_iso"

    if (( image_epoch < source_epoch )); then
        warn "The running image was built BEFORE the latest frontend source change — it may be stale. Rebuild: $FRONTEND_SCRIPTS_DIR/frontend-restart.sh --build"
    else
        success "The running image was built at or after the latest frontend source change."
    fi
}

main() {
    check_frontend_environment
    print_header "EduM8 Frontend — Status"

    print_container_details
    print_http_checks
    print_asset_cache_checks
    print_resource_usage
    print_git_status
    print_image_freshness

    echo
    success "Frontend status report complete."
}

main "$@"
