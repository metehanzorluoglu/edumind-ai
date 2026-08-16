"""Milestone 4.2 Section 4/32 — author name-parsing fixtures."""

from __future__ import annotations

from app.core.citation_authors import parse_author, parse_authors


class TestParseAuthor:
    def test_family_given_comma_form(self) -> None:
        result = parse_author("Forrester, K. R.")
        assert result.family == "Forrester"
        assert result.given == "K. R."
        assert result.literal is None

    def test_first_last_space_form(self) -> None:
        result = parse_author("Katherine Forrester")
        assert result.family == "Forrester"
        assert result.given == "Katherine"
        assert result.literal is None

    def test_initial_first_last_form(self) -> None:
        result = parse_author("K. R. Forrester")
        assert result.family == "Forrester"
        assert result.given == "K. R."
        assert result.literal is None

    def test_family_only_mononym(self) -> None:
        result = parse_author("Forrester")
        assert result.family == "Forrester"
        assert result.given is None
        assert result.literal is None

    def test_organization_marker_is_literal(self) -> None:
        result = parse_author("World Health Organization")
        assert result.literal == "World Health Organization"
        assert result.family is None
        assert result.given is None

    def test_university_marker_is_literal(self) -> None:
        result = parse_author("Stanford University")
        assert result.literal == "Stanford University"

    def test_all_caps_acronym_is_literal(self) -> None:
        result = parse_author("NASA")
        assert result.literal == "NASA"

    def test_unicode_name_splits_normally(self) -> None:
        result = parse_author("Hans Müller")
        assert result.family == "Müller"
        assert result.given == "Hans"

    def test_unicode_comma_form(self) -> None:
        result = parse_author("Garcia-Lopez, María José")
        assert result.family == "Garcia-Lopez"
        assert result.given == "María José"

    def test_missing_author_empty_string_is_empty_literal(self) -> None:
        result = parse_author("")
        assert result.literal == ""

    def test_ambiguous_lowercase_token_falls_back_to_literal(self) -> None:
        # "et al" or other non-name-shaped text some upstream extraction
        # might hand us — never guessed at.
        result = parse_author("et al")
        assert result.literal == "et al"

    def test_three_or_more_word_personal_name(self) -> None:
        result = parse_author("Jean Paul Marie Dubois")
        assert result.family == "Dubois"
        assert result.given == "Jean Paul Marie"

    def test_raw_preserved(self) -> None:
        result = parse_author("  Forrester, K. R.  ")
        assert result.raw == "  Forrester, K. R.  "


class TestParseAuthors:
    def test_one_author(self) -> None:
        result = parse_authors(["Forrester, K. R."])
        assert len(result) == 1

    def test_two_authors(self) -> None:
        result = parse_authors(["Forrester, K. R.", "Stewart, C."])
        assert len(result) == 2
        assert result[0].family == "Forrester"
        assert result[1].family == "Stewart"

    def test_three_plus_authors(self) -> None:
        result = parse_authors(["A One", "B Two", "C Three", "D Four"])
        assert len(result) == 4

    def test_drops_blank_entries(self) -> None:
        result = parse_authors(["Forrester, K. R.", "", "   "])
        assert len(result) == 1

    def test_missing_authors_is_empty_list(self) -> None:
        assert parse_authors([]) == []
