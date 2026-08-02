#!/usr/bin/env bash
#
# Updates and redeploys ONLY the EduMind frontend: fetches and
# fast-forwards the configured Git branch, shows which frontend-related
# files changed, and — only when something the frontend image depends on
# actually changed (or --force-build is given) — rebuilds and recreates the
# frontend container, then verifies health and prints rollback
# instructions.
#
# Adapted from deploy/oracle/scripts/oracle-update.sh, narrowed to the
# frontend service: no pre-update volume backup (the frontend holds no
# persistent data), no database migrations, and `--no-deps` so the backend,
# Ollama, Qdrant, and backend-migrate are never restarted by a frontend
# update.

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

REMOTE="${UPDATE_REMOTE:-origin}"
BRANCH="${UPDATE_BRANCH:-main}"

DRY_RUN=false
ASSUME_YES=false
FORCE=false
FORCE_BUILD=false
PULL_ONLY=false
SHOW_PLAN=false

CURRENT_COMMIT=""
TARGET_COMMIT=""
CHANGED_FILES=""
FRONTEND_CHANGED_FILES=""
REBUILD_REQUIRED=false

usage() {
    cat <<EOF_USAGE
Usage:
  $(basename "$0") [options]

Updates the frontend deployment from $REMOTE/\$UPDATE_BRANCH: fetches the
branch, shows the current/target commits and the frontend-related changed
files, pulls (with confirmation unless --yes), then rebuilds and recreates
ONLY the '$FRONTEND_SERVICE' container — the backend, Ollama, Qdrant, and
migration services are never restarted. Prints rollback instructions.

Frontend-related paths:
$(printf '  - %s/\n' "${FRONTEND_SOURCE_PATHS[@]}")

Options:
  --dry-run       Show the update plan without changing anything
  --yes           Skip interactive confirmation
  --force         Proceed even if the working tree is dirty or the branch
                  differs from \$UPDATE_BRANCH (local changes are never
                  discarded — the fast-forward merge still refuses to lose
                  them; this only relaxes the up-front refusal)
  --force-build   Rebuild and recreate the frontend even when no
                  frontend-related files changed
  --pull-only     Update the Git repository without touching containers
  --show-plan     Show the deployment plan and exit
  -h, --help      Show this help message

Environment overrides:
  UPDATE_REMOTE   Git remote to deploy from; default: origin
  UPDATE_BRANCH   Git branch to deploy; default: main

Examples:
  $(basename "$0") --show-plan
  $(basename "$0") --dry-run
  $(basename "$0")
  $(basename "$0") --yes
  $(basename "$0") --yes --force-build
EOF_USAGE
}

parse_arguments() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --dry-run) DRY_RUN=true; shift ;;
            --yes) ASSUME_YES=true; shift ;;
            --force) FORCE=true; shift ;;
            --force-build) FORCE_BUILD=true; shift ;;
            --pull-only) PULL_ONLY=true; shift ;;
            --show-plan) SHOW_PLAN=true; shift ;;
            -h|--help) usage; exit 0 ;;
            *) die "Unknown option: $1 (see --help)" ;;
        esac
    done
}

require_clean_repository() {
    git -C "$REPO_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
        || die "Repository not found: $REPO_ROOT"

    local current_branch
    current_branch="$(git -C "$REPO_ROOT" branch --show-current)"

    if [[ "$current_branch" != "$BRANCH" ]]; then
        if [[ "$FORCE" == true ]]; then
            warn "Expected branch '$BRANCH', but currently on '$current_branch' — continuing because --force was given."
        else
            die "Expected branch '$BRANCH', but currently on '$current_branch'. Set UPDATE_BRANCH to override, or pass --force."
        fi
    fi

    if [[ -n "$(git -C "$REPO_ROOT" status --porcelain)" ]]; then
        if [[ "$FORCE" == true ]]; then
            warn "The repository has uncommitted changes — continuing because --force was given:"
            git -C "$REPO_ROOT" status --short >&2 || true
        else
            error "The repository has uncommitted changes:"
            git -C "$REPO_ROOT" status --short
            die "Commit, stash, or discard local changes before updating (or pass --force)."
        fi
    fi
}

fetch_remote() {
    info "Fetching $REMOTE/$BRANCH..."
    git -C "$REPO_ROOT" fetch --prune "$REMOTE" "$BRANCH"

    CURRENT_COMMIT="$(git -C "$REPO_ROOT" rev-parse HEAD)"
    TARGET_COMMIT="$(git -C "$REPO_ROOT" rev-parse "$REMOTE/$BRANCH")"

    success "Remote metadata fetched."
}

validate_fast_forward() {
    [[ "$CURRENT_COMMIT" == "$TARGET_COMMIT" ]] && return

    git -C "$REPO_ROOT" merge-base --is-ancestor "$CURRENT_COMMIT" "$TARGET_COMMIT" \
        || die "Local branch cannot fast-forward to $REMOTE/$BRANCH (current=$CURRENT_COMMIT target=$TARGET_COMMIT). Resolve Git history manually."
}

collect_changed_files() {
    if [[ "$CURRENT_COMMIT" == "$TARGET_COMMIT" ]]; then
        CHANGED_FILES=""
        FRONTEND_CHANGED_FILES=""
        return
    fi
    CHANGED_FILES="$(git -C "$REPO_ROOT" diff --name-only "$CURRENT_COMMIT..$TARGET_COMMIT")"

    # Keep only the paths a frontend rebuild actually depends on (see
    # deploy/frontend/Dockerfile's build stages).
    local path pattern=""
    for path in "${FRONTEND_SOURCE_PATHS[@]}"; do
        pattern="${pattern:+$pattern|}^${path}/"
    done
    FRONTEND_CHANGED_FILES="$(grep -E "$pattern" <<<"$CHANGED_FILES" || true)"
}

# The frontend image is a static export baked at build time, so ANY changed
# frontend-related file requires a rebuild; if nothing frontend-related
# changed, the pull needs no container work at all (unless --force-build).
detect_rebuild_requirement() {
    if [[ "$FORCE_BUILD" == true ]]; then
        REBUILD_REQUIRED=true
        return
    fi
    if [[ -n "$FRONTEND_CHANGED_FILES" ]]; then
        REBUILD_REQUIRED=true
    else
        REBUILD_REQUIRED=false
    fi
}

short_commit() {
    git -C "$REPO_ROOT" rev-parse --short "$1"
}

show_update_plan() {
    echo
    echo "============================================================"
    echo "EduMind frontend update plan"
    echo "============================================================"
    printf '%-26s %s\n' "Repository:" "$REPO_ROOT"
    printf '%-26s %s/%s\n' "Source:" "$REMOTE" "$BRANCH"
    printf '%-26s %s\n' "Current commit:" "$(short_commit "$CURRENT_COMMIT")"
    printf '%-26s %s\n' "Target commit:" "$(short_commit "$TARGET_COMMIT")"

    if [[ "$CURRENT_COMMIT" == "$TARGET_COMMIT" ]]; then
        printf '%-26s %s\n' "Update available:" "No"
    else
        printf '%-26s %s\n' "Update available:" "Yes"
    fi

    printf '%-26s %s\n' "Frontend files changed:" "$([[ -n "$FRONTEND_CHANGED_FILES" ]] && echo "Yes" || echo "No")"
    printf '%-26s %s\n' "Frontend rebuild:" "$([[ "$REBUILD_REQUIRED" == true ]] && echo "Yes" || echo "No")"
    printf '%-26s %s\n' "Container update:" "$([[ "$PULL_ONLY" == true ]] && echo "No (--pull-only)" || echo "Yes")"
    printf '%-26s %s\n' "Other services:" "Not touched (frontend only)"

    if [[ -n "$FRONTEND_CHANGED_FILES" ]]; then
        echo
        echo "Frontend-related changed files:"
        while IFS= read -r file; do
            printf '  - %s\n' "$file"
        done <<<"$FRONTEND_CHANGED_FILES"
    fi

    if [[ -n "$CHANGED_FILES" && -z "$FRONTEND_CHANGED_FILES" ]]; then
        echo
        echo "Changed files (none frontend-related — no frontend rebuild necessary):"
        while IFS= read -r file; do
            printf '  - %s\n' "$file"
        done <<<"$CHANGED_FILES"
    fi

    if [[ "$CURRENT_COMMIT" != "$TARGET_COMMIT" ]]; then
        echo
        echo "Commits to deploy:"
        git -C "$REPO_ROOT" log --oneline --decorate "$CURRENT_COMMIT..$TARGET_COMMIT"
    fi

    echo "============================================================"
}

confirm_update() {
    confirm_phrase "UPDATE" "$ASSUME_YES"
}

pull_update() {
    echo
    info "Fast-forwarding to $REMOTE/$BRANCH..."
    git -C "$REPO_ROOT" merge --ff-only "$TARGET_COMMIT"
    success "Repository updated to $(git_commit_short)."
}

validate_compose_after_pull() {
    info "Validating Compose configuration after pull..."
    frontend_compose config --quiet \
        || die "docker compose config validation failed after pulling new code."
}

deploy_frontend() {
    echo
    if [[ "$REBUILD_REQUIRED" == true ]]; then
        info "Rebuilding and recreating ONLY the frontend container (--no-deps)..."
        frontend_compose up -d --build --force-recreate --no-deps "$FRONTEND_SERVICE"
    else
        # Unreachable unless flags change: detect_rebuild_requirement only
        # lets execution reach deployment when a rebuild is required.
        info "Recreating the frontend container without rebuilding..."
        frontend_compose up -d --force-recreate --no-deps "$FRONTEND_SERVICE"
    fi
    success "Frontend container recreated."
}

print_rollback_instructions() {
    local previous="$1"
    echo
    info "Rollback instructions (previous commit: $(short_commit "$previous")):"
    echo "  git -C '$REPO_ROOT' reset --hard $previous"
    echo "  $FRONTEND_SCRIPTS_DIR/frontend-restart.sh --build"
}

verify_deployment() {
    echo
    info "Waiting for the frontend to become healthy at $FRONTEND_URL (/health and /)..."

    if wait_for_frontend_health "${HEALTH_ATTEMPTS:-24}" "${HEALTH_DELAY:-5}"; then
        success "Frontend health checks passed."
        return
    fi

    error "Frontend deployment did not become healthy after the update."
    error "Previous commit: $(short_commit "$CURRENT_COMMIT")"
    error "Current commit:  $(git_commit_short)"
    print_rollback_instructions "$CURRENT_COMMIT"

    return 1
}

print_summary() {
    echo
    echo "============================================================"
    echo "EduMind frontend update completed"
    echo "============================================================"
    printf '%-26s %s\n' "Previous commit:" "$(short_commit "$CURRENT_COMMIT")"
    printf '%-26s %s\n' "Current commit:" "$(git_commit_short)"
    printf '%-26s %s\n' "Branch:" "$BRANCH"

    if [[ "$PULL_ONLY" == true ]]; then
        printf '%-26s %s\n' "Frontend container:" "Not changed"
    elif [[ "$REBUILD_REQUIRED" == true ]]; then
        printf '%-26s %s\n' "Frontend image:" "Rebuilt"
        printf '%-26s %s\n' "Health:" "Passed"
    fi
    printf '%-26s %s\n' "Other services:" "Not touched"
    echo "============================================================"
}

main() {
    parse_arguments "$@"
    check_frontend_environment
    print_header "EduMind Frontend — Update"

    require_clean_repository
    fetch_remote
    validate_fast_forward
    collect_changed_files
    detect_rebuild_requirement
    show_update_plan

    if [[ "$SHOW_PLAN" == true ]]; then
        success "Update plan displayed. No deployment changes were made."
        exit 0
    fi

    if [[ "$CURRENT_COMMIT" == "$TARGET_COMMIT" ]]; then
        success "Frontend deployment is already up to date."
        exit 0
    fi

    if [[ "$DRY_RUN" == true ]]; then
        echo
        success "Dry run completed. The frontend deployment was not modified."
        exit 0
    fi

    confirm_update
    pull_update

    if [[ "$PULL_ONLY" == true ]]; then
        echo
        success "Repository update completed. The frontend container was not changed."
        print_summary
        exit 0
    fi

    if [[ "$REBUILD_REQUIRED" != true ]]; then
        echo
        success "No frontend-related files changed in this update — no frontend rebuild is necessary."
        print_summary
        exit 0
    fi

    validate_compose_after_pull
    deploy_frontend
    verify_deployment
    print_summary
    print_rollback_instructions "$CURRENT_COMMIT"
}

main "$@"
