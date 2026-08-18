r"""Milestone 5.1 Part 4/6/9/10/18/19 — the actual pdflatex/bibtex
subprocess orchestration. Every safety property this service promises
lives in this one module:

* Part 4 (shell escape disabled): `-no-shell-escape` on every pdflatex
  invocation, and every subprocess is launched via
  `asyncio.create_subprocess_exec` with an explicit argv list — never
  `shell=True`, never string interpolation into a shell command, so
  there is no shell for a `\write18` or any other injected command to
  run in even if `-no-shell-escape` had been forgotten.
* Part 6 (filesystem isolation / absolute-path & traversal defense):
  `-cnf-line=openin_any=p` and `-cnf-line=openout_any=p` — kpathsea's
  own "paranoid" mode, which refuses to open any path that is absolute
  or contains a `..` component, so `\input{/etc/passwd}` or
  `\include{../../etc/shadow}` fail closed inside TeX itself, on top of
  the container-level read-only-root-fs + tmpfs-only-workdir isolation
  (Part 6/7 — see the Dockerfile and docker-compose.oracle.yml).
* Part 9 (bounded process count): every subprocess is launched in its
  own new session (`start_new_session=True`) so its PID becomes a
  process-group leader; Part 10's timeout kill targets that whole group
  (`os.killpg`), not just the one PID, so an attacker who forks
  children cannot outlive the timeout by escaping the direct child
  relationship.
* Part 10 (hard timeout): each individual subprocess phase has its own
  wall-clock budget (`settings.phase_timeout_seconds`); the caller
  (app/main.py, via app/concurrency.py's BoundedJobExecutor) also
  enforces a whole-job budget across all phases combined.
* Part 18 (cleanup on every path): the job's working directory is
  removed in a `finally` block that runs on success, LaTeX error,
  timeout, AND any unexpected exception — see `run_compile_job`.
* Part 19 (correct BibTeX pipeline): pdflatex -> [bibtex if the .aux
  file actually requests one] -> pdflatex -> pdflatex. Never assumed —
  see `_needs_bibtex`.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import shutil
import signal
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path

from app.config import Settings
from app.log_sanitizer import extract_diagnostics, sanitize_log
from app.schemas import CompileResponse, Diagnostic

logger = logging.getLogger("latex_compiler")

# A minimal, fixed environment — deliberately NOT `os.environ` wholesale
# (Part 15/23: never let host/container environment variables leak into
# a subprocess a malicious manuscript might find some way to introspect
# via a TeX primitive). HOME points inside the job's own tmpfs working
# directory so any incidental config-dir write (some TeX tools probe
# `~/.texlive*`) lands somewhere already covered by cleanup, never on
# the read-only root filesystem.
_BASE_ENV = {
    "PATH": "/usr/bin:/bin",
    "LC_ALL": "C.UTF-8",
    "LANG": "C.UTF-8",
}


class OutputTooLargeError(Exception):
    pass


@dataclass
class PhaseResult:
    exit_code: int
    log: str
    timed_out: bool = False


@dataclass
class CompileOutcome:
    status: str  # "success" | "error" | "timeout"
    diagnostics: list[Diagnostic] = field(default_factory=list)
    log_excerpt: str = ""
    duration_ms: float = 0.0
    pdf_bytes: bytes | None = None
    page_count: int | None = None


def _job_env(workdir: Path) -> dict[str, str]:
    env = dict(_BASE_ENV)
    env["HOME"] = str(workdir)
    # M5.5.3 continuation — real-world finding from the Springer Nature
    # journal fixture: its many `.bst` citation-style files ship nested
    # one level down, in a "bst/" subfolder next to the root .tex, not
    # as a direct sibling (unlike every `.cls`/`.sty` case seen so far).
    # kpathsea's stock texmf.cnf gives BSTINPUTS a bare "." entry for
    # the working directory — NOT recursive — so bibtex genuinely could
    # not find `bst/sn-basic.bst` from a plain `\bibliographystyle
    # {sn-basic}` (confirmed by direct reproduction: "I couldn't open
    # style file sn-basic.bst"). The trailing "//" here means "this
    # directory AND all its subdirectories"; the trailing bare ":"
    # means "then fall through to the compiled-in default path" (so
    # texmf-installed styles keep resolving exactly as before). This
    # only widens the search *within* the job's own already-jailed
    # workdir (still confined by safe_relative_path() at write time and
    # by kpathsea's own openin_any=p for pdflatex) — no new directory
    # outside the sandbox becomes reachable. BIBINPUTS/TEXINPUTS get the
    # identical treatment for the same reason, even though no real
    # fixture has needed it yet for `.bib`/`.cls`/`.sty` specifically —
    # keeping all three consistent avoids this exact bug recurring for
    # whichever one a future real template happens to nest first.
    env["BSTINPUTS"] = ".//:"
    env["BIBINPUTS"] = ".//:"
    env["TEXINPUTS"] = ".//:"
    return env


def safe_relative_path(rel_path: str, workdir: Path) -> Path | None:
    """Milestone 5.3 Part 18/19/45 — a SECOND, independent traversal
    check on top of kpathsea's `openin_any=p`/`openout_any=p` (Part 6,
    still in force via _PDFLATEX_ARGS below) and on top of the calling
    backend's own path validation (rag-backend's
    app/core/writing_file_validation.py, which structurally never lets a
    "../"-bearing string become a WritingProjectFile name in the first
    place). This service has no way to know whether the caller actually
    enforced that — Part 45's "defense in depth, not a substitute" — so
    it re-derives safety from first principles here: reject an absolute
    path outright, reject any path with a literal ".." path segment,
    then resolve it against the job's own workdir and reject anything
    that doesn't land strictly inside it. Returns None for anything
    unsafe (the caller treats that as a hard compile error, never a
    silent skip — Part 18: never mislead the user about what the job
    actually did)."""
    if not rel_path or rel_path in {".", ".."}:
        return None
    candidate_raw = Path(rel_path)
    if candidate_raw.is_absolute():
        return None
    if ".." in candidate_raw.parts:
        return None
    resolved_workdir = workdir.resolve()
    candidate = (resolved_workdir / candidate_raw).resolve()
    try:
        candidate.relative_to(resolved_workdir)
    except ValueError:
        return None
    return candidate


async def _run_phase(
    argv: list[str], *, cwd: Path, env: dict[str, str], timeout_seconds: float
) -> PhaseResult:
    """Launches one subprocess (pdflatex or bibtex), in its own session
    so the whole process group can be killed together, with a hard
    wall-clock timeout. Never raises on a LaTeX-level failure (a nonzero
    exit code) — only on genuine infrastructure failure (e.g. the binary
    itself is missing), which the caller lets propagate as a 500 rather
    than mislabel as a manuscript error."""
    proc = await asyncio.create_subprocess_exec(
        *argv,
        cwd=str(cwd),
        env=env,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
        start_new_session=True,
    )
    try:
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout_seconds)
        return PhaseResult(exit_code=proc.returncode or 0, log=stdout.decode("utf-8", "replace"))
    except TimeoutError:
        _kill_process_group(proc.pid)
        # Reap the now-terminated process so it doesn't linger as a zombie.
        try:
            await asyncio.wait_for(proc.wait(), timeout=5.0)
        except TimeoutError:
            logger.warning("process group %s did not exit after SIGKILL", proc.pid)
        return PhaseResult(exit_code=-1, log="", timed_out=True)
    except asyncio.CancelledError:
        # The whole job was cancelled (outer job timeout) while this
        # phase was mid-flight — Part 10/18: kill the group, then let
        # cancellation continue propagating (never swallow it).
        _kill_process_group(proc.pid)
        raise


def _kill_process_group(pid: int) -> None:
    try:
        pgid = os.getpgid(pid)
        os.killpg(pgid, signal.SIGKILL)
    except ProcessLookupError:
        pass  # already exited


def _needs_bibtex(aux_path: Path) -> bool:
    """Part 19: only run bibtex if the .aux file actually contains a
    `\\bibdata` command — i.e. the manuscript itself used
    `\\bibliography{...}`. Running bibtex unconditionally on a manuscript
    with no bibliography command errors out ("I couldn't open the
    database file"), which would incorrectly fail manuscripts that never
    cite anything (Part 20: the default project — no citations — must
    always compile cleanly)."""
    if not aux_path.exists():
        return False
    try:
        content = aux_path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return False
    return "\\bibdata{" in content


def _extract_page_count(log: str) -> int | None:
    """Best-effort only — pdflatex's own stdout reports `Output written
    on main.pdf (N pages, ...)` on a clean run. Never guessed if absent."""
    m = re.search(r"Output written on \S+ \((\d+) pages?,", log)
    return int(m.group(1)) if m else None


_PDFLATEX_ARGS = [
    "pdflatex",
    "-no-shell-escape",
    "-interaction=nonstopmode",
    "-halt-on-error",
    "-file-line-error",
    "-cnf-line=openin_any=p",
    "-cnf-line=openout_any=p",
    "main.tex",
]


async def run_compile_job(
    *,
    main_tex: str,
    references_bib: str,
    settings: Settings,
    extra_files: dict[str, bytes] | None = None,
) -> CompileOutcome:
    """The full multi-pass pipeline for one compile job. Always cleans up
    its own working directory (Part 18), regardless of outcome —
    including on cancellation, which is why the cleanup lives in a
    `finally` block wrapping the entire pipeline, not just the happy
    path.

    Milestone 5.3 Part 17/18/19/20 — `extra_files` (relative path ->
    raw bytes, already base64-decoded by app/main.py) are the project's
    OTHER compile-relevant files: additional `.tex` sources for
    `\\input{}`/`\\include{}`, allowed `.cls`/`.sty` style files, and
    figure/PDF assets for `\\includegraphics{}`. Every path is
    re-validated by safe_relative_path() before anything is written —
    see that function's own docstring for why this is a second,
    independent check rather than trusting the caller."""
    start = time.perf_counter()
    # A fresh, randomly-named directory under the tmpfs-mounted working
    # root — never derived from caller-supplied input (Part 6: no path
    # traversal via a crafted job id).
    workdir = Path(settings.working_root) / uuid.uuid4().hex
    workdir.mkdir(parents=True, exist_ok=False, mode=0o700)
    env = _job_env(workdir)
    all_log_parts: list[str] = []

    try:
        (workdir / "main.tex").write_text(main_tex, encoding="utf-8")
        (workdir / "references.bib").write_text(references_bib, encoding="utf-8")

        for rel_path, data in (extra_files or {}).items():
            dest = safe_relative_path(rel_path, workdir)
            if dest is None:
                # Unreachable in normal operation (the calling backend
                # never sends an unsafe path) — a hard, honest error
                # rather than silently dropping the file and compiling
                # an incomplete project (Part 18).
                return CompileOutcome(
                    status="error",
                    diagnostics=[
                        Diagnostic(
                            severity="error",
                            message=f"Rejected unsafe project file path: {rel_path!r}",
                        )
                    ],
                    duration_ms=(time.perf_counter() - start) * 1000,
                )
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(data)

        pass1 = await _run_phase(
            _PDFLATEX_ARGS, cwd=workdir, env=env, timeout_seconds=settings.phase_timeout_seconds
        )
        all_log_parts.append(pass1.log)
        if pass1.timed_out:
            return _finish_timeout(all_log_parts, start, workdir)

        aux_path = workdir / "main.aux"
        ran_bibtex = False
        if _needs_bibtex(aux_path):
            ran_bibtex = True
            bibtex_result = await _run_phase(
                ["bibtex", "main"],
                cwd=workdir,
                env=env,
                timeout_seconds=settings.phase_timeout_seconds,
            )
            all_log_parts.append(bibtex_result.log)
            if bibtex_result.timed_out:
                return _finish_timeout(all_log_parts, start, workdir)
            # A bibtex-level error (e.g. malformed .bib) is surfaced via
            # diagnostics after the final pdflatex pass re-reads the same
            # log content, not treated as fatal here — pdflatex still
            # runs and produces a PDF with "?" citations, which is more
            # useful to the user than no PDF at all.

        passes_needed = 3 if ran_bibtex else 2
        last_pass: PhaseResult | None = None
        for _ in range(passes_needed):
            last_pass = await _run_phase(
                _PDFLATEX_ARGS,
                cwd=workdir,
                env=env,
                timeout_seconds=settings.phase_timeout_seconds,
            )
            all_log_parts.append(last_pass.log)
            if last_pass.timed_out:
                return _finish_timeout(all_log_parts, start, workdir)

        combined_log = "\n".join(all_log_parts)
        duration_ms = (time.perf_counter() - start) * 1000
        pdf_path = workdir / "main.pdf"

        assert last_pass is not None
        # Diagnostics come from ONLY the final pass's own log, never the
        # full multi-pass concatenation — a citation that shows
        # "undefined" on pass 2 (before bibtex's .bbl has been read into
        # a fresh .aux) but resolves cleanly by the final pass would
        # otherwise surface a stale, misleading warning even though the
        # actual compiled PDF has it correctly resolved. `log_excerpt`
        # (the full history, for the expandable raw view) intentionally
        # keeps every pass — only the primary structured diagnostics
        # list is scoped to final state.
        if last_pass.exit_code != 0 or not pdf_path.exists():
            return CompileOutcome(
                status="error",
                diagnostics=extract_diagnostics(last_pass.log),
                log_excerpt=sanitize_log(combined_log, workdir_label=str(workdir)),
                duration_ms=duration_ms,
            )

        pdf_bytes = pdf_path.read_bytes()
        if len(pdf_bytes) > settings.max_pdf_output_bytes:
            return CompileOutcome(
                status="error",
                diagnostics=[
                    Diagnostic(
                        severity="error",
                        message=(
                            f"Compiled PDF exceeds the {settings.max_pdf_output_bytes} byte limit."
                        ),
                    )
                ],
                log_excerpt=sanitize_log(combined_log, workdir_label=str(workdir)),
                duration_ms=duration_ms,
            )

        return CompileOutcome(
            status="success",
            diagnostics=extract_diagnostics(last_pass.log),
            log_excerpt=sanitize_log(combined_log, workdir_label=str(workdir)),
            duration_ms=duration_ms,
            pdf_bytes=pdf_bytes,
            page_count=_extract_page_count(last_pass.log),
        )
    finally:
        # Part 18 — unconditional cleanup. shutil.rmtree on a
        # tmpfs-backed directory is fast and never leaves .aux/.log/.pdf/
        # .bbl/.blg artifacts behind for the next job or a future
        # request to stumble over.
        shutil.rmtree(workdir, ignore_errors=True)


def _finish_timeout(log_parts: list[str], start: float, workdir: Path) -> CompileOutcome:
    combined_log = "\n".join(log_parts)
    return CompileOutcome(
        status="timeout",
        diagnostics=[Diagnostic(severity="error", message="Compilation timed out.")],
        log_excerpt=sanitize_log(combined_log, workdir_label=str(workdir)),
        duration_ms=0.0,
    )


def to_response(outcome: CompileOutcome) -> CompileResponse:
    import base64

    return CompileResponse(
        status=outcome.status,  # type: ignore[arg-type]
        diagnostics=outcome.diagnostics,
        log_excerpt=outcome.log_excerpt,
        duration_ms=round(outcome.duration_ms, 2),
        pdf_base64=(
            base64.b64encode(outcome.pdf_bytes).decode("ascii")
            if outcome.pdf_bytes is not None
            else None
        ),
        pdf_size_bytes=len(outcome.pdf_bytes) if outcome.pdf_bytes is not None else None,
        page_count=outcome.page_count,
    )
