import type { DocumentSummary, FolderResponse } from 'education-assistant-client';
import {
  LIBRARY_SORT_KEYS,
  libraryItemBylineLabel,
  librarySortLabel,
  sortLibraryContents,
  toDocumentItems,
  toFolderItems,
  type LibrarySortKey,
} from '@/lib/libraryItems';

function makeDocument(overrides: Partial<DocumentSummary> = {}): DocumentSummary {
  return {
    document_id: 'd1',
    source_filename: 'paper.pdf',
    document_type: 'unknown',
    authors: [],
    chunk_count: 1,
    ingested_at: '2026-01-01T00:00:00Z',
    original_file_available: false,
    has_usable_doi: false,
    ...overrides,
  };
}

function makeFolder(overrides: Partial<FolderResponse> = {}): FolderResponse {
  return {
    id: 'f1',
    name: 'A Folder',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    folder_count: 0,
    document_count: 0,
    ...overrides,
  };
}

describe('LIBRARY_SORT_KEYS / librarySortLabel (Milestone 4: bibliographic sorts)', () => {
  it('includes the two new Milestone 4 sort keys alongside the pre-existing ones', () => {
    expect(LIBRARY_SORT_KEYS).toEqual(
      expect.arrayContaining(['name', 'modified', 'publicationYear', 'author', 'type', 'size'])
    );
  });

  it('has a human label for every declared sort key', () => {
    for (const key of LIBRARY_SORT_KEYS) {
      expect(librarySortLabel(key).length).toBeGreaterThan(0);
    }
  });

  it('labels publicationYear/author distinctly from the pre-existing keys', () => {
    expect(librarySortLabel('publicationYear')).toBe('Publication year');
    expect(librarySortLabel('author')).toBe('Author');
  });
});

describe('sortLibraryContents — publicationYear', () => {
  it('sorts documents ascending by publication year', () => {
    const docs = [
      makeDocument({ document_id: 'a', publication_year: 2021 }),
      makeDocument({ document_id: 'b', publication_year: 2005 }),
      makeDocument({ document_id: 'c', publication_year: 2019 }),
    ];
    const { documents } = sortLibraryContents([], docs, 'publicationYear', 'asc');
    expect(documents.map((d) => d.document_id)).toEqual(['b', 'c', 'a']);
  });

  it('sorts documents descending by publication year', () => {
    const docs = [
      makeDocument({ document_id: 'a', publication_year: 2021 }),
      makeDocument({ document_id: 'b', publication_year: 2005 }),
    ];
    const { documents } = sortLibraryContents([], docs, 'publicationYear', 'desc');
    expect(documents.map((d) => d.document_id)).toEqual(['a', 'b']);
  });

  it('never fabricates a year for a document that has none — falls back to name, not 0', () => {
    const docs = [
      makeDocument({ document_id: 'known', title: 'Zebra Paper', publication_year: 2010 }),
      makeDocument({ document_id: 'unknown', title: 'Apple Paper', publication_year: null }),
    ];
    const { documents } = sortLibraryContents([], docs, 'publicationYear', 'asc');
    // The unknown-year document sorts by name ("Apple" < "Zebra"), not as
    // though its year were 0 (which would incorrectly place it first for
    // an unrelated reason).
    expect(documents.map((d) => d.document_id)).toEqual(['unknown', 'known']);
  });
});

describe('sortLibraryContents — author', () => {
  it('sorts documents alphabetically by first author', () => {
    const docs = [
      makeDocument({ document_id: 'a', authors: ['Zoe Smith'] }),
      makeDocument({ document_id: 'b', authors: ['Ada Lovelace'] }),
    ];
    const { documents } = sortLibraryContents([], docs, 'author', 'asc');
    expect(documents.map((d) => d.document_id)).toEqual(['b', 'a']);
  });

  it('an authorless document falls back to name, never fabricates an author', () => {
    const docs = [
      makeDocument({ document_id: 'known', title: 'Zebra Paper', authors: ['Ada Lovelace'] }),
      makeDocument({ document_id: 'unknown', title: 'Apple Paper', authors: [] }),
    ];
    const { documents } = sortLibraryContents([], docs, 'author', 'asc');
    expect(documents.map((d) => d.document_id)).toEqual(['unknown', 'known']);
  });
});

describe('sortLibraryContents — folders always sort as their own group', () => {
  it('folders never lose their own name-sort behavior for the new keys', () => {
    const folders = [makeFolder({ id: 'z', name: 'Zeta' }), makeFolder({ id: 'a', name: 'Alpha' })];
    const { folders: sortedFolders } = sortLibraryContents(folders, [], 'publicationYear', 'asc');
    expect(sortedFolders.map((f) => f.id)).toEqual(['a', 'z']);
  });
});

describe('every LibrarySortKey is handled without throwing', () => {
  it.each(LIBRARY_SORT_KEYS as LibrarySortKey[])('sorts by %s without error', (key) => {
    const folders = [makeFolder()];
    const docs = [makeDocument()];
    expect(() => sortLibraryContents(folders, docs, key, 'asc')).not.toThrow();
  });
});

describe('libraryItemBylineLabel (Milestone 4: grid-card Author · Year line)', () => {
  it('shows "Author et al. · Year" when both are known', () => {
    const [item] = toDocumentItems([
      makeDocument({ authors: ['Jeff Forrester', 'Jane Doe'], publication_year: 2004 }),
    ]);
    expect(libraryItemBylineLabel(item!)).toBe('Forrester et al. · 2004');
  });

  it('omits the year when only authors are known', () => {
    const [item] = toDocumentItems([makeDocument({ authors: ['Jeff Forrester'] })]);
    expect(libraryItemBylineLabel(item!)).toBe('Forrester');
  });

  it('returns null (never a fabricated placeholder) when neither is known', () => {
    const [item] = toDocumentItems([makeDocument()]);
    expect(libraryItemBylineLabel(item!)).toBeNull();
  });

  it('returns null for a folder', () => {
    const [item] = toFolderItems([makeFolder()]);
    expect(libraryItemBylineLabel(item!)).toBeNull();
  });
});
