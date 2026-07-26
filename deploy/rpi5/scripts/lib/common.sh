# Shared shell utilities for the deploy/rpi5/scripts/* helpers.
#
# Sourced (`source "${SCRIPT_DIR}/lib/common.sh"`) by every public script.
# Adds:
#   - `set -euo pipefail` + several safety defaults to prevent accidental
#     variable expansion of unset names (keeps the scripts strict under
#     `set -u`, matching the conventions of the existing
#     rag-backend/scripts/*.sh scripts).
#   - `rpi5_log()`, `rpi5_warn()`, `rpi5_die()` for colorized, ts-prefixed
#     output.
#   - `rpi5_require_cmd()` to fail-fast on missing system binaries
#     (e.g. `ssh`, `scp`, `tar`) rather than discovering them mid-script.
#   - `rpi5_utc_ts()` for the canonical UTC ISO-8601-compact form used in
#     package filenames and backup tarball names.
#   - `rpi5_run_on_pi()` for `ssh $PI_HOST -- <cmd>` with retry — every
#     public script uses this so the user can `export PI_HOST` once and
#     forget per-command.
#
# Conventions:
#   - All rpi5 scripts are HOST-side (run on the developer's Mac, not on
#     the Pi). Only the package tarball and the names of the SSH / docker
#     commands we issue cross the network boundary.
#   - Library names are prefixed `rpi5_` rather than `rpi5_` to avoid
#     shadowing any standard / vendor-defined names (sourced scripts can
#     pollute the caller's namespace; namespacing is the cheapest defense).

set -euo pipefail
# `inherit_errexit` from bash 4.4 / bash 5.x keeps errexit inside $(...)
# command substitutions — useful when we capture ssh output and check it.
shopt -s inherit_errexit 2>/dev/null || true

# ----------------------------------------------------------------------------
# Output
# ----------------------------------------------------------------------------

# ANSI colors, auto-disabled when stdout isn't a TTY so `| tee` doesn't
# produce garbage in captured logs. Use `RPI5_FORCE_COLOR=1` to force.
_rpi5_color_tty() {
  if [[ -n "${RPI5_FORCE_COLOR:-}" ]]; then return 0; fi
  [[ -t 1 ]]
}

_rpi5_log_level() {
  local level="$1"
  case "$level" in
    INFO)  [[ -t 1 ]] && printf '\033[0;36m%s\033[0m' "$level" || printf '%s' "$level" ;;
    WARN)  [[ -t 1 ]] && printf '\033[0;33m%s\033[0m' "$level" || printf '%s' "$level" ;;
    ERROR) [[ -t 1 ]] && printf '\033[0;31m%s\033[0m' "$level" || printf '%s' "$level" ;;
    *)     printf '%s' "$level" ;;
  esac
}

# rpi5_log LEVEL MESSAGE...
# Prefix every message with the script name + UTC timestamp.
# Capture the script name once on first call (cheap to repeat; predictable).
_RPI5_SCRIPT_NAME="${_RPI5_SCRIPT_NAME:-$(basename "${BASH_SOURCE[1]:-$0}")}"

rpi5_log() {
  local level="$1"; shift
  local ts
  ts="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  printf '[%s] [%s] [%s] %s\n' "$ts" "$(_rpi5_log_level "$level")" "$_RPI5_SCRIPT_NAME" "$*"
}

rpi5_warn() { rpi5_log WARN  "$@"; }
rpi5_info() { rpi5_log INFO  "$@"; }
rpi5_error(){ rpi5_log ERROR "$@" 1>&2; }

# rpi5_die MESSAGE... — log + exit 1 with the same processed timestamp.
rpi5_die() {
  rpi5_error "$@"
  exit 1
}

# ----------------------------------------------------------------------------
# Validation / prerequisites
# ----------------------------------------------------------------------------

# rpi5_require_cmd NAME [NAME...]
# Warns/exits if any of the listed binaries aren't on PATH. Used at the top
# of each script's main body to fail-fast before any state is touched.
rpi5_require_cmd() {
  local missing=()
  for cmd in "$@"; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
      missing+=("$cmd")
    fi
  done
  if (( ${#missing[@]} > 0 )); then
    rpi5_die "missing required commands: ${missing[*]} — install them and retry"
  fi
}

# rpi5_utc_ts — UTC ISO-8601 compact, no colons. Filename-safe.
# Always writes to stdout so callers can capture via $(...).
# Example: 20260724T220012Z
rpi5_utc_ts() { date -u '+%Y%m%dT%H%M%SZ'; }

# rpi5_utc_ts_human — UTC ISO-8601 with colons + Z. Pretty for log lines.
rpi5_utc_ts_human() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }

# ----------------------------------------------------------------------------
# Environment / configuration
# ----------------------------------------------------------------------------

# Default values for any PI_* / package-name env vars. Scripts that take
# options override these. The defaults are deliberately friendly so a
# brand-new user can `bash rpi5-setup.sh` and have things "kind of work":
# they still need to answer the prompts.
: "${PI_HOST:=pi@raspberrypi.local}"
: "${PI_DIR:=~/edumind-rpi5}"
: "${PI_FRONTEND_HOST:=raspberrypi.local}"

# ----------------------------------------------------------------------------
# SSH
# ----------------------------------------------------------------------------

# Optional SSH-options flag string. Picked up so that user can override key
# location, port forwarding settings, etc., with `RPI5_SSH_OPTS`-style
# env vars if needed. Currently unused by each script (kept as a hook).
: "${RPI5_SSH_OPTS:=}"

# rpi5_run_on_pi COMMAND [ARGS...]
# `ssh PI_HOST --` with a single command. ConnectTimeout 10s to fail-fast
# in case the hostname is wrong (default ssh waits forever).
rpi5_run_on_pi() {
  ssh -o ConnectTimeout=10 -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
      ${RPI5_SSH_OPTS:-} "$PI_HOST" -- "$@"
}

# rpi5_scp_to_pi LOCAL_PATH PI_REMOTE_PATH
# Mirror of rpi5_run_on_pi but for `scp` — bundle uploads use this.
rpi5_scp_to_pi() {
  local local_path="$1" remote_path="$2"
  scp -o ConnectTimeout=10 ${RPI5_SSH_OPTS:-} "$local_path" "$PI_HOST:$remote_path"
}

# ----------------------------------------------------------------------------
# Path
# ----------------------------------------------------------------------------

# Resolve the absolute path to the deploy/rpi5 directory regardless of how
# a script is invoked (relative, from $PATH, symlinked, etc.).
# Stored in RPI5_DIR so every script source-line reads from the same place.
if [[ -z "${RPI5_DIR:-}" ]]; then
  # Walk up from $BASH_SOURCE until we find the dir that contains the
  # Dockerfile.rpi5 sentinel. BASH_SOURCE[0] is the file containing this
  # library; its directory is supposed to be `deploy/rpi5/scripts/lib`.
  _rpi5_lib_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
  if [[ "${_rpi5_lib_dir}" == */deploy/rpi5/scripts/lib ]]; then
    export RPI5_DIR="${_rpi5_lib_dir%/scripts/lib}"
  else
    # Fall back to the canonical repository root: scripts are only ever
    # sourced from `deploy/rpi5/scripts/`. Anything else is a caller
    # bug we want to surface loudly.
    rpi5_die "could not resolve RPI5_DIR from $_rpi5_lib_dir — is this script being sourced correctly?"
  fi
fi
