import { groupImportWarnings } from '../WritingProjectImportPanel';

/**
 * M5.5.3 continuation Part 14 — real journal ZIP imports (the Springer
 * Nature fixture originally motivated this: before Milestone 5.5.4,
 * its `.eps` figures were an unsupported type and produced a dozen+
 * individually-identical "Unsupported file type — not imported"
 * warnings; `.eps` is a supported binary type as of M5.5.4, see
 * BINARY_FILE_EXTENSIONS in rag-backend/app/db/models_writing.py, so
 * `.docx` stands in here as a still-genuinely-unsupported extension)
 * can carry a dozen+ individually-identical warnings. This locks in
 * the grouping behavior that keeps the import-review UI from becoming
 * a wall of repeated yellow cards, per the spec's own worked example:
 * "Unsupported files (2) - a.docx - b.docx" /
 * "Repository metadata not imported (1) - .gitignore". groupImport
 * Warnings itself is a pure function over arbitrary {path, reason}
 * pairs, so these fixtures only need to be realistic, not tied to
 * whichever extensions are unsupported on any given day.
 */
describe('groupImportWarnings', () => {
  it('groups repeated identical known reasons into one labeled group', () => {
    const { groups, standalone } = groupImportWarnings([
      { path: 'docs/notes.docx', reason: 'Unsupported file type — not imported' },
      { path: 'docs/outline.docx', reason: 'Unsupported file type — not imported' },
    ]);
    expect(groups).toEqual([
      { label: 'Unsupported files', paths: ['docs/notes.docx', 'docs/outline.docx'] },
    ]);
    expect(standalone).toEqual([]);
  });

  it('still groups a known reason even when only one file matches it', () => {
    const { groups, standalone } = groupImportWarnings([
      { path: '.gitignore', reason: 'Repository metadata is not imported by EduM8.' },
    ]);
    expect(groups).toEqual([{ label: 'Repository metadata not imported', paths: ['.gitignore'] }]);
    expect(standalone).toEqual([]);
  });

  it('keeps a unique, non-generic reason standalone with its full body', () => {
    const uniqueReason =
      '"references.bib" is reserved for EduM8\'s own generated bibliography and was not imported.';
    const { groups, standalone } = groupImportWarnings([
      { path: 'references.bib', reason: uniqueReason },
    ]);
    expect(groups).toEqual([]);
    expect(standalone).toEqual([{ path: 'references.bib', reason: uniqueReason }]);
  });

  it('separates multiple known-reason groups and leaves unrelated ones apart', () => {
    const { groups, standalone } = groupImportWarnings([
      { path: 'a.docx', reason: 'Unsupported file type — not imported' },
      { path: 'b.docx', reason: 'Unsupported file type — not imported' },
      { path: 'empty.txt', reason: 'File is empty — not imported' },
      { path: '.gitignore', reason: 'Repository metadata is not imported by EduM8.' },
    ]);
    expect(groups).toEqual(
      expect.arrayContaining([
        { label: 'Unsupported files', paths: ['a.docx', 'b.docx'] },
        { label: 'Empty files', paths: ['empty.txt'] },
        { label: 'Repository metadata not imported', paths: ['.gitignore'] },
      ])
    );
    expect(groups).toHaveLength(3);
    expect(standalone).toEqual([]);
  });

  it('returns empty groups/standalone for no warnings', () => {
    expect(groupImportWarnings([])).toEqual({ groups: [], standalone: [] });
  });
});
