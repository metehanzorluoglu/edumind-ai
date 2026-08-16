"""Milestone 4.2 (Citation & BibTeX Foundation) Sections 15/16 — stable,
deterministic citation key generation.

Format: FirstAuthorFamily + Year + SignificantTitleWord (e.g.
"Forrester2004Laser"), the conventional BibTeX-key shape most reference
managers (Zotero, JabRef) default to — chosen for familiarity, not
invented here. Never a random UUID (Section 15: "do not use random UUIDs
as citation keys") — every input is deterministic so the SAME metadata
always produces the SAME key, which is what makes stability (Section 16)
possible at all: app/db/documents_repository.py's
get_or_create_citation_key() calls this ONCE per document and persists the
result (Document.citation_key), so a future metadata edit never silently
regenerates/changes a key a user may have already pasted into a
manuscript — see that function's own docstring.
"""

from __future__ import annotations

import re
import unicodedata

from app.core.citation_item import CitationItem

#: A short, conservative English stopword list — enough to skip past
#: "The"/"A"/"An"/"On"/"Of" etc. to the first word that actually carries
#: meaning, without pretending to be a real NLP stopword list. Only used
#: to pick a nicer significant word; if every title word happens to be a
#: stopword (or the title has no usable word at all) the title segment is
#: simply omitted (see _significant_title_word) — never a reason to fail.
_STOPWORDS = {
    "a",
    "an",
    "the",
    "of",
    "on",
    "in",
    "at",
    "to",
    "for",
    "and",
    "or",
    "with",
    "from",
    "into",
    "using",
    "toward",
    "towards",
    "about",
}

_NON_ALNUM_RE = re.compile(r"[^A-Za-z0-9]+")


def _asciify(text: str) -> str:
    """Best-effort transliteration to plain ASCII letters/digits (e.g.
    "Müller" -> "Muller") — BibTeX keys are conventionally safe, portable
    ASCII identifiers (Section 15: "safe characters"); this never changes
    the AUTHOR'S NAME as displayed anywhere else in the product (citation
    text, BibTeX `author` field, the UI) — only this one derived
    identifier."""
    decomposed = unicodedata.normalize("NFKD", text)
    without_marks = "".join(ch for ch in decomposed if not unicodedata.combining(ch))
    return _NON_ALNUM_RE.sub("", without_marks)


def _first_author_segment(item: CitationItem) -> str:
    if not item.authors:
        return "Unknown"
    first = item.authors[0]
    name = first.family or first.literal or ""
    # An organizational/literal author contributes its first word only
    # (e.g. "World Health Organization" -> "World"), not the whole phrase
    # — keeps the key short and readable (Section 15: "readable") the same
    # way a personal family name alone would.
    first_word = name.split()[0] if name.split() else name
    ascii_word = _asciify(first_word)
    return ascii_word or "Unknown"


def _significant_title_word(title: str | None) -> str:
    if not title:
        return ""
    for word in re.findall(r"[A-Za-z][A-Za-z'-]*", title):
        if len(word) <= 3:
            continue
        if word.lower() in _STOPWORDS:
            continue
        ascii_word = _asciify(word)
        if ascii_word:
            return ascii_word[:1].upper() + ascii_word[1:]
    return ""


def base_citation_key(item: CitationItem) -> str:
    """The deterministic key BEFORE collision-suffix resolution — pure
    function of the item's own metadata, safe to call as many times as
    needed for the same input (see get_or_create_citation_key, which calls
    this once and persists the result)."""
    author_segment = _first_author_segment(item)
    year_segment = str(item.issued_year) if item.issued_year is not None else ""
    title_segment = _significant_title_word(item.title)
    key = f"{author_segment}{year_segment}{title_segment}"
    # Degenerate case: no author, no year, no usable title word (e.g. a
    # document with only a filename-derived title of all short/stopword
    # tokens). Falls back to the document id's own already-unique,
    # already-safe characters rather than fabricating a fake author/title
    # — still fully deterministic.
    if key == "Unknown":
        safe_id = _NON_ALNUM_RE.sub("", item.document_id) or "Reference"
        key = f"Unknown{safe_id[:8]}"
    return key


def resolve_citation_key(base_key: str, existing_keys: set[str]) -> str:
    """Milestone 4.2 Section 15 — deterministic collision suffix:
    "Forrester2004Laser", "Forrester2004Laser2", "Forrester2004Laser3", ...
    (never a random suffix). `existing_keys` is every OTHER document's
    already-assigned key this key must stay unique against — the caller
    decides scope (per-user for persisted keys — see
    DocumentsRepository.get_or_create_citation_key; the full selected set
    for one multi-export — see bibtex.py's export functions)."""
    if base_key not in existing_keys:
        return base_key
    suffix = 2
    while f"{base_key}{suffix}" in existing_keys:
        suffix += 1
    return f"{base_key}{suffix}"
