"""Milestone 4.2 (Citation & BibTeX Foundation) Section 2 — the citation
formatter: CitationItem -> deterministic APA 7 / IEEE formatted text.

Engine choice (Section 2: "prefer a deterministic standards-based citation
engine... evaluate a maintained citation/CSL library rather than
implementing APA/IEEE punctuation manually"): `citeproc-py`, driven by the
UNMODIFIED official CSL style files vendored in app/core/csl_styles/ (see
that directory's README) — the same style definitions Zotero/Mendeley/
every other CSL-aware tool uses. This is what makes adding a third style
later "essentially free" (Section 5): drop in another .csl file and add
one line to `_STYLE_FILES` below, no formatting code to write.

Known, narrow citeproc-py/CSL rendering artifact this module corrects: APA
7's name-list template ends a period-terminated initial (e.g. "Doe, J.")
immediately followed by the sentence-ending period after the year
parenthetical, producing "Doe, J.. (2020)." — a real citeproc-py output,
confirmed against the vendored apa.csl, not a bug in our mapping. Fixed by
collapsing exactly two consecutive periods to one (`_collapse_double_period`
below) — deliberately NOT a blanket "collapse 2+ periods" rule, since APA's
own 21+-author truncation legitimately renders a single Unicode ellipsis
character ("…", U+2026), never three ASCII periods, so there is nothing
else in real output this could accidentally corrupt.
"""

from __future__ import annotations

import re
import threading
from pathlib import Path
from typing import Literal

from citeproc import Citation, CitationStylesBibliography, CitationStylesStyle, formatter
from citeproc import CitationItem as CiteprocCitationItem
from citeproc.source.json import CiteProcJSON

from app.core.citation_authors import ParsedAuthor
from app.core.citation_item import CitationItem

CitationStyle = Literal["apa7", "ieee"]

_STYLES_DIR = Path(__file__).parent / "csl_styles"
_LOCALE_PATH = _STYLES_DIR / "locales-en-US.xml"
_STYLE_FILES: dict[CitationStyle, Path] = {
    "apa7": _STYLES_DIR / "apa.csl",
    "ieee": _STYLES_DIR / "ieee.csl",
}

#: Human-readable labels — used only for error messages here; the
#: frontend has its own copy for UI labels (Section 6's small style
#: selector), kept separate on purpose since this backend module has no
#: business dictating frontend copy.
_STYLE_LABELS: dict[CitationStyle, str] = {"apa7": "APA 7", "ieee": "IEEE"}

# citeproc-py parses each .csl/.xml file once per CitationStylesStyle
# instantiation; parsing is cheap (~3ms even for apa.csl — measured) but
# there is no reason to repeat it on every single request. A style object
# is stateless/immutable once built (only CitationStylesBibliography,
# built fresh per request below, carries per-call registration state), so
# a process-wide cache is safe across concurrent requests.
_style_cache: dict[CitationStyle, CitationStylesStyle] = {}
_style_cache_lock = threading.Lock()

_DOUBLE_PERIOD_RE = re.compile(r"(?<!\.)\.\.(?!\.)")
_DOUBLE_SPACE_RE = re.compile(r" {2,}")


def _collapse_double_period(text: str) -> str:
    """See module docstring. `(?<!\\.)` / `(?!\\.)` guards make this touch
    only an exact run of two periods, never three-or-more (the legitimate
    "…" ellipsis is a single Unicode character and is never affected
    either way — this regex only ever looks at literal '.' characters)."""
    return _DOUBLE_PERIOD_RE.sub(".", text)


def _collapse_double_space(text: str) -> str:
    """A second narrow, safe cleanup: IEEE's conference-paper/book-chapter
    templates render a now-empty editor slot as a bare space (e.g. "in
    Proceedings of ACL,  2019" — Document has no editor field at all, so
    this slot is always empty here), leaving two consecutive spaces.
    Collapsing any run of 2+ spaces to one never removes real content —
    no CSL style legitimately renders intentional multi-space runs — so
    this is a pure formatting cleanup, not a content change."""
    return _DOUBLE_SPACE_RE.sub(" ", text)


def _get_style(style: CitationStyle) -> CitationStylesStyle:
    if style not in _STYLE_FILES:
        raise ValueError(f"Unsupported citation style: {style!r}")
    with _style_cache_lock:
        cached = _style_cache.get(style)
        if cached is not None:
            return cached
        built = CitationStylesStyle(
            str(_STYLE_FILES[style]), locale=str(_LOCALE_PATH), validate=False
        )
        _style_cache[style] = built
        return built


def _author_to_csl(author: ParsedAuthor) -> dict[str, str]:
    if author.is_literal:
        assert author.literal is not None
        return {"literal": author.literal}
    csl_author: dict[str, str] = {}
    if author.family:
        csl_author["family"] = author.family
    if author.given:
        csl_author["given"] = author.given
    return csl_author


def citation_item_to_csl_json(item: CitationItem) -> dict[str, object]:
    """CitationItem -> the plain dict citeproc-py's CiteProcJSON source
    expects (CSL-JSON, https://citeproc-js.readthedocs.io/en/latest/csl-json/markup.html).
    Every field is omitted (never emitted as null/empty) when the
    underlying CitationItem field is None — Section 8: "if DOI missing,
    citation still works... do not show broken punctuation from absent
    fields" — an omitted CSL variable is exactly what makes citeproc-py's
    own style templates skip that piece cleanly (a conditional `<if
    variable="DOI">` in the style, not a blank string this code would have
    to reason about)."""
    data: dict[str, object] = {"id": item.id, "type": item.type}
    if item.title:
        data["title"] = item.title
    if item.authors:
        data["author"] = [_author_to_csl(a) for a in item.authors]
    if item.issued_year is not None:
        data["issued"] = {"date-parts": [[item.issued_year]]}
    if item.container_title:
        data["container-title"] = item.container_title
    if item.volume:
        data["volume"] = item.volume
    if item.issue:
        data["issue"] = item.issue
    if item.page:
        data["page"] = item.page
    if item.publisher:
        data["publisher"] = item.publisher
    if item.doi:
        data["DOI"] = item.doi
    if item.url:
        data["URL"] = item.url
    if item.language:
        data["language"] = item.language
    return data


def format_citation(item: CitationItem, style: CitationStyle) -> str:
    """The one function every citation-formatting caller (the per-document
    endpoint, and — indirectly, via the same CitationItem — future BibTeX/
    key generation) uses. Deterministic: the same CitationItem + style
    always produces the same string, no randomness, no network, no LLM
    (Section 35). Missing metadata degrades gracefully (Section 8) purely
    because citation_item_to_csl_json omits absent fields rather than
    emitting nulls citeproc-py's templates would otherwise have to guard
    against themselves."""
    csl_style = _get_style(style)
    data = citation_item_to_csl_json(item)
    source = CiteProcJSON([data])
    bibliography = CitationStylesBibliography(csl_style, source, formatter.plain)
    bibliography.register(Citation([CiteprocCitationItem(item.id)]))
    (formatted,) = bibliography.bibliography()
    return _collapse_double_space(_collapse_double_period(str(formatted)))


def style_label(style: CitationStyle) -> str:
    return _STYLE_LABELS.get(style, style)
