# syntax=docker/dockerfile:1.6
#
# Milestone 5.1 (Secure LaTeX Compilation Service) Part 2/8 — a minimal,
# pinned TeX Live runtime plus a small FastAPI wrapper. Deliberately its
# OWN image (Part 1) — never folded into rag-backend, frontend, Ollama,
# Qdrant, or evidence-service.
#
# Package set is the conservative minimum that compiles EduM8's default
# Writing template (article class, utf8/fontenc/lmodern, plain-style
# BibTeX) — NOT texlive-full (which the Debian archive ships at several
# GB). See the Milestone 5.1 report's "Disk/Image Impact" section for
# the real measured size this produced, and Part 2's "only packages
# required by EduM8's default Writing template need to compile" — a
# manuscript that needs a package outside this set fails with a clear
# "File `X.sty' not found" diagnostic (Part 22) rather than silently
# installing more packages at runtime (which the read-only root
# filesystem — see docker-compose.oracle.yml — would refuse anyway).
#
# Built for native arm64 (Oracle host — see evidence-service/Dockerfile's
# identical reasoning for why this repo's service images target arm64
# directly rather than staying platform-generic).
FROM --platform=linux/arm64 python:3.12-slim-bookworm AS runtime

ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

# texlive-latex-base:       latex/pdflatex binaries + core classes (article, report, book)
# texlive-latex-recommended: commonly used packages (geometry, hyperref, natbib, inputenc, fontenc, ...)
# texlive-fonts-recommended: the extra CM-family fonts most templates assume are present
# lmodern:                  Latin Modern fonts — better outline/Type1 rendering + wider
#                            accented-Latin (Unicode-via-inputenc) glyph coverage than
#                            the bare Computer Modern fonts (Part 3's compiler-choice
#                            investigation: pdflatex + utf8 inputenc + fontenc T1 + lmodern
#                            covers the accented-Latin academic-title case EduM8 actually
#                            needs; true multi-script Unicode — CJK, Arabic — is explicitly
#                            NOT supported by this M5.1 scope, see the report's "Known
#                            Limitations" — that would call for xelatex/lualatex + fontspec
#                            and a materially larger image, deferred until there's a real
#                            product need for it).
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        texlive-latex-base \
        texlive-latex-recommended \
        texlive-fonts-recommended \
        lmodern \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && rm -rf /var/cache/apt/archives/*

WORKDIR /app

# Installs runtime dependencies directly (fastapi/uvicorn/pydantic*)
# without packaging this app itself as a wheel — simpler than a
# build-backend round trip for four pinned dependencies, and this image
# never needs `edumind-latex-compiler` importable as an installed
# package from anywhere other than /app (uvicorn is invoked with /app as
# its cwd below).
COPY pyproject.toml ./
RUN pip install --no-cache-dir \
        "fastapi>=0.115,<1.0" \
        "uvicorn>=0.30,<1.0" \
        "pydantic>=2.7,<3.0" \
        "pydantic-settings>=2.3,<3.0"

COPY app /app/app

# Non-root, matching evidence-service/Dockerfile's convention. UID 10003
# picked to avoid collision with the other two services' pinned UIDs
# (backend 10001, evidence-service 10002) — not load-bearing (each runs
# in its own container/PID namespace), just a project-wide convention of
# never reusing a UID by coincidence across sibling images.
RUN groupadd --system --gid 10003 compiler \
    && useradd  --system --uid 10003 --gid compiler --create-home --home-dir /app compiler \
    && mkdir -p /tmp/jobs \
    && chown -R compiler:compiler /app /tmp/jobs

# Part 7 — pre-warm TeX's format caches (fmtutil) as root, at build time,
# so the runtime user (on a read-only root filesystem — see
# docker-compose.oracle.yml's `read_only: true`) never needs to write
# into texmf-var itself. A throwaway compile in a temp dir proves the
# toolchain works AND primes the format cache in one step.
RUN mkdir -p /tmp/warm && cd /tmp/warm \
    && printf '\\documentclass{article}\\usepackage[utf8]{inputenc}\\usepackage[T1]{fontenc}\\usepackage{lmodern}\\begin{document}warm\\end{document}' > main.tex \
    && pdflatex -no-shell-escape -interaction=nonstopmode main.tex > /dev/null \
    && cd / && rm -rf /tmp/warm

USER compiler

EXPOSE 8200

# No `ports:` published anywhere in compose (Part 1: "Browser should NOT
# call the compiler service directly") — EXPOSE here only documents the
# container-internal port.
#
# --workers 1: the BoundedJobExecutor's admission accounting lives in one
# process's memory (Part 11) — a second uvicorn worker would enforce its
# OWN, independent concurrency limit, doubling real concurrent pdflatex
# load on a host that already has none to spare (see the Milestone 5.1
# report's "Host Resilience" section). Mirrors evidence-service's
# identical one-worker reasoning.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8200", "--workers", "1"]
