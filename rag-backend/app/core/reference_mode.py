"""Bibliography Source Detection — deterministic (no LLM) detection of
HOW a Writing Project actually manages its citations/references.

Real academic templates do not all use EduM8's own generated
`references.bib` — see the two real fixtures this milestone was built
and tested against:

- The Springer Nature journal template ships its own
  `sn-bibliography.bib`, referenced via `\\bibliography{sn-bibliography}`
  in the root document (IMPORTED_BIB_DATABASE).
- The UNLV thesis template ships a `Bibliography.tex` containing a
  manual `\\begin{thebibliography}...\\end{thebibliography}` block with
  `\\bibitem{...}` entries, pulled in via `\\include{Bibliography}`
  (TEMPLATE_TEX_BIBLIOGRAPHY).

Before this module existed, EduM8 always assumed EDUM8_REFERENCE_LIBRARY
mode — the synthesized `references.bib` virtual file exists in every
project's tree regardless — so citation autocomplete offered EduM8's own
canonical keys even for a project that had never connected any EduM8
reference and had its own real bibliography already working. This module
fixes that by actually inspecting the project's root document (and, one
level deep, whatever it `\\input`/`\\include`s) for real, present
evidence of how references are configured, before ever assuming the
EduM8-library default.

No LLM anywhere in this module: every extraction is a bounded regex/scan
over text this project already owns, exactly this codebase's existing
convention for LaTeX-adjacent parsing (see app/core/latex_citations.py's
own `\\cite{...}` parser, and app/core/log_sanitizer.py in the compiler
service). Unlike latex_citations.py's own \\cite parser (which
deliberately does NOT strip comments — a commented-out `\\cite{...}` is
conservatively still counted as "in use", since under-counting a real
citation is the wrong kind of mistake there), THIS module deliberately
DOES strip comments first: the UNLV Bibliography.tex fixture itself
contains a commented-out `% \\bibliography{references}` line as an
inline usage example, and treating that as real configuration would be
exactly the kind of false-positive this module exists to avoid.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Literal

ReferenceMode = Literal["edum8_library", "imported_bib", "template_tex", "inline_template"]
CitationKeySource = Literal["edum8", "bib_file", "bibitem", "none"]


# ---------------------------------------------------------------------
# Deterministic LaTeX text helpers
# ---------------------------------------------------------------------


def strip_latex_comments(text: str) -> str:
    """Removes everything from a real (unescaped) `%` to the end of its
    line, line by line. `\\%` (an escaped percent, a literal percent
    sign in the rendered document) is NOT a comment start — determined
    by counting the run of backslashes immediately before the `%`: an
    ODD count means the `%` itself is escaped (real percent sign), an
    EVEN count (including zero) means it isn't (real comment). This is
    the standard TeX escaping-parity rule; a fixed-width regex
    lookbehind cannot express it for an arbitrary-length backslash run,
    so this is a small linear scan instead."""
    out_lines: list[str] = []
    for line in text.splitlines():
        cut = len(line)
        i = 0
        n = len(line)
        while i < n:
            if line[i] == "%":
                backslashes = 0
                j = i - 1
                while j >= 0 and line[j] == "\\":
                    backslashes += 1
                    j -= 1
                if backslashes % 2 == 0:
                    cut = i
                    break
            i += 1
        out_lines.append(line[:cut])
    return "\n".join(out_lines)


_BIBLIOGRAPHY_MACRO_RE = re.compile(r"\\bibliography\{([^}]*)\}")
_INPUT_INCLUDE_RE = re.compile(r"\\(?:input|include)\{([^}]*)\}")
_THEBIBLIOGRAPHY_RE = re.compile(r"\\begin\{thebibliography\}")
_BIBITEM_RE = re.compile(r"\\bibitem(?:\[[^\]]*\])?\{([^}]+)\}")
_BIBTEX_ENTRY_START_RE = re.compile(r"@([A-Za-z]+)\s*\{\s*([^,\s}]+)\s*,")


def extract_bibliography_targets(stripped_text: str) -> list[str]:
    """Every argument of every `\\bibliography{...}` macro call, in
    order, with a comma-separated list (`\\bibliography{a,b}`) split
    into separate entries. Expects comment-stripped input — see
    strip_latex_comments."""
    targets: list[str] = []
    for m in _BIBLIOGRAPHY_MACRO_RE.finditer(stripped_text):
        for raw in m.group(1).split(","):
            name = raw.strip()
            if name:
                targets.append(name)
    return targets


def extract_input_include_targets(stripped_text: str) -> list[str]:
    """Every argument of every `\\input{...}` / `\\include{...}` macro
    call, in document order. Expects comment-stripped input."""
    return [m.group(1).strip() for m in _INPUT_INCLUDE_RE.finditer(stripped_text) if m.group(1).strip()]


def has_thebibliography(stripped_text: str) -> bool:
    """Whether a real (uncommented) `\\begin{thebibliography}` appears
    anywhere in the text. Expects comment-stripped input."""
    return _THEBIBLIOGRAPHY_RE.search(stripped_text) is not None


def extract_bibitem_entries(stripped_text: str) -> list[tuple[str, str | None]]:
    """Deterministic `\\bibitem{key}` / `\\bibitem[label]{key}`
    extraction — never an LLM, never a guess. The second tuple element
    is a best-effort DISPLAY label only (the raw text between this
    `\\bibitem` and the next one, whitespace-collapsed and truncated) —
    never used as a citation key itself, so imperfect LaTeX markup left
    in it (e.g. a stray `\\textit{...}`) is harmless. Expects
    comment-stripped input."""
    matches = list(_BIBITEM_RE.finditer(stripped_text))
    entries: list[tuple[str, str | None]] = []
    for idx, m in enumerate(matches):
        key = m.group(1).strip()
        if not key:
            continue
        body_start = m.end()
        body_end = matches[idx + 1].start() if idx + 1 < len(matches) else len(stripped_text)
        label = " ".join(stripped_text[body_start:body_end].split())[:120].strip() or None
        entries.append((key, label))
    return entries


def _find_bibtex_field_value(text: str, field_name: str, start: int, end: int) -> str | None:
    """Best-effort scan for `field_name = <value>` within text[start:end]
    (one BibTeX entry's body), handling both `"..."` and `{...}`
    delimited values — including `{}` nested INSIDE a double-quoted
    value (a common way real .bib files protect capitalization inside a
    title, e.g. `title = "The index of general nonlinear {D}{A}{E}{S}"`,
    confirmed against the real Springer Nature sn-bibliography.bib
    fixture) and values that wrap across multiple lines (also present in
    that same real fixture). Returns None rather than guessing if the
    field is absent or its value isn't one of these two conventional
    forms."""
    pattern = re.compile(rf"\b{re.escape(field_name)}\s*=\s*", re.IGNORECASE)
    m = pattern.search(text, start, end)
    if m is None or m.end() >= end:
        return None
    i = m.end()
    opener = text[i]
    if opener == '"':
        depth = 0
        j = i + 1
        while j < end:
            ch = text[j]
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth = max(0, depth - 1)
            elif ch == '"' and depth == 0:
                return text[i + 1 : j]
            j += 1
        return None
    if opener == "{":
        depth = 1
        j = i + 1
        while j < end:
            ch = text[j]
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    return text[i + 1 : j]
            j += 1
        return None
    return None


def extract_bibtex_entries(text: str) -> list[tuple[str, str | None]]:
    """Deterministic `@type{key, ...}` entry-key extraction from a real
    `.bib` file's content — never a full BibTeX parser (this codebase's
    own app/core/bibtex.py generates BibTeX by hand rather than via a
    library for the same "no real ambiguity to get wrong" reason), never
    an LLM. The title (best-effort, display only — see
    _find_bibtex_field_value) has its protecting `{`/`}` characters and
    any internal newline/whitespace runs collapsed for a cleaner
    autocomplete label; a title that can't be bounded safely is simply
    omitted, never guessed."""
    matches = list(_BIBTEX_ENTRY_START_RE.finditer(text))
    entries: list[tuple[str, str | None]] = []
    for idx, m in enumerate(matches):
        key = m.group(2).strip()
        if not key:
            continue
        entry_start = m.end()
        entry_end = matches[idx + 1].start() if idx + 1 < len(matches) else len(text)
        raw_title = _find_bibtex_field_value(text, "title", entry_start, entry_end)
        title = None
        if raw_title is not None:
            cleaned = " ".join(raw_title.split()).replace("{", "").replace("}", "").strip()
            title = cleaned or None
        entries.append((key, title))
    return entries


# ---------------------------------------------------------------------
# Reference-mode detection
# ---------------------------------------------------------------------


@dataclass(frozen=True)
class ReferenceModeResult:
    mode: ReferenceMode
    #: Display path of whatever file is the project's actual
    #: bibliography source — "references.bib" (the virtual EduM8 file,
    #: EDUM8_REFERENCE_LIBRARY mode only), a real imported `.bib` path,
    #: or a real `.tex` path (TEMPLATE_TEX_BIBLIOGRAPHY /
    #: INLINE_TEMPLATE_BIBLIOGRAPHY).
    bibliography_source: str | None
    citation_key_source: CitationKeySource
    #: (key, display_title_or_label) pairs — empty for
    #: EDUM8_REFERENCE_LIBRARY mode (the caller already has its own,
    #: separate EduM8-reference-derived key list; this module has no DB
    #: access and never needs one to stay pure/deterministic).
    keys: list[tuple[str, str | None]] = field(default_factory=list)
    #: Whether the project has at least one EduM8 reference attached,
    #: independent of `mode` — informs the "EduM8 Reference Library:
    #: Available, not currently connected" UI line even in a non-EduM8
    #: mode.
    edum8_available: bool = False
    #: Set only when citation_key_source == "none" — a real, specific
    #: reason to show the user, never a fabricated explanation.
    no_key_source_reason: str | None = None


@dataclass(frozen=True)
class Edum8SwitchProposal:
    """A safe, deterministic, single-substitution rewrite — the ONLY
    kind of "switch to EduM8 references" change this module will ever
    propose automatically. Never covers converting a `thebibliography`
    block or rewriting `\\bibitem`s (TEMPLATE_TEX_BIBLIOGRAPHY /
    INLINE_TEMPLATE_BIBLIOGRAPHY) — those are real content decisions, not
    a safe mechanical edit, so those modes get instructions instead (see
    routes_writing.py's use of this)."""

    file_path: str
    find: str
    replace: str


def propose_edum8_switch(*, mode: ReferenceMode, root_path: str, root_content: str) -> Edum8SwitchProposal | None:
    """Only ever proposes a change for IMPORTED_BIB_DATABASE mode,
    where the change is exactly "replace the one real `\\bibliography{...}`
    macro's argument with `references`" — nothing else in the file is
    touched, the old `.bib` file is never deleted (see
    routes_writing.py's apply endpoint, which only ever rewrites this
    exact substring). Scans line by line so the returned `find` text is
    always an exact, verbatim substring of `root_content` (safe for a
    single `str.replace(find, replace, 1)` at apply time) — never
    re-derived from the comment-stripped copy, which would not
    necessarily match the original byte-for-byte."""
    if mode != "imported_bib":
        return None
    for line in root_content.splitlines():
        stripped_line = strip_latex_comments(line)
        m = _BIBLIOGRAPHY_MACRO_RE.search(stripped_line)
        if m is None:
            continue
        find_text = m.group(0)
        if find_text not in root_content:
            continue  # defensive; should be unreachable given the scan above
        return Edum8SwitchProposal(
            file_path=root_path, find=find_text, replace="\\bibliography{references}"
        )
    return None


def detect_reference_mode(
    *,
    root_path: str,
    root_content: str,
    text_files: dict[str, str],
    edum8_reference_count: int,
) -> ReferenceModeResult:
    """`text_files` must include EVERY `.tex` and `.bib` file currently
    in the project (root included), keyed by its display path. Detection
    only ever follows `\\input`/`\\include` ONE level from the root
    document — matching this codebase's own existing compile-dependency
    conservatism elsewhere (Part 13 of the ZIP-import work: "do not
    recursively follow arbitrary input directives" — this module applies
    the same bound for the same reason: a template's root document is
    the one place a project's OWN bibliography choice is actually
    declared; chasing an arbitrary multi-level include graph to find one
    is not something a real academic template ever requires).

    Priority order (first real signal wins — never guessed, always
    grounded in text actually present in the project):

      1. A real `\\bibliography{X}` in the root document. If `X` is
         "references" and no real `references.bib` file exists in the
         project (there never is one — see WritingProjectFile's own
         docstring), that IS the EduM8-generated virtual file:
         EDUM8_REFERENCE_LIBRARY. Otherwise, if a real `X.bib` file
         exists in the project: IMPORTED_BIB_DATABASE.
      2. A real `\\input{Y}` / `\\include{Y}` where `Y.tex` exists and
         contains a real `\\begin{thebibliography}`: TEMPLATE_TEX_BIBLIOGRAPHY
         (or, if that file itself resolves to a real `.bib` via its own
         `\\bibliography{...}`, that `.bib`'s keys are used instead of
         `\\bibitem` extraction — "if Bibliography.tex ultimately
         references a real .bib database, resolve that relationship
         deterministically").
      3. A real `\\begin{thebibliography}` directly in the root
         document: INLINE_TEMPLATE_BIBLIOGRAPHY.
      4. Otherwise: EDUM8_REFERENCE_LIBRARY — the correct default for
         every blank/EduM8-template project (today's existing, unchanged
         behavior), never chosen merely because `references.bib` exists
         (it always does, as a virtual file) but because no other real
         configuration signal was found.
    """
    edum8_available = edum8_reference_count > 0
    stripped_root = strip_latex_comments(root_content)

    by_stem: dict[str, str] = {}
    bib_by_stem: dict[str, str] = {}
    for path in text_files:
        base = path.rsplit("/", 1)[-1]
        stem, dot, ext = base.rpartition(".")
        if not dot:
            stem, ext = base, ""
        lower_stem = stem.lower()
        if ext.lower() == "bib":
            bib_by_stem[lower_stem] = path
        elif ext.lower() == "tex":
            by_stem[lower_stem] = path

    # 1. \bibliography{X} in the root document.
    for target in extract_bibliography_targets(stripped_root):
        stem = target.rsplit("/", 1)[-1]
        if stem.lower().endswith(".bib"):
            stem = stem[: -len(".bib")]
        stem = stem.lower()
        real_path = bib_by_stem.get(stem)
        if real_path is None and stem == "references":
            return ReferenceModeResult(
                mode="edum8_library",
                bibliography_source="references.bib",
                citation_key_source="edum8",
                edum8_available=edum8_available,
            )
        if real_path is not None:
            entries = extract_bibtex_entries(text_files[real_path])
            return ReferenceModeResult(
                mode="imported_bib",
                bibliography_source=real_path,
                citation_key_source="bib_file" if entries else "none",
                keys=entries,
                edum8_available=edum8_available,
                no_key_source_reason=(
                    None if entries else f"No BibTeX entries could be parsed from {real_path}."
                ),
            )
        # \bibliography{X} present but X.bib isn't actually in this
        # project — not a signal we can act on; fall through.

    # 2. \input{Y} / \include{Y} where Y.tex has a thebibliography block.
    for target in extract_input_include_targets(stripped_root):
        stem = target.rsplit("/", 1)[-1]
        if stem.lower().endswith(".tex"):
            stem = stem[: -len(".tex")]
        real_path = by_stem.get(stem.lower())
        if real_path is None or real_path == root_path:
            continue
        included_stripped = strip_latex_comments(text_files[real_path])
        if not has_thebibliography(included_stripped):
            continue
        # Nested resolution: does the included file itself point at a
        # real .bib database?
        for nested_target in extract_bibliography_targets(included_stripped):
            nested_stem = nested_target.rsplit("/", 1)[-1]
            if nested_stem.lower().endswith(".bib"):
                nested_stem = nested_stem[: -len(".bib")]
            nested_path = bib_by_stem.get(nested_stem.lower())
            if nested_path is not None:
                entries = extract_bibtex_entries(text_files[nested_path])
                return ReferenceModeResult(
                    mode="template_tex",
                    bibliography_source=real_path,
                    citation_key_source="bib_file" if entries else "none",
                    keys=entries,
                    edum8_available=edum8_available,
                    no_key_source_reason=(
                        None if entries else f"No BibTeX entries could be parsed from {nested_path}."
                    ),
                )
        entries = extract_bibitem_entries(included_stripped)
        return ReferenceModeResult(
            mode="template_tex",
            bibliography_source=real_path,
            citation_key_source="bibitem" if entries else "none",
            keys=entries,
            edum8_available=edum8_available,
            no_key_source_reason=(
                None if entries else f"No \\bibitem entries found in {real_path}."
            ),
        )

    # 3. thebibliography directly in the root document.
    if has_thebibliography(stripped_root):
        entries = extract_bibitem_entries(stripped_root)
        return ReferenceModeResult(
            mode="inline_template",
            bibliography_source=root_path,
            citation_key_source="bibitem" if entries else "none",
            keys=entries,
            edum8_available=edum8_available,
            no_key_source_reason=(
                None if entries else f"No \\bibitem entries found in {root_path}."
            ),
        )

    # 4. Default.
    return ReferenceModeResult(
        mode="edum8_library",
        bibliography_source="references.bib",
        citation_key_source="edum8",
        edum8_available=edum8_available,
    )
