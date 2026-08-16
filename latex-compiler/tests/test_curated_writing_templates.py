"""Milestone 5.4 (LaTeX Templates & Project Import) Part 27 — RELEASE
CRITICAL: "curated templates bundled by EduM8 MUST pass compilation
tests before shipping — automated import/clone, root selection,
compile, PDF output for every one; if a template doesn't compile
against the real compiler image, do not ship it."

Reads each template directly from
rag-backend/app/templates/writing_templates/*/manifest.json (this
package deliberately does not import rag-backend's own
app.core.writing_templates module — the two services are independently
deployed, and this test's only job is to prove the CONTENT that ships
in that directory compiles, using the exact same run_compile_job() path
every real user's template-created project goes through) and drives it
through the same subprocess pdflatex/bibtex pipeline as every other
test in this file — skipped automatically wherever TeX Live isn't on
PATH, authoritative when run against the built compiler Docker image
(see test_compiler_subprocess.py's own docstring for why that's the
environment this suite is meant to be judged in)."""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest

from app.compiler import run_compile_job
from app.config import Settings

pytestmark = pytest.mark.skipif(
    shutil.which("pdflatex") is None, reason="pdflatex not installed in this environment"
)

_TEMPLATES_ROOT = Path(__file__).resolve().parents[2] / "rag-backend" / "app" / "templates" / "writing_templates"


def _settings(**overrides) -> Settings:
    merged = {"working_root": "/tmp", **overrides}
    return Settings(**merged)


def _template_ids() -> list[str]:
    if not _TEMPLATES_ROOT.is_dir():
        return []
    return sorted(p.name for p in _TEMPLATES_ROOT.iterdir() if (p / "manifest.json").is_file())


def _load_manifest(template_id: str) -> dict:
    manifest_path = _TEMPLATES_ROOT / template_id / "manifest.json"
    return json.loads(manifest_path.read_text(encoding="utf-8"))


@pytest.mark.skipif(not _template_ids(), reason="writing_templates directory not found alongside this checkout")
@pytest.mark.parametrize("template_id", _template_ids())
async def test_curated_template_compiles_with_zero_diagnostics(tmp_path, template_id: str) -> None:
    manifest = _load_manifest(template_id)
    template_dir = _TEMPLATES_ROOT / template_id
    root_path = manifest["root"]

    main_tex = (template_dir / root_path).read_text(encoding="utf-8")
    extra_files = {
        path: (template_dir / path).read_bytes() for path in manifest["files"] if path != root_path
    }

    settings = _settings(working_root=str(tmp_path))
    outcome = await run_compile_job(
        main_tex=main_tex, references_bib="", settings=settings, extra_files=extra_files
    )

    assert outcome.status == "success", (
        f"Template {template_id!r} failed to compile: "
        f"{[d.message for d in outcome.diagnostics]}\n{outcome.log_excerpt}"
    )
    assert outcome.pdf_bytes is not None
    assert outcome.pdf_bytes.startswith(b"%PDF")
    error_diagnostics = [d for d in outcome.diagnostics if d.severity == "error"]
    assert error_diagnostics == [], f"Template {template_id!r} shipped with error diagnostics: {error_diagnostics}"


@pytest.mark.skipif(not _template_ids(), reason="writing_templates directory not found alongside this checkout")
def test_every_curated_template_root_is_among_its_own_files() -> None:
    for template_id in _template_ids():
        manifest = _load_manifest(template_id)
        assert manifest["root"] in manifest["files"], f"{template_id}: root not listed in files"
        for path in manifest["files"]:
            assert (_TEMPLATES_ROOT / template_id / path).is_file(), f"{template_id}: missing {path}"
