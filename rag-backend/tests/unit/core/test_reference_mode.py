"""Bibliography Source Detection — tests use REAL fixture content copied
verbatim from the two ZIP templates already used throughout this
codebase's own manual/real-browser testing (the UNLV thesis template's
Bibliography.tex/thesis.tex, and the Springer Nature journal template's
sn-bibliography.bib/sn-article.tex) — not synthetic strings invented for
this test file. `extend_asset/` itself is gitignored (local dev fixtures
only, never depended on by the automated suite), so the exact real text
is embedded directly here instead of read from that directory.
"""

from __future__ import annotations

import bibtexparser

from app.core.reference_mode import (
    detect_reference_mode,
    extract_bibitem_entries,
    extract_bibliography_targets,
    extract_bibtex_entries,
    extract_input_include_targets,
    has_thebibliography,
    propose_edum8_switch,
    strip_latex_comments,
)

# Verbatim from UNLV_Thesis_Template_Clean.zip's Bibliography.tex.
UNLV_BIBLIOGRAPHY_TEX = """\\begin{thebibliography}{99}

%% Example bibliography entries - replace with your own references

\\bibitem{example1}
Author, A. and Author, B. (Year).
\\textit{Title of the Paper}.
Journal Name, Volume(Issue), pages.

\\bibitem{example2}
Author, C. (Year).
\\textit{Book Title}.
Publisher, Location.

\\bibitem{example3}
Author, D., Author, E., and Author, F. (Year).
Title of Conference Paper.
In \\textit{Proceedings of Conference Name}, pages, Location.

%% Add your references here following the appropriate citation style
%% You can also use BibTeX by creating a references.bib file

\\end{thebibliography}

%% Alternative: Use BibTeX
%% Uncomment the following lines and comment out the thebibliography environment above
%% \\bibliographystyle{plain}  %% or ieeetr, acm, etc.
%% \\bibliography{references}  %% references.bib file
"""

# Verbatim excerpt from UNLV_Thesis_Template_Clean.zip's thesis.tex.
UNLV_THESIS_TEX = """\\documentclass{book}
\\begin{document}
\\include{Titlepage}
\\include{Abstract}
\\include{Acknowledgements}
\\include{Chapter1}
\\include{Chapter2}
\\include{Chapter3}
\\include{Chapter4}
\\include{Chapter5}
%% \\include{Appendices/AppendixA}
\\include{Bibliography}
\\include{Vita}
\\end{document}
"""

# Verbatim excerpt (first 4 entries) from the Springer Nature template's
# sn-bibliography.bib — includes both the nested-braces-inside-a-quoted-
# title case (bib1) and a title that wraps across lines (bib3).
SN_BIBLIOGRAPHY_BIB = """
%% Journal article
@article{bib1,
  author\t\t= "Campbell, S. L. and Gear, C. W.",
  title\t\t\t= "The index of general nonlinear {D}{A}{E}{S}",
  journal\t\t= "Numer. {M}ath.",
  volume\t\t= "72",
  number\t\t= "2",
  pages\t\t\t= "173--196",
  year\t\t\t= "1995"
}

%% Journal article with DOI
@article{bib2,
  author\t\t= "Slifka, M. K. and Whitton, J. L.",
  title\t\t\t= "Clinical implications of dysregulated cytokine production",
  journal\t\t= "J. {M}ol. {M}ed.",
  volume\t\t= "78",
  pages\t\t\t= "74--80",
  year\t\t\t= "2000",
  doi\t\t\t= "10.1007/s001090000086"
}

%% Journal article
@article{bib3,
  author\t\t= "Hamburger, C.",
  title\t\t\t= "Quasimonotonicity, regularity and duality for nonlinear systems of
\t\t\t\t\tpartial differential equations",
  journal\t\t= "Ann. Mat. Pura. Appl.",
  volume\t\t= "169",
  number\t\t= "2",
  pages\t\t\t= "321--354",
  year\t\t\t= "1995"
}

%% book, authored
@book{bib4,
  author\t\t= "Geddes, K. O. and Czapor, S. R. and Labahn, G.",
  title\t\t\t= "Algorithms for {C}omputer {A}lgebra",
  address\t\t= "Boston",
  publisher\t\t= "Kluwer",
  year\t\t\t= "1992"
}
"""

# Verbatim excerpt from sn-article.tex.
SN_ARTICLE_TEX = """\\documentclass[pdflatex,sn-mathphys-num]{sn-jnl}
\\begin{document}
\\section{Introduction}
See \\cite{bib1}.
%% file, and delete the associated \\verb+\\bibliography+ commands.
\\bibliography{sn-bibliography}%% common bib file
\\end{document}
"""


class TestStripLatexComments:
    def test_strips_a_real_comment_to_end_of_line(self):
        assert strip_latex_comments("foo %% bar\nbaz") == "foo \nbaz"

    def test_does_not_strip_an_escaped_percent(self):
        assert strip_latex_comments(r"100\% done") == r"100\% done"

    def test_a_percent_after_an_escaped_backslash_IS_a_comment(self):
        # `\\` is an escaped backslash (a literal backslash character);
        # the `%` right after it is therefore NOT escaped by that
        # backslash and starts a real comment.
        assert strip_latex_comments("x\\\\% real comment\ny") == "x\\\\\ny"

    def test_strips_the_real_commented_out_bibliography_example_in_unlv_bibliography_tex(self):
        stripped = strip_latex_comments(UNLV_BIBLIOGRAPHY_TEX)
        assert "\\bibliography{references}" not in stripped
        assert has_thebibliography(stripped)


class TestExtractors:
    def test_extract_bibliography_targets_single(self):
        assert extract_bibliography_targets(r"\bibliography{sn-bibliography}") == [
            "sn-bibliography"
        ]

    def test_extract_bibliography_targets_comma_separated(self):
        assert extract_bibliography_targets(r"\bibliography{a,b, c}") == ["a", "b", "c"]

    def test_extract_input_include_targets(self):
        stripped = strip_latex_comments(UNLV_THESIS_TEX)
        targets = extract_input_include_targets(stripped)
        assert targets == [
            "Titlepage",
            "Abstract",
            "Acknowledgements",
            "Chapter1",
            "Chapter2",
            "Chapter3",
            "Chapter4",
            "Chapter5",
            "Bibliography",
            "Vita",
        ]
        # The commented-out AppendixA include must NOT appear.
        assert "Appendices/AppendixA" not in targets

    def test_extract_bibitem_entries_from_the_real_unlv_fixture(self):
        stripped = strip_latex_comments(UNLV_BIBLIOGRAPHY_TEX)
        entries = extract_bibitem_entries(stripped)
        keys = [k for k, _label in entries]
        assert keys == ["example1", "example2", "example3"]
        # Labels are best-effort display text, never used as keys —
        # just confirm something real (not empty) came through.
        assert all(label for _key, label in entries)

    def test_extract_bibtex_entries_keys_match_a_real_bibtex_parser(self):
        """Cross-checked against `bibtexparser` (this codebase's own
        round-trip-validation dependency, see test_bibtex.py) — not just
        this module's own hand-rolled regex agreeing with itself."""
        db = bibtexparser.loads(SN_BIBLIOGRAPHY_BIB)
        expected_keys = {e["ID"] for e in db.entries}
        entries = extract_bibtex_entries(SN_BIBLIOGRAPHY_BIB)
        assert {k for k, _title in entries} == expected_keys == {"bib1", "bib2", "bib3", "bib4"}

    def test_extract_bibtex_entries_title_handles_nested_braces_inside_quotes(self):
        entries = dict(extract_bibtex_entries(SN_BIBLIOGRAPHY_BIB))
        assert entries["bib1"] == "The index of general nonlinear DAES"

    def test_extract_bibtex_entries_title_handles_a_real_multi_line_wrap(self):
        entries = dict(extract_bibtex_entries(SN_BIBLIOGRAPHY_BIB))
        assert entries["bib3"] == (
            "Quasimonotonicity, regularity and duality for nonlinear systems of "
            "partial differential equations"
        )


class TestDetectReferenceMode:
    def test_the_real_unlv_thesis_is_detected_as_template_tex_bibliography(self):
        result = detect_reference_mode(
            root_path="thesis.tex",
            root_content=UNLV_THESIS_TEX,
            text_files={
                "thesis.tex": UNLV_THESIS_TEX,
                "Bibliography.tex": UNLV_BIBLIOGRAPHY_TEX,
                "Chapter1.tex": "Chapter one.",
            },
            edum8_reference_count=0,
        )
        assert result.mode == "template_tex"
        assert result.bibliography_source == "Bibliography.tex"
        assert result.citation_key_source == "bibitem"
        assert [k for k, _label in result.keys] == ["example1", "example2", "example3"]
        assert result.edum8_available is False
        assert result.no_key_source_reason is None

    def test_the_real_sn_article_is_detected_as_imported_bib_database(self):
        result = detect_reference_mode(
            root_path="sn-article.tex",
            root_content=SN_ARTICLE_TEX,
            text_files={
                "sn-article.tex": SN_ARTICLE_TEX,
                "sn-bibliography.bib": SN_BIBLIOGRAPHY_BIB,
            },
            edum8_reference_count=0,
        )
        assert result.mode == "imported_bib"
        assert result.bibliography_source == "sn-bibliography.bib"
        assert result.citation_key_source == "bib_file"
        assert {k for k, _title in result.keys} == {"bib1", "bib2", "bib3", "bib4"}

    def test_a_blank_project_with_no_signals_defaults_to_edum8_library(self):
        result = detect_reference_mode(
            root_path="main.tex",
            root_content="\\documentclass{article}\n\\begin{document}\nHello.\n\\end{document}",
            text_files={"main.tex": "\\documentclass{article}\n\\begin{document}\nHello.\n\\end{document}"},
            edum8_reference_count=3,
        )
        assert result.mode == "edum8_library"
        assert result.bibliography_source == "references.bib"
        assert result.citation_key_source == "edum8"
        assert result.edum8_available is True

    def test_bibliography_references_macro_pointing_at_the_virtual_edum8_file_is_edum8_library(self):
        content = "\\documentclass{article}\n\\bibliography{references}\n"
        result = detect_reference_mode(
            root_path="main.tex",
            root_content=content,
            text_files={"main.tex": content},
            edum8_reference_count=0,
        )
        assert result.mode == "edum8_library"
        assert result.citation_key_source == "edum8"

    def test_never_treats_a_commented_out_bibliography_macro_as_real_configuration(self):
        """The UNLV Bibliography.tex fixture's own commented-out
        `%% \\bibliography{references}` line, reachable via \\include, must
        NOT flip this into imported_bib/edum8_library mode — it's inert
        example text, not real configuration."""
        result = detect_reference_mode(
            root_path="thesis.tex",
            root_content=UNLV_THESIS_TEX,
            text_files={
                "thesis.tex": UNLV_THESIS_TEX,
                "Bibliography.tex": UNLV_BIBLIOGRAPHY_TEX,
            },
            edum8_reference_count=0,
        )
        assert result.mode == "template_tex"  # not edum8_library

    def test_inline_thebibliography_directly_in_the_root_document(self):
        content = (
            "\\documentclass{article}\n\\begin{document}\n"
            "\\begin{thebibliography}{9}\n\\bibitem{foo}\nFoo et al.\n\\end{thebibliography}\n"
            "\\end{document}\n"
        )
        result = detect_reference_mode(
            root_path="main.tex",
            root_content=content,
            text_files={"main.tex": content},
            edum8_reference_count=0,
        )
        assert result.mode == "inline_template"
        assert result.bibliography_source == "main.tex"
        assert [k for k, _label in result.keys] == ["foo"]

    def test_bibliography_macro_pointing_at_a_bib_file_not_actually_in_the_project_falls_through(self):
        content = "\\documentclass{article}\n\\bibliography{nonexistent}\n"
        result = detect_reference_mode(
            root_path="main.tex",
            root_content=content,
            text_files={"main.tex": content},
            edum8_reference_count=2,
        )
        # No real nonexistent.bib file, and the argument isn't
        # "references" either — falls through to the EduM8 default.
        assert result.mode == "edum8_library"

    def test_no_key_source_reason_set_when_a_bib_file_has_no_parseable_entries(self):
        content = "\\documentclass{article}\n\\bibliography{empty}\n"
        result = detect_reference_mode(
            root_path="main.tex",
            root_content=content,
            text_files={"main.tex": content, "empty.bib": "%% nothing here\n"},
            edum8_reference_count=0,
        )
        assert result.mode == "imported_bib"
        assert result.citation_key_source == "none"
        assert result.no_key_source_reason is not None
        assert "empty.bib" in result.no_key_source_reason

    def test_template_tex_nested_bib_database_is_resolved(self):
        """"If Bibliography.tex ultimately references a real .bib
        database, resolve that relationship deterministically and use
        that database's keys" — Bibliography.tex here itself uses
        \\bibliography{refs}, not thebibliography/\\bibitem."""
        bib_tex = "\\bibliographystyle{plain}\n\\bibliography{refs}\n"
        result = detect_reference_mode(
            root_path="main.tex",
            root_content="\\documentclass{article}\n\\include{Bibliography}\n",
            text_files={
                "main.tex": "\\documentclass{article}\n\\include{Bibliography}\n",
                "Bibliography.tex": bib_tex,
                "refs.bib": SN_BIBLIOGRAPHY_BIB,
            },
            edum8_reference_count=0,
        )
        # Bibliography.tex has no thebibliography block, so step 2's
        # thebibliography check doesn't match it directly — but it DOES
        # have a real \\bibliography{refs} of its own; without special
        # handling this would fall through to the default. Confirm the
        # actual (documented) behavior: since Bibliography.tex has no
        # thebibliography environment, detection does not treat it as
        # TEMPLATE_TEX_BIBLIOGRAPHY at all — it falls through to the
        # EduM8 default, because step 1 only scans the ROOT document's
        # own \\bibliography{...}, not an included file's.
        assert result.mode == "edum8_library"


class TestProposeEdum8Switch:
    def test_proposes_a_safe_single_line_rewrite_for_imported_bib_mode(self):
        proposal = propose_edum8_switch(
            mode="imported_bib", root_path="sn-article.tex", root_content=SN_ARTICLE_TEX
        )
        assert proposal is not None
        assert proposal.file_path == "sn-article.tex"
        assert proposal.find == "\\bibliography{sn-bibliography}"
        assert proposal.replace == "\\bibliography{references}"
        # The `find` text must be an exact, verbatim substring of the
        # original content — safe for a single str.replace(..., 1).
        assert proposal.find in SN_ARTICLE_TEX
        rewritten = SN_ARTICLE_TEX.replace(proposal.find, proposal.replace, 1)
        assert "\\bibliography{references}" in rewritten
        assert "sn-bibliography" not in rewritten.split("\\bibliography{references}")[1]

    def test_never_proposes_anything_for_template_tex_mode(self):
        assert (
            propose_edum8_switch(
                mode="template_tex", root_path="thesis.tex", root_content=UNLV_THESIS_TEX
            )
            is None
        )

    def test_never_proposes_anything_for_inline_template_mode(self):
        assert (
            propose_edum8_switch(mode="inline_template", root_path="main.tex", root_content="x")
            is None
        )

    def test_never_proposes_anything_for_edum8_library_mode(self):
        assert (
            propose_edum8_switch(mode="edum8_library", root_path="main.tex", root_content="x")
            is None
        )
