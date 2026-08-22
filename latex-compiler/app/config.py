"""Milestone 5.1 (Secure LaTeX Compilation Service) Part 9/10/11 — every
tunable safety limit lives here, with conservative defaults chosen for
the Oracle host's real, tight resource budget (4 OCPUs / 24GB RAM, with
qdrant/evidence-service/backend already reserving 3.5 of those 4 OCPUs —
see the Milestone 5.1 report's "Host Resilience" section for the actual
numbers this was derived from). Nothing here is loaded from the shared
backend .env.oracle file — this service is deliberately isolated from
that secret bundle (see evidence-service/app/config.py's own precedent,
which this mirrors)."""

from __future__ import annotations

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="LATEX_COMPILER_", extra="ignore")

    # Milestone 5.1 Part 11 — exactly one compile runs at a time by
    # default. Conservative starting point, matching evidence-service's
    # own documented precedent of starting at concurrency=1 on this same
    # host and only raising it after a real measured need — see
    # app/concurrency.py's BoundedJobExecutor, which this configures.
    concurrency: int = 1
    queue_depth: int = 4

    # Milestone 5.1 Part 10 — every subprocess phase (a single pdflatex
    # or bibtex invocation) gets its own hard wall-clock budget; the
    # whole job (multiple phases) gets a separate, larger budget. Chosen
    # empirically-conservative for a short academic manuscript, not
    # copied from the spec's own example range without justification —
    # see the Milestone 5.1 report's "Compile Performance" section for
    # the real measured numbers behind these.
    phase_timeout_seconds: float = 20.0
    job_timeout_seconds: float = 45.0

    # Milestone 5.1 Part 12/9 — exactly two input files, both bounded.
    # 200KB comfortably exceeds the ~30KB "large manuscript" fixture
    # used in Milestone 5's own 100-reference performance gate.
    max_main_tex_bytes: int = 200_000
    max_references_bib_bytes: int = 500_000

    # Milestone 5.1 Part 9 — defends against an output-bomb fixture
    # (e.g. \loop filling pages forever within the phase timeout window).
    max_pdf_output_bytes: int = 20_000_000

    # Milestone 5.1 Part 9 — PIDs a single compile job's process group is
    # allowed to hold at once (pdflatex/bibtex plus any child kpathsea
    # helper it spawns). Generous headroom over the 2-3 processes a
    # normal compile actually uses, tight enough to bound a fork-bomb
    # fixture; see docker-compose.oracle.yml's own `pids_limit` for the
    # container-wide backstop this pairs with.
    max_job_processes: int = 32

    working_root: str = "/tmp/jobs"

    # Milestone 5.3 Part 12/17/18 — mirrors rag-backend's own
    # MAX_FILES_PER_PROJECT/MAX_TEXT_FILE_CONTENT_CHARS/
    # MAX_BINARY_FILE_BYTES/MAX_PROJECT_TOTAL_STORAGE_BYTES (see that
    # service's app/db/models_writing.py) — checked here TOO, never
    # trusting the caller (Part 45: "defense in depth", the same posture
    # max_main_tex_bytes above already takes even though the caller is
    # always our own backend).
    max_extra_files_count: int = 150
    max_extra_file_bytes: int = 15_000_000
    max_extra_files_total_bytes: int = 100_000_000

    # SyncTeX implementation — a real .synctex.gz for a short academic
    # manuscript is a few KB; generous headroom (still tiny next to
    # max_pdf_output_bytes) rather than a tight guess. `synctex edit`
    # itself is a near-instant read-only query (no TeX engine invoked at
    # all) — its own timeout is correspondingly much smaller than a
    # compile phase's.
    max_synctex_bytes: int = 5_000_000
    synctex_edit_timeout_seconds: float = 10.0
