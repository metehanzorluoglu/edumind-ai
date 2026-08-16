"""Milestone 4.1 (Authoritative Metadata Enrichment & Duplicate Awareness)
Section 35/36 — tests for app/core/bibliographic_enrichment.py. A fake
`_HttpGetter` (no real network call, no httpx transport) drives every
CrossrefProvider failure/success path, matching this repo's existing
convention for external-service clients (see
tests/unit/core/test_evidence_client.py). merge_authoritative_metadata is
tested as a pure function, independent of any HTTP concern."""

from __future__ import annotations

import httpx
import pytest

from app.core.bibliographic_enrichment import (
    CrossrefProvider,
    CrossrefWork,
    NormalizedAuthor,
    merge_authoritative_metadata,
)
from app.ingestion.loaders.base import ExtractionSource


class _FakeHttpGetter:
    def __init__(
        self,
        *,
        responses: list[httpx.Response] | None = None,
        response: httpx.Response | None = None,
        raises: list[Exception] | Exception | None = None,
    ) -> None:
        self._responses = list(responses) if responses is not None else None
        self._response = response
        self._raises = raises if isinstance(raises, list) else ([raises] if raises else None)
        self.calls: list[dict[str, object]] = []

    def get(self, url: str, *, headers: dict[str, str], timeout: float) -> httpx.Response:
        self.calls.append({"url": url, "headers": headers, "timeout": timeout})
        call_index = len(self.calls) - 1
        if self._raises is not None:
            exc = self._raises[min(call_index, len(self._raises) - 1)]
            raise exc
        if self._responses is not None:
            return self._responses[min(call_index, len(self._responses) - 1)]
        assert self._response is not None
        return self._response


class _FlakyThenOkGetter:
    """Raises a timeout on the first call, then returns a normal 200 on
    every subsequent call — for exercising the single-retry path all the
    way through to a recovered, successful lookup."""

    def __init__(self) -> None:
        self.calls: list[str] = []

    def get(self, url: str, *, headers: dict[str, str], timeout: float) -> httpx.Response:
        self.calls.append(url)
        if len(self.calls) == 1:
            raise httpx.TimeoutException("slow")
        return httpx.Response(200, json=_crossref_body())


def _provider(
    fake: _FakeHttpGetter | _FlakyThenOkGetter, *, contact_email: str = "x@x.com"
) -> CrossrefProvider:
    return CrossrefProvider(
        base_url="https://api.crossref.org", contact_email=contact_email, client=fake
    )


def _crossref_body(**overrides: object) -> dict[str, object]:
    message: dict[str, object] = {
        "DOI": "10.1038/nature12373",
        "type": "journal-article",
        "title": ["A study of things"],
        "container-title": ["Nature"],
        "author": [
            {"given": "Jane", "family": "Smith", "sequence": "first"},
            {"given": "Alan", "family": "Reyes", "sequence": "additional"},
        ],
        "published-print": {"date-parts": [[2013, 6, 15]]},
        "issued": {"date-parts": [[2013, 6, 1]]},
        "volume": "499",
        "issue": "7459",
        "page": "54-58",
        "publisher": "Springer Nature",
        "URL": "https://doi.org/10.1038/nature12373",
        "language": "en",
    }
    message.update(overrides)
    return {"message": message}


class TestLookupByDoiSuccess:
    def test_normal_journal_article(self) -> None:
        fake = _FakeHttpGetter(response=httpx.Response(200, json=_crossref_body()))
        provider = CrossrefProvider(
            base_url="https://api.crossref.org", contact_email="dev@edum8.us", client=fake
        )
        outcome = provider.lookup_by_doi("10.1038/nature12373")
        assert outcome.ok is True
        assert outcome.failure is None
        work = outcome.work
        assert work is not None
        assert work.title == "A study of things"
        assert work.venue == "Nature"
        assert [a.display_name for a in work.authors] == ["Jane Smith", "Alan Reyes"]
        assert work.publication_year == 2013
        assert work.volume == "499"
        assert work.issue == "7459"
        assert work.page_start == 54
        assert work.page_end == 58
        assert work.publisher == "Springer Nature"
        assert work.document_type == "journal_article"
        assert work.language == "en"

    def test_request_uses_normalized_doi_and_polite_pool_headers(self) -> None:
        fake = _FakeHttpGetter(response=httpx.Response(200, json=_crossref_body()))
        provider = CrossrefProvider(
            base_url="https://api.crossref.org/", contact_email="dev@edum8.us", client=fake
        )
        provider.lookup_by_doi("https://doi.org/10.1038/NATURE12373")
        call = fake.calls[0]
        headers = call["headers"]
        assert isinstance(headers, dict)
        # normalize_doi() strips the doi.org wrapper but does not
        # lowercase the suffix (DOI suffixes are case-sensitive per the
        # spec) — see app/ingestion/metadata_extraction.py.
        assert call["url"] == "https://api.crossref.org/works/10.1038/NATURE12373"
        assert "mailto:dev@edum8.us" in headers["User-Agent"]

    def test_multiple_authors_preserve_order(self) -> None:
        body = _crossref_body(
            author=[
                {"given": "A", "family": "One"},
                {"given": "B", "family": "Two"},
                {"given": "C", "family": "Three"},
            ]
        )
        fake = _FakeHttpGetter(response=httpx.Response(200, json=body))
        provider = _provider(fake)
        outcome = provider.lookup_by_doi("10.1234/x")
        assert outcome.work is not None
        assert [a.display_name for a in outcome.work.authors] == ["A One", "B Two", "C Three"]

    def test_organization_author_uses_literal_name(self) -> None:
        body = _crossref_body(author=[{"name": "World Health Organization"}])
        fake = _FakeHttpGetter(response=httpx.Response(200, json=body))
        provider = _provider(fake)
        outcome = provider.lookup_by_doi("10.1234/x")
        assert outcome.work is not None
        assert [a.display_name for a in outcome.work.authors] == ["World Health Organization"]

    def test_family_only_author(self) -> None:
        body = _crossref_body(author=[{"family": "Cher"}])
        fake = _FakeHttpGetter(response=httpx.Response(200, json=body))
        provider = _provider(fake)
        outcome = provider.lookup_by_doi("10.1234/x")
        assert outcome.work is not None
        assert [a.display_name for a in outcome.work.authors] == ["Cher"]

    def test_no_authors(self) -> None:
        body = _crossref_body(author=[])
        fake = _FakeHttpGetter(response=httpx.Response(200, json=body))
        provider = _provider(fake)
        outcome = provider.lookup_by_doi("10.1234/x")
        assert outcome.work is not None
        assert outcome.work.authors == ()

    def test_missing_optional_fields_leave_them_none(self) -> None:
        body = {
            "message": {
                "DOI": "10.1234/minimal",
                "title": ["Minimal record"],
            }
        }
        fake = _FakeHttpGetter(response=httpx.Response(200, json=body))
        provider = _provider(fake)
        outcome = provider.lookup_by_doi("10.1234/minimal")
        assert outcome.ok is True
        work = outcome.work
        assert work is not None
        assert work.venue is None
        assert work.authors == ()
        assert work.publication_year is None
        assert work.volume is None
        assert work.page_start is None
        assert work.publisher is None
        assert work.document_type is None
        assert work.abstract is None
        assert work.language is None

    def test_unicode_names_and_title(self) -> None:
        body = _crossref_body(
            title=["Étude sur la synthèse"],
            author=[{"given": "José", "family": "Müller"}, {"name": "Universität Wien"}],
        )
        fake = _FakeHttpGetter(response=httpx.Response(200, json=body))
        provider = _provider(fake)
        outcome = provider.lookup_by_doi("10.1234/x")
        assert outcome.work is not None
        assert outcome.work.title == "Étude sur la synthèse"
        assert [a.display_name for a in outcome.work.authors] == ["José Müller", "Universität Wien"]

    def test_abstract_markup_is_stripped(self) -> None:
        raw_abstract = "<jats:p>This is the <jats:italic>abstract</jats:italic>.</jats:p>"
        body = _crossref_body(abstract=raw_abstract)
        fake = _FakeHttpGetter(response=httpx.Response(200, json=body))
        provider = _provider(fake)
        outcome = provider.lookup_by_doi("10.1234/x")
        assert outcome.work is not None
        assert outcome.work.abstract == "This is the abstract ."

    def test_nonstandard_article_number_page_is_preserved_raw_only(self) -> None:
        body = _crossref_body(page="e12345")
        fake = _FakeHttpGetter(response=httpx.Response(200, json=body))
        provider = _provider(fake)
        outcome = provider.lookup_by_doi("10.1234/x")
        assert outcome.work is not None
        assert outcome.work.page_start is None
        assert outcome.work.page_end is None
        assert outcome.work.page_raw == "e12345"

    def test_single_page_number(self) -> None:
        body = _crossref_body(page="54")
        fake = _FakeHttpGetter(response=httpx.Response(200, json=body))
        provider = _provider(fake)
        outcome = provider.lookup_by_doi("10.1234/x")
        assert outcome.work is not None
        assert outcome.work.page_start == 54
        assert outcome.work.page_end is None
        assert outcome.work.page_raw == "54"

    @pytest.mark.parametrize(
        ("published_print", "published_online", "issued", "created", "expected"),
        [
            (2020, 2019, 2020, 2018, 2020),  # published-print wins over everything
            (None, 2019, 2020, 2018, 2020),  # no print date -> issued wins over online
            (None, 2019, None, 2018, 2019),  # no print/issued -> published-online
            (None, None, None, 2018, 2018),  # only created -> last resort
            (None, None, None, None, None),  # nothing at all -> unknown
        ],
    )
    def test_publication_year_priority(
        self,
        published_print: int | None,
        published_online: int | None,
        issued: int | None,
        created: int | None,
        expected: int | None,
    ) -> None:
        message: dict[str, object] = {"DOI": "10.1234/x", "title": ["Some title"]}
        for key, value in (
            ("published-print", published_print),
            ("published-online", published_online),
            ("issued", issued),
            ("created", created),
        ):
            if value is not None:
                message[key] = {"date-parts": [[value]]}
        fake = _FakeHttpGetter(response=httpx.Response(200, json={"message": message}))
        provider = _provider(fake)
        outcome = provider.lookup_by_doi("10.1234/x")
        assert outcome.work is not None
        assert outcome.work.publication_year == expected

    @pytest.mark.parametrize(
        ("crossref_type", "expected"),
        [
            ("journal-article", "journal_article"),
            ("proceedings-article", "conference_paper"),
            ("book-chapter", "book_chapter"),
            ("book", "book"),
            ("dissertation", "thesis_dissertation"),
            ("report", "report"),
            ("some-unrecognized-type", None),
        ],
    )
    def test_document_type_mapping(self, crossref_type: str, expected: str | None) -> None:
        body = _crossref_body(type=crossref_type)
        fake = _FakeHttpGetter(response=httpx.Response(200, json=body))
        provider = _provider(fake)
        outcome = provider.lookup_by_doi("10.1234/x")
        assert outcome.work is not None
        assert outcome.work.document_type == expected


class TestLookupByDoiFailureModes:
    def test_invalid_doi_shape_is_not_found_without_a_network_call(self) -> None:
        fake = _FakeHttpGetter(response=httpx.Response(200, json=_crossref_body()))
        provider = _provider(fake)
        outcome = provider.lookup_by_doi("not a doi at all")
        assert outcome.ok is False
        assert outcome.failure == "not_found"
        assert fake.calls == []

    def test_404_maps_to_not_found(self) -> None:
        fake = _FakeHttpGetter(response=httpx.Response(404, json={"status": "not-found"}))
        provider = _provider(fake)
        outcome = provider.lookup_by_doi("10.1234/missing")
        assert outcome.ok is False
        assert outcome.failure == "not_found"

    def test_timeout_retried_once_then_fails(self) -> None:
        fake = _FakeHttpGetter(
            raises=[httpx.TimeoutException("slow"), httpx.TimeoutException("slow again")]
        )
        provider = _provider(fake)
        outcome = provider.lookup_by_doi("10.1234/x")
        assert outcome.ok is False
        assert outcome.failure == "timeout"
        assert len(fake.calls) == 2

    def test_timeout_then_success_recovers(self) -> None:
        # First call raises, the retry (second call) gets a real
        # response — _FakeHttpGetter clamps its raises index once
        # exhausted, so this needs a distinct fake per call outcome.
        fake = _FlakyThenOkGetter()
        provider = _provider(fake)
        outcome = provider.lookup_by_doi("10.1234/x")
        assert outcome.ok is True
        assert len(fake.calls) == 2

    def test_connect_error_maps_to_unavailable_after_retry(self) -> None:
        connect_errors: list[Exception] = [
            httpx.ConnectError("refused"),
            httpx.ConnectError("refused"),
        ]
        fake = _FakeHttpGetter(raises=connect_errors)
        provider = _provider(fake)
        outcome = provider.lookup_by_doi("10.1234/x")
        assert outcome.ok is False
        assert outcome.failure == "unavailable"

    def test_5xx_retried_once_then_unavailable(self) -> None:
        fake = _FakeHttpGetter(
            responses=[httpx.Response(503, text="down"), httpx.Response(503, text="still down")]
        )
        provider = _provider(fake)
        outcome = provider.lookup_by_doi("10.1234/x")
        assert outcome.ok is False
        assert outcome.failure == "unavailable"
        assert len(fake.calls) == 2

    def test_429_without_retry_after_is_rate_limited_immediately(self) -> None:
        fake = _FakeHttpGetter(response=httpx.Response(429, text="slow down"))
        provider = _provider(fake)
        outcome = provider.lookup_by_doi("10.1234/x")
        assert outcome.ok is False
        assert outcome.failure == "rate_limited"
        assert len(fake.calls) == 1

    def test_429_with_long_retry_after_reports_rate_limited_without_blocking(self) -> None:
        fake = _FakeHttpGetter(
            response=httpx.Response(429, headers={"Retry-After": "30"}, text="slow down")
        )
        provider = _provider(fake)
        outcome = provider.lookup_by_doi("10.1234/x")
        assert outcome.ok is False
        assert outcome.failure == "rate_limited"
        assert outcome.retry_after_seconds == 30.0
        assert len(fake.calls) == 1

    def test_429_with_short_retry_after_waits_then_retries(self) -> None:
        fake = _FakeHttpGetter(
            responses=[
                httpx.Response(429, headers={"Retry-After": "0"}, text="slow down"),
                httpx.Response(200, json=_crossref_body()),
            ]
        )
        provider = _provider(fake)
        outcome = provider.lookup_by_doi("10.1234/x")
        assert outcome.ok is True
        assert len(fake.calls) == 2

    def test_malformed_response_missing_message_key(self) -> None:
        fake = _FakeHttpGetter(response=httpx.Response(200, json={"unexpected": "shape"}))
        provider = _provider(fake)
        outcome = provider.lookup_by_doi("10.1234/x")
        assert outcome.ok is False
        assert outcome.failure == "malformed_response"

    def test_malformed_response_not_json(self) -> None:
        fake = _FakeHttpGetter(response=httpx.Response(200, content=b"not json"))
        provider = _provider(fake)
        outcome = provider.lookup_by_doi("10.1234/x")
        assert outcome.ok is False
        assert outcome.failure == "malformed_response"

    def test_unexpected_status_maps_to_unknown_error(self) -> None:
        fake = _FakeHttpGetter(response=httpx.Response(302, text="redirect"))
        provider = _provider(fake)
        outcome = provider.lookup_by_doi("10.1234/x")
        assert outcome.ok is False
        assert outcome.failure == "unknown_error"


class TestMergeAuthoritativeMetadata:
    def _work(self, **overrides: object) -> CrossrefWork:
        defaults: dict[str, object] = {
            "doi": "10.1234/x",
            "title": "Authoritative Title",
            "authors": (NormalizedAuthor("Jane Smith"),),
            "publication_year": 2021,
            "venue": "Journal of Things",
            "volume": "12",
            "issue": "3",
            "page_start": 1,
            "page_end": 10,
            "publisher": "Big Publisher",
            "url": "https://doi.org/10.1234/x",
            "document_type": "journal_article",
            "abstract": "An abstract.",
            "language": "en",
        }
        defaults.update(overrides)
        return CrossrefWork(**defaults)  # type: ignore[arg-type]

    def test_fills_missing_fields(self) -> None:
        result = merge_authoritative_metadata(
            current_values={"title": None, "document_type": "unknown"},
            current_sources={},
            work=self._work(),
        )
        assert result.field_updates["title"] == "Authoritative Title"
        assert result.provenance_updates["title"] == ExtractionSource.AUTHORITATIVE.value

    def test_user_field_is_never_touched(self) -> None:
        result = merge_authoritative_metadata(
            current_values={"title": "My Own Title", "document_type": "unknown"},
            current_sources={"title": ExtractionSource.USER.value},
            work=self._work(),
        )
        assert "title" not in result.field_updates
        assert "title" not in result.provenance_updates
        assert result.manual_fields_preserved == 1

    def test_authoritative_replaces_structured_text(self) -> None:
        result = merge_authoritative_metadata(
            current_values={"source_venue": "guessed venue", "document_type": "unknown"},
            current_sources={"source_venue": ExtractionSource.STRUCTURED_TEXT.value},
            work=self._work(),
        )
        assert result.field_updates["source_venue"] == "Journal of Things"

    def test_authoritative_replaces_embedded_metadata(self) -> None:
        result = merge_authoritative_metadata(
            current_values={"publisher": "old publisher", "document_type": "unknown"},
            current_sources={"publisher": ExtractionSource.EMBEDDED_METADATA.value},
            work=self._work(),
        )
        assert result.field_updates["publisher"] == "Big Publisher"

    def test_authoritative_replaces_filename(self) -> None:
        result = merge_authoritative_metadata(
            current_values={"title": "some_file_name", "document_type": "unknown"},
            current_sources={"title": ExtractionSource.FILENAME.value},
            work=self._work(),
        )
        assert result.field_updates["title"] == "Authoritative Title"

    def test_authoritative_can_refresh_its_own_prior_value(self) -> None:
        result = merge_authoritative_metadata(
            current_values={"title": "Old Authoritative Title", "document_type": "unknown"},
            current_sources={"title": ExtractionSource.AUTHORITATIVE.value},
            work=self._work(title="New Authoritative Title"),
        )
        assert result.field_updates["title"] == "New Authoritative Title"

    def test_no_change_when_value_already_matches(self) -> None:
        result = merge_authoritative_metadata(
            current_values={"title": "Authoritative Title", "document_type": "unknown"},
            current_sources={"title": ExtractionSource.AUTHORITATIVE.value},
            work=self._work(),
        )
        assert "title" not in result.field_updates

    def test_provider_none_never_blanks_a_field(self) -> None:
        result = merge_authoritative_metadata(
            current_values={"abstract": "existing abstract", "document_type": "unknown"},
            current_sources={"abstract": ExtractionSource.STRUCTURED_TEXT.value},
            work=self._work(abstract=None),
        )
        assert "abstract" not in result.field_updates

    def test_authors_empty_tuple_never_blanks_authors(self) -> None:
        result = merge_authoritative_metadata(
            current_values={"authors": ["Existing Author"], "document_type": "unknown"},
            current_sources={"authors": ExtractionSource.STRUCTURED_TEXT.value},
            work=self._work(authors=()),
        )
        assert "authors" not in result.field_updates

    def test_document_type_fills_when_unclassified(self) -> None:
        result = merge_authoritative_metadata(
            current_values={"document_type": "unknown"},
            current_sources={},
            work=self._work(document_type="book_chapter"),
        )
        assert result.field_updates["document_type"] == "book_chapter"
        assert result.provenance_updates["document_type"] == ExtractionSource.AUTHORITATIVE.value

    def test_document_type_never_overwrites_a_concrete_existing_type(self) -> None:
        result = merge_authoritative_metadata(
            current_values={"document_type": "report"},
            current_sources={},
            work=self._work(document_type="journal_article"),
        )
        assert "document_type" not in result.field_updates

    def test_document_type_not_included_when_provider_has_none(self) -> None:
        result = merge_authoritative_metadata(
            current_values={"document_type": "unknown"},
            current_sources={},
            work=self._work(document_type=None),
        )
        assert "document_type" not in result.field_updates

    def test_manual_fields_preserved_counts_only_user_sourced_fields(self) -> None:
        result = merge_authoritative_metadata(
            current_values={
                "title": "manual title",
                "source_venue": "manual venue",
                "document_type": "unknown",
            },
            current_sources={
                "title": ExtractionSource.USER.value,
                "source_venue": ExtractionSource.USER.value,
            },
            work=self._work(),
        )
        # title/source_venue are USER-sourced and must be preserved, not
        # replaced — but every other field the provider has data for is
        # still fair game to fill (this is a per-field merge, not a
        # whole-object one — Section 8).
        assert result.manual_fields_preserved == 2
        assert "title" not in result.field_updates
        assert "source_venue" not in result.field_updates
        assert result.field_updates["publisher"] == "Big Publisher"
        assert result.field_updates["document_type"] == "journal_article"
