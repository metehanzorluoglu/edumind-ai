import type { Citation } from '../types/citations';

/**
 * Mirrors app/core/citation_validation.py's `_CITATION_PATTERN` exactly
 * ([S<digits>], nothing looser) so marker positions found here always agree
 * with what the backend itself recognizes as a citation token. This SDK
 * does not re-validate citations (that's the backend's job, surfaced via
 * `citation_warnings` on the done event) — it only locates markers already
 * known to be well-formed-shaped, for the purpose of rendering them.
 */
const CITATION_MARKER_PATTERN = /\[S(\d+)\]/g;

export interface CitationMarkerMatch {
  /** The literal matched text, e.g. "[S1]". */
  raw: string;
  /** e.g. "S1". */
  sourceId: string;
  /** Character offset of the match start within the answer string. */
  index: number;
  /**
   * The backend-provided Citation for this sourceId, or null if the answer
   * cites an id that isn't in the provided citations list. A null value
   * here is a *display* fact ("no source card available for this marker"),
   * not a correctness judgment — the backend's own `citation_warnings`
   * already flags unknown citations; this never duplicates that check.
   */
  citation: Citation | null;
}

/**
 * Finds every [S<n>] marker in `answer` and maps it to its backend-provided
 * Citation, in the order the markers appear in the text (a marker can
 * legitimately repeat, and several can appear back-to-back — both are
 * returned as separate entries, in document order, exactly as written).
 */
export function mapCitationMarkers(
  answer: string,
  citations: readonly Citation[]
): CitationMarkerMatch[] {
  const byId = new Map(citations.map((citation) => [citation.source_id, citation]));
  const matches: CitationMarkerMatch[] = [];

  for (const match of answer.matchAll(CITATION_MARKER_PATTERN)) {
    const raw = match[0];
    const sourceId = `S${match[1]}`;
    matches.push({
      raw,
      sourceId,
      index: match.index,
      citation: byId.get(sourceId) ?? null,
    });
  }

  return matches;
}

/** Unique source ids actually cited in the answer, in first-appearance order. */
export function uniqueCitedSourceIds(matches: readonly CitationMarkerMatch[]): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const match of matches) {
    if (!seen.has(match.sourceId)) {
      seen.add(match.sourceId);
      ids.push(match.sourceId);
    }
  }
  return ids;
}

export type AnswerSegment =
  { type: 'text'; content: string } | { type: 'citation'; match: CitationMarkerMatch };

/**
 * Splits an answer into alternating text/citation segments, suitable for
 * rendering citation markers as tappable chips inline with the surrounding
 * prose (e.g. to scroll/focus a source card on tap). Punctuation
 * immediately around a marker (periods, commas, brackets like "[Table 1]")
 * is left untouched in the surrounding text segments — only the exact
 * [S<n>] token is split out.
 */
export function splitAnswerIntoSegments(
  answer: string,
  citations: readonly Citation[]
): AnswerSegment[] {
  const matches = mapCitationMarkers(answer, citations);
  if (matches.length === 0) return [{ type: 'text', content: answer }];

  const segments: AnswerSegment[] = [];
  let cursor = 0;

  for (const match of matches) {
    if (match.index > cursor) {
      segments.push({ type: 'text', content: answer.slice(cursor, match.index) });
    }
    segments.push({ type: 'citation', match });
    cursor = match.index + match.raw.length;
  }

  if (cursor < answer.length) {
    segments.push({ type: 'text', content: answer.slice(cursor) });
  }

  return segments;
}
