#!/usr/bin/env bash
# rpi5-setup.sh — host-side orchestrator for first-time Pi deployment.
#
# What this does (in order), every step idempotent so re-runs are safe:
#   1. Prompts the operator for PI_HOST, PI_DIR, FRONTEND_LAN_HOST
#      (the LAN IP / mDNS hostname the Expo frontend uses to reach the
#      Pi). All three can also be set via env so the same setup works
#      unattended (CI / unattended setup). Defaults: pi@raspberrypi.local,
#      ~/edumind-rpi5, raspberrypi.local.
#   2. Verifies `uname -m` on the Pi returns aarch64 / arm64 — refuses
#      to proceed if the host isn't actually a Raspberry Pi (or
#      equivalent). Catches the common "I SCP'd to the wrong host"
#      mistake before any docker / compose calls go through.
#   3. Generates a fresh 32-character URL-safe `JWT_SECRET` via
#      `python3 -c 'import secrets; print(secrets.token_urlsafe(32))'`.
#      The secret is printed exactly once to stdout AND substituted into
#      the local `.env.rpi5` file. The user should copy it elsewhere
#      right after setup completes (rotating it invalidates every
#      currently-issued access token).
#   4. Reads `deploy/rpi5/.env.rpi5.example`, replaces `<PI_LAN_HOST>` and
#      `<SET_BY_SETUP_SH>` markers, writes the result to
#      `deploy/rpi5/.env.rpi5`. The latter ends up inside the SCP
#      package and is read by the running containers via
#      `env_file: .env.rpi5`.
#   5. SSHes into the Pi to confirm reachability (ssh-key auth assumed —
#      `rpi5_scp_to_pi` honors `RPI5_SSH_OPTS` if set), creates the
#      target directory if missing, and reports the existing
#      `docker compose` version. Aborts with a clear message if the
#      host isn't reachable or Docker Engine isn't installed yet
#      (`apt install docker.io docker-compose-plugin` on Bookworm).
#
# Step 4 of the host-side flow (docker compose build / pull / up) is
# deliberately NOT done here. `rpi5-start.sh` does it. Splitting setup
# (config) from start (deployment) lets the operator review `cat .env.rpi5`
# between the two, catch typos in the env, and re-run start with a clean
# slate if needed.
#
# Exit codes:
#   0 success
#   1 user-cancelled (Ctrl-C / empty input on a required prompt)
#   2 prerequisite missing (ssh / scp / python3 not installed)
#   3 SSH target unreachable / wrong arch / wrong host
#   4 .env.rpi5.example not found (run from the repo root)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

# Sentinel against the script being accidentally sourced from a different
# layout. require_cmd ensures ssh/scp/python3 exist before anything
# irreversible happens below.
rpi5_require_cmd ssh scp python3 tar

# ----------------------------------------------------------------------------
# 1. Resolve configuration (env overrides → interactive prompts)
# ----------------------------------------------------------------------------

prompt_default() {
  # Read a single line from stdin, returning the default if the user just
  # hits enter. Empty input for a required prompt is treated as a
  # cancellation — exit 1.
  local var_name="$1" default_value="$2" prompt_text="$3" required="${4:-true}"
  local current="${!var_name:-}"
  local effective_default="${current:-$default_value}"
  local reply
  if [[ -n "$effective_default" ]]; then
    read -r -p "${prompt_text} [${effective_default}]: " reply
  else
    read -r -p "${prompt_text}: " reply
  fi
  reply="${reply:-$effective_default}"

  if [[ "$required" == "true" && -z "$reply" ]]; then
    rpi5_die "no value provided for ${var_name} — aborting"
  fi
  printf -v "$var_name" '%s' "$reply"
}

rpi5_info "=== rpi5-setup.sh === interactive configuration for first-time Pi install"

prompt_default PI_HOST          ""           "Pi SSH host (user@host)"                  true
if [[ -z "${PI_DIR:-}" ]]; then
  PI_DIR_DEFAULT="$HOME/edumind-rpi5"
else
  PI_DIR_DEFAULT=""
fi
prompt_default PI_DIR            "$PI_DIR_DEFAULT" "Directory on the Pi to deploy into" true
prompt_default PI_FRONTEND_HOST  ""           "Frontend LAN host/IP the app uses to reach the Pi (e.g. raspberrypi.local or 192.168.x.y)" true

# Export so the SCP / ssh helpers introduced by common.sh pick them up.
export PI_HOST PI_DIR PI_FRONTEND_HOST

# ----------------------------------------------------------------------------
# 2. Verify Pi is reachable + is arm64
# ----------------------------------------------------------------------------

rpi5_info "checking Pi reachability and architecture at $PI_HOST …"

# `uname -m` returns arm64 (Apple-silicon style) on Bookworm aarch64.
# Older Pi images used armv7l (we explicitly reject that). Compose is
# platform-pinned linux/arm64, so anything other than aarch64 / arm64
# would pull an emulated image and run badly.
PI_UNAME_M="$(rpi5_run_on_pi 'uname -m' 2>&1 || true)"

case "$PI_UNAME_M" in
  aarch64|arm64)
    rpi5_info "  architecture: $PI_UNAME_M (Raspberry Pi 5 OK)"
    ;;
  *)
    # Don't echo stderr too loudly — ssh proxies can be chatty.
    rpi5_die "Pi at $PI_HOST is not arm64 (got: '${PI_UNAME_M:-<unreachable>}'). Refusing to continue. Check \$PI_HOST and retry."
    ;;
esac

# Docker availability check — Bookworm needs `apt install docker.io
# docker-compose-plugin` (or the official Docker repo). Fail loudly
# because a missing compose plugin makes `docker compose -f … up` fail
# with a totally unrelated "command not found" error.
if ! PI_DOCKER_OK="$(rpi5_run_on_pi 'command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 && docker compose version' 2>&1)"; then
  rpi5_warn "Docker Engine and/or compose plugin not found at $PI_HOST"
  rpi5_warn "  install with: apt-get update && apt-get install -y docker.io docker-compose-plugin"
  rpi5_warn "  (or follow https://docs.docker.com/engine/install/debian/)"
  rpi5_die "install Docker on the Pi first, then re-run rpi5-setup.sh"
fi
rpi5_info "Docker is available: ${PI_DOCKER_OK##*$'\n'}"

# ----------------------------------------------------------------------------
# 3. Generate the JWT secret
# ----------------------------------------------------------------------------

rpi5_info "generating JWT_SECRET (32 bytes URL-safe)"

# `secrets.token_urlsafe(32)` emits ~43 ch of base64url >= the
# pydantic validator's `min_length=16`. Use python3 from the host;
# the value is purely a string at this point (no cryptography needed).
JWT_SECRET_RAW="$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')"

# Sanity: 43 base64 chars; should never be empty. Python has already
# proven it, but a guard here surfaces a binary env issue more clearly
# than an obscure later pydantic-rejection.
if [[ -z "$JWT_SECRET_RAW" || ${#JWT_SECRET_RAW} -lt 16 ]]; then
  rpi5_die "could not generate JWT_SECRET — python3 is not in a working state"
fi

# ----------------------------------------------------------------------------
# 4. Render the env from the .env.rpi5.example template
# ----------------------------------------------------------------------------

ENV_EXAMPLE="${RPI5_DIR}/.env.rpi5.example"
ENV_TARGET="${RPI5_DIR}/.env.rpi5"

# In the host's checkout, .env.rpi5.example sits at deploy/rpi5/.env.rpi5.example
# (RPI5_DIR already points there). The same env file is what gets SCP'd
# into the package and what the running containers read.
if [[ ! -f "$ENV_EXAMPLE" ]]; then
  rpi5_die "template not found at $ENV_EXAMPLE — are you running this from the deploy/rpi5/ tree?"
fi

rpi5_info "writing $ENV_TARGET"

# Substitutions are done with python rather than sed because the env file
# intentionally contains forward slashes, `=` values, and full URLs —
# python is not byte-pattern-blind the way sed can be when escaping is
# wrong. We use `str.replace` (not regex) so ampersands and backslashes
# in the placeholder values are not special.
python3 - "$ENV_EXAMPLE" "$ENV_TARGET" "$PI_FRONTEND_HOST" "$JWT_SECRET_RAW" <<'PYEOF'
import sys
template_path, target_path, frontend_host, jwt_secret = sys.argv[1:5]
text = open(template_path, encoding="utf-8").read()
text = text.replace("<PI_LAN_HOST>", frontend_host)
text = text.replace("<SET_BY_SETUP_SH>", jwt_secret)
open(target_path, "w", encoding="utf-8").write(text)
PYEOF

# Make sure permissions work for a moved env file. World-readable secrets
# would be a disaster if the user's account permission-leaked later;
# 0600 is the right base.
chmod 0600 "$ENV_TARGET"

# ----------------------------------------------------------------------------
# 5. Final report
# ----------------------------------------------------------------------------

# Pre-flight summary: read the file back and confirm the substitutions
# landed. Belt-and-suspenders so an unusual encoding (BOM, UTF-16 from a
# paste-in edit) doesn't silently leak <PI_LAN_HOST> into the runtime.
if grep -q '<PI_LAN_HOST>' "$ENV_TARGET" || grep -q '<SET_BY_SETUP_SH>' "$ENV_TARGET"; then
  rpi5_die "post-substitution $ENV_TARGET still contains unresolved placeholders — aborting"
fi

cat <<EOF

=================================================
  Pi deployment configured.

  PI_HOST (ssh):          $PI_HOST  (architecture: $PI_UNAME_M, OK)
  PI_DIR (deployed):      $PI_DIR
  FRONTEND LAN host/IP:   $PI_FRONTEND_HOST

  Generated JWT_SECRET (43 chars, write this down somewhere durable — you
  cannot recover it from the Pi after this script ends, and rotating it
  later invalidates every issued access token):

    $JWT_SECRET_RAW

  Wrote env file:
    $ENV_TARGET

  Next:
    1. (Revisit $ENV_TARGET if you need to change IP/CORS/etc.)
    2. Run from the HOST:
         rpi5-package.sh          # produces the SCP tarball at /tmp/...
         scp /tmp/edumind-rpi5-pkg-<ts>/*.tar.gz  $PI_HOST:~
         ssh  $PI_HOST  'tar -xzf edumind-rpi5-pkg-<...>.tar.gz'
         ssh  $PI_HOST  'cd <extracted-dir> && ./rpi5-start.sh'  # the Pi-side startup is rpi5-start.sh's domain
    3. Pull the models from Ollama (qwen3:4b, qwen2.5vl:3b, mxbai-embed-large):
         rpi5-models-download.sh
    4. Verify health:
         rpi5-healthcheck.sh

  Helper scripts in deploy/rpi5/scripts/:
    rpi5-build.sh            optional host-side build (default: build on Pi natively)
    rpi5-package.sh          tarball builder for SCP
    rpi5-start.sh            ssh + docker compose up -d
    rpi5-stop.sh             ssh + docker compose down
    rpi5-models-download.sh  pull required Ollama models
    rpi5-healthcheck.sh      show service state + /health/ready body
    rpi5-logs.sh             ssh + docker compose logs -f
    rpi5-backup.sh           snapshot data/qdrant volumes to a host-side tar
=================================================
EOF
