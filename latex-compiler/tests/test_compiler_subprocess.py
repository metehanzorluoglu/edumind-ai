"""Milestone 5.1 Part 41/50 — real end-to-end subprocess tests: actually
invokes pdflatex/bibtex, not mocks. Skipped automatically in any
environment without a TeX Live install on PATH (this repo's main CI/test
environment does not install TeX Live — see the Milestone 5.1 report's
"Compiler Tests" section for how this suite was actually run, against
the built Docker image, as the authoritative validation of this exact
code path)."""

import shutil
import subprocess

import pytest

from app.compiler import run_compile_job
from app.config import Settings

pytestmark = pytest.mark.skipif(
    shutil.which("pdflatex") is None, reason="pdflatex not installed in this environment"
)


def _settings(**overrides) -> Settings:
    merged = {"working_root": "/tmp", **overrides}
    return Settings(**merged)


async def test_default_template_compiles_successfully(tmp_path):
    settings = _settings(working_root=str(tmp_path))
    outcome = await run_compile_job(
        main_tex=(
            "\\documentclass{article}\n\\usepackage[utf8]{inputenc}\n"
            "\\title{T}\n\\begin{document}\\maketitle\\section{Intro}\\end{document}\n"
        ),
        references_bib="",
        settings=settings,
    )
    assert outcome.status == "success"
    assert outcome.pdf_bytes is not None
    assert outcome.pdf_bytes.startswith(b"%PDF")


async def test_citation_resolves_with_bibtex(tmp_path):
    settings = _settings(working_root=str(tmp_path))
    main_tex = (
        "\\documentclass{article}\n\\begin{document}\nSee \\cite{Smith2020}.\n"
        "\\bibliographystyle{plain}\n\\bibliography{references}\n\\end{document}\n"
    )
    bib = (
        "@article{Smith2020, author={Smith, John}, title={A Paper}, "
        "journal={J}, year={2020}}\n"
    )
    outcome = await run_compile_job(main_tex=main_tex, references_bib=bib, settings=settings)
    assert outcome.status == "success"
    assert not any("undefined" in d.message.lower() for d in outcome.diagnostics)


async def test_bibtex_finds_a_project_bst_file_nested_in_a_subdirectory(tmp_path):
    """M5.5.3 continuation Part 15/16 — real-world reproduction: the
    Springer Nature journal fixture ships its many `.bst` citation-style
    files one level down, in a "bst/" subfolder next to the root .tex,
    not as a direct sibling (unlike every `.cls`/`.sty` case this
    compiler had previously been exercised against). Direct reproduction
    against a running dev stack confirmed bibtex failed with "I couldn't
    open style file <name>.bst" before _job_env() gave BSTINPUTS a
    recursive "." entry — this test locks that fix in without needing a
    live dev stack. Uses a real system-installed plain.bst's own bytes
    (copied into extra_files under a name no system texmf tree has:
    "no_such_style_in_system_texmf") so success can ONLY come from the
    project's own subdirectory copy being found, never a same-named
    system style silently masking a still-broken lookup."""
    try:
        located = subprocess.run(
            ["kpsewhich", "plain.bst"], capture_output=True, text=True, timeout=10
        )
    except (OSError, subprocess.TimeoutExpired):
        located = None
    if located is None or located.returncode != 0 or not located.stdout.strip():
        pytest.skip("plain.bst not found via kpsewhich in this environment")
    bst_bytes = open(located.stdout.strip(), "rb").read()

    settings = _settings(working_root=str(tmp_path))
    main_tex = (
        "\\documentclass{article}\n\\begin{document}\nSee \\cite{Smith2020}.\n"
        "\\bibliographystyle{no_such_style_in_system_texmf}\n"
        "\\bibliography{references}\n\\end{document}\n"
    )
    bib = (
        "@article{Smith2020, author={Smith, John}, title={A Paper}, "
        "journal={J}, year={2020}}\n"
    )
    outcome = await run_compile_job(
        main_tex=main_tex,
        references_bib=bib,
        settings=settings,
        extra_files={"bst/no_such_style_in_system_texmf.bst": bst_bytes},
    )
    assert not any("couldn't open style file" in d.message.lower() for d in outcome.diagnostics)
    assert "couldn't open style file" not in (outcome.log_excerpt or "").lower()
    assert outcome.status == "success"
    assert not any("citation" in d.message.lower() for d in outcome.diagnostics)


async def test_shell_escape_never_executes(tmp_path):
    settings = _settings(working_root=str(tmp_path))
    marker = tmp_path / "PWNED"
    main_tex = (
        "\\documentclass{article}\\begin{document}"
        f"\\immediate\\write18{{touch {marker}}}"
        "hi\\end{document}"
    )
    await run_compile_job(main_tex=main_tex, references_bib="", settings=settings)
    assert not marker.exists()


async def test_absolute_path_read_blocked(tmp_path):
    settings = _settings(working_root=str(tmp_path))
    main_tex = "\\documentclass{article}\\begin{document}\\input{/etc/passwd}\\end{document}"
    outcome = await run_compile_job(main_tex=main_tex, references_bib="", settings=settings)
    assert "root:" not in outcome.log_excerpt


async def test_malformed_tex_fails_with_diagnostics(tmp_path):
    settings = _settings(working_root=str(tmp_path))
    outcome = await run_compile_job(
        main_tex="\\documentclass{article}\\begin{document", references_bib="", settings=settings
    )
    assert outcome.status == "error"
    assert len(outcome.diagnostics) > 0


async def test_timeout_fixture_is_terminated(tmp_path):
    settings = _settings(working_root=str(tmp_path), phase_timeout_seconds=3.0)
    main_tex = (
        "\\documentclass{article}\\def\\infiniteloop{\\infiniteloop}"
        "\\begin{document}\\infiniteloop\\end{document}"
    )
    outcome = await run_compile_job(main_tex=main_tex, references_bib="", settings=settings)
    assert outcome.status == "timeout"


async def test_cleanup_leaves_no_working_directory(tmp_path):
    settings = _settings(working_root=str(tmp_path))
    await run_compile_job(
        main_tex="\\documentclass{article}\\begin{document}x\\end{document}",
        references_bib="",
        settings=settings,
    )
    assert list(tmp_path.iterdir()) == []


# --- Milestone 5.3 Part 20/44 — multi-file compilation ---------------------


async def test_input_resolves_a_project_tex_file(tmp_path):
    """Scenario D — main.tex \\input{}'s a secondary project file; its
    text must appear in the compiled PDF."""
    settings = _settings(working_root=str(tmp_path))
    main_tex = (
        "\\documentclass{article}\\begin{document}\\input{sections/introduction}"
        "\\end{document}"
    )
    extra_files = {
        "sections/introduction.tex": b"Hello from a secondary file."
    }
    outcome = await run_compile_job(
        main_tex=main_tex, references_bib="", settings=settings, extra_files=extra_files
    )
    assert outcome.status == "success"
    assert outcome.pdf_bytes is not None


async def test_include_resolves_a_project_tex_file(tmp_path):
    settings = _settings(working_root=str(tmp_path))
    main_tex = (
        "\\documentclass{article}\\begin{document}\\include{sections/methods}"
        "\\end{document}"
    )
    extra_files = {"sections/methods.tex": b"Methods content here."}
    outcome = await run_compile_job(
        main_tex=main_tex, references_bib="", settings=settings, extra_files=extra_files
    )
    assert outcome.status == "success"


async def test_includegraphics_resolves_an_uploaded_figure(tmp_path):
    """Scenario E — a real, tiny valid PNG."""
    settings = _settings(working_root=str(tmp_path))
    # 1x1 transparent PNG.
    png_bytes = bytes.fromhex(
        "89504e470d0a1a0a0000000d494844520000000100000001080600000"
        "01f15c4890000000a49444154789c6300010000050001"
        "0d0a2db40000000049454e44ae426082"
    )
    main_tex = (
        "\\documentclass{article}\\usepackage{graphicx}\\begin{document}"
        "\\includegraphics[width=1cm]{figures/framework.png}\\end{document}"
    )
    outcome = await run_compile_job(
        main_tex=main_tex,
        references_bib="",
        settings=settings,
        extra_files={"figures/framework.png": png_bytes},
    )
    assert outcome.status == "success"
    assert outcome.pdf_bytes is not None


async def test_extra_files_absolute_path_rejected_with_error_diagnostic(tmp_path):
    """Belt-and-suspenders (Part 45) — this path should never actually
    be reachable via rag-backend's own validation, but this service
    must never silently drop or blindly write an unsafe extra_files
    path even if it somehow received one."""
    settings = _settings(working_root=str(tmp_path))
    outcome = await run_compile_job(
        main_tex="\\documentclass{article}\\begin{document}x\\end{document}",
        references_bib="",
        settings=settings,
        extra_files={"/etc/passwd": b"malicious"},
    )
    assert outcome.status == "error"
    assert any("unsafe" in d.message.lower() for d in outcome.diagnostics)


async def test_extra_files_traversal_path_rejected(tmp_path):
    settings = _settings(working_root=str(tmp_path))
    outcome = await run_compile_job(
        main_tex="\\documentclass{article}\\begin{document}x\\end{document}",
        references_bib="",
        settings=settings,
        extra_files={"../../etc/passwd": b"malicious"},
    )
    assert outcome.status == "error"


async def test_extra_files_cleaned_up_after_compile(tmp_path):
    settings = _settings(working_root=str(tmp_path))
    await run_compile_job(
        main_tex="\\documentclass{article}\\begin{document}\\input{a}\\end{document}",
        references_bib="",
        settings=settings,
        extra_files={"a.tex": b"hi"},
    )
    assert list(tmp_path.iterdir()) == []
