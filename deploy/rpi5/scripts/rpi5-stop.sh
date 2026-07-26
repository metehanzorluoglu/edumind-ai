#!/usr/bin/env bash
# rpi5-stop.sh — host-side: ssh to the Pi and bring the stack down.
#
# `docker compose down` stops & removes containers AND the default
# network — but NOT the named volumes. Persistent data (sqlite db,
# chat attachments, qdrant storage, ollama model weights) survives.
#
# If the operator wants a full wipe (rebuild from scratch), they should
# ALSO `ssh $PI_HOST "docker volume rm edumind-rpi5_{backend,qdrant,ollama}-data"`.
# We deliberately do NOT automatically remove volumes — `down` keeping
# data is the safe default, and any data loss here would be one
# operator-decision-step too far.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

rpi5_require_cmd ssh

rpi5_info "stopping Pi stack at $PI_HOST:$PI_DIR ..."

COMPOSE_PROJECT="edumind-rpi5"
rpi5_run_on_pi \
  "cd '${PI_DIR}' && \
   docker compose -p '${COMPOSE_PROJECT}' \
     -f docker-compose.rpi5.yml \
     --env-file .env.rpi5 \
     down"

rpi5_info "stack is down. Persistent volumes preserved."

cat <<EOF

=================================================
  Persisted volumes survive `docker compose down`:

    edumind-rpi5_backend-data    (sqlite db + chat attachments)
    edumind-rpi5_qdrant-data     (Qdrant HTTP API storage)
    edumind-rpi5_ollama-data     (downloaded model weights)

  To nuke them too (DESTRUCTIVE — next up will be a clean install
  requiring model re-download + corpus re-ingest):

    ssh $PI_HOST 'docker volume rm edumind-rpi5_{backend,qdrant,ollama}-data'

  Or, equivalently, an interactive `docker compose down --volumes`.
=================================================
EOF
