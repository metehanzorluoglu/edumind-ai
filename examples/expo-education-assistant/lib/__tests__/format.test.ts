import {
  formatAuthors,
  formatAuthorsCompact,
  parseJournalCitation,
  safeText,
} from '@/lib/format';

describe('safeText', () => {
  it('returns the fallback for null/undefined/blank values', () => {
    expect(safeText(null)).toBe('Not available');
    expect(safeText(undefined)).toBe('Not available');
    expect(safeText('   ')).toBe('Not available');
  });

  it('returns the trimmed value when present', () => {
    expect(safeText('  Hello  ')).toBe('Hello');
  });
});

describe('formatAuthors (full list)', () => {
  it('joins every author', () => {
    expect(formatAuthors(['Ada Lovelace', 'Grace Hopper'])).toBe('Ada Lovelace, Grace Hopper');
  });

  it('shows an honest unavailable message, never "Unknown author(s)", when empty', () => {
    expect(formatAuthors([])).toBe('Author information unavailable');
    expect(formatAuthors(null)).toBe('Author information unavailable');
  });
});

describe('formatAuthorsCompact', () => {
  it('shows only the last name for a single author', () => {
    expect(formatAuthorsCompact(['Anne Ottenbreit-Leftwich'])).toBe('Ottenbreit-Leftwich');
  });

  it('keeps a hyphenated surname whole, never splitting on the hyphen', () => {
    expect(formatAuthorsCompact(['Cindy E. Hmelo-Silver'])).toBe('Hmelo-Silver');
  });

  it('shows "first author et al." for multiple authors', () => {
    const authors = [
      'Anne Ottenbreit-Leftwich',
      'Krista Glazewski',
      'Minji Jeon',
      'Katie Jantaraweragul',
      'Cindy E. Hmelo-Silver',
      'Adam Scribner',
      'Seung Lee',
      'Bradford Mott',
      'James Lester',
    ];
    expect(formatAuthorsCompact(authors)).toBe('Ottenbreit-Leftwich et al.');
  });

  it('shows an honest unavailable message, never "Unknown author(s)", when empty', () => {
    expect(formatAuthorsCompact([])).toBe('Author information unavailable');
    expect(formatAuthorsCompact(undefined)).toBe('Author information unavailable');
  });
});

describe('parseJournalCitation', () => {
  it('decomposes a full "Journal Name (YYYY) Volume:Start-End" citation', () => {
    const parsed = parseJournalCitation(
      'International Journal of Artificial Intelligence in Education (2023) 33:267-289'
    );
    expect(parsed).toEqual({
      journalTitle: 'International Journal of Artificial Intelligence in Education',
      year: 2023,
      volume: '33',
      pageStart: 267,
      pageEnd: 289,
    });
  });

  it('accepts an en-dash page-range separator, matching the backend parser', () => {
    const parsed = parseJournalCitation(
      'International Journal of Artificial Intelligence in Education (2023) 33:267–289'
    );
    expect(parsed?.pageStart).toBe(267);
    expect(parsed?.pageEnd).toBe(289);
  });

  it('returns null for a venue that is not in the citation-banner shape', () => {
    expect(parseJournalCitation('Journal of Applied Literacy')).toBeNull();
    expect(parseJournalCitation(null)).toBeNull();
    expect(parseJournalCitation(undefined)).toBeNull();
  });
});
