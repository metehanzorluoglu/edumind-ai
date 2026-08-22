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

Milestone 5.5.4 (LaTeX Template Compatibility Gate) added one more
pre-pass, ahead of pass 1: deterministic EPS->PDF conversion (see
`_convert_eps_assets`/`_rewrite_eps_includegraphics`). The real,
unmodified Springer Nature fixture (and real academic manuscripts in
general) embed figures as `\includegraphics{fig.eps}` with an EXPLICIT
`.eps` extension — pdflatex cannot place EPS directly, and standard
TeX Live's own answer to this (the `epstopdf` package) requires
TeX-level shell-escape, which Part 4 above permanently forbids. Instead
this service converts every EPS asset to PDF itself, via a small, fixed
Ghostscript subprocess call it owns and controls directly (never
reachable from the manuscript's own TeX code, never routed through
`\write18`), then rewrites only the exact, literal `.eps` references it
just converted to point at the generated `.pdf` — never a blind/guessed
substitution. This keeps `-no-shell-escape` intact and adds no new
capability the manuscript itself can invoke.
"""

from __future__ import annotations

import asyncio
import logging
import math
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
    # SyncTeX implementation — the compiled manuscript's own SyncTeX
    # database (see `-synctex=1` on _PDFLATEX_ARGS below), read from the
    # job's workdir before it's torn down, same lifecycle as `pdf_bytes`:
    # only ever populated on a genuine successful compile (a failed/
    # timed-out pass never reaches main.pdf either, by construction —
    # `-halt-on-error` means neither file exists at all once pdflatex
    # actually halts). None whenever the file wasn't produced for any
    # reason (never treated as fatal on its own — a compile that
    # succeeds but somehow has no SyncTeX data still returns its PDF;
    # the caller (rag-backend) just has nothing to persist for inverse
    # search on that specific compile).
    synctex_bytes: bytes | None = None


@dataclass
class InverseSearchOutcome:
    """SyncTeX implementation — the result of one `synctex edit` inverse
    query (rendered-PDF click -> source location). `resolved=False` for
    every non-answer case (invalid input already rejected by the caller,
    an out-of-range page/coordinate, a genuinely missing SyncTeX record,
    a timed-out/crashed synctex process) — this service never guesses;
    the caller (rag-backend) treats `resolved=False` as "decline
    navigation," exactly like every other "no reliable match" case
    already established in this app's Writing workspace.

    `file` is a SOURCE-RELATIVE path only (e.g. "main.tex" or
    "sections/intro.tex") — never the absolute scratch-workdir path
    SyncTeX's own raw `Input:` line actually contains (see
    `_parse_inverse_search_output`'s own docstring for why that raw
    value must never leave this function)."""

    resolved: bool
    file: str | None = None
    line: int | None = None


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


async def _convert_eps_assets(
    workdir: Path,
    extra_files: dict[str, bytes],
    env: dict[str, str],
    timeout_seconds: float,
) -> tuple[dict[str, str], list[Diagnostic]]:
    """Milestone 5.5.4 — deterministic, sandboxed EPS->PDF pre-conversion.

    Converts every `.eps`/`.EPS` file already written under `workdir`
    (from `extra_files`) into a sibling `.pdf` via a single, fixed
    Ghostscript invocation per file — no LaTeX/`\\write18` involvement,
    same subprocess discipline as pdflatex/bibtex (`_run_phase`: own
    session, `killpg`-able, hard per-call timeout, argv-only, no shell).
    `-dPARANOIDSAFER` is Ghostscript's own strictest sandbox flag —
    forbids the EPS content itself from doing file/network I/O outside
    the two paths this call passes it. `-dEPSCrop` matches standard
    `epstopdf` behavior (crop to the EPS's own BoundingBox, the same
    visual result a real epstopdf-package conversion would produce).

    Returns (conversions, diagnostics) where `conversions` maps each
    original EPS's relative path to its new PDF's relative path (empty
    if there were no EPS files at all — the overwhelmingly common case,
    left as a no-op), and `diagnostics` is non-empty only if a real
    conversion failure occurred (a genuinely malformed/corrupt EPS) —
    the caller treats that as a hard compile error (Part 18's "never
    mislead the user about what the job actually did"), never a silent
    skip that would later surface as a confusing missing-figure PDF."""
    conversions: dict[str, str] = {}
    diagnostics: list[Diagnostic] = []
    eps_rel_paths = [p for p in extra_files if p.lower().endswith(".eps")]
    for rel_path in eps_rel_paths:
        eps_file = safe_relative_path(rel_path, workdir)
        if eps_file is None or not eps_file.exists():
            # Already rejected (unsafe path) or never written — nothing
            # to convert; the unsafe-path case already produced its own
            # hard error earlier in run_compile_job.
            continue
        pdf_file = eps_file.with_suffix(".pdf")
        result = await _run_phase(
            [
                "gs",
                "-q",
                "-dNOPAUSE",
                "-dBATCH",
                "-dPARANOIDSAFER",
                "-dEPSCrop",
                "-sDEVICE=pdfwrite",
                f"-sOutputFile={pdf_file.name}",
                eps_file.name,
            ],
            cwd=eps_file.parent,
            env=env,
            timeout_seconds=timeout_seconds,
        )
        if result.timed_out or result.exit_code != 0 or not pdf_file.exists():
            diagnostics.append(
                Diagnostic(
                    severity="error",
                    message=(
                        f"Could not convert embedded EPS figure {rel_path!r} to a "
                        "PDF-LaTeX-compatible format."
                    ),
                )
            )
            continue
        pdf_rel = rel_path[: -len(Path(rel_path).suffix)] + ".pdf"
        conversions[rel_path] = pdf_rel
    return conversions, diagnostics


_INCLUDEGRAPHICS_RE = re.compile(r"(\\includegraphics\s*(?:\[[^\]\n]*\])?\s*\{)([^}]*)(\})")


def _rewrite_eps_includegraphics(tex_source: str, conversions: dict[str, str]) -> str:
    """Milestone 5.5.4 — rewrites ONLY `\\includegraphics{...}` arguments
    that literally, exactly match an EPS file this job just converted
    (by its full relative path or bare basename — both common ways a
    manuscript references a root-level figure) to point at the new
    `.pdf` instead. Deliberately narrow: never touches an
    extensionless reference (pdflatex's own kpathsea extension search
    already finds the new sibling `.pdf` automatically once it exists
    on disk — no rewrite needed there) and never touches unrelated text
    (e.g. the real Springer fixture's own `\\verb+\\includegraphics
    {<eps-file>}+` documentation example inside a `verbatim` block,
    which can never match a real filename)."""
    if not conversions:
        return tex_source
    lookup: dict[str, str] = {}
    for eps_rel, pdf_rel in conversions.items():
        lookup[eps_rel.lower()] = pdf_rel
        lookup[Path(eps_rel).name.lower()] = Path(pdf_rel).name

    def _replace(match: re.Match[str]) -> str:
        prefix, arg, suffix = match.group(1), match.group(2), match.group(3)
        replacement = lookup.get(arg.strip().lower())
        if replacement is None:
            return match.group(0)
        return f"{prefix}{replacement}{suffix}"

    return _INCLUDEGRAPHICS_RE.sub(_replace, tex_source)


_PDFLATEX_ARGS = [
    "pdflatex",
    "-no-shell-escape",
    "-interaction=nonstopmode",
    "-halt-on-error",
    "-file-line-error",
    "-cnf-line=openin_any=p",
    "-cnf-line=openout_any=p",
    # SyncTeX implementation — generates main.synctex.gz alongside
    # main.pdf on every pass (only the LAST pass's copy is ever read —
    # see run_compile_job below — same "only the final state matters"
    # convention already established for main.pdf/diagnostics). A plain
    # pdflatex flag: no shell-escape interaction, no new capability the
    # manuscript's own TeX code can invoke, nothing for Part 4's
    # `-no-shell-escape` guarantee to interact with.
    "-synctex=1",
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

        # Milestone 5.5.4 — deterministic EPS->PDF pre-conversion, ahead of
        # pass 1 (see the module docstring and _convert_eps_assets' own
        # docstring for the full rationale). A no-op for the overwhelming
        # majority of projects (no .eps among extra_files).
        eps_conversions, eps_diagnostics = await _convert_eps_assets(
            workdir, extra_files or {}, env, settings.phase_timeout_seconds
        )
        if eps_diagnostics:
            return CompileOutcome(
                status="error",
                diagnostics=eps_diagnostics,
                duration_ms=(time.perf_counter() - start) * 1000,
            )

        main_tex_final = (
            _rewrite_eps_includegraphics(main_tex, eps_conversions)
            if eps_conversions
            else main_tex
        )
        (workdir / "main.tex").write_text(main_tex_final, encoding="utf-8")

        if eps_conversions:
            # Also rewrite any OTHER already-written .tex source (a
            # \input/\include'd file may be the one that actually embeds
            # the figure, not main.tex itself) — re-reading from disk
            # rather than the original extra_files bytes keeps this a
            # single code path regardless of where the file came from.
            for rel_path in extra_files or {}:
                if not rel_path.lower().endswith(".tex"):
                    continue
                dest = safe_relative_path(rel_path, workdir)
                if dest is None:
                    continue
                try:
                    original = dest.read_text(encoding="utf-8")
                except (OSError, UnicodeDecodeError):
                    # Not valid UTF-8 text — leave it untouched rather
                    # than risk corrupting a file we can't safely
                    # round-trip (Part 18: never silently damage project
                    # content). This has no bearing on the real Springer
                    # fixture, whose only EPS reference is in the root
                    # main.tex.
                    continue
                rewritten = _rewrite_eps_includegraphics(original, eps_conversions)
                if rewritten != original:
                    dest.write_text(rewritten, encoding="utf-8")

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

        # SyncTeX implementation — read BEFORE the `finally` block's
        # cleanup, same "read the bytes out of the doomed workdir while
        # it still exists" discipline pdf_bytes above already follows.
        # Never fatal if missing (see CompileOutcome.synctex_bytes's own
        # docstring) — a compile that produced a real PDF but somehow no
        # SyncTeX data still returns successfully; there's simply
        # nothing to persist for inverse search on that one compile.
        synctex_path = workdir / "main.synctex.gz"
        synctex_bytes = synctex_path.read_bytes() if synctex_path.exists() else None

        return CompileOutcome(
            status="success",
            diagnostics=extract_diagnostics(last_pass.log),
            log_excerpt=sanitize_log(combined_log, workdir_label=str(workdir)),
            duration_ms=duration_ms,
            pdf_bytes=pdf_bytes,
            page_count=_extract_page_count(last_pass.log),
            synctex_bytes=synctex_bytes,
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
        synctex_base64=(
            base64.b64encode(outcome.synctex_bytes).decode("ascii")
            if outcome.synctex_bytes is not None
            else None
        ),
    )


# SyncTeX implementation — `synctex edit`'s own result block always names
# the input file as TeX itself saw it: relative to the CURRENT WORKING
# DIRECTORY pdflatex actually ran in AT COMPILE TIME — NOT the inverse-
# search job's own scratch directory. This was confirmed the hard way
# (a real bug caught by this module's own round-trip tests, not assumed
# from documentation): a .synctex.gz file bakes in the absolute compile-
# time cwd permanently at generation time. By the time an inverse-search
# query runs against it — copied into an entirely new scratch directory,
# often long after the original compile's own workdir has already been
# rmtree'd — `Input:` still reports that ORIGINAL, now-nonexistent path,
# e.g. "/tmp/jobs/<original-compile-uuid>/./main.tex" or ".../sections/
# intro.tex". So this function does NOT (and structurally cannot) match
# against ITS OWN caller's workdir — that was the actual bug in an
# earlier version of this function, only caught because the real
# subprocess test suite (tests/test_compiler_subprocess.py) exercises a
# full compile -> inverse-search round trip, not a hand-crafted stdout
# fixture.
#
# The robust fix: SyncTeX always separates "the absolute cwd it ran in"
# from "the relative path as TeX opened it" with a literal "/./" marker
# (confirmed across every real compile in this file's own test suite,
# both single- and multi-file) — split on the FIRST such marker and keep
# only what follows. Anything that doesn't contain that marker at all is
# declined rather than guessed at (never a fuzzier "strip everything
# before the last few segments" heuristic that could accidentally leave
# a real absolute path fragment in what's returned to the caller). The
# caller (rag-backend) still independently validates the result maps to
# a real project file before ever using it — this is the first, and
# most important, layer of "never leak container filesystem internals"
# (the design report's own §9/§6 requirement).
_SYNCTEX_INPUT_CWD_MARKER = "/./"


def _parse_inverse_search_output(stdout: str) -> InverseSearchOutcome:
    if "SyncTeX result begin" not in stdout:
        # No result block at all — SyncTeX's own documented behavior for
        # an out-of-range page/coordinate or a synctex file with nothing
        # at that location (verified directly: exit code is still 0).
        return InverseSearchOutcome(resolved=False)

    input_match = re.search(r"^Input:(.*)$", stdout, re.MULTILINE)
    line_match = re.search(r"^Line:(-?\d+)$", stdout, re.MULTILINE)
    if not input_match or not line_match:
        return InverseSearchOutcome(resolved=False)

    raw_input = input_match.group(1).strip()
    line = int(line_match.group(1))
    if line < 1:
        return InverseSearchOutcome(resolved=False)

    if _SYNCTEX_INPUT_CWD_MARKER not in raw_input:
        # Never seen in real testing (every real compile in this
        # service always invokes pdflatex with a bare relative "main.tex"
        # / "\input{...}" target) — if SyncTeX's own output shape ever
        # differs, decline rather than risk forwarding an unrecognized
        # (possibly still-absolute) path.
        return InverseSearchOutcome(resolved=False)
    relative = raw_input.split(_SYNCTEX_INPUT_CWD_MARKER, 1)[1]

    # Defense in depth, mirroring safe_relative_path's own checks above
    # — a relative path this service is about to hand back to the
    # caller must itself never be absolute or traversal-bearing, even
    # though SyncTeX's own well-formed output should never produce one.
    if not relative or Path(relative).is_absolute() or ".." in Path(relative).parts:
        return InverseSearchOutcome(resolved=False)

    return InverseSearchOutcome(resolved=True, file=relative, line=line)


def _is_finite(value: float) -> bool:
    return math.isfinite(value)


async def run_inverse_search_job(
    *,
    synctex_bytes: bytes,
    page: int,
    x: float,
    y: float,
    settings: Settings,
) -> InverseSearchOutcome:
    """SyncTeX implementation — runs exactly one whitelisted, fixed-argv
    `synctex edit` query against a caller-supplied SyncTeX database, in a
    fresh, isolated scratch directory this function creates and tears
    down itself (same tmpfs-under-/tmp/jobs, own-session,
    killpg-on-timeout, unconditional-cleanup discipline as
    run_compile_job — see _run_phase/_kill_process_group above; this is
    NOT a new execution model, it's the same one applied to a second,
    much smaller and faster operation).

    `page`/`x`/`y` are already validated by the caller (app/main.py) as
    plain, bounded numbers before this is ever invoked — `synctex edit`'s
    own `-o` argument here is ALWAYS the literal, fixed string
    "main.pdf" this function creates itself; no part of the request body
    is ever concatenated into a shell command or an argv element other
    than these three already-numeric-typed values.

    `synctex edit` only reads the SyncTeX database and needs its `-o`
    target file to merely EXIST (verified directly — a placeholder/
    empty-shell PDF works identically to the real one for this purpose,
    since only main.synctex.gz's own recorded coordinates are actually
    consulted); a real PDF's bytes are never needed here and are never
    sent to this endpoint at all.
    """
    # Defense in depth — app/main.py's endpoint already validates these
    # via pydantic (int page, finite float x/y, all bounded) before ever
    # calling this function, but this function re-derives its own safety
    # from first principles too, matching safe_relative_path's own
    # "never trust the caller, even our own caller" posture elsewhere in
    # this module.
    if not isinstance(page, int) or page < 1:
        return InverseSearchOutcome(resolved=False)
    if not isinstance(x, int | float) or not isinstance(y, int | float):
        return InverseSearchOutcome(resolved=False)
    if not (_is_finite(x) and _is_finite(y)):
        return InverseSearchOutcome(resolved=False)

    workdir = Path(settings.working_root) / f"inverse-{uuid.uuid4().hex}"
    workdir.mkdir(parents=True, exist_ok=False, mode=0o700)
    try:
        (workdir / "main.synctex.gz").write_bytes(synctex_bytes)
        # synctex edit's own docs: "-o page:x:y:file ... This named file
        # must always exist" — its CONTENTS are irrelevant to an edit
        # (inverse) query, only main.synctex.gz's own recorded
        # coordinates are consulted.
        (workdir / "main.pdf").write_bytes(b"%PDF-1.4\n%%EOF\n")

        # Fixed-decimal formatting (never scientific notation, which a
        # bare str()/repr() of a very small/large float could produce
        # and which synctex's own "page:x:y:file" colon-delimited parser
        # has no documented handling for) — one more reason this is
        # never simply interpolated from unvalidated caller input.
        coordinate = f"{page}:{x:.4f}:{y:.4f}:main.pdf"
        argv = ["synctex", "edit", "-o", coordinate]
        proc = await asyncio.create_subprocess_exec(
            *argv,
            cwd=str(workdir),
            env=dict(_BASE_ENV),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            start_new_session=True,
        )
        try:
            stdout, _ = await asyncio.wait_for(
                proc.communicate(), timeout=settings.synctex_edit_timeout_seconds
            )
        except TimeoutError:
            _kill_process_group(proc.pid)
            try:
                await asyncio.wait_for(proc.wait(), timeout=5.0)
            except TimeoutError:
                logger.warning("synctex edit process group %s did not exit after SIGKILL", proc.pid)
            return InverseSearchOutcome(resolved=False)

        if proc.returncode != 0:
            return InverseSearchOutcome(resolved=False)

        return _parse_inverse_search_output(stdout.decode("utf-8", "replace"))
    finally:
        shutil.rmtree(workdir, ignore_errors=True)
