#!/usr/bin/env bash
# rpi5-start.sh — host-side: ssh to the Pi and bring the stack up.
#
# What this does (compose order on Pi):
#   - `docker compose pull`    : fetch qdrant + ollama ARM64 layers from Docker Hub
#   - `docker compose build`   : build the rag-backend image natively on the Pi
#                                (slow on first run, near-instant on subsequent)
#   - `docker compose up -d`   : start ollama + qdrant + backend-migrate +
#                                backend. The migrate one-shot runs alembic
#                                `upgrade head` against the persistent
#                                sqlite / qdrant storage before backend
#                                comes up (depends_on service_completed_
#                                successfully).
#
# Right path to run:
#   rpi5-package.sh
#   scp <tarball>  $PI_HOST:~
#   ssh $PI_HOST  'cd ~ && tar -xzf <...>.tar.gz'
#   rpi5-models-download.sh      ← pulls qwen3:4b / qwen2.5vl:3b /
#                                  mxbai-embed-large into ollama-data
#   rpi5-start.sh                ← THIS script (or use on the Pi dir
#                                  directly as below).
#
# Any of these steps can be run on the Pi directly: ssh $PI_HOST 'cd
# ~/edumind-rpi5-pkg-<ts>/deploy/rpi5 && ./rpi5-start.sh-internal'.
# The "internal" version is identical; this script just wraps the ssh +
# scp for command-line convenience from the host's terminal.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

rpi5_require_cmd ssh

rpi5_info "starting Pi stack at $PI_HOST:$PI_DIR ..."

# Compose project name mirrors the docker-compose.rpi5.yml's top-level
# `name:` field. We pass it explicitly so that even an environment where
# the Pi's docker CLI defaults to a different project name (e.g. via the
# COMPOSE_PROJECT_NAME env var) still works.
COMPOSE_PROJECT="edumind-rpi5"

rpi5_run_on_pi \
  "cd '${PI_DIR}' && \
   docker compose -p '${COMPOSE_PROJECT}' \
     -f docker-compose.rpi5.yml \
     --env-file .env.rpi5 \
     pull \
   && docker compose -p '${COMPOSE_PROJECT}' \
     -f docker-compose.rpi5.yml \
     --env-file .env.rpi5 \
     build \
   && docker compose -p '${COMPOSE_PROJECT}' \
     -f docker-compose.rpi5.yml \
     --env-file .env.rpi5 \
     up -d"

rpi5_info "stack is up. Next: rpi5-models-download.sh (if not yet run) and rpi5-healthcheck.sh"
