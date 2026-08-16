"""Milestone 4.2 Section 33 — BibTeX generation fixtures.

Every generated entry is round-trip parsed with `bibtexparser` (a real
BibTeX parser, dev-only dependency — Section 33: "parse exported .bib
with a real BibTeX parser if a suitable dependency exists"), not just
snapshot-compared as a string — a syntactically valid-looking string could
still be invalid BibTeX (unbalanced braces, a bad key character); actually
parsing it is the only way to be sure.
"""

from __future__ import annotations

import bibtexparser

from app.core.bibtex import (
    build_bibtex_entry,
    escape_bibtex_value,
    export_bibtex,
    format_bibtex_authors,
    render_bibtex_entry,
)
from app.core.citation_authors import parse_author
from app.core.citation_item import CitationItem
from app.core.citation_key import base_citation_key, resolve_citation_key


def _parse_one(text: str) -> dict[str, str]:
    db = bibtexparser.loads(text)
    assert len(db.entries) == 1, f"expected exactly 1 entry, got {len(db.entries)}: {text}"
    return db.entries[0]


class TestNormalJournalArticle:
    def test_generates_valid_article_entry(self) -> None:
        item = CitationItem(
            id="a",
            type="article-journal",
            title="A laser speckle imaging technique",
            authors=[parse_author("K. R. Forrester"), parse_author("C. Stewart")],
            issued_year=2004,
            container_title="IEEE Transactions on Biomedical Engineering",
            volume="51",
            issue="11",
            page="2074-2084",
            doi="10.1109/TBME.2004.834255",
            document_id="doc-1",
            document_type_raw="journal_article",
        )
        text = render_bibtex_entry(item, "Forrester2004Laser")
        assert text.startswith("@article{Forrester2004Laser,")
        parsed = _parse_one(text)
        assert parsed["ENTRYTYPE"] == "article"
        assert parsed["ID"] == "Forrester2004Laser"
        assert parsed["journal"] == "IEEE Transactions on Biomedical Engineering"
        assert parsed["volume"] == "51"
        assert parsed["number"] == "11"
        assert parsed["pages"] == "2074--2084"
        assert parsed["doi"] == "10.1109/TBME.2004.834255"
        assert parsed["year"] == "2004"


class TestMultipleAuthors:
    def test_authors_joined_with_and(self) -> None:
        item = CitationItem(
            id="b",
            type="article-journal",
            title="A study",
            authors=[parse_author("Jane Doe"), parse_author("John Smith"), parse_author("Amy Lin")],
            issued_year=2020,
            document_id="doc-2",
            document_type_raw="journal_article",
        )
        text = render_bibtex_entry(item, "Doe2020Study")
        parsed = _parse_one(text)
        assert parsed["author"] == "Doe, Jane and Smith, John and Lin, Amy"


class TestOrganizationAuthor:
    def test_organization_author_wrapped_in_braces(self) -> None:
        authors = [parse_author("World Health Organization")]
        result = format_bibtex_authors(authors)
        assert result == "{World Health Organization}"

    def test_mixed_personal_and_organization_authors(self) -> None:
        authors = [parse_author("Jane Doe"), parse_author("World Health Organization")]
        result = format_bibtex_authors(authors)
        assert result == "Doe, Jane and {World Health Organization}"
        # bibtexparser must see this as a valid two-name author field.
        item = CitationItem(
            id="c",
            type="report",
            title="A joint report",
            authors=authors,
            issued_year=2021,
            document_id="doc-3",
            document_type_raw="report",
        )
        text = render_bibtex_entry(item, "Doe2021Joint")
        parsed = _parse_one(text)
        assert parsed["author"] == "Doe, Jane and {World Health Organization}"


class TestSpecialCharacters:
    def test_ampersand_percent_dollar(self) -> None:
        assert escape_bibtex_value("Cost & benefit: 50% off $10") == r"Cost \& benefit: 50\% off \$10"

    def test_hash_underscore(self) -> None:
        assert escape_bibtex_value("file_name #1") == r"file\_name \#1"

    def test_braces(self) -> None:
        assert escape_bibtex_value("{special}") == r"\{special\}"

    def test_tilde_caret_backslash(self) -> None:
        assert escape_bibtex_value("a~b^c\\d") == r"a\textasciitilde{}b\textasciicircum{}c\textbackslash{}d"

    def test_backslash_does_not_cascade_into_brace_escaping(self) -> None:
        # A single backslash must become \textbackslash{} WITHOUT its own
        # braces then being escaped again into \{ \}.
        result = escape_bibtex_value("\\")
        assert result == r"\textbackslash{}"
        assert r"\textbackslash\{\}" not in result

    def test_full_entry_with_special_characters_is_valid_bibtex(self) -> None:
        item = CitationItem(
            id="d",
            type="article-journal",
            title="Cost & benefit: a 50% discount on R&D spending (2020) {special} $10 #1 a~b^c\\d",
            authors=[parse_author("Jane Doe")],
            issued_year=2020,
            container_title="Journal of $ & % Symbols",
            document_id="doc-4",
            document_type_raw="journal_article",
        )
        text = render_bibtex_entry(item, "Doe2020Cost")
        parsed = _parse_one(text)
        assert "Cost" in parsed["title"]
        assert parsed["journal"] is not None


class TestUnicode:
    def test_unicode_author_and_title_pass_through_valid_utf8(self) -> None:
        item = CitationItem(
            id="e",
            type="article-journal",
            title="Étude sur la thermodynamique",
            authors=[parse_author("Hans Müller"), parse_author("María José García-López")],
            issued_year=2018,
            container_title="Revue de Physique",
            document_id="doc-5",
            document_type_raw="journal_article",
        )
        text = render_bibtex_entry(item, "Muller2018Etude")
        # Valid UTF-8 (encodes without error) and round-trips.
        text.encode("utf-8")
        parsed = _parse_one(text)
        assert "Müller" in parsed["author"]
        assert "García-López" in parsed["author"]
        assert parsed["title"] == "Étude sur la thermodynamique"


class TestMissingOptionalFields:
    def test_missing_doi_url_volume_issue_omitted_entirely(self) -> None:
        item = CitationItem(
            id="f",
            type="article-journal",
            title="A minimal record",
            authors=[parse_author("Jane Doe")],
            issued_year=2020,
            container_title="Journal of Testing",
            document_id="doc-6",
            document_type_raw="journal_article",
        )
        text = render_bibtex_entry(item, "Doe2020Minimal")
        assert "doi" not in text.lower().replace("Doe2020Minimal", "")
        parsed = _parse_one(text)
        assert "doi" not in parsed
        assert "url" not in parsed
        assert "volume" not in parsed
        assert "number" not in parsed
        assert "pages" not in parsed


class TestTypeMapping:
    def test_journal_article_maps_to_article(self) -> None:
        item = CitationItem(
            id="g", type="article-journal", title="T", authors=[], document_id="d",
            document_type_raw="journal_article",
        )
        assert render_bibtex_entry(item, "K").startswith("@article{")

    def test_conference_paper_maps_to_inproceedings(self) -> None:
        item = CitationItem(
            id="h", type="paper-conference", title="T", authors=[], document_id="d",
            document_type_raw="conference_paper", container_title="Proc. X",
        )
        text = render_bibtex_entry(item, "K")
        assert text.startswith("@inproceedings{")
        parsed = _parse_one(text)
        assert parsed["booktitle"] == "Proc. X"

    def test_book_maps_to_book(self) -> None:
        item = CitationItem(
            id="i", type="book", title="T", authors=[], document_id="d", document_type_raw="book",
        )
        assert render_bibtex_entry(item, "K").startswith("@book{")

    def test_book_chapter_maps_to_incollection(self) -> None:
        item = CitationItem(
            id="j", type="chapter", title="T", authors=[], document_id="d",
            document_type_raw="book_chapter", container_title="Big Book",
        )
        text = render_bibtex_entry(item, "K")
        assert text.startswith("@incollection{")
        parsed = _parse_one(text)
        assert parsed["booktitle"] == "Big Book"

    def test_report_maps_to_techreport_with_institution_field(self) -> None:
        item = CitationItem(
            id="k", type="report", title="T", authors=[], document_id="d",
            document_type_raw="report", publisher="WHO",
        )
        text = render_bibtex_entry(item, "K")
        assert text.startswith("@techreport{")
        parsed = _parse_one(text)
        assert parsed["institution"] == "WHO"
        assert "publisher" not in parsed

    def test_thesis_maps_to_misc_with_thesis_note_never_guesses_degree(self) -> None:
        item = CitationItem(
            id="l", type="thesis", title="T", authors=[], document_id="d",
            document_type_raw="thesis_dissertation",
        )
        text = render_bibtex_entry(item, "K")
        assert text.startswith("@misc{")
        parsed = _parse_one(text)
        assert parsed["note"] == "Thesis"
        assert "phdthesis" not in text.lower()
        assert "mastersthesis" not in text.lower()

    def test_other_and_unknown_map_to_misc(self) -> None:
        for doc_type in ("other", "unknown"):
            item = CitationItem(
                id=f"m-{doc_type}", type="article", title="T", authors=[], document_id="d",
                document_type_raw=doc_type,
            )
            assert render_bibtex_entry(item, "K").startswith("@misc{")

    def test_never_exports_internal_fields(self) -> None:
        item = CitationItem(
            id="n", type="article-journal", title="T", authors=[], document_id="internal-doc-id-123",
            document_type_raw="journal_article",
        )
        text = render_bibtex_entry(item, "K")
        assert "internal-doc-id-123" not in text


class TestCitationKey:
    def test_deterministic_base_key(self) -> None:
        item = CitationItem(
            id="a",
            type="article-journal",
            title="A laser speckle imaging technique",
            authors=[parse_author("K. R. Forrester")],
            issued_year=2004,
            document_id="doc-1",
            document_type_raw="journal_article",
        )
        assert base_citation_key(item) == "Forrester2004Laser"
        # Same input -> same output, always.
        assert base_citation_key(item) == base_citation_key(item)

    def test_organization_author_uses_first_word(self) -> None:
        item = CitationItem(
            id="a",
            type="report",
            title="Annual report",
            authors=[parse_author("World Health Organization")],
            issued_year=2021,
            document_id="doc-1",
            document_type_raw="report",
        )
        assert base_citation_key(item) == "World2021Annual"

    def test_missing_author_uses_unknown(self) -> None:
        item = CitationItem(
            id="a", type="article-journal", title="A study", authors=[], issued_year=2020,
            document_id="doc-1", document_type_raw="journal_article",
        )
        assert base_citation_key(item) == "Unknown2020Study"

    def test_missing_year_omits_year_segment(self) -> None:
        item = CitationItem(
            id="a", type="article-journal", title="A study",
            authors=[parse_author("Jane Doe")], document_id="doc-1", document_type_raw="journal_article",
        )
        assert base_citation_key(item) == "DoeStudy"

    def test_no_random_uuid_ever(self) -> None:
        item = CitationItem(id="a", type="article-journal", title=None, authors=[], document_id="doc-xyz")
        key = base_citation_key(item)
        assert "-" not in key  # UUIDs always contain hyphens; this never does
        assert key == base_citation_key(item)

    def test_collision_gets_deterministic_numeric_suffix(self) -> None:
        assert resolve_citation_key("Forrester2004Laser", set()) == "Forrester2004Laser"
        assert (
            resolve_citation_key("Forrester2004Laser", {"Forrester2004Laser"}) == "Forrester2004Laser2"
        )
        taken = {"Forrester2004Laser", "Forrester2004Laser2"}
        assert resolve_citation_key("Forrester2004Laser", taken) == "Forrester2004Laser3"

    def test_unicode_author_transliterated_to_ascii(self) -> None:
        item = CitationItem(
            id="a", type="article-journal", title="Étude", authors=[parse_author("Hans Müller")],
            issued_year=2018, document_id="doc-1", document_type_raw="journal_article",
        )
        key = base_citation_key(item)
        assert key.isascii()
        assert key.startswith("Muller2018")


class TestSameDoiDifferentDocuments:
    def test_two_documents_same_doi_get_distinct_unique_keys(self) -> None:
        item_a = CitationItem(
            id="a", type="article-journal", title="Paper Title",
            authors=[parse_author("Jane Doe")], issued_year=2020, doi="10.1000/shared",
            document_id="doc-a", document_type_raw="journal_article",
        )
        item_b = CitationItem(
            id="b", type="article-journal", title="Paper Title",
            authors=[parse_author("Jane Doe")], issued_year=2020, doi="10.1000/shared",
            document_id="doc-b", document_type_raw="journal_article",
        )
        entry_a = build_bibtex_entry(item_a)
        entry_b = build_bibtex_entry(item_b, existing_keys={entry_a.citation_key})
        assert entry_a.citation_key != entry_b.citation_key
        assert entry_a.document_id != entry_b.document_id


class TestMultiExport:
    def test_export_produces_all_entries_in_deterministic_key_order(self) -> None:
        item_z = CitationItem(
            id="z", type="article-journal", title="Zebra study",
            authors=[parse_author("Zara Zeta")], issued_year=2020,
            document_id="doc-z", document_type_raw="journal_article",
        )
        item_a = CitationItem(
            id="a", type="article-journal", title="Apple study",
            authors=[parse_author("Amy Alpha")], issued_year=2020,
            document_id="doc-a", document_type_raw="journal_article",
        )
        entries = [
            (item_z, base_citation_key(item_z)),
            (item_a, base_citation_key(item_a)),
        ]
        text = export_bibtex(entries)
        db = bibtexparser.loads(text)
        assert len(db.entries) == 2
        ids = [e["ID"] for e in db.entries]
        assert ids == sorted(ids)  # alphabetical by citation key

    def test_export_utf8_valid(self) -> None:
        item = CitationItem(
            id="a", type="article-journal", title="Étude", authors=[parse_author("Hans Müller")],
            issued_year=2018, document_id="doc-1", document_type_raw="journal_article",
        )
        text = export_bibtex([(item, base_citation_key(item))])
        text.encode("utf-8")  # must not raise
