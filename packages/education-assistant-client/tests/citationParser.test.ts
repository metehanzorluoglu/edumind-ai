import { describe, expect, it } from 'vitest';
import {
  mapCitationMarkers,
  splitAnswerIntoSegments,
  uniqueCitedSourceIds,
} from '../src/utils/citationParser';
import type { Citation } from '../src/types/citations';

function makeCitation(sourceId: string): Citation {
  return {
    source_id: sourceId,
    document_id: `doc-${sourceId}`,
    chunk_id: `chunk-${sourceId}`,
    title: `Title ${sourceId}`,
    authors: [],
    publication_year: 2020,
    source_venue: null,
    document_type: 'journal_article',
    journal_quartile: null,
    page_start: 1,
    page_end: 1,
    doi: null,
    source_url: null,
    score: 0.9,
  };
}

describe('mapCitationMarkers', () => {
  it('maps [S1]/[S2] markers to citations in document order, including a repeated marker', () => {
    const citations = [makeCitation('S1'), makeCitation('S2')];
    const answer = 'Claim A [S1]. Claim B [S2]. Claim A again [S1].';
    const matches = mapCitationMarkers(answer, citations);

    expect(matches.map((m) => m.sourceId)).toEqual(['S1', 'S2', 'S1']);
    expect(matches[0]!.citation).toBe(citations[0]);
    expect(matches[2]!.citation).toBe(citations[0]);
  });

  it('handles back-to-back markers for a multi-source claim', () => {
    const citations = [makeCitation('S1'), makeCitation('S2')];
    const matches = mapCitationMarkers('Supported by two sources [S1][S2].', citations);
    expect(matches).toHaveLength(2);
    expect(matches[0]!.index).toBeLessThan(matches[1]!.index);
  });

  it('marks an unknown source id as null without inventing a citation', () => {
    const matches = mapCitationMarkers('Unverified claim [S9].', [makeCitation('S1')]);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.sourceId).toBe('S9');
    expect(matches[0]!.citation).toBeNull();
  });

  it('does not match ordinary bracketed text that is not a citation token', () => {
    const matches = mapCitationMarkers('See [Table 1] and [S1].', [makeCitation('S1')]);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.raw).toBe('[S1]');
  });

  it('returns an empty list for an answer with no citation markers', () => {
    expect(mapCitationMarkers('No citations here.', [makeCitation('S1')])).toEqual([]);
  });
});

describe('uniqueCitedSourceIds', () => {
  it('deduplicates while preserving first-appearance order', () => {
    const citations = [makeCitation('S1'), makeCitation('S2')];
    const matches = mapCitationMarkers('[S2] then [S1] then [S2] again', citations);
    expect(uniqueCitedSourceIds(matches)).toEqual(['S2', 'S1']);
  });
});

describe('splitAnswerIntoSegments', () => {
  it('produces alternating text/citation segments and preserves surrounding punctuation', () => {
    const citations = [makeCitation('S1')];
    const segments = splitAnswerIntoSegments('The sky is blue [S1]. Confirmed.', citations);

    expect(segments).toEqual([
      { type: 'text', content: 'The sky is blue ' },
      { type: 'citation', match: expect.objectContaining({ sourceId: 'S1' }) },
      { type: 'text', content: '. Confirmed.' },
    ]);
  });

  it('returns a single text segment when there are no markers', () => {
    const segments = splitAnswerIntoSegments('Plain answer.', []);
    expect(segments).toEqual([{ type: 'text', content: 'Plain answer.' }]);
  });

  it('does not emit an empty text segment when the answer starts with a marker', () => {
    const citations = [makeCitation('S1')];
    const segments = splitAnswerIntoSegments('[S1] leads the claim.', citations);
    expect(segments[0]).toEqual({
      type: 'citation',
      match: expect.objectContaining({ sourceId: 'S1' }),
    });
  });
});
