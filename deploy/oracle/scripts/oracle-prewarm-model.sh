#!/usr/bin/env bash
#
# Preloads the chat LLM (OLLAMA_LLM_MODEL, default qwen3:8b) — and,
# separately, the vision LLM (OLLAMA_VISION_MODEL, default qwen2.5vl:7b)
# — into Ollama's memory with a minimal request, so the *first real user
# turn* doesn't pay Ollama's cold-load cost on top of prompt evaluation
# and generation.
#
# Background (text): on the Oracle CPU-only host, a cold qwen3:8b load
# alone was measured at ~44s, and the frontend had no way to distinguish
# "loading" from "hung" during that wait before an earlier session's SSE
# progress-events fix (see ChatProgressEvent in app/schemas/chat.py).
# Prewarming at deployment/startup time moves that fixed cost out of the
# user-facing critical path for the very first chat after a (re)start —
# it does not help subsequent cold-loads if OLLAMA_KEEP_ALIVE expires
# from inactivity.
#
# Background (vision): a live investigation into the "model did not
# respond in time" vision-attachment production error found qwen2.5vl:7b
# prompt-evaluation alone taking 114-232+ seconds even fully *warm* for a
# single modest image on this CPU host (see app/config.py's
# vision_request_timeout_seconds docstring) — cold load adds to that.
# Prewarming the vision model removes only the cold-load component for
# the first post-restart vision request; it does not make evaluation
# itself faster (see this task's report for why: prompt-eval time tracks
# decoded pixel/token count, not model residency).
#
# Deliberately opt-in for both (OLLAMA_PREWARM_ENABLED=true /
# OLLAMA_VISION_PREWARM_ENABLED=true, independently) and deliberately
# non-fatal on failure — see main()'s exit-code handling and
# oracle-start.sh's call site: a prewarm failure must never block
# startup, since a normal (slower) first user request still works via the
# same code path this script exercises.
#
# Every actual chat request runs *inside* the backend container (not this
# host), reusing its already-installed `ollama` Python package,
# OLLAMA_BASE_URL, and OLLAMA_LLM_MODEL/OLLAMA_VISION_MODEL — the exact
# same client classes and network path a real request uses (see
# app/core/llm_provider.py and app/services/vision_service.py), so a
# successful prewarm is a genuine guarantee the model can be reached and
# loaded, not a separate/parallel code path that could pass while the
# real one fails.

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/common.sh"

FORCE=false
TIMEOUT_SECONDS="${OLLAMA_PREWARM_TIMEOUT_SECONDS:-180}"
VISION_FORCE=false
# Vision cold-load + evaluation was measured far slower than text's — see
# the module docstring — so this needs materially more headroom than
# OLLAMA_PREWARM_TIMEOUT_SECONDS' 180s default.
VISION_TIMEOUT_SECONDS="${OLLAMA_VISION_PREWARM_TIMEOUT_SECONDS:-300}"

usage() {
    cat <<EOF_USAGE
Usage:
  $(basename "$0") [options]

Sends a single minimal chat request (think=false, num_predict=1, output
discarded) to the backend's configured text model, so it is already
loaded into memory before the first real user request arrives. A no-op
that exits 0 unless OLLAMA_PREWARM_ENABLED=true in .env.oracle (or
--force is given).

Also sends a single minimal *vision* chat request (a 1x1 pixel synthetic
image, num_predict=1, output discarded) to the configured vision model —
independently opt-in via OLLAMA_VISION_PREWARM_ENABLED=true (or
--vision-force) — and reports whether doing so evicted the just-warmed
text model (see "Model residency" in this task's report: whether that can
happen depends on OLLAMA_MAX_LOADED_MODELS).

Neither prewarm is ever treated as fatal by oracle-start.sh: a failed
prewarm only produces a warning, never blocks startup — the normal chat
path works fine without it, just slower for the first request of that
kind.

Options:
  --force                    Run the text-model prewarm even if
                              OLLAMA_PREWARM_ENABLED is not true
  --vision-force              Run the vision-model prewarm even if
                              OLLAMA_VISION_PREWARM_ENABLED is not true
  --timeout-seconds N         Max seconds to wait for the text prewarm
                               (default: 180, or \$OLLAMA_PREWARM_TIMEOUT_SECONDS)
  --vision-timeout-seconds N  Max seconds to wait for the vision prewarm
                               (default: 300, or \$OLLAMA_VISION_PREWARM_TIMEOUT_SECONDS)
  -h, --help                  Show this help message

Examples:
  $(basename "$0")
  $(basename "$0") --force
  $(basename "$0") --vision-force
  $(basename "$0") --force --vision-force --vision-timeout-seconds 420
EOF_USAGE
}

parse_arguments() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --force)
                FORCE=true
                shift
                ;;
            --vision-force)
                VISION_FORCE=true
                shift
                ;;
            --timeout-seconds)
                [[ $# -ge 2 ]] || die "--timeout-seconds requires a value"
                TIMEOUT_SECONDS="$2"
                shift 2
                ;;
            --vision-timeout-seconds)
                [[ $# -ge 2 ]] || die "--vision-timeout-seconds requires a value"
                VISION_TIMEOUT_SECONDS="$2"
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

vision_prewarm_enabled() {
    [[ "$VISION_FORCE" == true ]] && return 0
    local value
    value="$(oracle_env_value OLLAMA_VISION_PREWARM_ENABLED)"
    [[ "$value" == "true" ]]
}

# Names every model *currently* resident in Ollama, one per line — used
# before/after the vision prewarm to detect and report an eviction (see
# run_vision_prewarm_request below), not to make any decision here.
# Never dies on failure: this is a best-effort report, not a
# precondition, and `ollama ps` failing shouldn't itself fail the
# prewarm.
oracle_loaded_models() {
    oracle_compose exec -T ollama ollama ps 2>/dev/null \
        | tail -n +2 \
        | awk '{print $1}' \
        || true
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

# Same shape as run_prewarm_request above, but sends a *vision* chat call
# (images=[...]) to OLLAMA_VISION_MODEL through app's own VisionService —
# not a raw ollama.Client.chat() the way the text prewarm above uses,
# because VisionService.stream_chat is async (see
# app/services/vision_service.py's module docstring for why) and this
# should exercise the real production code path, not a parallel one that
# could pass while the real one fails. The "image" is the smallest
# possible valid PNG (a hardcoded 1x1 pixel, ~70 bytes, base64-decoded
# inline) — genuinely minimal, per this task's requirement, and avoids
# needing any file to exist inside the container.
run_vision_prewarm_request() {
    timeout "${VISION_TIMEOUT_SECONDS}s" docker compose \
        -f "$ORACLE_COMPOSE_FILE" \
        --env-file "$ORACLE_ENV_FILE" \
        --project-name "$ORACLE_PROJECT_NAME" \
        exec -T backend python3 - <<'PY'
import asyncio
import base64
import os
import sys
import time

from app.services.vision_service import VisionService

# A 1x1 transparent PNG — the smallest valid PNG byte sequence, not a
# real photo/screenshot. Never printed; only its length is ever logged.
_TINY_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk"
    "+A8AAQUBAScY42YAAAAASUVORK5CYII="
)

model = os.environ.get("OLLAMA_VISION_MODEL", "qwen2.5vl:7b")
base_url = os.environ.get("OLLAMA_BASE_URL", "http://ollama:11434")
service = VisionService(model=model, base_url=base_url, timeout_seconds=280.0, num_predict=1)


async def run() -> None:
    start = time.monotonic()
    try:
        async for _token in service.stream_chat(prompt="Hi", images=[_TINY_PNG]):
            pass
    except Exception as exc:
        elapsed = time.monotonic() - start
        print(f"VISION_PREWARM_FAILED model={model} elapsed_s={elapsed:.1f} error={exc}", file=sys.stderr)
        sys.exit(1)
    elapsed = time.monotonic() - start
    print(f"VISION_PREWARM_OK model={model} elapsed_s={elapsed:.1f}")


asyncio.run(run())
PY
}

main() {
    parse_arguments "$@"
    check_oracle_environment
    print_header "EduMind Oracle — Ollama Model Prewarm"

    local backend_id
    backend_id="$(oracle_container_id backend)"
    local backend_running=true
    if [[ -z "$backend_id" ]] || [[ "$(oracle_container_status "$backend_id")" != "running" ]]; then
        backend_running=false
    fi

    local text_failed=false
    if ! prewarm_enabled; then
        info "Text-model prewarm: OLLAMA_PREWARM_ENABLED is not 'true' in $ORACLE_ENV_FILE — skipping (pass --force to run anyway)."
    elif [[ "$backend_running" != true ]]; then
        warn "Text-model prewarm skipped: the backend container is not running."
        text_failed=true
    else
        info "Sending a minimal chat request to preload the text model (timeout: ${TIMEOUT_SECONDS}s)..."
        if run_prewarm_request; then
            success "Text-model prewarm completed."
        else
            warn "Text-model prewarm failed or timed out — the first real chat request will pay the cold-load cost instead. This does not block startup."
            text_failed=true
        fi
    fi

    local vision_failed=false
    if ! vision_prewarm_enabled; then
        info "Vision-model prewarm: OLLAMA_VISION_PREWARM_ENABLED is not 'true' in $ORACLE_ENV_FILE — skipping (pass --vision-force to run anyway)."
    elif [[ "$backend_running" != true ]]; then
        warn "Vision-model prewarm skipped: the backend container is not running."
        vision_failed=true
    else
        local models_before
        models_before="$(oracle_loaded_models)"
        info "Sending a minimal vision chat request to preload the vision model (timeout: ${VISION_TIMEOUT_SECONDS}s)..."
        if run_vision_prewarm_request; then
            success "Vision-model prewarm completed."
        else
            warn "Vision-model prewarm failed or timed out — the first real vision request will pay the cold-load cost instead. This does not block startup."
            vision_failed=true
        fi

        # Reported regardless of the prewarm's own success/failure — even
        # a *failed* vision prewarm can have loaded the vision model far
        # enough to evict something under OLLAMA_MAX_LOADED_MODELS (see
        # this task's report, "Model residency"). Best-effort only: never
        # itself treated as a failure condition for this script.
        if [[ -n "$models_before" ]]; then
            local models_after
            models_after="$(oracle_loaded_models)"
            local evicted
            evicted="$(comm -23 <(echo "$models_before" | sort) <(echo "$models_after" | sort) 2>/dev/null || true)"
            if [[ -n "$evicted" ]]; then
                warn "Vision-model prewarm evicted the following previously-loaded model(s) from Ollama's memory: $(echo "$evicted" | tr '\n' ' ')"
                warn "This is expected if OLLAMA_MAX_LOADED_MODELS is too low for every model your traffic actually uses concurrently — see this deployment's README, 'Model residency'."
            fi
        fi
    fi

    if [[ "$text_failed" == true || "$vision_failed" == true ]]; then
        exit 1
    fi
}

main "$@"
