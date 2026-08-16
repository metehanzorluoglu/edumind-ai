"""Milestone 4.1 (Authoritative Metadata Enrichment & Duplicate Awareness):
DOI-backed bibliographic enrichment via Crossref's public REST API
(https://api.crossref.org — no authentication required; see
Settings.bibliographic_provider_contact_email for the "polite pool"
User-Agent convention Crossref documents).

Two independent responsibilities live here, deliberately kept in one small
module rather than a plugin framework (Milestone 4.1 Section 4's explicit
instruction):

1. `CrossrefProvider` — a thin, never-raises HTTP client (mirrors
   app/core/evidence_client.py's EvidenceClient shape exactly: an
   injectable `_HttpGetter` Protocol for testability, a fixed
   `EnrichmentFailureReason` vocabulary, every failure mode turned into an
   ordinary `EnrichmentLookupOutcome` value instead of a raised exception —
   see that module's own docstring for why "failure must be a plain,
   checkable field" matters here too: a lookup failure must never become
   an unhandled exception that could break document ingestion).

2. `merge_authoritative_metadata` — the field-level precedence merge
   (Section 7/8): USER > AUTHORITATIVE > EMBEDDED_METADATA >
   STRUCTURED_TEXT > FILENAME, enforced per field, never as a whole-object
   replacement. A provider result may fill a missing field or replace a
   less-trusted one; it can never overwrite a field whose current
   provenance is USER.

"Authoritative" describes the SOURCE (an identifier-backed lookup against
the work's own registered scholarial record), not a guarantee of
correctness — Crossref data can itself be incomplete or wrong. Nothing
here ever claims infallibility to the user (see the frontend's "Refresh
metadata" copy).
"""

from __future__ import annotations

import logging
import re
import time
from dataclasses import dataclass, field
from typing import Literal, Protocol

import httpx

from app.ingestion.loaders.base import ExtractionSource
from app.ingestion.metadata_extraction import normalize_doi
from app.ingestion.metadata_schema import DocumentType

logger = logging.getLogger(__name__)

#: The fixed, named set of ways a DOI lookup can fail — mirrors
#: EvidenceClient's FailureReason (app/core/evidence_client.py) for the
#: same reason: a fixed vocabulary is what Section 40's observability
#: fields (lookup_not_found/lookup_timeout/lookup_rate_limited/
#: lookup_error) key off, and what the frontend's "concise, non-alarming"
#: failure copy (Section 33) switches on.
EnrichmentFailureReason = Literal[
    "not_found",
    "timeout",
    "unavailable",
    "rate_limited",
    "malformed_response",
    "unknown_error",
]


@dataclass(frozen=True)
class NormalizedAuthor:
    """One author, already resolved to a single display string — Crossref
    represents a personal author as given+family and an organizational/
    literal author as a bare `name` (Section 14); this collapses both into
    the one shape `Document.authors` (a flat `list[str]`) already expects,
    so the merge step never needs to know which shape a given entry came
    from."""

    display_name: str


@dataclass(frozen=True)
class CrossrefWork:
    """A normalized Crossref `work` record — only the fields Milestone
    4.1 Section 13 lists as reliably mappable. Every field is optional:
    Crossref records are frequently incomplete, and this never fabricates
    a value Crossref didn't actually provide (mirrors app/ingestion/
    metadata_extraction.py's own "unknown means unknown" discipline)."""

    doi: str
    title: str | None = None
    authors: tuple[NormalizedAuthor, ...] = ()
    publication_year: int | None = None
    venue: str | None = None
    volume: str | None = None
    issue: str | None = None
    page_start: int | None = None
    page_end: int | None = None
    # Raw page-range string as Crossref reported it (e.g. "e12345", a
    # nonstandard article number) — kept alongside page_start/page_end
    # even when those couldn't be parsed as plain integers, so no
    # information is silently discarded (Section 17).
    page_raw: str | None = None
    publisher: str | None = None
    url: str | None = None
    document_type: DocumentType | None = None
    abstract: str | None = None
    language: str | None = None


@dataclass(frozen=True)
class EnrichmentLookupOutcome:
    """The one return type CrossrefProvider.lookup_by_doi uses — success
    and failure are both plain, checkable values, never an exception a
    caller must remember to catch (same contract as EvidenceClient's
    ClassificationOutcome, and for the same reason: a lookup failure here
    must never become an unhandled exception that could break document
    ingestion — Section 9)."""

    ok: bool
    work: CrossrefWork | None = None
    failure: EnrichmentFailureReason | None = None
    #: Populated only when failure == "rate_limited" and the response
    #: included one (Section 19's "respect Retry-After where appropriate").
    retry_after_seconds: float | None = None


class _HttpGetter(Protocol):
    def get(self, url: str, *, headers: dict[str, str], timeout: float) -> httpx.Response: ...


# One conservative retry for a transient failure (timeout/connection
# error/5xx) only — never for a 4xx, which by definition won't succeed on
# retry (Section 19: "do not retry 4xx blindly", "do not create request
# storms"). A single retry, not a loop: this call already sits on the
# critical path of a background ingestion job and a user-triggered
# "Refresh metadata" action, so bounded, predictable latency matters more
# than maximizing eventual success.
_MAX_TRANSIENT_RETRIES = 1


class CrossrefProvider:
    """One instance per process (see app/deps.py::get_bibliographic_
    provider), matching every other external-service client in this
    codebase. Constructed unconditionally even when
    Settings.bibliographic_enrichment_enabled is false — building an
    httpx.Client opens no connection — so that flag is the one place that
    decides whether this is ever actually called, not a second
    conditional-construction path that could drift out of sync with it
    (same reasoning as EvidenceClient's own docstring)."""

    def __init__(
        self,
        *,
        base_url: str,
        contact_email: str,
        timeout_seconds: float = 5.0,
        client: _HttpGetter | None = None,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._timeout_seconds = timeout_seconds
        # Crossref's own documented "polite pool" convention: a
        # descriptive User-Agent naming the application and a contact
        # mailto: gets priority routing and a materially higher rate
        # limit than an anonymous request — see
        # https://api.crossref.org and Section 3's own instruction to
        # verify this rather than assume old API behavior.
        self._headers = {
            "User-Agent": f"EduM8/1.0 (mailto:{contact_email})",
            "Accept": "application/json",
        }
        self._client: _HttpGetter = (
            client if client is not None else httpx.Client(timeout=timeout_seconds)
        )

    def lookup_by_doi(self, doi: str) -> EnrichmentLookupOutcome:
        """Never raises: every failure mode (connection refused, timeout,
        4xx/5xx, malformed JSON, an unexpected shape) is caught and
        returned as EnrichmentLookupOutcome(ok=False, failure=...) — see
        the class docstring. `doi` is normalized before the request (the
        same normalize_doi() ingest.py and the metadata-edit endpoint
        already use), so a caller can pass whatever shape a document's
        `doi` column happens to hold."""
        normalized = normalize_doi(doi)
        if normalized is None:
            return EnrichmentLookupOutcome(ok=False, failure="not_found")

        url = f"{self._base_url}/works/{normalized}"
        attempt = 0
        while True:
            try:
                response = self._client.get(
                    url, headers=self._headers, timeout=self._timeout_seconds
                )
            except httpx.TimeoutException:
                if attempt < _MAX_TRANSIENT_RETRIES:
                    attempt += 1
                    continue
                return EnrichmentLookupOutcome(ok=False, failure="timeout")
            except httpx.HTTPError:
                if attempt < _MAX_TRANSIENT_RETRIES:
                    attempt += 1
                    continue
                return EnrichmentLookupOutcome(ok=False, failure="unavailable")

            if response.status_code == 404:
                return EnrichmentLookupOutcome(ok=False, failure="not_found")
            if response.status_code == 429:
                retry_after = _parse_retry_after(response.headers.get("Retry-After"))
                may_retry = attempt < _MAX_TRANSIENT_RETRIES
                if may_retry and retry_after is not None and retry_after <= 2.0:
                    # Only worth waiting inline for a short, explicit
                    # delay — anything longer is reported back rather than
                    # blocking this call (Section 19: "conservative
                    # concurrency", never a request storm).
                    attempt += 1
                    time.sleep(retry_after)
                    continue
                return EnrichmentLookupOutcome(
                    ok=False, failure="rate_limited", retry_after_seconds=retry_after
                )
            if 500 <= response.status_code < 600:
                if attempt < _MAX_TRANSIENT_RETRIES:
                    attempt += 1
                    continue
                return EnrichmentLookupOutcome(ok=False, failure="unavailable")
            if response.status_code != 200:
                return EnrichmentLookupOutcome(ok=False, failure="unknown_error")

            try:
                body = response.json()
                message = body["message"]
                work = _parse_crossref_work(message, fallback_doi=normalized)
            except (KeyError, ValueError, TypeError) as exc:
                logger.warning(
                    "Crossref response for DOI %r had an unexpected shape: %s", normalized, exc
                )
                return EnrichmentLookupOutcome(ok=False, failure="malformed_response")

            return EnrichmentLookupOutcome(ok=True, work=work)


def _parse_retry_after(raw: str | None) -> float | None:
    if raw is None:
        return None
    try:
        return max(0.0, float(raw))
    except ValueError:
        return None


# --- Crossref response normalization -----------------------------------

_ABSTRACT_TAG_PATTERN = re.compile(r"<[^>]+>")

# Section 18: conservative, additive mapping — an unrecognized Crossref
# `type` is never forced into "other"; the caller simply omits
# document_type from the merge entirely (see merge_authoritative_metadata),
# leaving whatever the document already had untouched.
_CROSSREF_TYPE_MAP: dict[str, DocumentType] = {
    "journal-article": "journal_article",
    "proceedings-article": "conference_paper",
    "book-chapter": "book_chapter",
    "book": "book",
    "monograph": "book",
    "reference-book": "book",
    "dissertation": "thesis_dissertation",
    "report": "report",
    "report-series": "report",
}


def _normalize_authors(raw_authors: object) -> tuple[NormalizedAuthor, ...]:
    """Section 14: given+family, family-only, and organizational/literal
    (`name`) author records all normalize to one display string, in the
    order Crossref returned them (`sequence` is informational only —
    Crossref already returns authors in citation order). An author entry
    with neither a usable name nor family/given is skipped, never turned
    into a placeholder like "Unknown Author"."""
    if not isinstance(raw_authors, list):
        return ()
    normalized: list[NormalizedAuthor] = []
    for entry in raw_authors:
        if not isinstance(entry, dict):
            continue
        literal_name = entry.get("name")
        if isinstance(literal_name, str) and literal_name.strip():
            normalized.append(NormalizedAuthor(display_name=literal_name.strip()))
            continue
        given = entry.get("given")
        family = entry.get("family")
        if isinstance(family, str) and family.strip():
            parts = [p for p in (given, family) if isinstance(p, str) and p.strip()]
            normalized.append(NormalizedAuthor(display_name=" ".join(p.strip() for p in parts)))
    return tuple(normalized)


def _year_from_date_parts(raw: object) -> int | None:
    if not isinstance(raw, dict):
        return None
    parts = raw.get("date-parts")
    if not isinstance(parts, list) or not parts or not isinstance(parts[0], list) or not parts[0]:
        return None
    year = parts[0][0]
    return year if isinstance(year, int) else None


def _resolve_publication_year(message: dict[str, object]) -> int | None:
    """Section 15: a deterministic priority across Crossref's several
    date fields, documented here rather than left to "whichever appears
    first in the JSON": `published-print` (the formal issue/volume
    publication — the same "citation year" precedence
    app/ingestion/metadata_extraction.py's extract_publication_year
    already gives a recognized journal citation banner over an online-first
    date) > `issued` (Crossref's own canonical "officially issued" date,
    used when there is no separate print date — e.g. an online-only
    journal) > `published-online` (can genuinely predate the formal
    issue) > `published` (a generic fallback some record types use instead
    of the more specific fields above) > `created` (merely when the
    metadata record itself was created — least meaningful for citation
    purposes, last resort only)."""
    for key in ("published-print", "issued", "published-online", "published", "created"):
        year = _year_from_date_parts(message.get(key))
        if year is not None:
            return year
    return None


def _parse_page_range(raw: object) -> tuple[int | None, int | None, str | None]:
    """Section 17: `page` is a free-form string ("54-58", "e12345", a
    single page). Only ever parsed into page_start/page_end when both
    sides are plain integers — a nonstandard article number is preserved
    verbatim in `page_raw` and never forced into page_start/page_end
    (never fabricated)."""
    if not isinstance(raw, str) or not raw.strip():
        return None, None, None
    text = raw.strip()
    # Page ranges commonly use a plain hyphen, but Crossref sources also
    # emit various Unicode dash characters: U+2010 HYPHEN, U+2011
    # NON-BREAKING HYPHEN, U+2012 FIGURE DASH, U+2013 EN DASH, U+2014 EM
    # DASH, U+2015 HORIZONTAL BAR — spelled out via \uXXXX escapes rather
    # than literal characters so this file has no ambiguous-Unicode lint
    # findings.
    dash_chars = "-\u2010\u2011\u2012\u2013\u2014\u2015"
    match = re.match(rf"^(\d+)\s*[{dash_chars}]\s*(\d+)$", text)
    if match:
        return int(match.group(1)), int(match.group(2)), text
    if re.fullmatch(r"\d+", text):
        return int(text), None, text
    return None, None, text


def _strip_abstract_markup(raw: object) -> str | None:
    """Crossref abstracts, when present at all, are JATS-XML-tagged
    (`<jats:p>...</jats:p>`) — this strips tags only, never rewrites or
    summarizes the text itself."""
    if not isinstance(raw, str) or not raw.strip():
        return None
    stripped = _ABSTRACT_TAG_PATTERN.sub(" ", raw)
    return re.sub(r"\s+", " ", stripped).strip() or None


def _first_str(items: object) -> str | None:
    """Crossref represents `title`/`container-title` as a list (rarely
    more than one entry in practice) — this takes the first usable string
    entry, or None if the list is missing/empty/non-string."""
    if isinstance(items, list) and items and isinstance(items[0], str):
        return items[0].strip() or None
    return None


def _optional_str(value: object) -> str | None:
    return value if isinstance(value, str) else None


def _parse_crossref_work(message: dict[str, object], *, fallback_doi: str) -> CrossrefWork:
    title = _first_str(message.get("title"))
    venue = _first_str(message.get("container-title"))

    page_start, page_end, page_raw = _parse_page_range(message.get("page"))

    crossref_type = message.get("type")
    document_type = (
        _CROSSREF_TYPE_MAP.get(crossref_type) if isinstance(crossref_type, str) else None
    )

    doi = message.get("DOI")
    resolved_doi = normalize_doi(doi) if isinstance(doi, str) else None

    return CrossrefWork(
        doi=resolved_doi or fallback_doi,
        title=title,
        authors=_normalize_authors(message.get("author")),
        publication_year=_resolve_publication_year(message),
        venue=venue,
        volume=_optional_str(message.get("volume")),
        issue=_optional_str(message.get("issue")),
        page_start=page_start,
        page_end=page_end,
        page_raw=page_raw,
        publisher=_optional_str(message.get("publisher")),
        url=_optional_str(message.get("URL")),
        document_type=document_type,
        abstract=_strip_abstract_markup(message.get("abstract")),
        language=_optional_str(message.get("language")),
    )


# --- Field-level precedence merge (Section 7/8) -------------------------

#: Ranks provenance from least to most trusted — used only to decide
#: whether AUTHORITATIVE may replace the CURRENT source of a field.
#: USER never appears as something AUTHORITATIVE could outrank; the
#: caller (merge_authoritative_metadata) checks for USER explicitly and
#: refuses to touch that field at all, matching Section 7's "must NOT
#: overwrite metadata_sources[field] == user" requirement literally rather
#: than relying on this ranking to encode it.
_PROVENANCE_RANK = {
    ExtractionSource.FILENAME.value: 0,
    ExtractionSource.STRUCTURED_TEXT.value: 1,
    ExtractionSource.EMBEDDED_METADATA.value: 2,
    ExtractionSource.AUTHORITATIVE.value: 3,
    ExtractionSource.USER.value: 4,
}


@dataclass(frozen=True)
class EnrichmentMergeResult:
    """Only the fields that actually changed (Section 8: "do NOT replace
    the whole metadata object; merge per field") plus a parallel provenance
    update — both empty when the provider had nothing better to offer than
    what the document already has."""

    field_updates: dict[str, object] = field(default_factory=dict)
    provenance_updates: dict[str, str] = field(default_factory=dict)
    manual_fields_preserved: int = 0


#: document_type is deliberately handled OUTSIDE the generic
#: metadata_sources-driven loop below: unlike every other bibliographic
#: field, a document's initial type is chosen from a required upload-form
#: dropdown (see routes_documents.py's POST /documents) that has never
#: recorded "user" provenance for it in `metadata_sources` (ingest.py's
#: provenance loop simply doesn't cover this column — it predates
#: Milestone 4's provenance tracking and was never retrofitted). Trusting
#: the generic rank lookup for this field would therefore let enrichment
#: silently overwrite a real user selection just because it happens to
#: have no recorded source — precisely what Section 18 forbids ("Do not
#: overwrite a USER-selected type"). "unknown" is DocumentType's own
#: documented value for "not classified" (see metadata_schema.py) — never
#: a considered selection — so it is the one, safe, unambiguous signal
#: that this field is genuinely open for enrichment to fill.
_DOCUMENT_TYPE_FIELD = "document_type"
_DOCUMENT_TYPE_UNCLASSIFIED = "unknown"


def merge_authoritative_metadata(
    *,
    current_values: dict[str, object],
    current_sources: dict[str, str],
    work: CrossrefWork,
) -> EnrichmentMergeResult:
    """The one place Milestone 4.1's precedence policy (Section 7) is
    enforced: USER > AUTHORITATIVE > EMBEDDED_METADATA > STRUCTURED_TEXT >
    FILENAME, decided independently per field (Section 8's worked
    example). A field whose current provenance is USER is never included
    in the result, full stop — not "outranked", entirely untouched,
    regardless of what the provider returned for it. A field with no
    current provenance entry (a pre-M4/never-extracted field) is treated
    as rank -1 (below FILENAME), so AUTHORITATIVE always wins there.

    AUTHORITATIVE is allowed to replace a field it AUTHORITATIVE already
    set on an earlier enrichment run (equal rank, strict `<` comparison
    below) — a user-triggered "Refresh metadata" must be able to pick up
    a since-corrected Crossref record, not freeze the first lookup's
    result forever; that is still never a USER field, so Section 7's
    guarantee is untouched."""
    candidates: dict[str, object | None] = {
        "title": work.title,
        "authors": [a.display_name for a in work.authors] if work.authors else None,
        "publication_year": work.publication_year,
        "source_venue": work.venue,
        "volume": work.volume,
        "issue": work.issue,
        "page_start": work.page_start,
        "page_end": work.page_end,
        "publisher": work.publisher,
        "source_url": work.url,
        "abstract": work.abstract,
        "language": work.language,
    }

    field_updates: dict[str, object] = {}
    provenance_updates: dict[str, str] = {}
    manual_preserved = 0

    for field_name, candidate_value in candidates.items():
        if candidate_value is None or candidate_value == [] or candidate_value == "":
            continue  # Section 13: never fill a field the provider didn't actually have.

        current_source = current_sources.get(field_name)
        if current_source == ExtractionSource.USER.value:
            manual_preserved += 1
            continue  # Section 7: absolute — never overwritten by enrichment.

        current_rank = _PROVENANCE_RANK.get(current_source, -1) if current_source else -1
        authoritative_rank = _PROVENANCE_RANK[ExtractionSource.AUTHORITATIVE.value]
        if authoritative_rank < current_rank:
            continue  # Current field is already strictly more trustworthy.

        current_value = current_values.get(field_name)
        if current_value == candidate_value:
            continue  # No real change — don't manufacture a provenance bump for free.

        field_updates[field_name] = candidate_value
        provenance_updates[field_name] = ExtractionSource.AUTHORITATIVE.value

    if work.document_type is not None:
        current_type = current_values.get(_DOCUMENT_TYPE_FIELD)
        if current_type != _DOCUMENT_TYPE_UNCLASSIFIED:
            # A concrete existing type (whether chosen at upload or later
            # edited) is a USER selection this milestone must never touch
            # — see _DOCUMENT_TYPE_FIELD's comment above. Note this is
            # NOT counted in manual_fields_preserved: that counter reports
            # fields explicitly tracked as "user" in metadata_sources
            # (Section 12's "N manual fields preserved" summary), and an
            # untracked upload-time type selection has no such entry.
            pass
        elif work.document_type != current_type:
            field_updates[_DOCUMENT_TYPE_FIELD] = work.document_type
            provenance_updates[_DOCUMENT_TYPE_FIELD] = ExtractionSource.AUTHORITATIVE.value

    return EnrichmentMergeResult(
        field_updates=field_updates,
        provenance_updates=provenance_updates,
        manual_fields_preserved=manual_preserved,
    )
