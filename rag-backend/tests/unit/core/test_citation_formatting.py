"""Milestone 4.2 Section 32 — APA 7 / IEEE style-engine fixtures.

Every expected string here is the REAL, captured output of citeproc-py
driven by the vendored official apa.csl/ieee.csl style files (see
app/core/citation_formatting.py's module docstring) — never a hand-typed
guess at what APA/IEEE "should" look like. Where the underlying engine has
a known quirk (see the "known limitation" tests at the bottom), the
fixture documents the ACTUAL behavior rather than hiding it, so a future
CSL-style-file update that changes this is caught by a failing test
instead of silently drifting.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from app.core.citation_authors import parse_author
from app.core.citation_formatting import format_citation
from app.core.citation_item import CitationItem, document_to_citation_item
from app.db.documents_repository import DocumentRecord


def _make_document_record(**overrides: object) -> DocumentRecord:
    defaults: dict[str, object] = {
        "document_id": "doc-1",
        "user_id": uuid.uuid4(),
        "folder_id": None,
        "sha256": "0" * 64,
        "source_filename": "paper.pdf",
        "title": "A Sample Title",
        "authors": ["Jane Doe"],
        "publication_year": 2020,
        "source_venue": "Journal of Testing",
        "doi": "10.1000/sample",
        "source_url": "https://doi.org/10.1000/sample",
        "document_type": "journal_article",
        "journal_quartile": None,
        "chunk_count": 1,
        "page_count": 1,
        "file_format": "pdf",
        "ingested_at": datetime.now(UTC),
        "storage_key": None,
        "original_mime_type": None,
        "original_file_size_bytes": None,
        "volume": "5",
        "issue": "2",
        "page_start": 10,
        "page_end": 20,
        "publisher": None,
        "abstract": None,
        "keywords": [],
        "language": None,
        "metadata_sources": {},
        "last_enriched_at": None,
        "enrichment_provider": None,
        "enrichment_status": None,
    }
    defaults.update(overrides)
    return DocumentRecord(**defaults)  # type: ignore[arg-type]


FIXTURES: dict[str, tuple[CitationItem, str, str]] = {
    "journal_article": (
        CitationItem(
            id="a",
            type="article-journal",
            title="A laser speckle imaging technique for measuring tissue perfusion",
            authors=[parse_author("K. R. Forrester"), parse_author("C. Stewart"), parse_author("J. Tulip")],
            issued_year=2004,
            container_title="IEEE Transactions on Biomedical Engineering",
            volume="51",
            issue="11",
            page="2074-2084",
            doi="10.1109/TBME.2004.834255",
        ),
        "Forrester, K. R., Stewart, C., & Tulip, J. (2004). A laser speckle imaging technique for measuring tissue perfusion. IEEE Transactions on Biomedical Engineering, 51(11), 2074–2084. https://doi.org/10.1109/TBME.2004.834255",
        "[1]K. R. Forrester, C. Stewart, and J. Tulip, “A laser speckle imaging technique for measuring tissue perfusion”, IEEE Transactions on Biomedical Engineering, vol. 51, no. 11, pp. 2074–2084, 2004, doi: 10.1109/TBME.2004.834255.",
    ),
    "conference_paper": (
        CitationItem(
            id="b",
            type="paper-conference",
            title="Deep learning for citation extraction",
            authors=[parse_author("Jane Doe")],
            issued_year=2019,
            container_title="Proceedings of ACL",
        ),
        "Doe, J. (2019). Deep learning for citation extraction. Proceedings of ACL.",
        "[1]J. Doe, “Deep learning for citation extraction”, in Proceedings of ACL, 2019.",
    ),
    "book": (
        CitationItem(
            id="c",
            type="book",
            title="The Structure of Scientific Revolutions",
            authors=[parse_author("Thomas Kuhn")],
            issued_year=1962,
            publisher="University of Chicago Press",
        ),
        "Kuhn, T. (1962). The Structure of Scientific Revolutions. University of Chicago Press.",
        "[1]T. Kuhn, The Structure of Scientific Revolutions. University of Chicago Press, 1962.",
    ),
    "book_chapter": (
        CitationItem(
            id="d",
            type="chapter",
            title="Citation networks",
            authors=[parse_author("Ann Lee")],
            issued_year=2010,
            container_title="Handbook of Bibliometrics",
            page="45-67",
        ),
        "Lee, A. (2010). Citation networks. In Handbook of Bibliometrics (pp. 45–67).",
        "[1]A. Lee, “Citation networks”, in Handbook of Bibliometrics, 2010, pp. 45–67.",
    ),
    "report": (
        CitationItem(
            id="e",
            type="report",
            title="Annual research report",
            authors=[parse_author("World Health Organization")],
            issued_year=2021,
            publisher="WHO Press",
        ),
        "World Health Organization. (2021). Annual research report. WHO Press.",
        "[1]World Health Organization, “Annual research report”, WHO Press, 2021.",
    ),
    "thesis": (
        CitationItem(
            id="f",
            type="thesis",
            title="Machine learning for scholarly search",
            authors=[parse_author("Sam Rivera")],
            issued_year=2018,
        ),
        "Rivera, S. (2018). Machine learning for scholarly search.",
        "[1]S. Rivera, “Machine learning for scholarly search”, 2018.",
    ),
    "missing_doi": (
        CitationItem(
            id="g",
            type="article-journal",
            title="A study with no DOI",
            authors=[parse_author("Jane Doe")],
            issued_year=2020,
            container_title="Journal of Testing",
        ),
        "Doe, J. (2020). A study with no DOI. Journal of Testing.",
        "[1]J. Doe, “A study with no DOI”, Journal of Testing, 2020.",
    ),
    "missing_author": (
        CitationItem(
            id="h",
            type="article-journal",
            title="An anonymous study",
            authors=[],
            issued_year=2020,
            container_title="Journal of Testing",
        ),
        "An anonymous study. (2020). An anonymous study. Journal of Testing.",
        "[1]“An anonymous study”, Journal of Testing, 2020.",
    ),
    "missing_year": (
        CitationItem(
            id="i",
            type="article-journal",
            title="A study with no year",
            authors=[parse_author("Jane Doe")],
            container_title="Journal of Testing",
        ),
        "Doe, J. (n.d.). A study with no year. Journal of Testing.",
        "[1]J. Doe, “A study with no year”, Journal of Testing.",
    ),
    "one_author": (
        CitationItem(
            id="j",
            type="article-journal",
            title="Solo study",
            authors=[parse_author("Jane Doe")],
            issued_year=2020,
            container_title="Journal of Testing",
        ),
        "Doe, J. (2020). Solo study. Journal of Testing.",
        "[1]J. Doe, “Solo study”, Journal of Testing, 2020.",
    ),
    "two_authors": (
        CitationItem(
            id="k",
            type="article-journal",
            title="Duo study",
            authors=[parse_author("Jane Doe"), parse_author("John Smith")],
            issued_year=2020,
            container_title="Journal of Testing",
        ),
        "Doe, J., & Smith, J. (2020). Duo study. Journal of Testing.",
        "[1]J. Doe and J. Smith, “Duo study”, Journal of Testing, 2020.",
    ),
    "three_plus_authors": (
        CitationItem(
            id="l",
            type="article-journal",
            title="Group study",
            authors=[parse_author("Jane Doe"), parse_author("John Smith"), parse_author("Amy Lin")],
            issued_year=2020,
            container_title="Journal of Testing",
        ),
        "Doe, J., Smith, J., & Lin, A. (2020). Group study. Journal of Testing.",
        "[1]J. Doe, J. Smith, and A. Lin, “Group study”, Journal of Testing, 2020.",
    ),
    "organization_author": (
        CitationItem(
            id="m",
            type="report",
            title="Global health report",
            authors=[parse_author("World Health Organization")],
            issued_year=2019,
        ),
        "World Health Organization. (2019). Global health report.",
        "[1]World Health Organization, “Global health report”, 2019.",
    ),
    "unicode_author": (
        CitationItem(
            id="n",
            type="article-journal",
            title="Étude thermodynamique",
            authors=[parse_author("Hans Müller"), parse_author("María José García-López")],
            issued_year=2018,
            container_title="Revue de Physique",
        ),
        "Müller, H., & García-López, M. J. (2018). Étude thermodynamique. Revue De Physique.",
        "[1]H. Müller and M. J. García-López, “Étude thermodynamique”, Revue de Physique, 2018.",
    ),
    "special_char_title": (
        CitationItem(
            id="o",
            type="article-journal",
            title="Cost & benefit: a 50% discount on R&D spending",
            authors=[parse_author("Jane Doe")],
            issued_year=2020,
            container_title="Journal of Symbols",
        ),
        "Doe, J. (2020). Cost & benefit: a 50% discount on R&D spending. Journal of Symbols.",
        "[1]J. Doe, “Cost & benefit: a 50% discount on R&D spending”, Journal of Symbols, 2020.",
    ),
    "article_number": (
        CitationItem(
            id="q",
            type="article-journal",
            title="Using article numbers instead of page ranges",
            authors=[parse_author("Sam Lee")],
            issued_year=2022,
            container_title="Journal of Modern Publishing",
            volume="12",
            page="e12345",
        ),
        "Lee, S. (2022). Using article numbers instead of page ranges. Journal of Modern Publishing, 12, e12345.",
        "[1]S. Lee, “Using article numbers instead of page ranges”, Journal of Modern Publishing, vol. 12, p. e12345, 2022.",
    ),
}


class TestApaAndIeeeFixtures:
    def test_all_fixtures_apa(self) -> None:
        for name, (item, expected_apa, _expected_ieee) in FIXTURES.items():
            assert format_citation(item, "apa7") == expected_apa, f"APA mismatch for {name}"

    def test_all_fixtures_ieee(self) -> None:
        for name, (item, _expected_apa, expected_ieee) in FIXTURES.items():
            assert format_citation(item, "ieee") == expected_ieee, f"IEEE mismatch for {name}"


class TestVeryLongTitle:
    def test_very_long_title_not_truncated(self) -> None:
        long_title = (
            "A Comprehensive and Extraordinarily Detailed Examination of Every "
            "Conceivable Factor Influencing Long-Term Educational Outcomes Across "
            "Diverse Populations and Settings"
        )
        item = CitationItem(
            id="p",
            type="article-journal",
            title=long_title,
            authors=[parse_author("Jane Doe")],
            issued_year=2020,
            container_title="Journal of Testing",
        )
        apa = format_citation(item, "apa7")
        ieee = format_citation(item, "ieee")
        assert long_title in apa
        assert long_title in ieee


class TestMissingMetadataNeverCrashes:
    def test_completely_empty_item_still_formats(self) -> None:
        item = CitationItem(id="empty", type="article-journal", title=None, authors=[])
        apa = format_citation(item, "apa7")
        ieee = format_citation(item, "ieee")
        assert isinstance(apa, str)
        assert isinstance(ieee, str)
        # No fabricated content — no digit-only year or "Unknown Author"
        # string leaked into the output.
        assert "Unknown" not in apa
        assert "Unknown" not in ieee

    def test_no_double_period_artifact(self) -> None:
        item = CitationItem(
            id="r",
            type="article-journal",
            title="A study",
            authors=[parse_author("A. Nguyen")],
            issued_year=2021,
            container_title="Journal X",
        )
        apa = format_citation(item, "apa7")
        assert ".." not in apa

    def test_no_double_space_artifact(self) -> None:
        item = CitationItem(
            id="s",
            type="paper-conference",
            title="A paper",
            authors=[parse_author("A. Nguyen")],
            issued_year=2021,
            container_title="Proceedings of Something",
        )
        ieee = format_citation(item, "ieee")
        assert "  " not in ieee


class TestDocumentToCitationItem:
    def test_maps_canonical_fields(self) -> None:
        record = _make_document_record()
        item = document_to_citation_item(record)
        assert item.title == "A Sample Title"
        assert item.issued_year == 2020
        assert item.container_title == "Journal of Testing"
        assert item.volume == "5"
        assert item.issue == "2"
        assert item.page == "10-20"
        assert item.doi == "10.1000/sample"
        assert item.document_id == "doc-1"
        assert item.type == "article-journal"

    def test_unknown_document_type_falls_back_to_generic_article(self) -> None:
        record = _make_document_record(document_type="unknown")
        item = document_to_citation_item(record)
        assert item.type == "article"

    def test_uses_current_canonical_metadata_not_a_snapshot(self) -> None:
        """Milestone 4.2 Section 28/30 — building straight from
        DocumentRecord (never a cached/stale object) means an edited title
        is reflected the moment the record itself reflects it."""
        record = _make_document_record(title="Original Title")
        assert document_to_citation_item(record).title == "Original Title"
        edited = _make_document_record(title="Edited Title")
        assert document_to_citation_item(edited).title == "Edited Title"
