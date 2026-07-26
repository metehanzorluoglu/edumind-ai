#!/usr/bin/env bash
# rpi5-models-download.sh — host-side: ssh to the Pi, pull the three
# needed Ollama models into the running ollama container.
#
# Models (verified against the .env.rpi5.example — keep in sync):
#   qwen3:4b                — text generation (default 8B is too RAM-heavy
#                             for Pi 5 + 8 GB; 4B is on the threshold)
#   qwen2.5vl:3b            — vision-input LLM (default 7B is too heavy)
#   mxbai-embed-large       — text-embedding model. Vector size is
#                             hardcoded into the Qdrant collection
#                             (`MXBAI_EMBED_LARGE_DIMENSIONS` in
#                             app/core/embedding_provider.py); switching
#                             embeddings requires recomputing every
#                             existing point + the collection spec.
#
# Pull cadence:
#   First deploy can take 5–15 minutes (each model is 1.5–3 GB). On
#   subsequent restarts re-pull is skipped if the model is already
#   present in `edumind-rpi5-ollama-data` — `ollama pull` does its own
#   ETag/hash check, so it's safe to leave in cron once for safety.
#
# Container naming convention: docker-compose prefixes container names
# with the project's `name:` field and an underscore — that's
# `edumind-rpi5-ollama-1` for our compose. We use `docker compose exec`
# rather than a hardcoded name so future renames land here too.
#
# Note: when image-generation is OFF (the default; .env.rpi5.example
# sets IMAGE_GENERATION_ENABLED=false) we deliberately do NOT pull
# x/flux2-klein — saves ~5 GB of disk for a model the backend will
# never request, and skipping the pull removes the most expensive image
# in the dep tree.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

rpi5_require_cmd ssh

# Canonical model list — keep in lock-step with what `.env.rpi5.example`
# declares as OLLAMA_LLM_MODEL / OLLAMA_VISION_MODEL / OLLAMA_EMBED_MODEL.
# Reading these from .env.rpi5 would be cleaner, but doing so without a
# yq/dotenv/parser tool keeps the script dependency-light and avoids
# accidental halts when an operator hand-edited the file. We treat
# `.env.rpi5.example` as the canonical source here too.
MODELS=(
  "qwen3:4b"
  "qwen2.5vl:3b"
  "mxbai-embed-large"
)

COMPOSE_PROJECT="edumind-rpi5"

# Convenience aggregate for log lines + final summary.
rpi5_info "pulling ${#MODELS[@]} Ollama models into ${PI_HOST}'s running Ollama container"

# `docker compose exec --no-deps ollama …` to avoid waiting on
# backend/qdrant healthchecks here (this script may run before/after the
# full stack — only the ollama container matters).
for model in "${MODELS[@]}"; do
  rpi5_info "  ollama pull ${model}"
  rpi5_run_on_pi \
    "cd '${PI_DIR}' && docker compose -p '${COMPOSE_PROJECT}' \
       exec --no-TTY -T ollama ollama pull '${model}'"
done

# Final summary: ollama's own `ollama list`, which prints just the
# pulled-model table. Quick sanity that the three target tags are now
# resident.
rpi5_run_on_pi \
  "cd '${PI_DIR}' && docker compose -p '${COMPOSE_PROJECT}' \
     exec --no-TTY -T ollama ollama list"

cat <<EOF

=================================================
  Models pulled into ${PI_HOST}.

  Sanity-check that it's ready for /health/ready by running:
    rpi5-healthcheck.sh

  The "ollama list" output above should show three entries matching
  the .env.rpi5.example's OLLAMA_LLM_MODEL / OLLAMA_VISION_MODEL /
  OLLAMA_EMBED_MODEL strings. If some have a different visible tag
  (Ollama adds `:latest` suffixes if you don't pin), check the
  .env.rpi5 rendering and update the model's pull list here to match.
=================================================
EOF
