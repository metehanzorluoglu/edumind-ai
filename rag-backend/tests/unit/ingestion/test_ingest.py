"""Milestone 4 constraint: direct coverage of app/ingestion/ingest.py's
"user override precedence" — explicit arguments to ingest_document() must
always win over whatever extraction found, and get "user" provenance in
the resulting metadata_sources map. Uses .txt files (the simplest loader —
no embedded-metadata pass at all, see app/ingestion/loaders/txt_loader.py)
so every extracted field is deterministically STRUCTURED_TEXT-only.
"""

from __future__ import annotations

import uuid
from pathlib import Path

import pytest

from app.ingestion.ingest import ingest_document
from app.ingestion.loaders.base import ExtractionSource

_JOURNAL_TEXT = (
    "Journal of Testing Research (2020) 5:10-20\n"
    "A Study of Something Real and Interesting\n"
    "Jane Doe, John Smith\n"
    "Abstract\n"
    "This study examines something interesting in detail.\n"
    "\n"
    "Keywords: testing, research\n"
    "https://doi.org/10.1234/abcd\n"
)

# A citation banner whose journal name contains none of
# extract_venue_from_lines' own hint words (journal/proceedings/quarterly/
# review/bulletin/transactions/conference) — so `source_venue` can only
# come from the journal_title fallback (see ingest.py's `extracted_venue`),
# never from extract_venue_from_lines matching the banner line itself.
_NO_VENUE_HINT_JOURNAL_TEXT = (
    "Studies in Comparative Education (2020) 5:10-20\n"
    "A Study of Something Real and Interesting\n"
    "Jane Doe, John Smith\n"
)


class _FakeDuplicateChecker:
    def __init__(self, *, duplicate: bool = False) -> None:
        self._duplicate = duplicate

    def contains_sha256(self, user_id: uuid.UUID, sha256: str) -> bool:
        return self._duplicate


def _write_txt(tmp_path: Path, text: str, *, name: str = "paper.txt") -> Path:
    path = tmp_path / name
    path.write_text(text, encoding="utf-8")
    return path


class TestUserOverridePrecedence:
    def test_explicit_title_wins_over_extracted_title(self, tmp_path: Path) -> None:
        path = _write_txt(tmp_path, _JOURNAL_TEXT)
        result = ingest_document(
            path,
            document_type="journal_article",
            duplicate_checker=_FakeDuplicateChecker(),
            user_id=uuid.uuid4(),
            title="My Own Corrected Title",
        )
        assert result.metadata.title == "My Own Corrected Title"
        assert result.metadata.metadata_sources["title"] == ExtractionSource.USER.value

    def test_explicit_authors_win_over_extracted_authors(self, tmp_path: Path) -> None:
        path = _write_txt(tmp_path, _JOURNAL_TEXT)
        result = ingest_document(
            path,
            document_type="journal_article",
            duplicate_checker=_FakeDuplicateChecker(),
            user_id=uuid.uuid4(),
            authors=["Ada Lovelace"],
        )
        assert result.metadata.authors == ["Ada Lovelace"]
        assert result.metadata.metadata_sources["authors"] == ExtractionSource.USER.value

    def test_explicit_empty_authors_list_still_counts_as_a_user_override(
        self, tmp_path: Path
    ) -> None:
        # authors=[] is a real, deliberate user choice ("no authors"), not
        # "nothing provided" — the resolved value AND its provenance must
        # both reflect that, never silently fall back to what extraction
        # found (see ingest.py's `_provenance` docstring on why this needs
        # an explicit `is not None` check rather than plain truthiness).
        path = _write_txt(tmp_path, _JOURNAL_TEXT)
        result = ingest_document(
            path,
            document_type="journal_article",
            duplicate_checker=_FakeDuplicateChecker(),
            user_id=uuid.uuid4(),
            authors=[],
        )
        assert result.metadata.authors == []
        assert result.metadata.metadata_sources["authors"] == ExtractionSource.USER.value

    def test_explicit_publication_year_wins(self, tmp_path: Path) -> None:
        path = _write_txt(tmp_path, _JOURNAL_TEXT)
        result = ingest_document(
            path,
            document_type="journal_article",
            duplicate_checker=_FakeDuplicateChecker(),
            user_id=uuid.uuid4(),
            publication_year=1999,
        )
        assert result.metadata.publication_year == 1999
        assert result.metadata.metadata_sources["publication_year"] == ExtractionSource.USER.value

    def test_explicit_doi_wins(self, tmp_path: Path) -> None:
        path = _write_txt(tmp_path, _JOURNAL_TEXT)
        result = ingest_document(
            path,
            document_type="journal_article",
            duplicate_checker=_FakeDuplicateChecker(),
            user_id=uuid.uuid4(),
            doi="10.9999/override",
        )
        assert result.metadata.doi == "10.9999/override"
        assert result.metadata.metadata_sources["doi"] == ExtractionSource.USER.value

    def test_explicit_source_venue_wins(self, tmp_path: Path) -> None:
        path = _write_txt(tmp_path, _JOURNAL_TEXT)
        result = ingest_document(
            path,
            document_type="journal_article",
            duplicate_checker=_FakeDuplicateChecker(),
            user_id=uuid.uuid4(),
            source_venue="A Different Journal Entirely",
        )
        assert result.metadata.source_venue == "A Different Journal Entirely"
        assert result.metadata.metadata_sources["source_venue"] == ExtractionSource.USER.value

    def test_explicit_source_url_wins(self, tmp_path: Path) -> None:
        path = _write_txt(tmp_path, _JOURNAL_TEXT)
        result = ingest_document(
            path,
            document_type="journal_article",
            duplicate_checker=_FakeDuplicateChecker(),
            user_id=uuid.uuid4(),
            source_url="https://example.com/my-copy",
        )
        assert result.metadata.source_url == "https://example.com/my-copy"
        assert result.metadata.metadata_sources["source_url"] == ExtractionSource.USER.value


class TestExtractionOnlyFieldsFlowThrough:
    def test_abstract_keywords_volume_pages_are_persisted_from_extraction(
        self, tmp_path: Path
    ) -> None:
        path = _write_txt(tmp_path, _JOURNAL_TEXT)
        result = ingest_document(
            path,
            document_type="journal_article",
            duplicate_checker=_FakeDuplicateChecker(),
            user_id=uuid.uuid4(),
        )
        metadata = result.metadata
        assert metadata.abstract == "This study examines something interesting in detail."
        assert metadata.keywords == ["testing", "research"]
        assert metadata.volume == "5"
        assert metadata.page_start == 10
        assert metadata.page_end == 20
        for field in ("abstract", "keywords", "volume", "page_start", "page_end"):
            assert metadata.metadata_sources[field] == ExtractionSource.STRUCTURED_TEXT.value

    def test_venue_falls_back_to_the_journal_citation_banner(self, tmp_path: Path) -> None:
        path = _write_txt(tmp_path, _NO_VENUE_HINT_JOURNAL_TEXT)
        result = ingest_document(
            path,
            document_type="journal_article",
            duplicate_checker=_FakeDuplicateChecker(),
            user_id=uuid.uuid4(),
        )
        assert result.metadata.source_venue == "Studies in Comparative Education"
        expected_source = ExtractionSource.STRUCTURED_TEXT.value
        assert result.metadata.metadata_sources["source_venue"] == expected_source

    def test_issue_and_publisher_are_always_none_from_ingestion_alone(self, tmp_path: Path) -> None:
        path = _write_txt(tmp_path, _JOURNAL_TEXT)
        result = ingest_document(
            path,
            document_type="journal_article",
            duplicate_checker=_FakeDuplicateChecker(),
            user_id=uuid.uuid4(),
        )
        assert result.metadata.issue is None
        assert result.metadata.publisher is None
        assert "issue" not in result.metadata.metadata_sources
        assert "publisher" not in result.metadata.metadata_sources


class TestFilenameFallbackAndMissingMetadata:
    def test_title_falls_back_to_the_filename_when_nothing_else_found(
        self, tmp_path: Path
    ) -> None:
        # Every line here is something is_plausible_title explicitly
        # rejects (a figure caption, a bare page number, bare section
        # headings) — see test_metadata_extraction.py's equivalent
        # "no recognizable structure" fixture for why ordinary prose can't
        # be used here: extract_title_from_lines takes the first
        # plausible-*looking* line as a weak-confidence guess, so it would
        # win before the filename fallback ever gets a chance to.
        path = _write_txt(tmp_path, "Figure 1\n3\nAbstract\nIntroduction")
        result = ingest_document(
            path,
            document_type="unknown",
            duplicate_checker=_FakeDuplicateChecker(),
            user_id=uuid.uuid4(),
            original_filename="my_research_notes.txt",
        )
        assert result.metadata.title == "my research notes"
        assert result.metadata.metadata_sources["title"] == ExtractionSource.FILENAME.value

    def test_a_document_with_no_bibliographic_signal_leaves_fields_unset(
        self, tmp_path: Path
    ) -> None:
        path = _write_txt(tmp_path, "Some plain notes with nothing bibliographic in them at all.")
        result = ingest_document(
            path,
            document_type="unknown",
            duplicate_checker=_FakeDuplicateChecker(),
            user_id=uuid.uuid4(),
        )
        metadata = result.metadata
        assert metadata.authors == []
        assert metadata.doi is None
        assert metadata.source_venue is None
        assert metadata.publication_year is None
        assert metadata.abstract is None
        assert metadata.keywords == []
        for field in ("authors", "doi", "source_venue", "publication_year", "abstract", "keywords"):
            assert field not in metadata.metadata_sources

    def test_duplicate_document_raises_before_touching_metadata(self, tmp_path: Path) -> None:
        from app.ingestion.errors import DuplicateDocumentError

        path = _write_txt(tmp_path, _JOURNAL_TEXT)
        with pytest.raises(DuplicateDocumentError):
            ingest_document(
                path,
                document_type="journal_article",
                duplicate_checker=_FakeDuplicateChecker(duplicate=True),
                user_id=uuid.uuid4(),
            )


class TestUnicodeAndSpecialCharacters:
    def test_unicode_title_survives_the_full_pipeline(self, tmp_path: Path) -> None:
        text = (
            "Journal of Testing (2021) 2:1-9\n"
            "\u00dcber die Wirkung von Bildung \u2013 \u00e9tude \u6559\u80b2\n"
            "Jane Doe, John Smith\n"
        )
        path = _write_txt(tmp_path, text, name="étude.txt")
        result = ingest_document(
            path,
            document_type="journal_article",
            duplicate_checker=_FakeDuplicateChecker(),
            user_id=uuid.uuid4(),
        )
        expected_title = "\u00dcber die Wirkung von Bildung \u2013 \u00e9tude \u6559\u80b2"
        assert result.metadata.title == expected_title
        assert result.metadata.authors == ["Jane Doe", "John Smith"]

    def test_unicode_filename_survives_as_a_last_resort_title(self, tmp_path: Path) -> None:
        path = _write_txt(tmp_path, "Figure 1\n3\nAbstract\nIntroduction", name="étude.txt")
        result = ingest_document(
            path,
            document_type="unknown",
            duplicate_checker=_FakeDuplicateChecker(),
            user_id=uuid.uuid4(),
        )
        assert result.metadata.title == "étude"
        assert result.metadata.metadata_sources["title"] == ExtractionSource.FILENAME.value

    def test_diacritic_author_names_are_a_known_extraction_limitation(
        self, tmp_path: Path
    ) -> None:
        # Documents current, honest behavior rather than a fabricated
        # expectation: the byline-shape heuristic's name-token pattern is
        # ASCII-only (see metadata_extraction._NAME_TOKEN_PATTERN), so a
        # byline made up entirely of diacritic names is not recognized as
        # author-shaped and authors comes back empty — never a mangled or
        # partially-invented name, just "not detected."
        text = (
            "Journal of Testing (2021) 2:1-9\n"
            "A Study of Something Real\n"
            "José García, Ana Muñoz\n"
        )
        path = _write_txt(tmp_path, text)
        result = ingest_document(
            path,
            document_type="journal_article",
            duplicate_checker=_FakeDuplicateChecker(),
            user_id=uuid.uuid4(),
        )
        assert result.metadata.authors == []
        assert "authors" not in result.metadata.metadata_sources


class TestDoiNormalizationOnIngest:
    def test_a_doi_org_url_is_normalized_on_upload(self, tmp_path: Path) -> None:
        path = _write_txt(tmp_path, "Just some ordinary notes.")
        result = ingest_document(
            path,
            document_type="unknown",
            duplicate_checker=_FakeDuplicateChecker(),
            user_id=uuid.uuid4(),
            doi="https://doi.org/10.1234/abcd",
        )
        assert result.metadata.doi == "10.1234/abcd"
        assert result.metadata.metadata_sources["doi"] == ExtractionSource.USER.value

    def test_a_doi_colon_prefix_is_normalized_on_upload(self, tmp_path: Path) -> None:
        path = _write_txt(tmp_path, "Just some ordinary notes.")
        result = ingest_document(
            path,
            document_type="unknown",
            duplicate_checker=_FakeDuplicateChecker(),
            user_id=uuid.uuid4(),
            doi="doi:10.1234/abcd",
        )
        assert result.metadata.doi == "10.1234/abcd"

    def test_an_already_clean_doi_is_unchanged(self, tmp_path: Path) -> None:
        path = _write_txt(tmp_path, "Just some ordinary notes.")
        result = ingest_document(
            path,
            document_type="unknown",
            duplicate_checker=_FakeDuplicateChecker(),
            user_id=uuid.uuid4(),
            doi="10.1234/abcd",
        )
        assert result.metadata.doi == "10.1234/abcd"
