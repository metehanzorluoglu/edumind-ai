"""Milestone 4 (Reference Library & Bibliographic Metadata Foundation)
constraint: focused direct tests for app/ingestion/metadata_extraction.py,
which had zero test coverage before this milestone despite being the
module every bibliographic field (title/authors/DOI/year/venue/abstract/
keywords/language/volume/pages) ultimately comes from. Covers, per the
milestone's explicit list: title, authors, DOI, year, venue/journal,
abstract, keywords, language, volume/pages, provenance priority, filename
fallback, missing metadata, and Unicode/special characters. "User override
precedence" (the one remaining item on that list) is a property of
app/ingestion/ingest.py, not this module — see test_ingest.py instead.
"""

from app.ingestion.loaders.base import ExtractedMetadata, ExtractionSource, PageContent
from app.ingestion.metadata_extraction import (
    apply_filename_fallback,
    clean_filename_as_title,
    detect_language,
    extract_abstract_from_lines,
    extract_authors_from_lines,
    extract_doi,
    extract_from_pages,
    extract_keywords_from_lines,
    extract_publication_year,
    extract_title_and_authors_from_front_matter,
    extract_title_from_lines,
    extract_venue_from_lines,
    is_plausible_title,
    merge_extracted_metadata,
    normalize_author_name,
    normalize_doi,
    parse_journal_citation,
    split_author_string,
)


def _page(text: str, number: int = 1) -> PageContent:
    return PageContent(page_number=number, text=text)


# --- Title -------------------------------------------------------------


class TestExtractTitleFromLines:
    def test_finds_the_first_plausible_line(self) -> None:
        lines = ["", "The Effects of Spaced Repetition on Retention", "Jane Doe"]
        assert extract_title_from_lines(lines) == "The Effects of Spaced Repetition on Retention"

    def test_skips_a_bare_page_number(self) -> None:
        lines = ["3", "Understanding Student Motivation in Online Courses"]
        expected = "Understanding Student Motivation in Online Courses"
        assert extract_title_from_lines(lines) == expected

    def test_skips_a_figure_caption(self) -> None:
        lines = [
            "Figure 1: Enrollment over time",
            "A Longitudinal Study of Course Completion Rates",
        ]
        expected = "A Longitudinal Study of Course Completion Rates"
        assert extract_title_from_lines(lines) == expected

    def test_skips_a_fully_uppercase_running_header(self) -> None:
        lines = ["JOURNAL OF EDUCATION RESEARCH", "Improving Feedback Loops in K-12 Classrooms"]
        assert extract_title_from_lines(lines) == "Improving Feedback Loops in K-12 Classrooms"

    def test_returns_none_when_nothing_plausible_exists(self) -> None:
        lines = ["3", "Figure 2", "Abstract", "©2023"]
        assert extract_title_from_lines(lines) is None

    def test_returns_none_for_empty_input(self) -> None:
        assert extract_title_from_lines([]) is None


class TestIsPlausibleTitle:
    def test_rejects_too_short(self) -> None:
        assert is_plausible_title("Short") is False

    def test_rejects_too_long(self) -> None:
        assert is_plausible_title("x" * 221) is False

    def test_rejects_a_doi_line(self) -> None:
        assert is_plausible_title("https://doi.org/10.1234/abcd.5678") is False

    def test_rejects_a_copyright_line(self) -> None:
        assert is_plausible_title("© 2023 The Authors. All rights reserved.") is False

    def test_rejects_an_email_contact_line(self) -> None:
        assert is_plausible_title("Corresponding author: jane.doe@example.edu") is False

    def test_accepts_an_ordinary_title(self) -> None:
        assert is_plausible_title("Rethinking Assessment Design in Higher Education") is True


# --- Authors -------------------------------------------------------------


class TestExtractAuthorsFromLines:
    def test_finds_the_byline_immediately_after_the_title(self) -> None:
        title = "Rethinking Assessment Design in Higher Education"
        lines = ["", title, "Jane Doe, John Smith", "University of Somewhere"]
        assert extract_authors_from_lines(lines, title) == ["Jane Doe", "John Smith"]

    def test_returns_empty_when_title_is_none(self) -> None:
        assert extract_authors_from_lines(["Jane Doe"], None) == []

    def test_returns_empty_when_nothing_byline_shaped_follows(self) -> None:
        title = "Rethinking Assessment Design in Higher Education"
        lines = [title, "This paper explores several approaches to formative assessment."]
        assert extract_authors_from_lines(lines, title) == []

    def test_skips_an_affiliation_line_before_the_byline(self) -> None:
        title = "Rethinking Assessment Design in Higher Education"
        lines = [title, "Department of Education Studies", "Jane Doe, John Smith"]
        assert extract_authors_from_lines(lines, title) == ["Jane Doe", "John Smith"]

    def test_never_picks_up_a_references_section_author_list(self) -> None:
        title = "Rethinking Assessment Design in Higher Education"
        lines = [
            title,
            "This paper explores several approaches to formative assessment.",
            "References",
            "Doe, J., & Smith, J. (2019). Some other paper.",
        ]
        assert extract_authors_from_lines(lines, title) == []


class TestExtractTitleAndAuthorsFromFrontMatter:
    def test_recognizes_a_full_journal_first_page(self) -> None:
        lines = [
            "International Journal of Artificial Intelligence in Education (2023) 33:267-289",
            "ARTICLE",
            "https://doi.org/10.1007/s40593-022-00311-5",
            "Abstract",
            "This study examines the use of AI tutoring systems in K-12 classrooms.",
            "Keywords AI tutoring · K-12 education · Learning analytics",
            "Received: 1 January 2022 / Accepted: 18 July 2022",
            "© The Author(s) 2022",
            "Teaching with Intelligent Tutors: A Classroom Study",
            "Jane Doe1 · John Smith2",
        ]
        result = extract_title_and_authors_from_front_matter(lines)
        assert result is not None
        title, authors = result
        assert title == "Teaching with Intelligent Tutors: A Classroom Study"
        assert authors == ["Jane Doe", "John Smith"]

    def test_returns_none_for_a_document_with_no_recognizable_front_matter(self) -> None:
        lines = ["Meeting notes", "Discussed budget for Q3."]
        assert extract_title_and_authors_from_front_matter(lines) is None

    def test_returns_none_when_no_byline_follows_the_title(self) -> None:
        lines = ["A Study of Something Interesting And Real", "This is just prose that follows."]
        assert extract_title_and_authors_from_front_matter(lines) is None

    def test_title_can_wrap_across_multiple_lines(self) -> None:
        # The second line deliberately has more than 4 words so it can't be
        # mistaken for a byline-shaped line (see _looks_like_academic_byline_line).
        lines = [
            "Improving Formative Feedback in Large",
            "Enrollment Introductory Courses for New Students",
            "Jane Doe, John Smith",
        ]
        result = extract_title_and_authors_from_front_matter(lines)
        assert result is not None
        title, authors = result
        assert title == (
            "Improving Formative Feedback in Large Enrollment Introductory Courses for New Students"
        )
        assert authors == ["Jane Doe", "John Smith"]


class TestNormalizeAuthorName:
    def test_collapses_non_breaking_whitespace(self) -> None:
        assert normalize_author_name("Jane\u00a0Doe") == "Jane Doe"

    def test_strips_a_trailing_footnote_digit(self) -> None:
        assert normalize_author_name("Jane Doe1") == "Jane Doe"

    def test_strips_an_embedded_email(self) -> None:
        assert normalize_author_name("Jane Doe jane@example.edu") == "Jane Doe"


class TestSplitAuthorString:
    def test_splits_on_semicolon(self) -> None:
        assert split_author_string("Jane Doe; John Smith") == ["Jane Doe", "John Smith"]

    def test_splits_on_ampersand_and_and(self) -> None:
        assert split_author_string("Jane Doe & John Smith and Ana Perez") == [
            "Jane Doe",
            "John Smith",
            "Ana Perez",
        ]

    def test_does_not_split_a_single_last_first_name_on_a_bare_comma(self) -> None:
        # A single "Last, First" name must stay one author, not be fabricated
        # into two out of one real name (see the function's own docstring).
        assert split_author_string("Doe, Jane") == ["Doe, Jane"]


# --- DOI -------------------------------------------------------------


class TestNormalizeDoi:
    def test_strips_a_doi_org_url(self) -> None:
        assert normalize_doi("https://doi.org/10.1007/s40593-022-00311-5") == (
            "10.1007/s40593-022-00311-5"
        )

    def test_strips_a_dx_doi_org_url(self) -> None:
        assert normalize_doi("http://dx.doi.org/10.1234/abcd") == "10.1234/abcd"

    def test_strips_a_doi_colon_prefix(self) -> None:
        assert normalize_doi("doi:10.1234/abcd") == "10.1234/abcd"

    def test_strips_trailing_punctuation(self) -> None:
        assert normalize_doi("10.1234/abcd.") == "10.1234/abcd"

    def test_returns_none_for_something_that_is_not_doi_shaped(self) -> None:
        assert normalize_doi("not a doi at all") is None

    def test_returns_none_for_empty_string(self) -> None:
        assert normalize_doi("") is None


class TestExtractDoi:
    def test_finds_a_bare_doi_in_running_text(self) -> None:
        text = "This article is available at 10.1007/s40593-022-00311-5 and elsewhere."
        assert extract_doi(text) == "10.1007/s40593-022-00311-5"

    def test_finds_a_doi_org_url_in_running_text(self) -> None:
        text = "See https://doi.org/10.1234/xyz.5678 for details."
        assert extract_doi(text) == "10.1234/xyz.5678"

    def test_returns_none_when_no_doi_present(self) -> None:
        assert extract_doi("This document has no digital object identifier at all.") is None


# --- Publication year -------------------------------------------------------------


class TestExtractPublicationYear:
    def test_extracts_from_a_copyright_marker(self) -> None:
        assert extract_publication_year("© 2019 The Authors.") == 2019

    def test_extracts_from_a_lone_parenthesized_year(self) -> None:
        assert extract_publication_year("Some Journal (2021) discusses this.") == 2021

    def test_prefers_the_journal_citation_banner_year_over_an_accepted_date(self) -> None:
        text = (
            "International Journal of Artificial Intelligence in Education (2023) 33:267-289\n"
            "Accepted: 18 July 2022"
        )
        # The issue year (2023) wins even though "Accepted: 2022" appears too
        # — an accepted/online date can legitimately predate the issue.
        assert extract_publication_year(text) == 2023

    def test_never_treats_a_bare_number_as_a_year(self) -> None:
        assert extract_publication_year("The study had 2024 participants in total.") is None

    def test_returns_none_when_no_year_marker_present(self) -> None:
        text = "No date information appears anywhere in this text."
        assert extract_publication_year(text) is None

    def test_rejects_an_implausibly_old_year(self) -> None:
        assert extract_publication_year("© 1066 The Authors.") is None

    def test_rejects_a_year_far_in_the_future(self) -> None:
        assert extract_publication_year("© 2999 The Authors.") is None


# --- Venue / journal / volume / pages -------------------------------------------------------------


class TestExtractVenueFromLines:
    def test_finds_a_line_with_a_journal_hint(self) -> None:
        lines = ["Some prose.", "Journal of Educational Psychology", "More prose."]
        assert extract_venue_from_lines(lines) == "Journal of Educational Psychology"

    def test_finds_a_line_with_a_conference_hint(self) -> None:
        lines = ["Proceedings of the International Conference on Learning Analytics"]
        assert extract_venue_from_lines(lines) == (
            "Proceedings of the International Conference on Learning Analytics"
        )

    def test_returns_none_when_no_venue_hint_present(self) -> None:
        assert extract_venue_from_lines(["Just some ordinary prose text here."]) is None

    def test_ignores_an_overly_long_line_even_with_a_hint(self) -> None:
        long_line = "Journal of " + ("x" * 200)
        assert extract_venue_from_lines([long_line]) is None


class TestParseJournalCitation:
    def test_parses_a_well_formed_citation_banner(self) -> None:
        lines = ["International Journal of Artificial Intelligence in Education (2023) 33:267-289"]
        citation = parse_journal_citation(lines)
        assert citation is not None
        expected_journal = "International Journal of Artificial Intelligence in Education"
        assert citation.journal_title == expected_journal
        assert citation.year == 2023
        assert citation.volume == "33"
        assert citation.page_start == 267
        assert citation.page_end == 289

    def test_accepts_an_en_dash_page_range(self) -> None:
        lines = ["Journal of Testing (2020) 5:10\u201320"]
        citation = parse_journal_citation(lines)
        assert citation is not None
        assert citation.page_start == 10
        assert citation.page_end == 20

    def test_returns_none_for_an_implausible_year(self) -> None:
        lines = ["Journal of Testing (1066) 5:10-20"]
        assert parse_journal_citation(lines) is None

    def test_returns_none_when_no_line_matches(self) -> None:
        assert parse_journal_citation(["Just a plain title line here"]) is None

    def test_raw_is_the_verbatim_original_line(self) -> None:
        lines = ["  Journal of Testing (2020) 5:10-20  "]
        citation = parse_journal_citation(lines)
        assert citation is not None
        assert citation.raw == "Journal of Testing (2020) 5:10-20"


# --- Abstract -------------------------------------------------------------


class TestExtractAbstractFromLines:
    def test_collects_the_paragraph_following_the_abstract_heading(self) -> None:
        lines = [
            "Abstract",
            "This study examines the effect of spaced repetition on retention.",
            "",
            "Keywords",
        ]
        assert extract_abstract_from_lines(lines) == (
            "This study examines the effect of spaced repetition on retention."
        )

    def test_stops_at_the_keywords_heading_without_a_blank_line(self) -> None:
        lines = ["Abstract", "A short abstract with no trailing blank line.", "Keywords"]
        assert extract_abstract_from_lines(lines) == "A short abstract with no trailing blank line."

    def test_returns_none_when_no_abstract_heading_present(self) -> None:
        assert extract_abstract_from_lines(["Just some prose.", "More prose."]) is None

    def test_truncates_to_max_chars(self) -> None:
        lines = ["Abstract", "x" * 5000]
        result = extract_abstract_from_lines(lines, max_chars=100)
        assert result is not None
        assert len(result) == 100


# --- Keywords -------------------------------------------------------------


class TestExtractKeywordsFromLines:
    def test_splits_a_semicolon_separated_keywords_line(self) -> None:
        lines = ["Keywords: AI tutoring; K-12 education; Learning analytics"]
        assert extract_keywords_from_lines(lines) == [
            "AI tutoring",
            "K-12 education",
            "Learning analytics",
        ]

    def test_splits_a_comma_separated_keywords_line(self) -> None:
        lines = ["Keywords: formative assessment, feedback, higher education"]
        assert extract_keywords_from_lines(lines) == [
            "formative assessment",
            "feedback",
            "higher education",
        ]

    def test_handles_a_keywords_line_with_no_colon(self) -> None:
        lines = ["Keywords AI tutoring; K-12 education"]
        assert extract_keywords_from_lines(lines) == ["AI tutoring", "K-12 education"]

    def test_returns_empty_list_when_no_keywords_line_present(self) -> None:
        assert extract_keywords_from_lines(["Just some prose."]) == []


# --- Language -------------------------------------------------------------


class TestDetectLanguage:
    def test_detects_english_from_common_function_words(self) -> None:
        text = (
            "This is a study of the effects of spaced repetition on retention "
            "in the context of higher education for students with this method."
        )
        assert detect_language(text) == "en"

    def test_returns_none_for_too_little_text(self) -> None:
        assert detect_language("Short.") is None

    def test_returns_none_for_text_without_english_function_words(self) -> None:
        # Repeated non-function tokens, none of which are in the common set.
        text = " ".join(["xyzzy"] * 30)
        assert detect_language(text) is None


# --- Missing metadata / honesty -------------------------------------------------------------


class TestExtractFromPagesMissingMetadata:
    def test_a_document_with_no_recognizable_structure_yields_all_none_or_empty(self) -> None:
        # extract_title_from_lines takes the first *plausible-looking* line
        # as a weak-confidence title guess (see its own docstring) — every
        # line here is deliberately something is_plausible_title explicitly
        # rejects (a figure caption, a bare page number, bare section
        # headings), and none of them carry a year/DOI/venue marker either,
        # so every field genuinely stays None/empty.
        pages = [_page("Figure 1\n3\nAbstract\nIntroduction")]
        result = extract_from_pages(pages)
        assert result.title is None
        assert result.authors == []
        assert result.publication_year is None
        assert result.source_venue is None
        assert result.doi is None
        assert result.source_url is None
        assert result.abstract is None
        assert result.keywords == []
        assert result.volume is None
        assert result.page_start is None
        assert result.page_end is None
        # Nothing was found, so nothing has a provenance label either — an
        # empty `sources` dict, never a fabricated entry for an absent field.
        assert result.sources == {}

    def test_empty_pages_never_raises_and_yields_nothing(self) -> None:
        result = extract_from_pages([])
        assert result.title is None
        assert result.authors == []
        assert result.sources == {}


# --- Provenance / sources -------------------------------------------------------------


class TestExtractFromPagesProvenance:
    def test_every_populated_field_is_labeled_structured_text(self) -> None:
        pages = [
            _page(
                "Journal of Testing (2020) 5:10-20\n"
                "A Study of Something Real and Interesting\n"
                "Jane Doe, John Smith\n"
                "https://doi.org/10.1234/abcd\n"
            )
        ]
        result = extract_from_pages(pages)
        for field in ("title", "authors", "doi", "source_url", "publication_year"):
            assert result.sources.get(field) == ExtractionSource.STRUCTURED_TEXT

    def test_source_url_is_derived_from_the_doi_when_no_url_found_directly(self) -> None:
        pages = [_page("A document mentioning 10.1234/abcd somewhere in its text body here.")]
        result = extract_from_pages(pages)
        assert result.source_url == "https://doi.org/10.1234/abcd"
        assert result.sources.get("source_url") == ExtractionSource.STRUCTURED_TEXT


class TestMergeExtractedMetadataProvenancePriority:
    def test_primary_wins_when_both_are_present(self) -> None:
        primary = ExtractedMetadata(
            title="Embedded Title",
            sources={"title": ExtractionSource.EMBEDDED_METADATA},
        )
        fallback = ExtractedMetadata(
            title="Structured-Text Title",
            sources={"title": ExtractionSource.STRUCTURED_TEXT},
        )
        merged = merge_extracted_metadata(primary, fallback)
        assert merged.title == "Embedded Title"
        assert merged.sources["title"] == ExtractionSource.EMBEDDED_METADATA

    def test_fallback_only_fills_a_genuine_gap(self) -> None:
        primary = ExtractedMetadata(title=None, sources={})
        fallback = ExtractedMetadata(
            title="Structured-Text Title",
            sources={"title": ExtractionSource.STRUCTURED_TEXT},
        )
        merged = merge_extracted_metadata(primary, fallback)
        assert merged.title == "Structured-Text Title"
        assert merged.sources["title"] == ExtractionSource.STRUCTURED_TEXT

    def test_authors_exception_fallback_wins_when_it_has_strictly_more_names(self) -> None:
        primary = ExtractedMetadata(
            authors=["Jane Doe"], sources={"authors": ExtractionSource.EMBEDDED_METADATA}
        )
        fallback = ExtractedMetadata(
            authors=["Jane Doe", "John Smith"],
            sources={"authors": ExtractionSource.STRUCTURED_TEXT},
        )
        merged = merge_extracted_metadata(primary, fallback)
        assert merged.authors == ["Jane Doe", "John Smith"]
        # The label reflects which list actually won.
        assert merged.sources["authors"] == ExtractionSource.STRUCTURED_TEXT

    def test_authors_exception_primary_wins_ties(self) -> None:
        primary = ExtractedMetadata(
            authors=["Jane Doe", "John Smith"],
            sources={"authors": ExtractionSource.EMBEDDED_METADATA},
        )
        fallback = ExtractedMetadata(
            authors=["Ana Perez", "Sam Lee"],
            sources={"authors": ExtractionSource.STRUCTURED_TEXT},
        )
        merged = merge_extracted_metadata(primary, fallback)
        assert merged.authors == ["Jane Doe", "John Smith"]
        assert merged.sources["authors"] == ExtractionSource.EMBEDDED_METADATA

    def test_new_milestone_4_fields_follow_the_same_primary_wins_rule(self) -> None:
        primary = ExtractedMetadata(abstract="Primary abstract", volume="3", page_start=10)
        fallback = ExtractedMetadata(
            abstract="Fallback abstract", volume="9", page_start=99, page_end=120
        )
        merged = merge_extracted_metadata(primary, fallback)
        assert merged.abstract == "Primary abstract"
        assert merged.volume == "3"
        assert merged.page_start == 10
        # page_end only exists in fallback -> genuine gap, fallback fills it.
        assert merged.page_end == 120

    def test_neither_source_populated_yields_none(self) -> None:
        merged = merge_extracted_metadata(ExtractedMetadata(), ExtractedMetadata())
        assert merged.title is None
        assert merged.authors == []
        assert merged.sources == {}


# --- Filename fallback -------------------------------------------------------------


class TestApplyFilenameFallback:
    def test_derives_a_title_from_the_filename_when_nothing_else_found(self) -> None:
        metadata = ExtractedMetadata()
        result = apply_filename_fallback(metadata, filename="student_motivation_final.pdf")
        assert result.title == "student motivation"
        assert result.sources["title"] == ExtractionSource.FILENAME

    def test_never_overrides_an_already_present_title(self) -> None:
        metadata = ExtractedMetadata(
            title="A Real Title", sources={"title": ExtractionSource.STRUCTURED_TEXT}
        )
        result = apply_filename_fallback(metadata, filename="whatever.pdf")
        assert result.title == "A Real Title"
        assert result.sources["title"] == ExtractionSource.STRUCTURED_TEXT

    def test_leaves_title_none_for_an_unusable_filename(self) -> None:
        # "final" is itself a stripped upload-suffix word (see
        # clean_filename_as_title/_UPLOAD_SUFFIX_PATTERN below), so this
        # filename's stem reduces to nothing usable.
        metadata = ExtractedMetadata()
        result = apply_filename_fallback(metadata, filename="final.pdf")
        assert result.title is None
        assert "title" not in result.sources


class TestCleanFilenameAsTitle:
    def test_strips_extension_and_underscores(self) -> None:
        assert clean_filename_as_title("student_motivation.pdf") == "student motivation"

    def test_strips_a_copy_suffix(self) -> None:
        assert clean_filename_as_title("report (1).pdf") == "report"

    def test_strips_a_version_suffix(self) -> None:
        assert clean_filename_as_title("thesis_v2.docx") == "thesis"

    def test_repeatedly_strips_multiple_stacked_suffixes(self) -> None:
        # Both "_v2" and "_final" are upload-suffix words on their own —
        # the loop must strip both, one pass at a time, not just the first.
        assert clean_filename_as_title("thesis_final_v2.docx") == "thesis"

    def test_returns_none_for_a_stem_that_is_only_an_upload_suffix(self) -> None:
        assert clean_filename_as_title("final.pdf") is None


# --- Unicode / special characters -------------------------------------------------------------


class TestUnicodeAndSpecialCharacters:
    def test_title_with_accented_and_cjk_characters_round_trips(self) -> None:
        title = "\u00dcber die Wirkung von Bildung \u2013 eine Studie \u6559\u80b2"
        lines = ["", title, "Jane Doe"]
        assert extract_title_from_lines(lines) == title

    def test_author_names_with_diacritics_are_preserved(self) -> None:
        assert normalize_author_name("José García") == "José García"

    def test_doi_with_unusual_but_valid_suffix_characters(self) -> None:
        text = "Available at 10.1234/abcd-efgh_1234(2023).01 for reference."
        doi = extract_doi(text)
        assert doi is not None
        assert doi.startswith("10.1234/")

    def test_extract_from_pages_never_raises_on_emoji_and_control_like_text(self) -> None:
        pages = [_page("🎓 Learning Outcomes 📊\nSome prose with emoji 🚀 sprinkled in it here.")]
        result = extract_from_pages(pages)  # must not raise
        assert isinstance(result, ExtractedMetadata)

    def test_non_breaking_space_in_a_byline_does_not_break_author_splitting(self) -> None:
        title = "A Study of Something Real"
        lines = [title, "Jane\u00a0Doe, John\u00a0Smith"]
        assert extract_authors_from_lines(lines, title) == ["Jane Doe", "John Smith"]
