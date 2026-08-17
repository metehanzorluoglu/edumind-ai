"""Milestone 5.1 Part 15/22/23, extended by 5.5 Part 14 — turns a raw
pdflatex/bibtex log into (a) a short list of structured Diagnostics for
the primary UI and (b) a truncated, path-sanitized excerpt safe to log or
show in an expandable "Show log" panel. Conservative by design (Part 22:
"Parse LaTeX output conservatively") — false negatives (missing an error,
or missing a diagnostic's file identity) are acceptable; false positives
that hide a genuine failure behind a fabricated "success", or attribute a
diagnostic to the WRONG file, are not — so the caller (app/compiler.py)
never relies on this module to decide success/failure, only pdflatex's
own exit code and PDF presence do that, and file identity (Diagnostic.file)
is only ever populated from the one log form that reliably carries a real
filename (see _find_nearby_line_and_file's own docstring)."""

from __future__ import annotations

import re

from app.schemas import Diagnostic

_MAX_LOG_EXCERPT_CHARS = 8_000
_MAX_DIAGNOSTICS = 20

# Conservative, well-known LaTeX log error/warning signatures. Order
# matters only for readability — every line is checked against all
# patterns.
_ERROR_PATTERNS = [
    re.compile(r"^! (.+)$"),
    re.compile(r"^(.+:\d+): (.+)$"),  # -file-line-error format: "main.tex:12: message"
]
_CITATION_WARNING = re.compile(r"Citation `([^']+)' on page \d+ undefined")
_UNDEFINED_REF_WARNING = re.compile(r"Reference `([^']+)' on page \d+ undefined")


def sanitize_log(raw_log: str, *, workdir_label: str = "<project>") -> str:
    """Replaces every occurrence of the real (absolute, host-specific)
    working-directory path with a neutral placeholder — Part 15/23: never
    leak container paths. `workdir_label` is a caller-supplied neutral
    name (e.g. "/tmp/jobs/<job>") to strip; this function doesn't need to
    know the exact real path itself, the caller passes it in."""
    cleaned = raw_log.replace(workdir_label, "<project>")
    if len(cleaned) > _MAX_LOG_EXCERPT_CHARS:
        cleaned = cleaned[:_MAX_LOG_EXCERPT_CHARS] + "\n... (log truncated)"
    return cleaned


def extract_diagnostics(raw_log: str) -> list[Diagnostic]:
    """Best-effort structured extraction — never raises, never assumed
    complete. See module docstring."""
    diagnostics: list[Diagnostic] = []
    lines = raw_log.splitlines()
    for i, line in enumerate(lines):
        if len(diagnostics) >= _MAX_DIAGNOSTICS:
            break
        m = _CITATION_WARNING.search(line)
        if m:
            diagnostics.append(
                Diagnostic(
                    severity="warning", message=f"Citation undefined: \\cite{{{m.group(1)}}}"
                )
            )
            continue
        m = _UNDEFINED_REF_WARNING.search(line)
        if m:
            diagnostics.append(
                Diagnostic(severity="warning", message=f"Reference undefined: {m.group(1)}")
            )
            continue
        if line.startswith("!"):
            message = line[1:].strip()
            line_no, file = _find_nearby_line_and_file(lines, i)
            diagnostics.append(
                Diagnostic(severity="error", message=message, line=line_no, file=file)
            )
            continue
        # Milestone 5.5 Part 14 — pdflatex's `-file-line-error` REPLACES
        # the classic "! message" opening with this "file:line: message"
        # form for most TeX-level errors (the two are alternative
        # prefixes for the SAME single error report, never both present
        # for one error) — so this needs its own top-level trigger, not
        # only the nearby-file lookup above (which only helps a `!` line
        # find a companion file:line: a few lines later, e.g. for
        # warnings that still use the classic form).
        m = _FILE_LINE_ERROR_PATTERN.match(line)
        if m:
            diagnostics.append(
                Diagnostic(
                    severity="error",
                    message=m.group(3).strip(),
                    line=int(m.group(2)),
                    file=m.group(1),
                )
            )
    return diagnostics


# Milestone 5.5 Part 14 — any project file, not just literally "main.tex"
# (the M5.4 multi-file `-file-line-error` case this hardcoded-to-main.tex
# regex previously missed entirely): an optional leading "./" (kpathsea
# reports either form for the same file), then a RELATIVE path only — no
# leading "/", so this can never match (and thus never leak) an absolute
# host path; that case simply falls through to the no-file "l.NN"
# fallback below, same as it always has.
_FILE_LINE_ERROR_PATTERN = re.compile(
    r"^(?:\./)?([\w.\-]+(?:/[\w.\-]+)*\.(?:tex|cls|sty)):(\d+): (.+)$"
)


def _find_nearby_line_and_file(
    lines: list[str], error_index: int
) -> tuple[int | None, str | None]:
    """pdflatex's `-file-line-error` prefixes some (not all) error lines
    with `<file>:NN:` directly — reliable, since kpathsea only ever
    reports a relative path here; for the classic `! message` / `l.NN
    ...` two-line form, only the line number appears a few lines later,
    with no filename in that line at all. Attributing THAT form to a
    file would mean guessing from LaTeX's separate, deeply-nested
    "(filename ... )" open/close trace — real, but fragile enough
    (nesting depth, kpathsea search noise) that a wrong guess is a false
    positive this module's own docstring rules out. So: file is only
    ever populated from the reliable `file:NN:` form; the `l.NN` form
    still contributes a line number alone, exactly as before this
    milestone. Checks a small forward window only — conservative, never
    guesses further than that either."""
    window = lines[error_index : error_index + 5]
    for line in window:
        m = _FILE_LINE_ERROR_PATTERN.match(line)
        if m:
            # The regex's own (?:\./)? already strips a leading "./" —
            # group(1) is the bare relative path either way, so
            # "./intro.tex" and "intro.tex" both normalize to "intro.tex".
            return int(m.group(2)), m.group(1)
        m = re.match(r"^l\.(\d+)", line)
        if m:
            return int(m.group(1)), None
    return None, None
