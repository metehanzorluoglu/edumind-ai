#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/lib/common.sh"

check_environment
print_header

REMOTE="${UPDATE_REMOTE:-origin}"
BRANCH="${UPDATE_BRANCH:-main}"

DRY_RUN=false
ASSUME_YES=false
SKIP_BACKUP=false
FORCE_BUILD=false
PULL_ONLY=false
SHOW_PLAN=false

CURRENT_COMMIT=""
TARGET_COMMIT=""
CHANGED_FILES=""
REBUILD_REQUIRED=false
BACKUP_DIR=""

usage() {
    cat <<EOF_USAGE
Usage:
  $(basename "$0") [options]

Options:
  --dry-run       Show the update plan without changing production
  --yes           Skip interactive confirmation
  --skip-backup   Update without creating a backup
  --force-build   Rebuild Docker images even when not automatically required
  --pull-only     Update the Git repository without changing containers
  --show-plan     Show the deployment plan and exit
  -h, --help      Show this help message

Environment overrides:
  UPDATE_REMOTE   Git remote to deploy from; default: origin
  UPDATE_BRANCH   Git branch to deploy; default: main

Examples:
  $(basename "$0") --dry-run
  $(basename "$0")
  $(basename "$0") --yes
  $(basename "$0") --force-build
EOF_USAGE
}

parse_arguments() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --dry-run)
                DRY_RUN=true
                shift
                ;;
            --yes)
                ASSUME_YES=true
                shift
                ;;
            --skip-backup)
                SKIP_BACKUP=true
                shift
                ;;
            --force-build)
                FORCE_BUILD=true
                shift
                ;;
            --pull-only)
                PULL_ONLY=true
                shift
                ;;
            --show-plan)
                SHOW_PLAN=true
                shift
                ;;
            -h|--help)
                usage
                exit 0
                ;;
            *)
                die "Unknown option: $1"
                ;;
        esac
    done
}

require_clean_repository() {
    git -C "$REPO_ROOT" rev-parse --is-inside-work-tree \
        >/dev/null 2>&1 ||
        die "Repository not found: $REPO_ROOT"

    local current_branch
    current_branch="$(git -C "$REPO_ROOT" branch --show-current)"

    [[ "$current_branch" == "$BRANCH" ]] ||
        die "Expected branch '$BRANCH', but currently on '$current_branch'."

    if [[ -n "$(git -C "$REPO_ROOT" status --porcelain)" ]]; then
        error "The repository contains uncommitted changes:"
        git -C "$REPO_ROOT" status --short
        die "Commit, stash, or discard local changes before updating."
    fi
}

fetch_remote() {
    info "Fetching $REMOTE/$BRANCH..."

    git -C "$REPO_ROOT" fetch --prune "$REMOTE" "$BRANCH"

    CURRENT_COMMIT="$(
        git -C "$REPO_ROOT" rev-parse HEAD
    )"

    TARGET_COMMIT="$(
        git -C "$REPO_ROOT" rev-parse "$REMOTE/$BRANCH"
    )"

    success "Remote metadata fetched."
}

validate_fast_forward() {
    if [[ "$CURRENT_COMMIT" == "$TARGET_COMMIT" ]]; then
        return
    fi

    if ! git -C "$REPO_ROOT" merge-base --is-ancestor \
        "$CURRENT_COMMIT" "$TARGET_COMMIT"; then
        error "The local branch cannot be fast-forwarded to $REMOTE/$BRANCH."
        error "Current: $CURRENT_COMMIT"
        error "Target:  $TARGET_COMMIT"
        die "Resolve the Git history manually before deploying."
    fi
}

collect_changed_files() {
    if [[ "$CURRENT_COMMIT" == "$TARGET_COMMIT" ]]; then
        CHANGED_FILES=""
        return
    fi

    CHANGED_FILES="$(
        git -C "$REPO_ROOT" diff \
            --name-only \
            "$CURRENT_COMMIT..$TARGET_COMMIT"
    )"
}

detect_rebuild_requirement() {
    if [[ "$FORCE_BUILD" == true ]]; then
        REBUILD_REQUIRED=true
        return
    fi

    if [[ -z "$CHANGED_FILES" ]]; then
        REBUILD_REQUIRED=false
        return
    fi

    if grep -Eq \
        '(^|/)(Dockerfile[^/]*|docker-compose[^/]*\.ya?ml|compose[^/]*\.ya?ml|requirements[^/]*\.txt|pyproject\.toml|poetry\.lock|uv\.lock|package\.json|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|expo\.json|app\.json)$' \
        <<<"$CHANGED_FILES"; then
        REBUILD_REQUIRED=true
    else
        REBUILD_REQUIRED=false
    fi
}

short_commit() {
    local commit="$1"
    git -C "$REPO_ROOT" rev-parse --short "$commit"
}

show_update_plan() {
    echo
    echo "============================================================"
    echo "EduM8 production update plan"
    echo "============================================================"
    printf '%-22s %s\n' "Repository:" "$REPO_ROOT"
    printf '%-22s %s/%s\n' "Source:" "$REMOTE" "$BRANCH"
    printf '%-22s %s\n' "Current commit:" "$(short_commit "$CURRENT_COMMIT")"
    printf '%-22s %s\n' "Target commit:" "$(short_commit "$TARGET_COMMIT")"

    if [[ "$CURRENT_COMMIT" == "$TARGET_COMMIT" ]]; then
        printf '%-22s %s\n' "Update available:" "No"
    else
        printf '%-22s %s\n' "Update available:" "Yes"
    fi

    printf '%-22s %s\n' \
        "Backup:" \
        "$([[ "$SKIP_BACKUP" == true ]] && echo "Skipped" || echo "Required")"

    printf '%-22s %s\n' \
        "Docker rebuild:" \
        "$([[ "$REBUILD_REQUIRED" == true ]] && echo "Yes" || echo "No")"

    printf '%-22s %s\n' \
        "Container update:" \
        "$([[ "$PULL_ONLY" == true ]] && echo "No (--pull-only)" || echo "Yes")"

    if [[ -n "$CHANGED_FILES" ]]; then
        echo
        echo "Files changed:"
        while IFS= read -r file; do
            printf '  - %s\n' "$file"
        done <<<"$CHANGED_FILES"
    fi

    if [[ "$CURRENT_COMMIT" != "$TARGET_COMMIT" ]]; then
        echo
        echo "Commits to deploy:"
        git -C "$REPO_ROOT" log \
            --oneline \
            --decorate \
            "$CURRENT_COMMIT..$TARGET_COMMIT"
    fi

    echo "============================================================"
}

confirm_update() {
    if [[ "$ASSUME_YES" == true ]]; then
        warn "Confirmation skipped because --yes was provided."
        return
    fi

    echo
    read -r -p "Type UPDATE to continue: " confirmation

    [[ "$confirmation" == "UPDATE" ]] ||
        die "Production update cancelled."
}

latest_backup_directory() {
    local backup_root="${BACKUP_ROOT:-$HOME/edumind-backups}"

    find "$backup_root" \
        -mindepth 1 \
        -maxdepth 1 \
        -type d \
        -name 'edumind-backup-*' \
        -printf '%T@ %p\n' 2>/dev/null |
        sort -nr |
        head -n 1 |
        cut -d' ' -f2-
}

create_update_backup() {
    if [[ "$SKIP_BACKUP" == true ]]; then
        warn "Production backup skipped."
        return
    fi

    echo
    info "Creating verified pre-update backup..."

    "$SCRIPTS_DIR/prod-backup.sh"

    BACKUP_DIR="$(latest_backup_directory || true)"

    [[ -n "$BACKUP_DIR" ]] ||
        die "Backup completed, but its directory could not be identified."

    success "Pre-update backup: $BACKUP_DIR"
}

pull_update() {
    echo
    info "Fast-forwarding $BRANCH to $REMOTE/$BRANCH..."

    git -C "$REPO_ROOT" merge \
        --ff-only \
        "$TARGET_COMMIT"

    success "Repository updated to $(git_commit)."
}

run_migrations() {
    echo
    info "Running production database migrations..."

    compose run --rm backend-migrate

    success "Database migrations completed."
}

deploy_containers() {
    echo

    if [[ "$REBUILD_REQUIRED" == true ]]; then
        info "Building and recreating production containers..."
        compose up -d --build
    else
        info "Recreating production containers without rebuilding images..."
        compose up -d
    fi

    success "Production containers started."
}

verify_deployment() {
    echo
    info "Waiting for production services to become healthy..."

    if wait_for_health \
        "${HEALTH_ATTEMPTS:-24}" \
        "${HEALTH_DELAY:-5}"; then
        success "All production health checks passed."
        return
    fi

    error "Production did not become healthy after the update."
    error "Previous commit: $(short_commit "$CURRENT_COMMIT")"
    error "Current commit:  $(git_commit)"

    if [[ -n "$BACKUP_DIR" ]]; then
        error "Rollback backup: $BACKUP_DIR"
        error "Restore command:"
        error "$SCRIPTS_DIR/prod-restore.sh '$BACKUP_DIR'"
    fi

    return 1
}

print_summary() {
    echo
    echo "============================================================"
    echo "EduM8 production update completed"
    echo "============================================================"
    printf '%-22s %s\n' "Previous commit:" "$(short_commit "$CURRENT_COMMIT")"
    printf '%-22s %s\n' "Current commit:" "$(git_commit)"
    printf '%-22s %s\n' "Branch:" "$BRANCH"

    if [[ "$PULL_ONLY" == true ]]; then
        printf '%-22s %s\n' "Containers:" "Not changed"
    elif [[ "$REBUILD_REQUIRED" == true ]]; then
        printf '%-22s %s\n' "Docker images:" "Rebuilt"
        printf '%-22s %s\n' "Health:" "Passed"
    else
        printf '%-22s %s\n' "Docker images:" "Reused"
        printf '%-22s %s\n' "Health:" "Passed"
    fi

    if [[ -n "$BACKUP_DIR" ]]; then
        printf '%-22s %s\n' "Backup:" "$BACKUP_DIR"
    elif [[ "$SKIP_BACKUP" == true ]]; then
        printf '%-22s %s\n' "Backup:" "Skipped"
    fi

    echo "============================================================"
}

main() {
    parse_arguments "$@"
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
        success "Production repository is already up to date."

        if [[ "$DRY_RUN" != true && "$PULL_ONLY" != true ]]; then
            "$SCRIPTS_DIR/prod-healthcheck.sh"
        fi

        exit 0
    fi

    if [[ "$DRY_RUN" == true ]]; then
        echo
        success "Dry run completed. Production was not modified."
        exit 0
    fi

    confirm_update
    create_update_backup
    pull_update

    if [[ "$PULL_ONLY" == true ]]; then
        echo
        success "Repository update completed. Containers were not changed."
        print_summary
        exit 0
    fi

    run_migrations
    deploy_containers
    verify_deployment
    print_summary
}

main "$@"
