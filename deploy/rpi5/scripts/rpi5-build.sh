#!/usr/bin/env bash
# rpi5-build.sh — host-side cross-build (OPTIONAL).
#
# This is an EXTRAS convenience. The default deployment path builds the
# backend image directly on the Pi (much faster, no QEMU emulation, no
# large image tar to SCP). rpi5-build.sh is for two scenarios:
#   1. The Pi has no internet for `docker compose pull / build`, so
#      the host builds the image, saves it to a tarball, and SCPs it
#      across.
#   2. The user wants the source-of-truth build to live on the host
#      (e.g. for tighter CI integration).
#
# Build output: a `edumind-rpi5-backend:<tag>` image on the host + an
# optional .tar via `docker save`. The host can then SCP the tar to the
# Pi where `docker load` makes it available to docker-compose.
#
# Cross-build mechanics:
#   - On Apple Silicon Macs: `docker buildx build --platform linux/arm64`
#     is native. No QEMU/emulation required.
#   - On Intel Macs: buildx uses QEMU binfmt for arch emulation — slow
#     for any non-trivial image (Python + pymupdf, few minutes on a
#     busy run). It works; just slow. Expect ~5-10 min per build.
#
# IMPORTANT: tagging the image `edumind-rpi5-backend:<tag>` matching
# what docker-compose.rpi5.yml's `image:` field could be set to is the
# only thing that makes the host-built image seamlessly used by the Pi
# (otherwise compose would rebuild). Today the compose references `build:`
# rather than `image:`, so this script only saves the host-built image
# out; the compose on the Pi still runs `docker compose build` and would
# rebuild from scratch (we could change the compose to use a pre-built
# image + `docker save/load` but that complicates the default path).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

rpi5_require_cmd docker

TAG="${RPI5_BUILD_TAG:-$(rpi5_utc_ts)}"
IMAGE_LOCAL="edumind-rpi5-backend:${TAG}"

rpi5_info "host-side cross-build for:  $IMAGE_LOCAL  (platform: linux/arm64)"

# `docker buildx` with a single --platform makes it deterministic on
# Apple Silicon AND Intel. `--load` parks the resulting image in the
# host's local image store, so subsequent `docker save` succeeds.
docker buildx build \
  --platform linux/arm64 \
  --tag "$IMAGE_LOCAL" \
  --load \
  --file "${RPI5_DIR}/../../deploy/rpi5/Dockerfile.rpi5" \
  "${RPI5_DIR}/../../rag-backend"

# The rpi5-deploy package expects the tarball filename to encode the
# UTC timestamp. We use the same ts the on-Pi flow would have generated.
UTC_TS="$TAG"
PI_LOAD_TAR="${RPI5_DIR}/../../edumind-rpi5-image-${UTC_TS}.tar"

cat <<EOF

=================================================
  Built host-side image:

  Local image: $IMAGE_LOCAL

  To ship this image to the Pi, save it to a tarball and SCP:

    docker save $IMAGE_LOCAL -o $PI_LOAD_TAR
    scp $PI_LOAD_TAR  $PI_HOST:~/
    ssh $PI_HOST  'docker load -i ~/$(basename $PI_LOAD_TAR)'

  Then on the Pi, re-run rpi5-start.sh (compose will detect and use the
  pre-built image, no rebuild required).

  Cleanup on host (after Pi has loaded the image):

    docker rmi $IMAGE_LOCAL
    rm $PI_LOAD_TAR

  (skip this if you instead want to publish the image to a registry
  the Pi pulls from — but that's expected of a multi-Pi fleet, not this
  single-Pi deployment.)
=================================================
EOF
