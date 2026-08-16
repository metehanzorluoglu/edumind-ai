"""Milestone 5.1 Part 22/23/50 — pure tests for log sanitization and
diagnostic extraction. No subprocess needed."""

from app.log_sanitizer import extract_diagnostics, sanitize_log


def test_sanitize_log_strips_workdir_path():
    raw = "! Undefined control sequence.\nl.5 /tmp/jobs/abc123/main.tex:5: \\foo\n"
    cleaned = sanitize_log(raw, workdir_label="/tmp/jobs/abc123")
    assert "/tmp/jobs/abc123" not in cleaned
    assert "<project>" in cleaned


def test_sanitize_log_truncates_long_logs():
    raw = "x" * 20_000
    cleaned = sanitize_log(raw)
    assert len(cleaned) < 10_000
    assert cleaned.endswith("(log truncated)")


def test_extract_diagnostics_finds_latex_errors():
    raw = (
        "! Undefined control sequence.\n"
        "l.7 \\foo\n"
        "        bar\n"
    )
    diags = extract_diagnostics(raw)
    assert len(diags) == 1
    assert diags[0].severity == "error"
    assert "Undefined control sequence" in diags[0].message
    assert diags[0].line == 7


def test_extract_diagnostics_finds_citation_warning():
    raw = "LaTeX Warning: Citation `Smith2020' on page 1 undefined on input line 7.\n"
    diags = extract_diagnostics(raw)
    assert len(diags) == 1
    assert diags[0].severity == "warning"
    assert "Smith2020" in diags[0].message


def test_extract_diagnostics_empty_for_clean_log():
    raw = "This is pdfTeX, Version 3.14...\nOutput written on main.pdf (1 page).\n"
    assert extract_diagnostics(raw) == []


def test_extract_diagnostics_caps_at_max():
    raw = "\n".join(f"! Error number {i}." for i in range(50))
    diags = extract_diagnostics(raw)
    assert len(diags) <= 20
