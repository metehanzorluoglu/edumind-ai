"""Milestone 4.2 (Citation & BibTeX Foundation) Section 4 — the ONE author
name-parsing heuristic shared by every citation surface: CSL family/given
mapping (app/core/citation_item.py, feeds APA/IEEE formatting), BibTeX
`author = {...}` field construction (app/core/bibtex.py), and citation-key
generation (app/core/citation_key.py). A single shared module so "what does
this author string mean" can never drift into two different answers for
the same document.

Document.authors (see app/db/models_documents.py) is, and has always been,
a list of opaque DISPLAY STRINGS — never structured given/family data.
Nothing in this codebase's extraction pipeline (app/ingestion/
metadata_extraction.py) or manual-edit path ever asked a user to enter a
family name and a given name separately; a user editing an author simply
types one string per author into a comma-separated field (see
EditMetadataModal's `authorsText`). This module's job is to recover
family/given structure from that string CONSERVATIVELY — "do not infer
name parts recklessly" (Milestone 4.2 Section 4) — falling back to a
`literal` (whole-string, unsplit) representation whenever the input
doesn't match one of a small number of confident, unambiguous patterns.
`literal` is a real CSL/BibTeX concept for organization authors (CSL's
`{"literal": "..."}` author object; BibTeX's `{World Health Organization}`
braced-literal convention) — reusing it here for "we chose not to guess"
is the same escape hatch citation tooling already has for genuinely
non-personal authors, not a new invented state.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

# A conservative, non-exhaustive list of tokens that strongly signal an
# organizational (not personal) author — checked case-insensitively as
# whole words. Deliberately errs toward under-detecting (treating a real
# organization as an unparsed personal name would still be safe, since an
# ambiguous personal name already falls back to `literal` too — see
# parse_author's docstring) rather than over-detecting (which could split
# a legitimate two-word surname organization-style).
_ORGANIZATION_MARKERS = {
    "university",
    "institute",
    "institution",
    "organization",
    "organisation",
    "association",
    "society",
    "committee",
    "commission",
    "council",
    "foundation",
    "department",
    "ministry",
    "agency",
    "administration",
    "corporation",
    "company",
    "group",
    "consortium",
    "network",
    "collaborative",
    "collaboration",
    "task force",
    "working group",
    "school",
    "college",
    "academy",
    "laboratory",
    "laboratories",
    "center",
    "centre",
    "bureau",
    "authority",
    "federation",
    "union",
    "alliance",
    "inc",
    "inc.",
    "ltd",
    "ltd.",
    "llc",
    "gmbh",
}

# A given-name "word": either a full capitalized name (Jonathan, Jean-Paul,
# O'Brien-style are still just one alphabetic token here since apostrophes/
# hyphens are handled below) or a bare initial ("J", "J.", "J.-P.").
_NAME_TOKEN_RE = re.compile(
    r"^[A-Z][\w'’-]*\.?$|^[A-Z](?:\.[A-Z])*\.?$",  # noqa: RUF001 - includes the curly apostrophe variant
    re.UNICODE,
)


@dataclass(frozen=True)
class ParsedAuthor:
    """One author, in CSL's own family/given/literal shape (see
    https://docs.citationstyles.org/en/stable/specification.html#names).
    Exactly one of (family, literal) is ever set — `family` alone for a
    successfully split personal name (`given` may still be empty for a
    family-only author, e.g. a mononym), `literal` alone for anything this
    module chose not to split (organizations and anything ambiguous)."""

    family: str | None
    given: str | None
    literal: str | None
    raw: str

    @property
    def is_literal(self) -> bool:
        return self.literal is not None


def _looks_organizational(raw: str) -> bool:
    lowered = raw.lower()
    if any(marker in lowered.split() for marker in _ORGANIZATION_MARKERS):
        return True
    # Multi-word marker phrases (e.g. "task force") that .split() alone
    # would never match as a single token.
    if "task force" in lowered or "working group" in lowered:
        return True
    # An all-uppercase token of 2+ letters with no lowercase anywhere and
    # more than one character (a personal initial like "J" is one char and
    # is handled by the token-pattern path, not here) reads as an acronym
    # (WHO, UNESCO, NASA) — organizational, not a personal surname.
    words = raw.split()
    return bool(words) and all(w.isupper() and len(w) >= 2 for w in words) and raw.isupper()


def parse_author(raw: str) -> ParsedAuthor:
    """Conservatively splits one author display string into CSL family/
    given parts, or falls back to `literal` when the input doesn't match a
    confident pattern. See this module's own docstring for the "why
    literal is the safe default" reasoning.

    Recognized patterns, in order:
    1. Organizational marker (see _ORGANIZATION_MARKERS) or an all-caps
       acronym -> literal.
    2. "Family, Given" (comma-separated) -> confident split; the part
       before the comma is `family` verbatim, the part after is `given`
       verbatim (already in the order a human chose to write it).
    3. No comma, 2+ whitespace-separated tokens, EVERY token matches
       _NAME_TOKEN_RE (capitalized word or an initial) -> confident split:
       family = last token, given = the rest joined.
    4. No comma, a single token -> family-only (mononym / surname-only
       author, e.g. "Cher", "Forrester") — not literal, since a single
       capitalized word is unambiguous.
    5. Anything else (stray punctuation, a token that doesn't look like a
       name fragment, etc.) -> literal, the safe default.

    Never strips/normalizes whitespace beyond a single `.strip()` on the
    whole input — an author's own chosen internal spacing/punctuation
    (e.g. "Jean-Paul", "O'Brien", "Müller") is preserved verbatim in
    whichever field it lands in.
    """
    stripped = raw.strip()
    if not stripped:
        return ParsedAuthor(family=None, given=None, literal="", raw=raw)

    if _looks_organizational(stripped):
        return ParsedAuthor(family=None, given=None, literal=stripped, raw=raw)

    if "," in stripped:
        family_part, _, given_part = stripped.partition(",")
        family = family_part.strip()
        given = given_part.strip()
        if family:
            return ParsedAuthor(family=family, given=given or None, literal=None, raw=raw)
        # A comma with nothing usable before it (e.g. ", Jane") is not a
        # pattern worth guessing at — fall through to literal.
        return ParsedAuthor(family=None, given=None, literal=stripped, raw=raw)

    tokens = stripped.split()
    if len(tokens) == 1:
        return ParsedAuthor(family=tokens[0], given=None, literal=None, raw=raw)

    if all(_NAME_TOKEN_RE.match(token) for token in tokens):
        *given_tokens, family = tokens
        given_name = " ".join(given_tokens) or None
        return ParsedAuthor(family=family, given=given_name, literal=None, raw=raw)

    # Ambiguous — doesn't match any confident pattern (unexpected
    # punctuation, lowercase-leading tokens, digits, etc.). Preserve
    # verbatim rather than guessing wrong (Section 4: "preserve literal-
    # author semantics rather than guessing").
    return ParsedAuthor(family=None, given=None, literal=stripped, raw=raw)


def parse_authors(raw_authors: list[str]) -> list[ParsedAuthor]:
    """Parses a whole Document.authors list, in order. Empty/whitespace-only
    entries are dropped (an empty author string is never a real author, and
    every downstream consumer — CSL, BibTeX — needs at least a `literal`
    or `family` to do anything with an entry)."""
    return [parse_author(a) for a in raw_authors if a and a.strip()]
