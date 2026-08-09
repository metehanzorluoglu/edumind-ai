# syntax=docker/dockerfile:1.6
#
# Standalone image for the EduM8 evidence-service (Milestone 11 §29) —
# NLI/entailment classification only. Never imports rag-backend's `app.*`
# package; never talks to Postgres/SQLite, Qdrant, or Ollama. Deployed as
# its own container on the internal Docker network only (see
# deploy/oracle/docker-compose.oracle.yml's evidence-service block) — no
# host port is ever published (Milestone 11 §7/§40).
#
# Built for native arm64 (Oracle host — see deploy/rpi5/Dockerfile.rpi5's
# equivalent comment for the same reasoning: this repo's other backend
# image already targets arm64 the same way).

# ----------------------------------------------------------------------------
# Builder: resolves + installs pinned dependencies (torch/transformers are
# the two heavy ones — see pyproject.toml's comment on why these specific
# versions). No compiler toolchain needed beyond what pip's own wheels
# already ship for torch/transformers on arm64 (no C-extension build from
# source here, unlike rag-backend's pymupdf/cryptography wheels).
# ----------------------------------------------------------------------------
FROM --platform=linux/arm64 python:3.12-slim-bookworm AS builder

ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    PYTHONDONTWRITEBYTECODE=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /install
COPY pyproject.toml ./

# torch FIRST, from PyTorch's own CPU-only wheel index, pinned to the
# exact `+cpu`-tagged build — see pyproject.toml's comment on why torch
# is deliberately NOT listed in `dependencies` and why this must be its
# own separate, explicitly-index-pinned, explicitly-version-pinned step:
# a plain `pip install .` afterwards resolving torch itself (rather than
# just accepting transformers' loose transitive dependency on it) would
# otherwise silently replace this with the CUDA-enabled build from
# default PyPI, pulling in ~1.5GB+ of unused nvidia-*/triton/cuda-toolkit
# packages this CPU-only, GPU-less host will never use (confirmed by a
# real build producing an 8.5GB image before this fix was applied).
RUN pip install --prefix=/install --no-cache-dir \
    --index-url https://download.pytorch.org/whl/cpu \
    "torch==2.13.0+cpu"

# Everything else from plain PyPI. `--no-deps` is NOT set here either —
# pip resolves the full remaining transitive tree (numpy, safetensors,
# huggingface-hub, tokenizers, fastapi, etc.) the same way
# deploy/rpi5/Dockerfile.rpi5 does for the backend image. transformers'
# own dependency on torch is unpinned/loose (no exact-version
# requirement of its own), so it accepts the already-installed `+cpu`
# build from the step above without pip re-resolving or replacing it.
RUN pip install --prefix=/install --no-cache-dir .

# ----------------------------------------------------------------------------
# Runtime: fresh slim image, no build toolchain, just the installed
# packages + application source. Non-root, matching the backend image's
# own hardening convention (deploy/rpi5/Dockerfile.rpi5).
# ----------------------------------------------------------------------------
FROM --platform=linux/arm64 python:3.12-slim-bookworm AS runtime

ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HOME=/app \
    # Overridden in compose by the model-cache volume mount — this default
    # only matters for a bare `docker run` without that mount (Milestone
    # 10 §41 / Milestone 11 §10: never re-download the ~1.35GB model on
    # every restart when the volume IS mounted).
    EVIDENCE_SERVICE_HF_HOME=/model-cache

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /install /usr/local

COPY app /app/app

WORKDIR /app

RUN groupadd --system --gid 10002 evidence \
    && useradd  --system --uid 10002 --gid evidence --create-home --home-dir /app evidence \
    && mkdir -p /model-cache \
    && chown -R evidence:evidence /app /model-cache

USER evidence

EXPOSE 8100

# No public route to this port anywhere (Milestone 11 §7/§40) — EXPOSE
# here only documents the container-internal port; the compose file never
# maps it to a host port.
#
# --workers 1 is deliberate, not a default left unconsidered: the model
# and the BoundedInferenceExecutor's concurrency accounting
# (app/concurrency.py) both live in one process's memory. A second
# uvicorn worker would load a SECOND full copy of the ~1.6GB model and
# enforce its OWN, independent concurrency=1 limit — reproducing exactly
# the in-process multi-worker duplication problem Milestone 10 §26
# rejected for the backend itself (2 workers x 1.6GB), just one level
# down. One worker, one model, one enforced concurrency limit.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8100", "--workers", "1"]
