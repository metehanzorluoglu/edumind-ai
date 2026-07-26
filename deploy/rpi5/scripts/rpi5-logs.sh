#!/usr/bin/env bash
# rpi5-logs.sh — host-side: ssh to the Pi and tail docker compose logs.
#
# Defaults: tail ALL services (compose passes all of them by default if
# you don't pass any). A service name can be supplied as $1 to follow
# just that one — typical use:
#   rpi5-logs.sh            # all
#   rpi5-logs.sh backend    # just backend
#   rpi5-logs.sh ollama     # just ollama
#   rpi5-logs.sh qdrant     # just qdrant
#   rpi5-logs.sh backend-migrate  # look for alembic errors during a
#                                 # pending migrate one-shot
#
# `docker compose logs -f --tail=200` keeps the connection open; Ctrl-C
# locally terminates the ssh session cleanly. `ssh -t` would only be
# needed if we had a TTY-bound tool, but `docker compose logs` works
# fine without one.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

rpi5_require_cmd ssh

SERVICE_NAME="${1:-}"
COMPOSE_PROJECT="edumind-rpi5"

rpi5_info "tailing logs (service: ${SERVICE_NAME:-all}) on $PI_HOST:$PI_DIR"

# Compose flags the `-f` service list flag as positional args after the
# command. Empty service name → "all".
rpi5_run_on_pi \
  "cd '${PI_DIR}' && docker compose -p '${COMPOSE_PROJECT}' \
     -f docker-compose.rpi5.yml \
     --env-file .env.rpi5 \
     logs -f --tail=200 ${SERVICE_NAME}"
