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
    # No file: the classic "l.NN" form carries no filename of its own
    # (Milestone 5.5 Part 14 — never guessed).
    assert diags[0].file is None


def test_extract_diagnostics_attributes_the_real_file_for_a_multi_file_project():
    """Milestone 5.5 Part 14 — the M5.4 multi-file regression this
    hardcoded-to-main.tex regex previously missed entirely: an error in
    an \\input-ed file, reported via pdflatex's own -file-line-error
    form."""
    raw = "sections/introduction.tex:12: Undefined control sequence.\nl.12 \\foo\n"
    diags = extract_diagnostics(raw)
    assert len(diags) == 1
    assert diags[0].line == 12
    assert diags[0].file == "sections/introduction.tex"


def test_extract_diagnostics_normalizes_a_leading_dot_slash():
    raw = "./main.tex:3: Undefined control sequence.\nl.3 \\foo\n"
    diags = extract_diagnostics(raw)
    assert diags[0].file == "main.tex"


def test_extract_diagnostics_never_reports_an_absolute_path_as_file():
    """The file:line: regex only matches a RELATIVE path — kpathsea never
    reports an absolute one for a normal \\input, but this is a hard
    guarantee against ever leaking a host path into `file` (Part 15/23's
    existing "never leak container paths" requirement, extended to this
    new field)."""
    raw = "! Undefined control sequence.\n/tmp/jobs/abc123/main.tex:9: junk\nl.9 \\foo\n"
    diags = extract_diagnostics(raw)
    assert len(diags) == 1
    # The absolute-path line didn't match _FILE_LINE_ERROR_PATTERN (no
    # leading slash allowed), so the window scan fell through to the
    # l.NN line instead — the SAME conservative "line-only, no file"
    # outcome the plain classic form gets.
    assert diags[0].line == 9
    assert diags[0].file is None


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
