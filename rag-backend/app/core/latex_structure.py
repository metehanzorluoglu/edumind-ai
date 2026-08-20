"""Milestone 6.1 (Writing Context Engine) — deterministic LaTeX structural
parsing. Answers exactly two questions the context engine needs, both
without an LLM and without a full TeX parser:

1. "What section/subsection is line N inside?" (find_enclosing_section)
2. "What files does this document \\input/\\include, and where's the
   bibliography declared?" (parse_latex_structure's inputs/bibliography
   fields — the multi-file graph itself lives in
   writing_manuscript_graph.py, which consumes this module per-file).

Deliberately NOT a full TeX parser (Part 4 of the M6.1 spec: "does not
need to become a full TeX compiler/parser... do not overengineer
this") — this module recognizes exactly the constructs the spec lists
(\\documentclass, \\begin/\\end{document}, \\chapter/\\section/
\\subsection/\\subsubsection, \\input, \\include, bibliography
declarations, comments) via linear regex scans over comment-stripped
text, nothing more.

Comment handling is NOT reimplemented here — `strip_latex_comments`
from app/core/reference_mode.py (M5.5's own comment/escaping-aware
scanner, already correct for the `\\%` vs real-`%` distinction) is
reused directly, per the M6.1 spec's explicit instruction to reuse it
rather than write a second implementation that could drift out of
sync. Preserves line count (blanks out only the commented SUFFIX of
each line, never removes a line) so every line number this module
computes stays aligned with the original, unstripped source — which
matters because callers (the context engine) report line numbers back
to whatever displayed the manuscript to the user.
"""

from __future__ import annotations

import bisect
import re
from dataclasses import dataclass, field
from typing import Literal

from app.core.reference_mode import strip_latex_comments

SectionKind = Literal["chapter", "section", "subsection", "subsubsection"]

_SECTION_LEVELS: dict[SectionKind, int] = {
    "chapter": 0,
    "section": 1,
    "subsection": 2,
    "subsubsection": 3,
}

# Matches \chapter{...}, \section*{...}, \subsection{...}, etc. — the
# optional `*` (unnumbered variant) is accepted but not distinguished;
# both number and title text are structural, not compiled output, so
# starred/unstarred sections are structurally identical for this
# module's purpose. `[^\n}]*` deliberately stops at the first `}` —
# doesn't handle a nested-brace title (e.g. `\section{A \textit{B} C}`)
# perfectly, but a raw first-`}` cutoff is the documented, deterministic
# behavior this module commits to rather than a fragile brace-matching
# regex; see the module docstring's "do not overengineer" mandate.
_SECTION_RE = re.compile(r"\\(chapter|section|subsection|subsubsection)\*?\s*\{([^\n}]*)\}")

_INPUT_INCLUDE_RE = re.compile(r"\\(input|include)\s*\{([^\n}]*)\}")
_DOCUMENTCLASS_RE = re.compile(r"\\documentclass(?:\[[^\]]*\])?\s*\{([^\n}]*)\}")
_BEGIN_DOCUMENT_RE = re.compile(r"\\begin\{document\}")
_END_DOCUMENT_RE = re.compile(r"\\end\{document\}")
_BIBLIOGRAPHY_RE = re.compile(r"\\bibliography\s*\{([^\n}]*)\}")
_BIBLIOGRAPHYSTYLE_RE = re.compile(r"\\bibliographystyle\s*\{([^\n}]*)\}")
_BEGIN_THEBIBLIOGRAPHY_RE = re.compile(r"\\begin\{thebibliography\}")


@dataclass(frozen=True)
class SectionNode:
    kind: SectionKind
    title: str
    line: int  # 1-indexed line the heading command appears on


@dataclass(frozen=True)
class InputTarget:
    kind: Literal["input", "include"]
    target: str  # raw macro argument, exactly as written (no extension guessing)
    line: int


@dataclass(frozen=True)
class SectionPath:
    """The enclosing structural path at a given line — at most one node
    per kind, per find_enclosing_section's own docstring. All fields are
    None when the line falls before the first heading (e.g. inside the
    preamble, or a document with no headings at all)."""

    chapter: str | None = None
    section: str | None = None
    subsection: str | None = None
    subsubsection: str | None = None

    def is_empty(self) -> bool:
        return not any((self.chapter, self.section, self.subsection, self.subsubsection))


@dataclass(frozen=True)
class LatexStructure:
    documentclass: str | None
    document_body_start_line: int | None
    document_body_end_line: int | None
    sections: list[SectionNode] = field(default_factory=list)
    inputs: list[InputTarget] = field(default_factory=list)
    bibliography_targets: list[str] = field(default_factory=list)
    bibliographystyle: str | None = None
    has_thebibliography: bool = False
    line_count: int = 0


def _first_match_line(stripped_lines: list[str], pattern: re.Pattern[str]) -> int | None:
    for i, line in enumerate(stripped_lines, start=1):
        if pattern.search(line):
            return i
    return None


def parse_latex_structure(content: str) -> LatexStructure:
    """Pure, deterministic, single-pass-per-concern parse. Never raises
    on malformed/partial LaTeX (a manuscript mid-edit is not an error
    state) — a construct that doesn't match a pattern is simply absent
    from the result, never guessed."""
    stripped = strip_latex_comments(content)
    lines = stripped.splitlines()

    documentclass_match = _DOCUMENTCLASS_RE.search(stripped)
    documentclass = documentclass_match.group(1).strip() if documentclass_match else None

    sections: list[SectionNode] = []
    inputs: list[InputTarget] = []
    bibliography_targets: list[str] = []
    bibliographystyle: str | None = None
    has_thebibliography = False

    for i, line in enumerate(lines, start=1):
        for m in _SECTION_RE.finditer(line):
            kind = m.group(1)
            assert kind in _SECTION_LEVELS
            sections.append(SectionNode(kind=kind, title=m.group(2).strip(), line=i))
        for m in _INPUT_INCLUDE_RE.finditer(line):
            kind = m.group(1)
            assert kind in ("input", "include")
            inputs.append(InputTarget(kind=kind, target=m.group(2).strip(), line=i))  # type: ignore[arg-type]
        for m in _BIBLIOGRAPHY_RE.finditer(line):
            for raw in m.group(1).split(","):
                name = raw.strip()
                if name:
                    bibliography_targets.append(name)
        style_match = _BIBLIOGRAPHYSTYLE_RE.search(line)
        if style_match and bibliographystyle is None:
            bibliographystyle = style_match.group(1).strip()
        if _BEGIN_THEBIBLIOGRAPHY_RE.search(line):
            has_thebibliography = True

    return LatexStructure(
        documentclass=documentclass,
        document_body_start_line=_first_match_line(lines, _BEGIN_DOCUMENT_RE),
        document_body_end_line=_first_match_line(lines, _END_DOCUMENT_RE),
        sections=sections,
        inputs=inputs,
        bibliography_targets=bibliography_targets,
        bibliographystyle=bibliographystyle,
        has_thebibliography=has_thebibliography,
        line_count=len(lines),
    )


def find_enclosing_section(structure: LatexStructure, line: int) -> SectionPath:
    """The structural path (chapter/section/subsection/subsubsection)
    enclosing `line` (1-indexed). Deterministic stack-based nesting: a
    heading closes every currently-open heading at its own level or
    deeper (a new \\section ends whatever \\subsection was open under
    the previous \\section, etc.) — the standard LaTeX sectioning
    nesting rule, computed once per parse rather than per query."""
    if not structure.sections:
        return SectionPath()

    # Build (line_start -> ancestor-path-including-self) once. Sections
    # are already in document order (single top-to-bottom scan above).
    stack: list[SectionNode] = []
    paths_by_line: list[tuple[int, SectionPath]] = []
    for node in structure.sections:
        level = _SECTION_LEVELS[node.kind]
        while stack and _SECTION_LEVELS[stack[-1].kind] >= level:
            stack.pop()
        stack.append(node)
        current: dict[SectionKind, str] = {n.kind: n.title for n in stack}
        paths_by_line.append(
            (
                node.line,
                SectionPath(
                    chapter=current.get("chapter"),
                    section=current.get("section"),
                    subsection=current.get("subsection"),
                    subsubsection=current.get("subsubsection"),
                ),
            )
        )

    starts = [ln for ln, _ in paths_by_line]
    idx = bisect.bisect_right(starts, line) - 1
    if idx < 0:
        return SectionPath()  # line is before the first heading (preamble/front matter)
    return paths_by_line[idx][1]


def offset_to_line(content: str, char_offset: int) -> int:
    """Converts a 0-indexed character offset (the frontend editor's own
    selection/cursor convention) into a 1-indexed line number. Clamped
    to the content's actual bounds — never raises on an out-of-range
    offset (a stale offset from a client that hasn't caught up with a
    concurrent edit is a real, expected case, not a bug to crash on)."""
    clamped = max(0, min(char_offset, len(content)))
    # `count` up to the clamped offset — a newline AT the offset itself
    # is not yet "passed", matching how a cursor sitting right before a
    # newline is still considered to be on the line before it.
    return content.count("\n", 0, clamped) + 1
