/** Never render "undefined"/"null" — a missing field becomes an explicit, honest fallback string instead. */
export function safeText(value: string | null | undefined, fallback = 'Not available'): string {
  if (value === null || value === undefined) return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

/**
 * "Unknown author(s)" reads as if extraction ran and confirmed there are no
 * authors — but a missing byline is at least as often just nothing having
 * been extracted at all. "Author information unavailable" is honest about
 * that either way, without implying a real absence that was never verified.
 */
export function formatAuthors(authors: readonly string[] | null | undefined): string {
  if (!authors || authors.length === 0) return 'Author information unavailable';
  return authors.join(', ');
}

/**
 * The final whitespace-separated token of a full name — a hyphenated
 * surname ("Anne Ottenbreit-Leftwich", "Cindy E. Hmelo-Silver") stays one
 * piece, since a hyphen isn't whitespace, but a middle initial ("E.") is
 * correctly skipped since it's its own separate token before the surname.
 */
function lastNameOf(fullName: string): string {
  const parts = fullName.trim().split(/\s+/);
  return parts[parts.length - 1] || fullName;
}

/**
 * A compact "Ottenbreit-Leftwich et al."-style label for space-constrained
 * displays (source cards) — the full author list is always what's stored
 * and available elsewhere (document metadata, expanded source details);
 * this is presentation-only and never the value that gets persisted.
 */
export function formatAuthorsCompact(authors: readonly string[] | null | undefined): string {
  if (!authors || authors.length === 0) return 'Author information unavailable';
  if (authors.length === 1) return lastNameOf(authors[0]!);
  return `${lastNameOf(authors[0]!)} et al.`;
}

export interface ParsedJournalCitation {
  journalTitle: string;
  year: number;
  volume: string;
  pageStart: number;
  pageEnd: number;
}

// Mirrors rag-backend's parse_journal_citation (app/ingestion/metadata_extraction.py)
// exactly — a "Journal Name (YYYY) Volume:StartPage-EndPage" citation
// banner, the shape Springer/many other journals print at the top of an
// article's first page. Includes the same dash-like unicode variants a
// page range might use (plain hyphen, non-breaking hyphen, figure dash,
// en dash, em dash, horizontal bar), written as \u escapes so the source
// file itself stays plain ASCII.
const JOURNAL_CITATION_PATTERN =
  /^([^()]{3,150}?)\s*\(((?:19|20)\d{2})\)\s*(\d+)\s*:\s*(\d+)\s*[-\u2010\u2011\u2012\u2013\u2014\u2015]\s*(\d+)\s*$/;

/**
 * Decomposes a full "Journal Name (YYYY) Volume:StartPage-EndPage"
 * source_venue string into its parts — `source_venue` itself always keeps
 * the full citation string verbatim (see the backend), so a source card
 * that wants just the bare journal name or the page range parses it here
 * rather than the backend needing to expose separate fields for it.
 * Returns null for any source_venue that isn't in that exact shape (most
 * documents, including every non-journal-article document type), so a
 * caller falls back to displaying the raw string unchanged.
 */
export function parseJournalCitation(
  sourceVenue: string | null | undefined
): ParsedJournalCitation | null {
  if (!sourceVenue) return null;
  const match = JOURNAL_CITATION_PATTERN.exec(sourceVenue.trim());
  if (!match) return null;
  return {
    journalTitle: match[1]!.trim(),
    year: Number(match[2]),
    volume: match[3]!,
    pageStart: Number(match[4]),
    pageEnd: Number(match[5]),
  };
}
