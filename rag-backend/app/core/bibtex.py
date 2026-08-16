"""Milestone 4.2 (Citation & BibTeX Foundation) Sections 11-14/21-23 —
deterministic BibTeX generation from CitationItem. No LLM, no external
service (Section 35) — pure string formatting from already-fetched,
ownership-scoped canonical metadata.

Hand-rolled rather than built on a BibTeX-writing library (Section 14:
"If implementing escaping manually, add extensive tests" — the sanctioned
fallback when a library isn't the obvious win): the actual entry shape
(type/key/`field = {value},` lines) is trivial, deterministic string
formatting with no real ambiguity to get wrong, and hand-rolling it keeps
this module's output entirely under our own control/tests rather than
subject to a third-party writer's own formatting opinions. Round-trip
validity is verified in tests/unit/core/test_bibtex.py using
`bibtexparser` (a real BibTeX parser, dev-only dependency — Section 33:
"parse exported .bib with a real BibTeX parser if a suitable dependency
exists") — a library IS used, just as the correctness check, not as the
generator.
"""

from __future__ import annotations

from dataclasses import dataclass

from app.core.citation_authors import ParsedAuthor
from app.core.citation_item import CitationItem
from app.core.citation_key import base_citation_key, resolve_citation_key

#: Milestone 4.2 Section 11 — conservative document_type -> (BibTeX entry
#: type, "venue" field name) mapping. A second, deliberately separate
#: table from citation_item.DOCUMENT_TYPE_TO_CSL: BibTeX and CSL type
#: vocabularies do not line up 1:1 (BibTeX has no "article-journal" vs
#: "article" distinction the way CSL does, and CSL has no "@techreport"
#: vs "@misc" split the way BibTeX does), so keeping one shared table
#: would force one of the two formats to use the other's compromises.
#: `venue_field` is None for types with no natural single "container"
#: field (book, thesis/report fallback, misc) — see
#: citation_item_to_bibtex_fields below for how each type's fields are
#: actually assembled.
_BIBTEX_TYPE_CONFIG: dict[str, tuple[str, str | None]] = {
    "journal_article": ("article", "journal"),
    "review_article": ("article", "journal"),
    "practitioner_article": ("article", "journal"),
    "conference_paper": ("inproceedings", "booktitle"),
    "book": ("book", None),
    "book_chapter": ("incollection", "booktitle"),
    # Section 11: "Do not guess thesis subtype if unknown" — Document has
    # no degree-level field anywhere in this codebase, so "truly known" is
    # never possible; @phdthesis/@mastersthesis are never used. @misc +
    # note={Thesis} is the safe generic mapping every plain-BibTeX
    # (non-biblatex) consumer can still parse without asserting a degree
    # this system was never told.
    "thesis_dissertation": ("misc", None),
    "report": ("techreport", None),
    "policy_document": ("techreport", None),
    "curriculum_document": ("misc", None),
    "other": ("misc", None),
    "unknown": ("misc", None),
}

#: Characters BibTeX/LaTeX treat specially, each mapped to its safe
#: escaped form. Applied via a single left-to-right character scan (see
#: escape_bibtex_value) rather than sequential str.replace() calls, which
#: would double-escape: replacing '\\' first with r'\textbackslash{}' and
#: THEN replacing '{'/'}' would corrupt the very escape sequence just
#: produced. A single scan never re-reads output it already emitted, so
#: this ordering hazard cannot occur.
_ESCAPE_MAP = {
    "&": r"\&",
    "%": r"\%",
    "$": r"\$",
    "#": r"\#",
    "_": r"\_",
    "{": r"\{",
    "}": r"\}",
    "~": r"\textasciitilde{}",
    "^": r"\textasciicircum{}",
    "\\": r"\textbackslash{}",
}


def escape_bibtex_value(value: str) -> str:
    """Escapes every LaTeX-special character in `value` for safe use
    inside a BibTeX `field = {...}` value. Unicode characters (accented
    author names, non-Latin titles) are passed through as-is — modern
    BibTeX/biber consumers expect UTF-8 source files (Section 33: "valid
    UTF-8"), and this codebase has no reason to emit legacy `\\'e`-style
    accent commands. Only the fixed set of ASCII LaTeX-special characters
    in _ESCAPE_MAP is ever rewritten."""
    return "".join(_ESCAPE_MAP.get(ch, ch) for ch in value)


def format_bibtex_authors(authors: list[ParsedAuthor]) -> str:
    """Milestone 4.2 Section 13 — "Author One and Author Two and
    Organization Name": BibTeX's own author-list delimiter is the literal
    word " and " between full names, each name already in "Family, Given"
    order (BibTeX parses that comma itself to tell family from given — the
    same convention format_bibtex_authors' own output must follow for a
    personal author). An organizational/literal author is wrapped in an
    EXTRA pair of braces (`{World Health Organization}`) — the standard
    BibTeX idiom that tells its name-parser "this whole string is one
    literal unit, do not try to split it into von/family/given parts,"
    preventing e.g. "World Health Organization" from being misread as
    given="World Health" family="Organization"."""
    parts: list[str] = []
    for author in authors:
        if author.is_literal:
            assert author.literal is not None
            parts.append("{" + escape_bibtex_value(author.literal) + "}")
        elif author.given:
            parts.append(
                f"{escape_bibtex_value(author.family or '')}, {escape_bibtex_value(author.given)}"
            )
        else:
            parts.append(escape_bibtex_value(author.family or ""))
    return " and ".join(p for p in parts if p)


def citation_item_to_bibtex_fields(item: CitationItem) -> tuple[str, dict[str, str]]:
    """Returns (bibtex_entry_type, ordered field dict) — Section 12's field
    mapping, skipping any field with no value (Section 12: "avoid
    exporting fields with null/empty values"). Deliberately excludes
    `abstract`/`keywords` even when present: Section 12 marks both
    "only if appropriate," and a full abstract block makes every exported
    entry far longer than what a researcher pasting a handful of
    references into a manuscript's .bib actually wants — same reasoning
    DetailsPanel.tsx already applies by never showing an abstract in the
    compact metadata view. Never includes any EduM8-internal field
    (document_id, ingestion timestamps, etc. — Section 12: "do not export
    internal EduM8 fields")."""
    entry_type, venue_field = _BIBTEX_TYPE_CONFIG.get(item.document_type_raw, ("misc", None))
    fields: dict[str, str] = {}

    if item.authors:
        fields["author"] = format_bibtex_authors(item.authors)
    if item.title:
        fields["title"] = escape_bibtex_value(item.title)
    if venue_field and item.container_title:
        fields[venue_field] = escape_bibtex_value(item.container_title)
    if item.issued_year is not None:
        fields["year"] = str(item.issued_year)
    if item.volume:
        fields["volume"] = escape_bibtex_value(item.volume)
    if item.issue:
        fields["number"] = escape_bibtex_value(item.issue)
    if item.page:
        # BibTeX convention: a page RANGE uses a double hyphen ("--"); a
        # single page/article-number (no hyphen already present in our own
        # page string — see citation_item._format_page_range) is left as-is.
        fields["pages"] = escape_bibtex_value(item.page.replace("-", "--", 1))
    if item.publisher:
        # @techreport's canonical field is "institution", not "publisher" —
        # every other type here uses "publisher" directly.
        field_name = "institution" if entry_type == "techreport" else "publisher"
        fields[field_name] = escape_bibtex_value(item.publisher)
    if item.doi:
        fields["doi"] = escape_bibtex_value(item.doi)
    if item.url:
        fields["url"] = escape_bibtex_value(item.url)
    if item.language:
        fields["language"] = escape_bibtex_value(item.language)
    if entry_type == "misc" and item.document_type_raw == "thesis_dissertation":
        fields["note"] = "Thesis"

    return entry_type, fields


def render_bibtex_entry(item: CitationItem, citation_key: str) -> str:
    """One complete, valid BibTeX entry — Section 18/19's "Copy BibTeX" /
    "Download BibTeX" both call this (for one document) via
    build_bibtex_entry below; export_bibtex (Section 21) calls it once per
    selected document and joins the results."""
    entry_type, fields = citation_item_to_bibtex_fields(item)
    lines = [f"@{entry_type}{{{citation_key},"]
    field_lines = [f"  {name} = {{{value}}}" for name, value in fields.items()]
    lines.append(",\n".join(field_lines))
    lines.append("}")
    return "\n".join(lines) + "\n"


@dataclass(frozen=True)
class BibtexEntry:
    """One rendered entry plus the citation_key it was rendered with —
    returned alongside the raw text so callers (routes_documents.py) can
    persist a freshly-generated key without re-deriving it."""

    document_id: str
    citation_key: str
    text: str


def build_bibtex_entry(item: CitationItem, *, existing_keys: set[str] | None = None) -> BibtexEntry:
    """Single-document BibTeX generation (Section 18/19). `existing_keys`
    lets a caller avoid colliding with keys already assigned to this
    user's OTHER documents even for a single-document request — pass the
    user's current full key set (persisted keys only skip regeneration;
    see DocumentsRepository.get_or_create_citation_key for the actual
    persist-once policy, Section 16)."""
    base_key = base_citation_key(item)
    key = resolve_citation_key(base_key, existing_keys or set())
    text = render_bibtex_entry(item, key)
    return BibtexEntry(document_id=item.document_id, citation_key=key, text=text)


def export_bibtex(items: list[tuple[CitationItem, str]]) -> str:
    """Milestone 4.2 Section 21/22/23 — multi-reference `.bib` export.
    `items` is (CitationItem, already-resolved citation_key) pairs — keys
    must already be unique within the set (routes_documents.py resolves
    collisions against exactly this selected set before calling this,
    reusing each document's PERSISTED key where one exists — Section
    16/17 — and only generating+resolving fresh ones for documents that
    never had one, e.g. pre-Milestone-4.2 rows).

    Deterministic order: sorted by citation_key (Section 22 — "alphabetical
    by citation key," the option this module actually implements; documented
    here as the chosen rule, not left ambiguous). No de-duplication of
    same-DOI documents (Section 23 — Milestone 4.1's "Keep Both" duplicates
    are exported as two distinct, fully valid entries with their own unique
    keys; reference-level dedup is explicitly out of scope for this
    milestone)."""
    ordered = sorted(items, key=lambda pair: pair[1])
    return "\n".join(render_bibtex_entry(item, key) for item, key in ordered)
