#!/usr/bin/env bash
#
# Preloads the chat LLM (OLLAMA_LLM_MODEL, default qwen3:8b) into Ollama's
# memory with a minimal request, so the *first real user chat turn* doesn't
# pay Ollama's cold-load cost on top of prompt evaluation and generation.
#
# Background: on the Oracle CPU-only host, a cold qwen3:8b load alone was
# measured at ~44s, and the frontend had no way to distinguish "loading"
# from "hung" during that wait before this session's SSE progress-events
# fix (see ChatProgressEvent in app/schemas/chat.py). Prewarming at
# deployment/startup time moves that fixed cost out of the user-facing
# critical path for the very first chat after a (re)start — it does not
# help subsequent cold-loads if OLLAMA_KEEP_ALIVE expires from inactivity.
#
# Deliberately opt-in (OLLAMA_PREWARM_ENABLED=true) and deliberately
# non-fatal on failure — see main()'s final exit-code handling and
# oracle-start.sh's call site: a prewarm failure must never block startup,
# since a normal (slower) first user request still works via the same code
# path this script exercises.
#
# Runs the actual chat request inside the *backend* container (not this
# host), reusing its already-installed `ollama` Python package,
# OLLAMA_BASE_URL, and OLLAMA_LLM_MODEL — the exact same client class and
# network path a real request uses (see app/core/llm_provider.py), so a
# successful prewarm is a genuine guarantee the model can be reached and
# loaded, not a separate/parallel code path that could pass while the real
# one fails.

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/common.sh"

FORCE=false
TIMEOUT_SECONDS="${OLLAMA_PREWARM_TIMEOUT_SECONDS:-180}"

usage() {
    cat <<EOF_USAGE
Usage:
  $(basename "$0") [options]

Sends a single minimal chat request (think=false, num_predict=1, output
discarded) to the backend's configured Ollama model, so it is already
loaded into memory before the first real user request arrives. A no-op
that exits 0 unless OLLAMA_PREWARM_ENABLED=true in .env.oracle (or
--force is given). Never treated as fatal by oracle-start.sh: a failed
prewarm only produces a warning, never blocks startup — the normal chat
path works fine without it, just slower for the first request.

Options:
  --force                 Run even if OLLAMA_PREWARM_ENABLED is not true
  --timeout-seconds N     Max seconds to wait for the prewarm request
                           (default: 180, or \$OLLAMA_PREWARM_TIMEOUT_SECONDS)
  -h, --help               Show this help message

Examples:
  $(basename "$0")
  $(basename "$0") --force
  $(basename "$0") --force --timeout-seconds 300
EOF_USAGE
}

parse_arguments() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --force)
                FORCE=true
                shift
                ;;
            --timeout-seconds)
                [[ $# -ge 2 ]] || die "--timeout-seconds requires a value"
                TIMEOUT_SECONDS="$2"
                shift 2
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
}

# Same read-one-key-from-.env.oracle pattern as oracle-status.sh's
# print_effective_config — deliberately not a generic "source the whole
# env file" (that would pull in secrets like JWT_SECRET into this
# process's environment for no reason).
oracle_env_value() {
    local key="$1"
    grep -E "^${key}=" "$ORACLE_ENV_FILE" 2>/dev/null | tail -n1 | cut -d'=' -f2- || true
}

prewarm_enabled() {
    [[ "$FORCE" == true ]] && return 0
    local value
    value="$(oracle_env_value OLLAMA_PREWARM_ENABLED)"
    [[ "$value" == "true" ]]
}

# The chat request itself runs *inside* the backend container: it already
# has the `ollama` Python package, OLLAMA_BASE_URL, and OLLAMA_LLM_MODEL
# available exactly as production chat requests see them (see
# app/core/llm_provider.py). Piped in via stdin (`python3 -`) rather than
# `-c` so no shell-quoting of the Python source is needed. Prints only a
# single PREWARM_OK/PREWARM_FAILED status line — the model's actual
# generated content is read and immediately discarded, never printed (see
# module docstring above and this task's "do not print generated content"
# requirement).
run_prewarm_request() {
    # Not routed through the oracle_compose() shell-function wrapper: this
    # needs to sit under `timeout`, and `timeout` execs an external command
    # (not a shell function) — so the same -f/--env-file/--project-name
    # flags oracle_compose() would pass are given directly here instead.
    timeout "${TIMEOUT_SECONDS}s" docker compose \
        -f "$ORACLE_COMPOSE_FILE" \
        --env-file "$ORACLE_ENV_FILE" \
        --project-name "$ORACLE_PROJECT_NAME" \
        exec -T backend python3 - <<'PY'
import os
import sys
import time

import ollama

model = os.environ.get("OLLAMA_LLM_MODEL", "qwen3:8b")
base_url = os.environ.get("OLLAMA_BASE_URL", "http://ollama:11434")
client = ollama.Client(host=base_url)

start = time.monotonic()
try:
    client.chat(
        model=model,
        messages=[{"role": "user", "content": "Hi"}],
        think=False,
        stream=False,
        options={"num_predict": 1},
    )
except Exception as exc:
    elapsed = time.monotonic() - start
    print(f"PREWARM_FAILED model={model} elapsed_s={elapsed:.1f} error={exc}", file=sys.stderr)
    sys.exit(1)

elapsed = time.monotonic() - start
print(f"PREWARM_OK model={model} elapsed_s={elapsed:.1f}")
PY
}

main() {
    parse_arguments "$@"
    check_oracle_environment
    print_header "EduMind Oracle — Ollama Model Prewarm"

    if ! prewarm_enabled; then
        info "OLLAMA_PREWARM_ENABLED is not 'true' in $ORACLE_ENV_FILE — skipping (pass --force to run anyway)."
        exit 0
    fi

    local backend_id
    backend_id="$(oracle_container_id backend)"
    if [[ -z "$backend_id" ]] || [[ "$(oracle_container_status "$backend_id")" != "running" ]]; then
        warn "Prewarm skipped: the backend container is not running."
        exit 1
    fi

    info "Sending a minimal chat request to preload the model (timeout: ${TIMEOUT_SECONDS}s)..."
    if run_prewarm_request; then
        success "Model prewarm completed."
    else
        warn "Model prewarm failed or timed out — the first real chat request will pay the cold-load cost instead. This does not block startup."
        exit 1
    fi
}

main "$@"
