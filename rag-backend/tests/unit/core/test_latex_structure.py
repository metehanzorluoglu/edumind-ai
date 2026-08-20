"""Milestone 6.1 (Writing Context Engine) Parts 4/7/22 — deterministic
LaTeX structural parsing. Letters D (section detection), E (subsection
detection), F (commented-out section ignored) from the spec's required
test list."""

from __future__ import annotations

from app.core.latex_structure import (
    find_enclosing_section,
    offset_to_line,
    parse_latex_structure,
)

_SAMPLE = """\\documentclass{article}
\\begin{document}
\\section{Introduction}
Some intro text.
\\subsection{Background}
Background text here.
% \\section{Commented Out Section}
More background.
\\subsection{Teacher Agency}
Teacher agency is influenced by contextual conditions.
\\section{Discussion}
Discussion text.
\\end{document}
"""


class TestParseLatexStructure:
    def test_documentclass_detected(self) -> None:
        s = parse_latex_structure(_SAMPLE)
        assert s.documentclass == "article"

    def test_document_body_bounds_detected(self) -> None:
        s = parse_latex_structure(_SAMPLE)
        assert s.document_body_start_line == 2
        assert s.document_body_end_line == 13

    def test_sections_found_in_order(self) -> None:
        s = parse_latex_structure(_SAMPLE)
        kinds_titles = [(n.kind, n.title) for n in s.sections]
        assert kinds_titles == [
            ("section", "Introduction"),
            ("subsection", "Background"),
            ("subsection", "Teacher Agency"),
            ("section", "Discussion"),
        ]

    def test_letter_F_commented_out_section_ignored(self) -> None:
        """A commented-out \\section must never appear as active
        manuscript structure (M6.1 Part 4)."""
        s = parse_latex_structure(_SAMPLE)
        titles = [n.title for n in s.sections]
        assert "Commented Out Section" not in titles

    def test_escaped_percent_is_not_a_comment(self) -> None:
        content = "\\section{100\\% Complete}\nBody text.\n"
        s = parse_latex_structure(content)
        assert s.sections[0].title == "100\\% Complete"

    def test_chapter_and_subsubsection_recognized(self) -> None:
        content = (
            "\\chapter{Methods}\n"
            "\\section{Design}\n"
            "\\subsection{Sample}\n"
            "\\subsubsection{Recruitment}\n"
            "Text.\n"
        )
        s = parse_latex_structure(content)
        assert [n.kind for n in s.sections] == ["chapter", "section", "subsection", "subsubsection"]

    def test_input_include_targets_collected_with_line_numbers(self) -> None:
        content = "\\input{sections/intro}\n\\include{Chapter1}\n"
        s = parse_latex_structure(content)
        assert [(t.kind, t.target, t.line) for t in s.inputs] == [
            ("input", "sections/intro", 1),
            ("include", "Chapter1", 2),
        ]

    def test_bibliography_targets_and_style_collected(self) -> None:
        content = "\\bibliographystyle{plain}\n\\bibliography{refs,extra}\n"
        s = parse_latex_structure(content)
        assert s.bibliographystyle == "plain"
        assert s.bibliography_targets == ["refs", "extra"]

    def test_thebibliography_detected(self) -> None:
        content = "\\begin{thebibliography}{9}\n\\bibitem{a} A.\n\\end{thebibliography}\n"
        s = parse_latex_structure(content)
        assert s.has_thebibliography is True

    def test_commented_input_not_collected(self) -> None:
        content = "% \\input{secret}\n\\input{real}\n"
        s = parse_latex_structure(content)
        assert [t.target for t in s.inputs] == ["real"]

    def test_malformed_latex_never_raises(self) -> None:
        # An unterminated \section brace / stray backslash must degrade
        # gracefully (Part 4), never crash the context engine.
        s = parse_latex_structure("\\section{Unterminated\n\\notacommand\\")
        assert isinstance(s.sections, list)


class TestFindEnclosingSection:
    def test_letter_D_section_detection(self) -> None:
        s = parse_latex_structure(_SAMPLE)
        # line 4 ("Some intro text.") is inside \section{Introduction}
        path = find_enclosing_section(s, 4)
        assert path.section == "Introduction"
        assert path.subsection is None

    def test_letter_E_subsection_detection(self) -> None:
        s = parse_latex_structure(_SAMPLE)
        # line 10 ("Teacher agency is influenced...") is inside subsection
        # "Teacher Agency", itself under section "Introduction".
        path = find_enclosing_section(s, 10)
        assert path.section == "Introduction"
        assert path.subsection == "Teacher Agency"

    def test_new_section_closes_prior_subsection(self) -> None:
        s = parse_latex_structure(_SAMPLE)
        path = find_enclosing_section(s, 12)  # "Discussion text." under \section{Discussion}
        assert path.section == "Discussion"
        assert path.subsection is None  # NOT "Teacher Agency" — must not leak across sections

    def test_line_before_any_heading_returns_empty_path(self) -> None:
        s = parse_latex_structure(_SAMPLE)
        path = find_enclosing_section(s, 1)  # \documentclass line, before any \section
        assert path.is_empty()

    def test_document_with_no_headings_returns_empty_path(self) -> None:
        s = parse_latex_structure(
            "\\documentclass{article}\n\\begin{document}\nplain text\n\\end{document}\n"
        )
        path = find_enclosing_section(s, 3)
        assert path.is_empty()

    def test_chapter_subsection_subsubsection_nesting(self) -> None:
        content = (
            "\\chapter{Methods}\n"
            "\\section{Design}\n"
            "\\subsection{Sample}\n"
            "\\subsubsection{Recruitment}\n"
            "Text about recruitment.\n"
        )
        s = parse_latex_structure(content)
        path = find_enclosing_section(s, 5)
        assert path.chapter == "Methods"
        assert path.section == "Design"
        assert path.subsection == "Sample"
        assert path.subsubsection == "Recruitment"


class TestOffsetToLine:
    def test_offset_zero_is_line_one(self) -> None:
        assert offset_to_line("abc\ndef", 0) == 1

    def test_offset_after_newline_is_next_line(self) -> None:
        content = "abc\ndef\nghi"
        assert offset_to_line(content, 4) == 2  # index 4 = 'd'

    def test_offset_clamped_when_out_of_range(self) -> None:
        content = "short"
        assert offset_to_line(content, 9999) == 1  # single line, clamped to end
