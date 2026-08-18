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


def test_extract_diagnostics_classifies_placeholder_content_truthfully():
    """Milestone 5.5.3 — real-world finding from the UNLV thesis fixture:
    Abstract.tex's own `\\` line break immediately followed by bracketed
    placeholder text on the next line ("[Advisor Title]") gets parsed by
    LaTeX as `\\[Advisor Title]` (an invalid spacing argument), producing
    "Missing number, treated as zero." The real pdflatex log this
    produces (-file-line-error form, with the standard l.NN context
    dump a couple of lines later)."""
    raw = (
        "./Abstract.tex:11: Missing number, treated as zero.\n"
        "<to be read again> \n"
        "                   [\n"
        "l.11 [Advisor Title] \\\\\n"
        "                       \n"
    )
    diags = extract_diagnostics(raw)
    assert len(diags) == 1
    assert diags[0].file == "Abstract.tex"
    assert diags[0].line == 11
    assert diags[0].message == (
        "Compilation reached Abstract.tex line 11. This template still contains "
        "placeholder content `[Advisor Title]`, which LaTeX is interpreting as syntax. "
        "Replace the placeholder with your actual content, then compile again."
    )


def test_extract_diagnostics_never_duplicates_the_fatal_error_trailer_row():
    """Milestone 5.5.3 continuation — real bug, reproduced against the
    ACTUAL log text captured from a real UNLV compile (not a trimmed
    synthetic excerpt): pdflatex's own "no output PDF file produced!"
    trailer is prefixed with the SAME file:line as the real error that
    caused it, so it previously matched _FILE_LINE_ERROR_PATTERN as its
    own second diagnostic — the UI showed "Abstract.tex:11" twice, one
    useful and one just a fixed pdflatex string. Must collapse to
    exactly the one useful, classified diagnostic."""
    raw = (
        "(./Abstract.tex\n"
        "./Abstract.tex:11: Missing number, treated as zero.\n"
        "<to be read again> \n"
        "                   A\n"
        "l.11 [Advisor Title]\n"
        "                     \\\\\n"
        "./Abstract.tex:11:  ==> Fatal error occurred, no output PDF file produced!\n"
        "Transcript written on main.log.\n"
    )
    diags = extract_diagnostics(raw)
    assert len(diags) == 1
    assert diags[0].file == "Abstract.tex"
    assert diags[0].line == 11
    assert "Fatal error occurred" not in diags[0].message
    assert diags[0].message == (
        "Compilation reached Abstract.tex line 11. This template still contains "
        "placeholder content `[Advisor Title]`, which LaTeX is interpreting as syntax. "
        "Replace the placeholder with your actual content, then compile again."
    )


def test_extract_diagnostics_deduplicates_a_genuinely_repeated_identical_diagnostic():
    raw = (
        "! Undefined control sequence.\nl.5 \\foo\n"
        "! Undefined control sequence.\nl.5 \\foo\n"
    )
    diags = extract_diagnostics(raw)
    assert len(diags) == 1


def test_extract_diagnostics_never_classifies_an_unrelated_missing_number_error():
    """The classification is scoped to a REAL bracket placeholder found
    in the log's own context line — a "Missing number" error with no
    such context (or none nearby) keeps its original, honest message."""
    raw = "./main.tex:5: Missing number, treated as zero.\nl.5 \\vspace{}\n"
    diags = extract_diagnostics(raw)
    assert len(diags) == 1
    assert diags[0].message == "Missing number, treated as zero."


def test_extract_diagnostics_never_classifies_a_different_error_type_even_with_brackets_nearby():
    raw = "./main.tex:5: Undefined control sequence.\nl.5 \\foo [Some Bracketed Text]\n"
    diags = extract_diagnostics(raw)
    assert len(diags) == 1
    assert diags[0].message == "Undefined control sequence."


def test_extract_diagnostics_never_classifies_the_classic_bang_form_without_a_file():
    """The classic "! message" / "l.NN" two-line form never carries a
    filename (module-wide design constraint — see _find_nearby_line_and
    _file's own docstring). The classification message names the file
    ("Compilation reached {file} line {line}"), so it only ever fires
    when a real filename is available — never with a placeholder/omitted
    file, which would be less useful and inconsistent with every other
    diagnostic's own file-attribution guarantee."""
    raw = "! Missing number, treated as zero.\nl.11 [Advisor Title] \\\\\n"
    diags = extract_diagnostics(raw)
    assert len(diags) == 1
    assert diags[0].file is None
    assert diags[0].message == "Missing number, treated as zero."


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
