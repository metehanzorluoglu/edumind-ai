import { groupImportWarnings } from '../WritingProjectImportPanel';

/**
 * M5.5.3 continuation Part 14 — real journal ZIP imports (the Springer
 * Nature fixture) can carry a dozen+ individually-identical warnings
 * ("Unsupported file type — not imported" once per .eps figure). This
 * locks in the grouping behavior that keeps the import-review UI from
 * becoming a wall of repeated yellow cards, per the spec's own worked
 * example: "Unsupported files (2) - empty.eps - fig.eps" /
 * "Repository metadata not imported (1) - .gitignore".
 */
describe('groupImportWarnings', () => {
  it('groups repeated identical known reasons into one labeled group', () => {
    const { groups, standalone } = groupImportWarnings([
      { path: 'figures/empty.eps', reason: 'Unsupported file type — not imported' },
      { path: 'figures/fig.eps', reason: 'Unsupported file type — not imported' },
    ]);
    expect(groups).toEqual([
      { label: 'Unsupported files', paths: ['figures/empty.eps', 'figures/fig.eps'] },
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
      { path: 'a.eps', reason: 'Unsupported file type — not imported' },
      { path: 'b.eps', reason: 'Unsupported file type — not imported' },
      { path: 'empty.txt', reason: 'File is empty — not imported' },
      { path: '.gitignore', reason: 'Repository metadata is not imported by EduM8.' },
    ]);
    expect(groups).toEqual(
      expect.arrayContaining([
        { label: 'Unsupported files', paths: ['a.eps', 'b.eps'] },
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
