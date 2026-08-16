"""Milestone 4.2 (Citation & BibTeX Foundation) Section 3 — the one
normalized, CSL-shaped citation representation every citation surface
(APA/IEEE formatting, BibTeX export) builds from. Derived entirely from a
document's EXISTING canonical SQL metadata (app/db/documents_repository.
DocumentRecord — the same source of truth Section 28 requires: "Do not use
stale Qdrant payloads. Do not use model-generated metadata."). Ephemeral by
design (Section 3: "This normalized object may be ephemeral") — never
persisted, built fresh on every citation/BibTeX request straight from the
current DocumentRecord, so a metadata edit is reflected the moment it's
saved with no cache to invalidate.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

from app.core.citation_authors import ParsedAuthor, parse_authors
from app.db.documents_repository import DocumentRecord

#: CSL item types this milestone actually needs — see
#: https://docs.citationstyles.org/en/stable/specification.html#appendix-iii-types
#: for the full vocabulary; only the ones DOCUMENT_TYPE_TO_CSL below can
#: produce are listed, so a Literal stays exhaustive and useful.
CslItemType = Literal[
    "article-journal",
    "paper-conference",
    "book",
    "chapter",
    "thesis",
    "report",
    "article",
]

#: Milestone 4.2 Section 3/11 — conservative document_type -> CSL type
#: mapping, shared conceptually with bibtex.py's own
#: DOCUMENT_TYPE_TO_BIBTEX (kept as two separate small tables, not one,
#: because CSL and BibTeX's type vocabularies genuinely don't line up
#: 1:1 — see that module's own docstring). "unknown"/"other" and every
#: value with no confident scholarly-type equivalent (practitioner_
#: article, policy_document, curriculum_document) fall back to the
#: generic "article" — never a guessed, more specific type a user never
#: confirmed.
DOCUMENT_TYPE_TO_CSL: dict[str, CslItemType] = {
    "journal_article": "article-journal",
    "review_article": "article-journal",
    "conference_paper": "paper-conference",
    "book": "book",
    "book_chapter": "chapter",
    "thesis_dissertation": "thesis",
    "report": "report",
    "policy_document": "report",
    "practitioner_article": "article",
    "curriculum_document": "article",
    "other": "article",
    "unknown": "article",
}


@dataclass(frozen=True)
class CitationItem:
    """One reference, CSL-JSON-shaped (see citeproc-py's
    citeproc.source.json.CiteProcJSON, the format app/core/
    citation_formatting.py feeds this into). Field names deliberately
    mirror CSL-JSON's own vocabulary (container_title not source_venue,
    issued_year not publication_year) so the mapping into citeproc-py's
    input dict is a direct, obvious 1:1 transcription — see
    citation_formatting.py's to_csl_json().
    """

    id: str
    type: CslItemType
    title: str | None
    authors: list[ParsedAuthor] = field(default_factory=list)
    issued_year: int | None = None
    container_title: str | None = None
    volume: str | None = None
    issue: str | None = None
    page: str | None = None
    publisher: str | None = None
    doi: str | None = None
    url: str | None = None
    language: str | None = None

    # --- Fields BibTeX/citation-key generation need but CSL formatting
    # does not (kept on the same item so callers build exactly one object
    # per document — Section 3: "Do not create another database table
    # merely for formatting", and by extension, do not create two
    # in-memory representations either).
    document_id: str = ""
    document_type_raw: str = "unknown"


def _format_page_range(page_start: int | None, page_end: int | None) -> str | None:
    """CSL's own `page` field is a single free-text string (it renders the
    dash itself per-style) — matches this codebase's existing convention
    of storing page_start/page_end as two separate ints and joining them
    for display (see DetailsPanel.tsx's own Pages row)."""
    if page_start is not None and page_end is not None:
        if page_start == page_end:
            return str(page_start)
        return f"{page_start}-{page_end}"
    if page_start is not None:
        return str(page_start)
    if page_end is not None:
        return str(page_end)
    return None


def document_to_citation_item(document: DocumentRecord) -> CitationItem:
    """The single Document -> CitationItem mapping every citation/BibTeX
    endpoint uses (Section 28/30: always current canonical SQL metadata,
    never a snapshot). `title`/`authors` missing is passed straight
    through as None/[] — Section 8's "formatting must degrade
    gracefully... do not fabricate" is the formatter's job to handle, not
    this mapping's."""
    csl_type = DOCUMENT_TYPE_TO_CSL.get(document.document_type, "article")
    return CitationItem(
        id=document.document_id,
        type=csl_type,
        title=document.title,
        authors=parse_authors(document.authors),
        issued_year=document.publication_year,
        container_title=document.source_venue,
        volume=document.volume,
        issue=document.issue,
        page=_format_page_range(document.page_start, document.page_end),
        publisher=document.publisher,
        doi=document.doi,
        url=document.source_url,
        language=document.language,
        document_id=document.document_id,
        document_type_raw=document.document_type,
    )
