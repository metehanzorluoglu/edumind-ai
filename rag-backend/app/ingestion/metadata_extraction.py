"""Structured-text metadata extraction: a best-effort second pass over a
loaded document's first page(s) of text, used by
app/ingestion/loaders/dispatch.py to fill in whatever a format's embedded
metadata (PDF/DOCX properties, HTML meta tags) didn't already provide.

Every heuristic here is deliberately conservative — a field this system
can't infer with reasonable confidence is left None/empty rather than
guessed (never fabricate missing metadata). In particular:

- Title/author/venue detection only ever looks at the first `max_pages`
  pages (see extract_from_pages) — scanning the whole document risks
  picking up a references section's "titles" or author names instead of
  the actual title page's.
- Author detection only starts scanning immediately after a detected
  title line, and gives up (returns no authors) at the first line that
  doesn't look like a name list — it never scans deep into the document
  looking for something that might be a byline.
- Publication year is only taken from a clear bibliographic context (a
  copyright/received/published marker, or a lone parenthesized year) —
  never an arbitrary 4-digit number that happens to appear.
"""

import re
from dataclasses import dataclass
from datetime import UTC, date, datetime
from pathlib import Path

from app.ingestion.loaders.base import ExtractedMetadata, ExtractionSource, PageContent

DOI_PATTERN = re.compile(r"10\.\d{4,9}/[^\s\"'<>]+")
_DOI_TRAILING_PUNCTUATION = ".,;:)]}>\"'"
_DOI_SHAPE = re.compile(r"10\.\d{4,9}/\S+")

_MIN_PLAUSIBLE_YEAR = 1900


def _max_plausible_year() -> int:
    return datetime.now(UTC).year + 1


# A proper "Journal Name (YYYY) Volume:StartPage-EndPage" citation banner -
# the shape Springer/many other journals print at the top of an article's
# first page. When present, its year is the issue/volume publication year
# and always outranks a "Published online"/"Accepted"/copyright date
# elsewhere on the page (see extract_publication_year) - those dates can
# legitimately predate the issue itself (an article is often available
# online months before its formal issue/volume/page assignment).
# Plain hyphen plus every dash-like unicode character a page range might
# use (hyphen, non-breaking hyphen, figure dash, en dash, em dash,
# horizontal bar) - written as \u escapes rather than literal characters so
# the source file itself stays plain ASCII.
_PAGE_RANGE_DASH_CLASS = "\\-\u2010\u2011\u2012\u2013\u2014\u2015"
_JOURNAL_CITATION_PATTERN = re.compile(
    r"^(?P<journal>[A-Z][^()\n]{3,150}?)\s*\((?P<year>(?:19|20)\d{2})\)\s*"
    r"(?P<volume>\d+)\s*:\s*(?P<page_start>\d+)\s*["
    + _PAGE_RANGE_DASH_CLASS
    + r"]\s*(?P<page_end>\d+)\s*$"
)
_PUBLISHED_ONLINE_PATTERN = re.compile(
    r"published\s+online\s*:?\s*(?P<date>\d{1,2}\s+\w+\s+(?:19|20)\d{2})", re.IGNORECASE
)
_ACCEPTED_DATE_PATTERN = re.compile(
    r"accepted\s*:?\s*(?P<date>\d{1,2}\s+\w+\s+(?:19|20)\d{2})", re.IGNORECASE
)
_ARTICLE_LABEL_PATTERN = re.compile(
    r"^(article|research\s+article|original\s+paper|original\s+article|review\s+article)$",
    re.IGNORECASE,
)
_DATE_MARKER_LINE_PATTERN = re.compile(
    r"^/?\s*(published\s+online|received|revised|accepted)\b", re.IGNORECASE
)
_COPYRIGHT_LINE_PATTERN = re.compile(r"^[©]|^\(c\)\s", re.IGNORECASE)
_ABSTRACT_HEADING_PATTERN = re.compile(r"^abstract\.?$", re.IGNORECASE)
_KEYWORDS_LINE_PATTERN = re.compile(r"^keywords\b", re.IGNORECASE)
_DOI_LINE_PATTERN = re.compile(r"doi\.org|^10\.\d{4,9}/", re.IGNORECASE)

_YEAR_CONTEXT_PATTERN = re.compile(
    r"(?:©|\(c\)|copyright|published|received|accepted|revised)\D{0,20}((?:19|20)\d{2})",
    re.IGNORECASE,
)
_YEAR_PARENS_PATTERN = re.compile(r"\(((?:19|20)\d{2})\)")
_YEAR_ANYWHERE_PATTERN = re.compile(r"((?:19|20)\d{2})")

_FIGURE_TABLE_PATTERN = re.compile(r"^(figure|fig\.|table|chart)\s*\d*\b", re.IGNORECASE)
_PAGE_NUMBER_PATTERN = re.compile(r"^(page\s*)?\d{1,4}$", re.IGNORECASE)
_RUNNING_HEADER_HINTS = ("issn", "isbn", "vol.", "volume", "no.", "www.", "http://", "https://")

_EMAIL_PATTERN = re.compile(r"\S+@\S+")
_AFFILIATION_HINTS = (
    "university",
    "department",
    "institute",
    "college",
    "school of",
    "faculty",
    "laboratory",
    "center for",
    "centre for",
)
_NAME_TOKEN_PATTERN = re.compile(r"^[A-Z][a-zA-Z'.-]*$")
_TRAILING_FOOTNOTE_DIGITS_PATTERN = re.compile(r"\d{1,2}$")
_VENUE_HINT_PATTERN = re.compile(
    r"\b(journal|proceedings|quarterly|review|bulletin|transactions|conference)\b", re.IGNORECASE
)
_AUTHOR_LIST_SEPARATOR_PATTERN = re.compile(r"·|,| and | & ")
_MAX_TITLE_CONTINUATION_LINES = 4

_MONTH_NAMES = {
    "january": 1,
    "february": 2,
    "march": 3,
    "april": 4,
    "may": 5,
    "june": 6,
    "july": 7,
    "august": 8,
    "september": 9,
    "october": 10,
    "november": 11,
    "december": 12,
}

_UPLOAD_SUFFIX_PATTERN = re.compile(
    r"[\s_-]*(\(\d+\)|\(copy\)|\(final\)|copy|final|draft|v\d+)\s*$", re.IGNORECASE
)


def normalize_doi(raw: str) -> str | None:
    """Strips a "doi:" prefix / doi.org URL wrapper and trailing
    punctuation, then validates the result against the same shape
    DocumentMetadata.doi requires (see app/ingestion/metadata_schema.py) —
    returns None rather than a value that would fail that validation."""
    candidate = raw.strip()
    candidate = re.sub(r"^(https?://)?(dx\.)?doi\.org/", "", candidate, flags=re.IGNORECASE)
    candidate = re.sub(r"^doi\s*:\s*", "", candidate, flags=re.IGNORECASE)
    candidate = candidate.rstrip(_DOI_TRAILING_PUNCTUATION)
    return candidate if _DOI_SHAPE.fullmatch(candidate) else None


def extract_doi(text: str) -> str | None:
    match = DOI_PATTERN.search(text)
    if not match:
        return None
    return normalize_doi(match.group(0))


def extract_year_from_date_string(raw: str) -> int | None:
    """For a date-ish string (e.g. HTML's citation_publication_date meta,
    which is often "2019/05/12", "2019-05", or just "2019")."""
    match = _YEAR_ANYWHERE_PATTERN.search(raw)
    if not match:
        return None
    year = int(match.group(1))
    return year if _MIN_PLAUSIBLE_YEAR <= year <= _max_plausible_year() else None


@dataclass(frozen=True)
class JournalCitation:
    """A parsed "Journal Name (YYYY) Volume:StartPage-EndPage" banner (see
    _JOURNAL_CITATION_PATTERN) — `raw` is the exact original line, used
    verbatim as `source_venue` (never reconstructed from the parsed
    pieces), so a venue with any formatting this parser doesn't fully
    understand is still stored faithfully even though the pieces below
    were understood well enough to extract."""

    raw: str
    journal_title: str
    year: int
    volume: str
    page_start: int
    page_end: int


def parse_journal_citation(lines: list[str]) -> JournalCitation | None:
    """Looks for one line shaped like a Springer/many-other-journals
    citation banner — e.g. "International Journal of Artificial
    Intelligence in Education (2023) 33:267-289" — and decomposes it.
    Returns None if no line matches (most documents, including every
    non-journal document type, simply won't have one)."""
    max_year = _max_plausible_year()
    for line in lines:
        stripped = line.strip()
        match = _JOURNAL_CITATION_PATTERN.match(stripped)
        if not match:
            continue
        year = int(match.group("year"))
        if not (_MIN_PLAUSIBLE_YEAR <= year <= max_year):
            continue
        return JournalCitation(
            raw=stripped,
            journal_title=match.group("journal").strip(),
            year=year,
            volume=match.group("volume"),
            page_start=int(match.group("page_start")),
            page_end=int(match.group("page_end")),
        )
    return None


def _parse_day_month_year(raw: str) -> date | None:
    """Parses a "18 July 2022"-shaped date string (the format both
    "Published online:" and "Accepted:" markers commonly use) — returns
    None for anything else rather than guessing at a different format."""
    match = re.match(r"(\d{1,2})\s+(\w+)\s+((?:19|20)\d{2})", raw.strip())
    if not match:
        return None
    day, month_name, year = match.groups()
    month = _MONTH_NAMES.get(month_name.lower())
    if month is None:
        return None
    try:
        return date(int(year), month, int(day))
    except ValueError:
        return None


def extract_online_publication_year(text: str) -> int | None:
    """The year from a "Published online: <date>" marker — kept as
    separate, optional detail (see ExtractedMetadata.online_publication_year)
    since it can legitimately predate the issue/volume year that
    extract_publication_year prefers for `publication_year` itself."""
    match = _PUBLISHED_ONLINE_PATTERN.search(text)
    if not match:
        return None
    parsed = _parse_day_month_year(match.group("date"))
    return parsed.year if parsed else None


def extract_accepted_date(text: str) -> date | None:
    """The date from an "Accepted: <date>" marker — kept as separate,
    optional detail (see ExtractedMetadata.accepted_date), never used for
    `publication_year` itself (see extract_publication_year)."""
    match = _ACCEPTED_DATE_PATTERN.search(text)
    if not match:
        return None
    return _parse_day_month_year(match.group("date"))


def extract_publication_year(text: str) -> int | None:
    """Only from a clear bibliographic marker (copyright/received/
    published/accepted, or a lone parenthesized year like "(2019)") — a
    bare four-digit number elsewhere in the text (a page count, an ISBN
    fragment, a phone number) is deliberately never treated as a year.

    A recognized journal issue/volume citation banner (see
    parse_journal_citation) always wins first, ahead of every other
    marker: a "Published online"/"Accepted"/copyright date can legitimately
    predate the issue the article was actually published in (a paper is
    often available online months before its formal volume/page
    assignment), so blindly taking the first date-shaped marker in reading
    order — which is usually the online-first date, since it's printed
    above the title — would silently prefer the wrong year."""
    citation = parse_journal_citation(text.splitlines())
    if citation is not None:
        return citation.year

    max_year = _max_plausible_year()
    for pattern in (_YEAR_CONTEXT_PATTERN, _YEAR_PARENS_PATTERN):
        match = pattern.search(text)
        if match:
            year = int(match.group(1))
            if _MIN_PLAUSIBLE_YEAR <= year <= max_year:
                return year
    return None


_BARE_SECTION_HEADING_WORDS = frozenset(
    {
        "abstract",
        "keywords",
        "introduction",
        "references",
        "bibliography",
        "acknowledgments",
        "acknowledgements",
        "contents",
        "table of contents",
        "conclusion",
        "conclusions",
        "discussion",
        "methods",
        "methodology",
        "results",
        "article",
    }
)


def is_plausible_title(candidate: str) -> bool:
    """True unless `candidate` looks like a figure/table caption, a
    running header, a bare page number, a bare section-heading word
    ("Abstract", "Keywords", ...), a recognized journal issue/volume
    citation banner (see parse_journal_citation), a "Published online"/
    "Accepted"/"Received"/"Revised" date marker, a copyright line, a DOI
    URL, or an affiliation/corresponding-author contact line (an email
    address, or an institution name) — used both to validate a
    structured-text title candidate and to sanity-check an *embedded*
    title (some PDF/DOCX exporters leave the original filename or
    "Untitled" as the embedded title property). This is defense in depth:
    the primary defense against picking one of these up as a title is
    _strip_front_matter_noise (used by
    extract_title_and_authors_from_front_matter); this function is what
    the simpler, single-line extract_title_from_lines fallback relies on
    when a document doesn't match that more structured front-matter
    shape."""
    stripped = candidate.strip()
    if not (8 <= len(stripped) <= 220):
        return False
    if _FIGURE_TABLE_PATTERN.match(stripped):
        return False
    if _PAGE_NUMBER_PATTERN.match(stripped):
        return False
    if stripped.rstrip(".:").lower() in _BARE_SECTION_HEADING_WORDS:
        return False
    if _JOURNAL_CITATION_PATTERN.match(stripped):
        return False
    if _DATE_MARKER_LINE_PATTERN.match(stripped):
        return False
    if _COPYRIGHT_LINE_PATTERN.match(stripped):
        return False
    if _DOI_LINE_PATTERN.search(stripped):
        return False
    if _looks_like_affiliation_or_contact(stripped):
        return False
    lower = stripped.lower()
    if any(hint in lower for hint in _RUNNING_HEADER_HINTS):
        return False
    # A short, fully-uppercase line reads as a running header/journal
    # banner ("JOURNAL OF EDUCATION RESEARCH VOL. 3"), not a real title —
    # genuine titles are rarely written fully in caps.
    return not (stripped.isupper() and len(stripped) < 80)


def extract_title_from_lines(lines: list[str]) -> str | None:
    for line in lines:
        stripped = line.strip()
        if stripped and is_plausible_title(stripped):
            return stripped
    return None


def _looks_like_affiliation_or_contact(line: str) -> bool:
    if _EMAIL_PATTERN.search(line):
        return True
    lower = line.lower()
    return any(hint in lower for hint in _AFFILIATION_HINTS)


def _looks_like_name_list(line: str) -> bool:
    """A byline is short, isn't a full sentence (no terminal period apart
    from a mid-name initial like "J."), and every comma/"and"-separated
    segment reads as "First Last" / "First M. Last" rather than prose."""
    stripped = line.strip()
    if not stripped or len(stripped) > 200:
        return False
    if stripped.endswith((".", ":", ";")) and not re.search(r"\b[A-Z]\.$", stripped):
        return False
    segments = [s.strip() for s in re.split(r",| and | & ", stripped) if s.strip()]
    if not segments:
        return False
    for segment in segments:
        words = segment.split()
        if not (1 <= len(words) <= 4):
            return False
        if not all(_NAME_TOKEN_PATTERN.match(word.rstrip(".,")) for word in words):
            return False
    return True


def normalize_author_name(raw: str) -> str:
    # Some PDFs (Springer/IJAIED among them) join a byline's words with a
    # non-breaking space rather than a plain one — collapse every run of
    # whitespace (of whatever kind) to a single regular space before
    # anything else, so a name never comes out with an invisible-looking
    # NBSP embedded in it.
    name = re.sub(r"\s+", " ", raw).strip()
    name = _EMAIL_PATTERN.sub("", name).strip()
    name = re.sub(r"\s*\d+\s*$", "", name)  # trailing footnote/affiliation-marker digit
    return name.strip(" ,;")


def extract_authors_from_lines(lines: list[str], title: str | None) -> list[str]:
    """Only ever looks at the lines immediately following a detected
    title, and stops at the first line that doesn't look like a name
    list — this is what keeps it from ever mistaking a references
    section's author names (which appear much later, in a very different
    context) for the document's own byline. Returns [] (never invents
    something) if there's no title to anchor the search from, or if no
    plausible byline immediately follows it."""
    if title is None:
        return []
    started = False
    for line in lines:
        stripped = line.strip()
        if not stripped:
            continue
        if not started:
            if stripped == title:
                started = True
            continue
        if _looks_like_affiliation_or_contact(stripped):
            continue
        if _looks_like_name_list(stripped):
            segments = [s.strip() for s in re.split(r",| and | & ", stripped) if s.strip()]
            return [normalize_author_name(s) for s in segments]
        return []
    return []


def _strip_trailing_footnote_digits(word: str) -> str:
    """A name directly followed by a 1-2 digit affiliation/footnote marker
    (a superscript in the original document, flattened to a plain trailing
    digit by text extraction — e.g. "Ottenbreit-Leftwich1") still counts as
    a name token for byline-shape detection — this strips exactly that
    marker, provided what's left still starts with an uppercase letter (so
    a token that's genuinely just digits is left alone)."""
    match = _TRAILING_FOOTNOTE_DIGITS_PATTERN.search(word)
    if not match:
        return word
    remainder = word[: match.start()]
    return remainder if remainder[:1].isupper() else word


def _looks_like_academic_byline_line(line: str) -> bool:
    """Like _looks_like_name_list, but also accepts "·"-separated author
    lists (the shape many journals — Springer/IJAIED among them — print,
    often across several physical lines) where each name may carry a
    direct-appended 1-2 digit affiliation-footnote marker (see
    _strip_trailing_footnote_digits). Used only by
    extract_title_and_authors_from_front_matter below."""
    stripped = line.strip()
    if not stripped or len(stripped) > 200:
        return False
    segments = [s.strip() for s in _AUTHOR_LIST_SEPARATOR_PATTERN.split(stripped) if s.strip()]
    if not segments:
        return False
    for segment in segments:
        words = segment.split()
        if not (1 <= len(words) <= 4):
            return False
        if not all(
            _NAME_TOKEN_PATTERN.match(_strip_trailing_footnote_digits(word.rstrip(".,")))
            for word in words
        ):
            return False
    return True


def _strip_front_matter_noise(lines: list[str]) -> list[str]:
    """Removes running headers, the journal issue/volume citation banner,
    section labels ("ARTICLE"), the DOI URL line, date markers
    ("Published online:"/"Accepted:"/"Received:"/"Revised:"), the
    copyright line, and the Abstract heading *and its body paragraph*, and
    the Keywords line *and its own wrapped continuation* (both bodies run
    until the next recognized marker) — everything that can appear
    *before* the actual title on a real journal's first page (see
    extract_title_and_authors_from_front_matter). What's left is, in
    practice, just the title, the author byline, and the affiliation/
    contact block that follows it.

    A keywords list is exactly as prone to wrapping across physical lines
    as the abstract paragraph is (e.g. "Keywords K-12 AI education · AI
    Ethics · ... · Teacher co-" / "design") — without tracking that as its
    own skip-state the wrapped continuation ("design") would leak through
    as a real candidate line, get rejected as too short to be a title
    (correctly), and abort front-matter detection entirely before it ever
    reaches the real title further down the page."""
    kept: list[str] = []
    in_abstract_body = False
    in_keywords_body = False
    for raw_line in lines:
        stripped = raw_line.strip()
        if not stripped:
            continue
        if _ABSTRACT_HEADING_PATTERN.match(stripped):
            in_abstract_body = True
            continue
        is_noise = (
            _JOURNAL_CITATION_PATTERN.match(stripped) is not None
            or _ARTICLE_LABEL_PATTERN.match(stripped) is not None
            or _DATE_MARKER_LINE_PATTERN.match(stripped) is not None
            or _COPYRIGHT_LINE_PATTERN.match(stripped) is not None
            or _DOI_LINE_PATTERN.search(stripped) is not None
        )
        is_keywords_heading = _KEYWORDS_LINE_PATTERN.match(stripped) is not None
        if in_abstract_body:
            if is_keywords_heading:
                in_abstract_body = False
                in_keywords_body = True
            elif is_noise:
                in_abstract_body = False
            continue
        if in_keywords_body:
            if is_noise:
                in_keywords_body = False
                continue
            continue  # still the keywords line's own wrapped continuation
        if is_keywords_heading:
            in_keywords_body = True
            continue
        if is_noise:
            continue
        kept.append(stripped)
    return kept


def extract_title_and_authors_from_front_matter(
    lines: list[str],
) -> tuple[str, list[str]] | None:
    """A second, more structured title/author heuristic for a real journal
    article's first page, where the title can be preceded by a running
    header, a journal issue/volume citation banner, an "ARTICLE" label,
    the DOI, the abstract, keywords, an "Accepted:" date, and a copyright
    line — in that order, all *before* the title itself — and can wrap
    across more than one physical line, with the author byline
    immediately following it (see _strip_front_matter_noise).

    Returns None (the caller falls back to the simpler
    extract_title_from_lines / extract_authors_from_lines pair) if, after
    stripping that noise, the first remaining line still isn't a plausible
    title, or nothing byline-shaped immediately follows the title — i.e.
    this simply isn't that kind of document."""
    candidates = _strip_front_matter_noise(lines)
    if not candidates or not is_plausible_title(candidates[0]):
        return None

    title_lines = [candidates[0]]
    index = 1
    while (
        index < len(candidates)
        and index < _MAX_TITLE_CONTINUATION_LINES
        and not _looks_like_academic_byline_line(candidates[index])
    ):
        title_lines.append(candidates[index])
        index += 1

    if index >= len(candidates) or not _looks_like_academic_byline_line(candidates[index]):
        return None  # no byline immediately follows -> not this shape after all

    byline_lines: list[str] = []
    while index < len(candidates) and _looks_like_academic_byline_line(candidates[index]):
        next_line = candidates[index + 1] if index + 1 < len(candidates) else None
        if next_line is not None and _looks_like_affiliation_or_contact(next_line):
            # `candidates[index]` is itself a "corresponding author" contact
            # callout — a single name repeated from the byline above,
            # immediately followed by an email/affiliation line — not a
            # continuation of the author list. That name is already
            # captured above, so don't add it again, and the author block
            # ends here rather than fusing it into the next line's tokens.
            break
        byline_lines.append(candidates[index])
        index += 1

    byline_blob = " ".join(byline_lines)
    segments = [s.strip() for s in _AUTHOR_LIST_SEPARATOR_PATTERN.split(byline_blob) if s.strip()]
    authors = [normalize_author_name(s) for s in segments]

    title = re.sub(r"\s+", " ", " ".join(title_lines)).strip()
    return title, authors


def extract_venue_from_lines(lines: list[str]) -> str | None:
    for line in lines:
        stripped = line.strip()
        if stripped and len(stripped) <= 160 and _VENUE_HINT_PATTERN.search(stripped):
            return stripped
    return None


def extract_abstract_from_lines(lines: list[str], *, max_chars: int = 2000) -> str | None:
    for index, line in enumerate(lines):
        if line.strip().lower().rstrip(":") != "abstract":
            continue
        collected: list[str] = []
        for candidate in lines[index + 1 : index + 15]:
            stripped = candidate.strip()
            if not stripped:
                if collected:
                    break
                continue
            if stripped.lower().rstrip(":") in ("keywords", "introduction", "1. introduction"):
                break
            collected.append(stripped)
        text = " ".join(collected).strip()
        return text[:max_chars] or None
    return None


def extract_keywords_from_lines(lines: list[str]) -> list[str]:
    for line in lines:
        stripped = line.strip()
        if not stripped.lower().startswith("keywords"):
            continue
        _prefix, _sep, rest = stripped.partition(":")
        if not _sep:
            rest = stripped[len("keywords") :]
        return [part.strip() for part in re.split(r"[;,]", rest) if part.strip()]
    return []


def detect_language(text: str) -> str | None:
    """A coarse heuristic, not a real language-identification model:
    flags "probably English" when a healthy fraction of common English
    function words are present, else None (unclassified) — good enough
    for an informational UI hint, never used to make an ingestion
    decision."""
    sample = text[:2000].lower()
    words = re.findall(r"[a-z']+", sample)
    if len(words) < 20:
        return None
    common = {"the", "and", "of", "to", "in", "is", "for", "on", "with", "that", "this"}
    hits = sum(1 for word in words if word in common)
    return "en" if hits / len(words) > 0.08 else None


def extract_from_pages(pages: list[PageContent], *, max_pages: int = 2) -> ExtractedMetadata:
    """Runs every heuristic above against the first `max_pages` pages
    only (see module docstring for why). Only ever produces
    ExtractionSource.STRUCTURED_TEXT-labeled fields — merging this with
    a format's own embedded-metadata pass is app/ingestion/loaders/dispatch.py's
    job, not this function's."""
    sample_pages = pages[:max_pages]
    combined_text = "\n".join(page.text for page in sample_pages)
    lines = [line for page in sample_pages for line in page.text.splitlines()]

    # The front-matter heuristic (real journal first pages: running header,
    # citation banner, ARTICLE label, DOI, abstract, keywords, dates,
    # copyright — all *before* a possibly-wrapped title and its byline)
    # takes priority when it recognizes that shape; otherwise fall back to
    # the simpler "first plausible line, then whatever byline immediately
    # follows it" pair, unchanged from before.
    front_matter = extract_title_and_authors_from_front_matter(lines)
    title: str | None
    authors: list[str]
    if front_matter is not None:
        title, authors = front_matter
    else:
        title = extract_title_from_lines(lines)
        authors = extract_authors_from_lines(lines, title)

    venue = extract_venue_from_lines(lines)
    doi = extract_doi(combined_text)
    publication_year = extract_publication_year(combined_text)
    abstract = extract_abstract_from_lines(lines)
    keywords = extract_keywords_from_lines(lines)
    language = detect_language(combined_text)

    citation = parse_journal_citation(lines)
    online_publication_year = extract_online_publication_year(combined_text)
    accepted_date = extract_accepted_date(combined_text)

    # A DOI is a globally resolvable, unique identifier for the document —
    # https://doi.org/{doi} is *always* a valid, working link once the DOI
    # itself has been validated (see normalize_doi), so it's always safe to
    # derive as source_url when nothing more specific (e.g. an HTML page's
    # own og:url/canonical link) already provided one.
    source_url = f"https://doi.org/{doi}" if doi else None

    sources: dict[str, ExtractionSource] = {}
    if title:
        sources["title"] = ExtractionSource.STRUCTURED_TEXT
    if authors:
        sources["authors"] = ExtractionSource.STRUCTURED_TEXT
    if venue:
        sources["source_venue"] = ExtractionSource.STRUCTURED_TEXT
    if doi:
        sources["doi"] = ExtractionSource.STRUCTURED_TEXT
    if source_url:
        sources["source_url"] = ExtractionSource.STRUCTURED_TEXT
    if publication_year:
        sources["publication_year"] = ExtractionSource.STRUCTURED_TEXT

    return ExtractedMetadata(
        title=title,
        authors=authors,
        publication_year=publication_year,
        source_venue=venue,
        doi=doi,
        source_url=source_url,
        abstract=abstract,
        keywords=keywords,
        language=language,
        journal_title=citation.journal_title if citation else None,
        volume=citation.volume if citation else None,
        page_start=citation.page_start if citation else None,
        page_end=citation.page_end if citation else None,
        online_publication_year=online_publication_year,
        accepted_date=accepted_date,
        sources=sources,
    )


def merge_extracted_metadata(
    primary: ExtractedMetadata, fallback: ExtractedMetadata
) -> ExtractedMetadata:
    """Fills any field `primary` left empty with `fallback`'s value.
    `primary`'s own fields — and their source labels — always win when
    present; `fallback` (typically the structured-text pass) only ever
    fills a genuine gap, never overwrites something embedded metadata (or
    the user, further up the call chain) already provided.

    `authors` is the one exception to "primary always wins when present":
    some PDF/DOCX exporters only ever populate the embedded Author
    property with a single name (often just the corresponding author),
    which is a real but *incomplete* value — the full first-page author
    block a structured-text pass can find is more complete information,
    not a fallback for a gap, so it wins whenever it lists strictly more
    authors than the embedded pass did."""
    merged_authors = (
        primary.authors if len(primary.authors) >= len(fallback.authors) else fallback.authors
    )
    fallback_authors_won = merged_authors is fallback.authors and merged_authors != primary.authors

    merged_sources = dict(fallback.sources)
    merged_sources.update(primary.sources)  # primary's labels win on overlap
    if fallback_authors_won:
        # The label must reflect which list actually won — otherwise a
        # reviewing user would be told "embedded_metadata" for a value that
        # came from the structured-text pass instead.
        if "authors" in fallback.sources:
            merged_sources["authors"] = fallback.sources["authors"]
        else:
            merged_sources.pop("authors", None)

    return ExtractedMetadata(
        title=primary.title or fallback.title,
        authors=merged_authors,
        publication_year=(
            primary.publication_year
            if primary.publication_year is not None
            else fallback.publication_year
        ),
        source_venue=primary.source_venue or fallback.source_venue,
        doi=primary.doi or fallback.doi,
        source_url=primary.source_url or fallback.source_url,
        abstract=primary.abstract or fallback.abstract,
        language=primary.language or fallback.language,
        keywords=primary.keywords or fallback.keywords,
        journal_title=primary.journal_title or fallback.journal_title,
        volume=primary.volume or fallback.volume,
        page_start=primary.page_start if primary.page_start is not None else fallback.page_start,
        page_end=primary.page_end if primary.page_end is not None else fallback.page_end,
        online_publication_year=(
            primary.online_publication_year
            if primary.online_publication_year is not None
            else fallback.online_publication_year
        ),
        accepted_date=primary.accepted_date or fallback.accepted_date,
        sources=merged_sources,
    )


def apply_filename_fallback(metadata: ExtractedMetadata, *, filename: str) -> ExtractedMetadata:
    """The lowest-priority step in the merge order (user > embedded >
    structured-text > filename): only ever touches `title`, and only when
    nothing else produced one. Used by POST /documents/metadata-preview,
    which — unlike ingest_document() — has no separate "temp path vs.
    original filename" distinction to worry about, since it's handed the
    real uploaded filename directly."""
    if metadata.title:
        return metadata
    cleaned = clean_filename_as_title(filename)
    if not cleaned:
        return metadata
    updated_sources = {**metadata.sources, "title": ExtractionSource.FILENAME}
    return metadata.model_copy(update={"title": cleaned, "sources": updated_sources})


def split_author_string(raw: str) -> list[str]:
    """Splits an embedded-metadata author field (e.g. a PDF/DOCX
    "author" property) on unambiguous multi-author separators only (";",
    "&", " and ") — deliberately *not* on a bare comma, since a single
    "Last, First" name is at least as common a shape for this field as
    genuinely comma-separated multiple authors, and splitting the former
    would fabricate two garbage authors out of one real name."""
    parts = re.split(r";| & | and ", raw)
    return [normalize_author_name(part) for part in parts if part.strip()]


def clean_filename_as_title(filename: str) -> str | None:
    """The lowest-priority title fallback (see ingest.py's merge order):
    strips the extension, repeatedly strips obvious upload suffixes
    ("_final", " (1)", "-copy", "v2", ...), then turns underscores/hyphens
    into spaces and collapses repeated whitespace."""
    stem = Path(filename).stem
    current = stem
    while True:
        stripped = _UPLOAD_SUFFIX_PATTERN.sub("", current).strip()
        if stripped == current:
            break
        current = stripped
    cleaned = current.replace("_", " ").replace("-", " ")
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned or None


_CONFIDENCE_BY_SOURCE = {
    ExtractionSource.USER: "high",
    ExtractionSource.EMBEDDED_METADATA: "high",
    ExtractionSource.STRUCTURED_TEXT: "medium",
    ExtractionSource.FILENAME: "low",
}


def confidence_for_source(source: ExtractionSource) -> str:
    """A coarse, informational-only confidence label for the metadata
    preview UI — never used to make an ingestion decision, only to hint to
    a reviewing user which fields are most worth double-checking."""
    return _CONFIDENCE_BY_SOURCE[source]
