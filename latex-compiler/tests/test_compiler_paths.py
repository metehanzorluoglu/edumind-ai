"""Milestone 5.3 Part 18/19/45 — app.compiler.safe_relative_path. No
pdflatex required (pure path-arithmetic), so this runs everywhere,
unlike test_compiler_subprocess.py's real end-to-end tests."""

from pathlib import Path

from app.compiler import safe_relative_path


def test_accepts_ordinary_relative_paths(tmp_path: Path) -> None:
    assert safe_relative_path("sections/introduction.tex", tmp_path) == (
        tmp_path / "sections" / "introduction.tex"
    )
    assert safe_relative_path("figures/framework.png", tmp_path) == (
        tmp_path / "figures" / "framework.png"
    )
    assert safe_relative_path("journal.cls", tmp_path) == tmp_path / "journal.cls"


def test_rejects_absolute_paths(tmp_path: Path) -> None:
    assert safe_relative_path("/etc/passwd", tmp_path) is None


def test_rejects_dotdot_traversal(tmp_path: Path) -> None:
    assert safe_relative_path("../../etc/passwd", tmp_path) is None
    assert safe_relative_path("sections/../../etc/passwd", tmp_path) is None
    assert safe_relative_path("..", tmp_path) is None


def test_rejects_empty_or_degenerate(tmp_path: Path) -> None:
    assert safe_relative_path("", tmp_path) is None
    assert safe_relative_path(".", tmp_path) is None


def test_accepts_nested_nontraversal_paths(tmp_path: Path) -> None:
    assert safe_relative_path("a/b/c/d.tex", tmp_path) == tmp_path / "a" / "b" / "c" / "d.tex"
