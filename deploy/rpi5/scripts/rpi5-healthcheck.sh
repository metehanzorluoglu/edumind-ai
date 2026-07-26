#!/usr/bin/env bash
# rpi5-healthcheck.sh — host-side: check the Pi's stack is healthy.
#
# `/health/ready` is unauthenticated (see `app/api/routes_health.py`)
# and returns a richer payload than `/health`:
#     {
#       "status": "ready" | "not_ready",
#       "ollama_reachable": bool,
#       "qdrant_reachable":  bool,
#       "models_available":   <model name -> bool>,
#       "text_model_available":       bool,
#       "vision_model_available":     bool | null,
#       "embedding_model_available":  bool,
#       "ollama_latency_ms": float | null,
#       "qdrant_latency_ms":  float | null
#     }
# The HTTP status code is **always 200** — readiness is encoded in the
# `status` field; consumers are expected to look at *that* field, not
# the response code.
#
# Script layout:
#   1. `docker compose ps --format json`     → service-level state per container
#   2. `curl http://<pi>:8000/health/ready`  → readiness JSON, parsed
#   3. Add a friendly summary with traige suggestions when something
#      is not-ready (likely failure modes: ollama model not pulled,
#      ollama still booting after fresh `ollama pull`, qdrant unhealthy
#      storage — diagnostic pointers in the output).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

rpi5_require_cmd ssh

# Pi hostname or LAN IP — used both as the SSH target (PI_HOST) and
# as the resolve target for `curl http://$PI_FQDN:8000/...`. If the
# PI_HOST env var was set to `user@something` (with ssh user prefix)
# we strip the user@ here so curl gets a bare hostname/IP. The bash
# expansion below keeps the existing ssh target intact.
PI_FQDN="${PI_HOST#*@}"

COMPOSE_PROJECT="edumind-rpi5"

rpi5_info "[1/3] container-level health from docker compose ps"
rpi5_run_on_pi \
  "cd '${PI_DIR}' && docker compose -p '${COMPOSE_PROJECT}' \
     -f docker-compose.rpi5.yml \
     ps --format json"

# Exit code 0 above is `docker compose ps`'s expectation, not readiness.

rpi5_info "[2/3] /health/ready body from $PI_FQDN:8000"

# Pull the JSON; tolerate non-200 (the /health/ready route returns
# 200 always, but a future version or a reverse-proxy-in-front-of-Docker
# misconfig can produce a 502/503 here — show that, don't crash).
READINESS_JSON="$(rpi5_run_on_pi \
  "curl -fsS --connect-timeout 5 --max-time 30 \
      http://localhost:8000/health/ready || true" \
  2>/dev/null || true)"

if [[ -z "$READINESS_JSON" ]]; then
  rpi5_error "could not reach backend at $PI_FQDN:8000/health/ready — is the stack up? (rpi5-start.sh runs docker compose up -d)"
  rpi5_info  "  hint: ssh $PI_HOST 'cd $PI_DIR && docker compose logs --tail=200 backend'"
  exit 1
fi

# Pretty-print the response.
if command -v python3 >/dev/null 2>&1; then
  printf '%s\n' "$READINESS_JSON" | python3 -m json.tool 1>&2 || printf '%s\n' "$READINESS_JSON"
else
  printf '%s\n' "$READINESS_JSON"
fi

rpi5_info "[3/3] summary"

# python3 is already required for jq-less parsing of the body. Use it to
# do an aggregate decision.
SUMMARY="$(printf '%s' "$READINESS_JSON" | python3 <<'PYEOF'
import json, sys
try:
    body = json.loads(sys.stdin.read())
except Exception as exc:
    print(f"error: could not parse /health/ready body: {exc}")
    sys.exit(0)
print(f"status:                  {body.get('status')}")
print(f"ollama_reachable:        {body.get('ollama_reachable')}")
print(f"qdrant_reachable:        {body.get('qdrant_reachable')}")
print(f"text_model_available:    {body.get('text_model_available')}")
print(f"vision_model_available:  {body.get('vision_model_available')}")
print(f"embedding_model_avail.:  {body.get('embedding_model_available')}")
models = body.get('models_available') or {}
for name, avail in sorted(models.items()):
    print(f"  {name:35}  -> {'available' if avail else 'NOT available'}")
print(f"ollama_latency_ms:       {body.get('ollama_latency_ms')}")
print(f"qdrant_latency_ms:       {body.get('qdrant_latency_ms')}")
PYEOF
)"

printf '\n%s\n' "$SUMMARY"

# Final pass/fail based on `status:` string.
if printf '%s' "$READINESS_JSON" | python3 -c "import sys, json; sys.exit(0 if json.loads(sys.stdin.read()).get('status') == 'ready' else 1)" 2>/dev/null; then
  rpi5_info "RESULT: ready"
  exit 0
fi

rpi5_warn_helper() {
  printf '  HINT: %s\n' "$1" >&2
}

printf '\n%s\n' "RESULT: not ready — triage suggestions:" >&2
if printf '%s' "$READINESS_JSON" | python3 -c "import sys, json; sys.exit(0 if json.loads(sys.stdin.read()).get('ollama_reachable') else 1)" 2>/dev/null; then
  rpi5_warn_helper "ollama is reachable but models may be missing — run rpi5-models-download.sh"
else
  rpi5_warn_helper "ollama_reachable=false — ollama container still booting or crashed. Try: ssh $PI_HOST 'cd $PI_DIR && docker compose logs --tail=200 ollama'"
fi
exit 2
