"""Milestone 5.4 (LaTeX Templates & Project Import) Part 1/3/19/42 — the
curated template registry.

A template is NOT a separate writing engine or a duplicated DB project
row (Part 19) — it is a small, version-controlled directory of real
project files plus a `manifest.json` under app/templates/writing_templates/,
bundled directly into the backend Docker image (part of the repo, never
the persistent /data volume — templates ship with a release, they are
not user data). `list_templates()`/`get_template()` read these once and
cache the result for the process lifetime (they never change without a
new deploy).

Every template here is EduM8-authored (Part 42/43: "this milestone may
ship only EduM8-authored templates initially. That is acceptable.") —
`license`/`source` are always present and explicit; nothing is ever
shipped with an unclear or unverified redistribution status.

Cloning a template into a real project reuses the EXACT SAME atomic
manifest-based creation path a ZIP import uses
(app/db/writing_projects_repository.py's `create_project_from_manifest`)
— after creation there is no template-specific state anywhere; it is a
completely normal WritingProject (Part 16)."""

from __future__ import annotations

import json
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

_TEMPLATES_ROOT = Path(__file__).resolve().parent.parent / "templates" / "writing_templates"


@dataclass(frozen=True)
class WritingTemplateFile:
    path: str
    content: str


@dataclass(frozen=True)
class WritingTemplateSummary:
    id: str
    name: str
    description: str
    category: str
    license: str
    source: str
    version: int
    file_count: int


@dataclass(frozen=True)
class WritingTemplateDetail(WritingTemplateSummary):
    root: str
    files: tuple[WritingTemplateFile, ...] = ()


def _load_one(template_dir: Path) -> WritingTemplateDetail:
    manifest_path = template_dir / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    files: list[WritingTemplateFile] = []
    for rel_path in manifest["files"]:
        # Every path in a manifest is written by EduM8 itself (never
        # user input) but is still resolved the same containment-safe
        # way as everything else in this codebase touches disk — belt
        # and suspenders costs nothing here.
        file_path = (template_dir / rel_path).resolve()
        file_path.relative_to(template_dir.resolve())
        files.append(
            WritingTemplateFile(path=rel_path, content=file_path.read_text(encoding="utf-8"))
        )
    return WritingTemplateDetail(
        id=manifest["id"],
        name=manifest["name"],
        description=manifest["description"],
        category=manifest["category"],
        license=manifest["license"],
        source=manifest["source"],
        version=manifest["version"],
        file_count=len(files),
        root=manifest["root"],
        files=tuple(files),
    )


@lru_cache(maxsize=1)
def _load_all() -> dict[str, WritingTemplateDetail]:
    if not _TEMPLATES_ROOT.is_dir():
        return {}
    result: dict[str, WritingTemplateDetail] = {}
    for child in sorted(_TEMPLATES_ROOT.iterdir()):
        if not child.is_dir() or not (child / "manifest.json").is_file():
            continue
        detail = _load_one(child)
        result[detail.id] = detail
    return result


def list_templates() -> list[WritingTemplateSummary]:
    return [
        WritingTemplateSummary(
            id=t.id,
            name=t.name,
            description=t.description,
            category=t.category,
            license=t.license,
            source=t.source,
            version=t.version,
            file_count=t.file_count,
        )
        for t in _load_all().values()
    ]


def get_template(template_id: str) -> WritingTemplateDetail | None:
    return _load_all().get(template_id)
