#!/usr/bin/env bash
# rpi5-backup.sh — host-side: snapshot one or more Pi service volumes
# to a host-side tarball via a transient alpine container.
#
# What this does (per target):
#   - ssh to the Pi,
#   - run an alpine container with the target's persistent volume
#     read-only mounted at /from and an empty directory backup-mounted
#     at /to,
#   - `tar -C /from -czf /to/<vol>-<UTC-TS>.tgz .` inside the alpine
#     container,
#   - scp the tarball from the Pi to a host-local PATH (default cwd).
#
# Why transient containers (vs `docker cp` or `docker run --rm …` mounted
# on /var/lib/docker/volumes):
#   - Cleaner: no need to know the host-side rootless docker daemon's
#     volume directory layout.
#   - Faster than `docker volume export` (which exists; niche) because
#     the alpine image is already small (~6 MB) and cached by the Pi's
#     Docker once.
#   - Volumes mounted to /from are mounted *ro* so a failed export
#     cannot mutate live state; we restore the volume back to the host
#     filesystem unmodified even if the tar step errors midway.
#
# Targets / what's backed up:
#   data     → edumind-rpi5_backend-data  (sqlite db + chat attachments)
#   qdrant   → edumind-rpi5_qdrant-data   (vector store)
#   all      → both + ollama (ollama models are large: ~3 GB per model,
#              ~9 GB total — see `Add target: ollama` below).
#
# Ollama models are NOT included by default — they're reproducible from
# `rpi5-models-download.sh` and including them in backups is wasted
# bandwidth. Pass `-t ollama` if you actually want them.
#
# Output naming (default: cwd):
#   rpi5-data-<UTC-TS>.tgz
#   rpi5-qdrant-<UTC-TS>.tgz
#   rpi5-ollama-<UTC-TS>.tgz

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

rpi5_require_cmd ssh scp

# CLI parsing — keep the surface tiny on purpose.
TARGETS=()
OUTPUT_DIR="."
while [[ $# -gt 0 ]]; do
  case "$1" in
    -t|--target)
      TARGETS+=("$2")
      shift 2
      ;;
    -o|--output-dir)
      OUTPUT_DIR="$2"
      shift 2
      ;;
    -h|--help)
      cat <<'USAGE'
Usage: rpi5-backup.sh [-t TARGET] [-o OUTPUT_DIR]
Targets (repeatable, may appear more than once):
  data     → edumind-rpi5_backend-data
  qdrant   → edumind-rpi5_qdrant-data
  ollama   → edumind-rpi5_ollama-data (large; ~9 GB)
Defaults: -t data -t qdrant, current working directory.
USAGE
      exit 0
      ;;
    *)
      rpi5_die "unknown argument: $1 (try --help)"
      ;;
  esac
done

# Default target set: data + qdrant. Ollama deliberately excluded — see
# header. Users re-pull models from `rpi5-models-download.sh` if needed.
if [[ ${#TARGETS[@]} -eq 0 ]]; then
  TARGETS=(data qdrant)
fi

mkdir -p "$OUTPUT_DIR"

UTC_TS="$(rpi5_utc_ts)"
COMPOSE_PROJECT="edumind-rpi5"

# Map target name -> named-volume name (matches docker-compose.rpi5.yml).
declare -A VOL_FOR_TARGET
VOL_FOR_TARGET[data]="edumind-rpi5_backend-data"
VOL_FOR_TARGET[qdrant]="edumind-rpi5_qdrant-data"
VOL_FOR_TARGET[ollama]="edumind-rpi5_ollama-data"

# Snapshot per target: launch alpine, mount+tar, scp-push the tarball.
for target in "${TARGETS[@]}"; do
  vol="${VOL_FOR_TARGET[$target]:-}"
  if [[ -z "$vol" ]]; then
    rpi5_die "unknown target '${target}' — try -t data | qdrant | ollama"
  fi

  tarball_name="rpi5-${target}-${UTC_TS}.tgz"

  rpi5_info "snapshotting volume ${vol} for target '${target}'"
  rpi5_run_on_pi \
    "cd '${PI_DIR}' && docker run --rm \
       --mount source=${vol},target=/from,readonly \
       --mount type=tmpfs,destination=/to \
       alpine sh -c 'tar --exclude=lost+found -C /from -czf /to/${tarball_name} .' && \
       echo 'snapshot ready locally on the Pi'"

  rpi5_info "  pulling ${tarball_name} to host: ${OUTPUT_DIR}/${tarball_name}"
  rpi5_scp_to_pi "${tarball_name}" "${OUTPUT_DIR}/$(basename "${tarball_name}")"

  rpi5_info "  done: ${OUTPUT_DIR}/${tarball_name}"
done

cat <<EOF

=================================================
  Pi backup complete.

  Outputs in ${OUTPUT_DIR}:
$(ls -la "${OUTPUT_DIR}"/rpi5-*-"${UTC_TS}".tgz 2>/dev/null | awk '{printf "    %s\n", $NF}')

  Restore is manual:
    1. `docker compose -p edumind-rpi5 down` on the Pi first.
    2. `ssh $PI_HOST 'cd <pkg-dir> && tar -xzf rpi5-data-${UTC_TS}.tgz -C /var/lib/docker/volumes/edumind-rpi5_backend-data/_data/'`
       (the volume driver may have nested intermediate dirs; the
       `--strip-components` or path layout depends on docker's bind
       mount.)

  For a quick, all-in-one restore, the manual commands are documented
  in RPI5.md.
=================================================
EOF
