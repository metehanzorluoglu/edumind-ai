#!/usr/bin/env bash
#
# Displays a full status dashboard for the EduMind Oracle VM stack.
#
# Adapted from deploy/prod/scripts/prod-status.sh — extended with Ollama
# loaded-model info, host memory/swap, Docker disk usage, effective
# (secret-free) model configuration, and Git branch/commit. A service that
# is still starting is reported, never treated as a fatal error — this
# script always exits 0 so it is safe to run at any point in the startup
# sequence.

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/common.sh"

usage() {
    cat <<EOF_USAGE
Usage:
  $(basename "$0") [options]

Shows container status, backend/frontend reachability, loaded Ollama
models, host memory/disk summary, effective (non-secret) model
configuration, and the current Git branch/commit. Never fails just
because a service is still starting.

Options:
  -h, --help    Show this help message
EOF_USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
    usage
    exit 0
fi

# Only non-secret keys are ever read/printed from $ORACLE_ENV_FILE — see
# common.sh's redact_notice(). Never add JWT_SECRET, *_CLIENT_SECRET, or
# any credential to this list.
SAFE_CONFIG_KEYS=(
    APP_ENV
    OLLAMA_LLM_MODEL
    OLLAMA_VISION_MODEL
    OLLAMA_EMBED_MODEL
    VISION_ENABLED
    OLLAMA_THINKING_ENABLED
    OLLAMA_NUM_PREDICT
    OLLAMA_PREWARM_ENABLED
    EMBEDDING_BATCH_SIZE
    QDRANT_COLLECTION_NAME
    QDRANT_MODE
    AUTH_DEV_LOGIN_ENABLED
    RETRIEVAL_TOP_K
    FRONTEND_PORT
)

print_effective_config() {
    local key value
    for key in "${SAFE_CONFIG_KEYS[@]}"; do
        value="$(grep -E "^${key}=" "$ORACLE_ENV_FILE" 2>/dev/null | tail -n1 | cut -d'=' -f2- || true)"
        if [[ -n "$value" ]]; then
            printf '  %-24s %s\n' "$key" "$value"
        else
            printf '  %-24s %s\n' "$key" "(unset — using app default)"
        fi
    done
}

main() {
    check_oracle_environment
    print_header "EduMind Oracle — Status"

    print_section "Docker Compose services"
    oracle_compose ps || warn "Could not list Compose services."

    print_section "Backend /health"
    if oracle_backend_health; then
        echo
    else
        warn "Backend is not reachable yet."
    fi

    print_section "Backend /health/ready"
    if oracle_backend_ready; then
        echo
    else
        warn "Backend readiness endpoint is not reachable yet."
    fi

    print_section "Authentication providers"
    if oracle_auth_providers; then
        echo
    else
        warn "Authentication endpoint is not reachable yet."
    fi

    print_section "Frontend"
    if oracle_frontend_health; then
        success "Frontend is reachable at $ORACLE_FRONTEND_URL"
    else
        warn "Frontend is not reachable yet."
    fi

    print_section "Ollama loaded models (ollama ps)"
    if ! oracle_ollama_ps; then
        warn "Could not query Ollama (container starting or unreachable)."
    fi

    print_section "Host memory and swap"
    free -h || warn "Could not read host memory summary."

    print_section "Docker disk usage"
    docker system df || warn "Could not read Docker disk usage."

    print_section "Effective model configuration (secrets never shown)"
    print_effective_config

    print_section "Git"
    printf '  %-24s %s\n' "Branch" "$(git_branch)"
    printf '  %-24s %s\n' "Commit" "$(git_commit_short)"

    echo
    success "Status report complete."
}

main "$@"
