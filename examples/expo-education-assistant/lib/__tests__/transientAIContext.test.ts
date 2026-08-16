import { buildTransientContextPrefix, type TransientAIContextEntry } from '../transientAIContext';

function entry(overrides: Partial<TransientAIContextEntry> = {}): TransientAIContextEntry {
  return {
    sourceType: 'reader-selection',
    documentId: 'doc-1',
    documentTitle: 'AI Education',
    pageNumber: 3,
    excerpt: 'Students completed a 12-week program.',
    ...overrides,
  };
}

describe('buildTransientContextPrefix', () => {
  it('returns an empty string for zero entries', () => {
    expect(buildTransientContextPrefix([])).toBe('');
  });

  it('a single entry matches Frontend Milestone 3\'s original single-passage phrasing exactly', () => {
    const result = buildTransientContextPrefix([entry()]);
    expect(result).toBe(
      'Regarding this passage from "AI Education" (page 3):\n\n' +
        '"Students completed a 12-week program."\n\n'
    );
  });

  it('falls back to "the selected source" when documentTitle is null', () => {
    const result = buildTransientContextPrefix([entry({ documentTitle: null })]);
    expect(result).toContain('Regarding this passage from the selected source');
  });

  it('omits the page suffix when pageNumber is null', () => {
    const result = buildTransientContextPrefix([entry({ pageNumber: null })]);
    expect(result).toBe(
      'Regarding this passage from "AI Education":\n\n"Students completed a 12-week program."\n\n'
    );
  });

  it('renders multiple entries as distinct numbered Evidence blocks, never merged', () => {
    const result = buildTransientContextPrefix([
      entry({ documentTitle: 'Source A', excerpt: 'First excerpt.', userNote: 'Worth citing.' }),
      entry({ documentTitle: 'Source B', pageNumber: 7, excerpt: 'Second excerpt.' }),
    ]);
    expect(result).toContain('Evidence 1 — Source: Source A, page 3');
    expect(result).toContain('Excerpt: "First excerpt."');
    expect(result).toContain('My note: Worth citing.');
    expect(result).toContain('Evidence 2 — Source: Source B, page 7');
    expect(result).toContain('Excerpt: "Second excerpt."');
    // Never concatenated into one blob — each excerpt/note stays scoped to
    // its own "Evidence N" block.
    expect(result.indexOf('Evidence 1')).toBeLessThan(result.indexOf('Evidence 2'));
  });

  it('omits the "My note" line for an entry with no note', () => {
    const result = buildTransientContextPrefix([
      entry({ userNote: null }),
      entry({ documentTitle: 'Other' }),
    ]);
    expect(result).not.toContain('My note:');
  });

  describe('manuscript-selection (Milestone 5.2 Part 3)', () => {
    function manuscriptEntry(overrides: Partial<TransientAIContextEntry> = {}): TransientAIContextEntry {
      return {
        sourceType: 'manuscript-selection',
        documentId: null,
        documentTitle: null,
        pageNumber: null,
        excerpt: "Teachers' motivational beliefs influenced how they enacted agency.",
        ...overrides,
      };
    }

    it('a single manuscript-selection entry is worded as "my manuscript", never as a library source', () => {
      const result = buildTransientContextPrefix([manuscriptEntry()]);
      expect(result).toBe(
        'Regarding this passage from my manuscript:\n\n' +
          '"Teachers\' motivational beliefs influenced how they enacted agency."\n\n'
      );
      // Never the generic "the selected source" fallback, which would
      // misleadingly imply this came from the library.
      expect(result).not.toContain('the selected source');
    });

    it('a manuscript-selection entry never shows a page suffix (it has none)', () => {
      const result = buildTransientContextPrefix([manuscriptEntry({ pageNumber: 5 })]);
      // pageNumber is always null for this sourceType in practice, but
      // even if a caller mistakenly set one, the manuscript phrasing
      // branch never reads it.
      expect(result).toBe(
        'Regarding this passage from my manuscript:\n\n' +
          '"Teachers\' motivational beliefs influenced how they enacted agency."\n\n'
      );
    });

    it('mixed manuscript-selection + library entries render distinct "My manuscript" vs source blocks', () => {
      const result = buildTransientContextPrefix([
        manuscriptEntry({ excerpt: 'My draft claim.' }),
        entry({ documentTitle: 'Forrester et al.', pageNumber: 7, excerpt: 'Supporting finding.' }),
      ]);
      expect(result).toContain('Evidence 1 — Source: My manuscript');
      expect(result).toContain('Excerpt: "My draft claim."');
      expect(result).toContain('Evidence 2 — Source: Forrester et al., page 7');
      expect(result).toContain('Excerpt: "Supporting finding."');
    });
  });
});
