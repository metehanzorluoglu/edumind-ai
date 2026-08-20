"""Milestone 6.1 (Writing Context Engine) — resolves the \\input/\\include
relationship graph for a Writing project's `.tex` files, without ever
concatenating file contents together (Part 5 of the spec: "Do NOT
concatenate every included file into every AI request").

Scope deliberately mirrors the spec's own floor: `\\input{}`, `\\include{}`,
and the project's existing root-document mechanism (WritingProjectTree's
`root_file_id` — the SAME root concept M5.3-5.5 already established and
already surfaced via the Files panel's "MAIN" badge). Missing \\input/
\\include targets are recorded, never invented (Part 5: "Never invent file
relationships") — a target that doesn't resolve to a real project file is
reported as `resolved=False`, not silently dropped.

Path resolution mirrors the compiler's own relative-path convention
(latex-compiler/app/compiler.py's TEXINPUTS=".//:" and this project's
existing WritingProjectFile `path` field): a bare `\\input{Chapter1}` or
`\\input{Chapter1.tex}` is looked up first against the exact path relative
to the referencing file's own directory, then against the exact path
relative to the project root — never a fuzzy/basename-only search, which
could silently pick the wrong file in a project with two same-named files
in different folders.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import PurePosixPath

from app.core.latex_structure import InputTarget, LatexStructure, parse_latex_structure

_TEX_EXT = ".tex"


@dataclass(frozen=True)
class ManuscriptFile:
    file_id: str
    path: str
    structure: LatexStructure


@dataclass(frozen=True)
class UnresolvedInput:
    from_path: str
    target: InputTarget


@dataclass(frozen=True)
class ManuscriptGraph:
    """The resolved \\input/\\include graph for one Writing project's
    `.tex` files. `root_path` comes from the project's own existing
    root-file mechanism (never guessed here) — may be None only if the
    project genuinely has no root set, which the caller decides how to
    handle (this module never picks a root on its own initiative)."""

    root_path: str | None
    files: dict[str, ManuscriptFile]  # keyed by path
    # from_path -> list of (target_path_if_resolved_else_None, raw InputTarget)
    edges: dict[str, list[tuple[str | None, InputTarget]]] = field(default_factory=dict)
    unresolved: list[UnresolvedInput] = field(default_factory=list)

    def resolve_target_path(self, from_path: str, target: InputTarget) -> str | None:
        """Public helper mirroring the same resolution rule build_manuscript_graph
        uses internally — exposed so a caller who already has one file's
        parsed InputTarget (e.g. the context engine, deciding whether to
        surface a specific \\input as a real file link) doesn't need to
        re-derive the rule."""
        return _resolve(from_path, target.target, self.files)

    def ancestors_of(self, path: str) -> list[str]:
        """Every file (in the existing graph) that \\input/\\include's
        `path`, directly — NOT transitively, since the spec's own worked
        example ("main.tex -> Discussion.tex") is a direct one-hop
        relationship and transitive closure isn't needed for the L3
        "project structure" layer's actual use (reporting the one
        relevant containing file, not a full reverse-dependency tree)."""
        return [
            from_path
            for from_path, targets in self.edges.items()
            for resolved_path, _raw in targets
            if resolved_path == path
        ]


def _candidate_paths(target_raw: str) -> list[str]:
    """A bare LaTeX \\input/\\include argument may or may not carry a
    `.tex` extension (both are legal and common) — try the argument
    exactly as written first (handles a target that already has an
    extension, or intentionally references a non-.tex file), then with
    `.tex` appended (the far more common case, e.g. `\\include{Chapter1}`)."""
    candidates = [target_raw]
    if not target_raw.endswith(_TEX_EXT):
        candidates.append(target_raw + _TEX_EXT)
    return candidates


def _resolve(from_path: str, target_raw: str, files: dict[str, ManuscriptFile]) -> str | None:
    from_dir = PurePosixPath(from_path).parent
    for candidate in _candidate_paths(target_raw):
        # Relative to the referencing file's own directory first —
        # matches kpathsea's own search order (cwd-relative before
        # root-relative) and this project's TEXINPUTS convention.
        relative_candidate = str(from_dir / candidate) if str(from_dir) != "." else candidate
        if relative_candidate in files:
            return relative_candidate
        if candidate in files:
            return candidate
    return None


def build_manuscript_graph(tex_files: dict[str, str], *, root_path: str | None) -> ManuscriptGraph:
    """`tex_files` maps each `.tex` file's real project path to its
    current text content (from WritingProjectFilesRepository.get_all_content
    — the caller's job to gather; this function never touches the
    database itself, keeping it a pure, directly-testable function).
    Every file is parsed exactly once regardless of how many other
    files reference it (Part 17's "avoid re-parsing... N+1" — the
    caller is expected to invoke this once per project state, not once
    per \\input edge)."""
    files: dict[str, ManuscriptFile] = {}
    for path, content in tex_files.items():
        files[path] = ManuscriptFile(
            file_id=path, path=path, structure=parse_latex_structure(content)
        )

    edges: dict[str, list[tuple[str | None, InputTarget]]] = {}
    unresolved: list[UnresolvedInput] = []
    for path, mf in files.items():
        resolved_edges: list[tuple[str | None, InputTarget]] = []
        for target in mf.structure.inputs:
            resolved_path = _resolve(path, target.target, files)
            resolved_edges.append((resolved_path, target))
            if resolved_path is None:
                unresolved.append(UnresolvedInput(from_path=path, target=target))
        edges[path] = resolved_edges

    return ManuscriptGraph(root_path=root_path, files=files, edges=edges, unresolved=unresolved)
