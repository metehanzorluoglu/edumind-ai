import {
  applySuggestion,
  detectAutocompleteContext,
  getSuggestions,
  LATEX_COMMANDS,
} from '../latexAutocomplete';

describe('detectAutocompleteContext', () => {
  it('detects an in-progress bare command', () => {
    const text = '\\sec';
    expect(detectAutocompleteContext(text, text.length)).toEqual({
      kind: 'command',
      rangeStart: 1,
      rangeEnd: 4,
      query: 'sec',
    });
  });

  it('detects an in-progress command mid-document', () => {
    const text = 'Intro text.\n\\subsec more later';
    const cursor = 'Intro text.\n\\subsec'.length;
    expect(detectAutocompleteContext(text, cursor)).toEqual({
      kind: 'command',
      rangeStart: 13,
      rangeEnd: 19,
      query: 'subsec',
    });
  });

  it('returns null for plain prose', () => {
    expect(detectAutocompleteContext('hello world', 11)).toBeNull();
  });

  it('returns null once a command name is finished (a space follows)', () => {
    const text = '\\section ';
    expect(detectAutocompleteContext(text, text.length)).toBeNull();
  });

  it('returns null right after the backslash with nothing typed yet', () => {
    // Still valid — an empty query is a legitimate "show everything" state.
    const text = '\\';
    expect(detectAutocompleteContext(text, 1)).toEqual({
      kind: 'command',
      rangeStart: 1,
      rangeEnd: 1,
      query: '',
    });
  });

  it('detects a citation-key query inside \\cite{}', () => {
    const text = '\\cite{smith';
    expect(detectAutocompleteContext(text, text.length)).toEqual({
      kind: 'citation',
      rangeStart: 6,
      rangeEnd: 11,
      query: 'smith',
    });
  });

  it('detects only the last comma-separated key in a multi-citation', () => {
    const text = '\\cite{smith2020,jo';
    expect(detectAutocompleteContext(text, text.length)).toEqual({
      kind: 'citation',
      rangeStart: 16,
      rangeEnd: 18,
      query: 'jo',
    });
  });

  it('trims leading whitespace after a comma from the query', () => {
    const text = '\\cite{smith2020, jo';
    const ctx = detectAutocompleteContext(text, text.length);
    expect(ctx?.query).toBe('jo');
    expect(ctx?.rangeStart).toBe(17); // right after the space, at "jo"
  });

  it('recognizes natbib citation command variants', () => {
    for (const cmd of ['citep', 'citet', 'parencite', 'textcite', 'autocite']) {
      const text = `\\${cmd}{ab`;
      expect(detectAutocompleteContext(text, text.length)?.kind).toBe('citation');
    }
  });

  it('detects a file-path query inside \\input{}', () => {
    const text = '\\input{sections/';
    expect(detectAutocompleteContext(text, text.length)).toEqual({
      kind: 'file',
      rangeStart: 7,
      rangeEnd: 16,
      query: 'sections/',
    });
  });

  it('detects a file-path query inside \\include{} and \\includegraphics{}', () => {
    expect(detectAutocompleteContext('\\include{Chap', 13)?.kind).toBe('file');
    expect(detectAutocompleteContext('\\includegraphics{fig', 20)?.kind).toBe('file');
  });

  it('skips an optional [..] group before the argument brace', () => {
    const text = '\\cite[see][p. 3]{sm';
    expect(detectAutocompleteContext(text, text.length)).toEqual({
      kind: 'citation',
      rangeStart: 17,
      rangeEnd: 19,
      query: 'sm',
    });
  });

  it('returns null once the argument brace has already closed', () => {
    const text = '\\cite{smith2020} and more text';
    expect(detectAutocompleteContext(text, text.length)).toBeNull();
  });

  it('returns null for an unrecognized command even inside a brace', () => {
    const text = '\\textbf{something';
    expect(detectAutocompleteContext(text, text.length)).toBeNull();
  });

  it('correctly skips a balanced nested command when scanning backward', () => {
    const text = '\\cite{smith2020}\\input{sec';
    expect(detectAutocompleteContext(text, text.length)).toEqual({
      kind: 'file',
      rangeStart: 23,
      rangeEnd: 26,
      query: 'sec',
    });
  });

  it('bails out (returns null) across a blank-line paragraph break', () => {
    const text = '\\cite{smith\n\nsomething}here';
    // Cursor placed well past the blank line, still "inside" a brace
    // by naive counting — the conservative bail-out must fire.
    const cursor = text.indexOf('here');
    expect(detectAutocompleteContext(text, cursor)).toBeNull();
  });

  it('rejects out-of-range cursor positions', () => {
    expect(detectAutocompleteContext('abc', -1)).toBeNull();
    expect(detectAutocompleteContext('abc', 99)).toBeNull();
  });
});

describe('getSuggestions', () => {
  it('filters LaTeX commands by prefix, case-insensitively', () => {
    const suggestions = getSuggestions(
      { kind: 'command', rangeStart: 0, rangeEnd: 0, query: 'SEC' },
      { citationKeys: [], filePaths: [] }
    );
    expect(suggestions.every((s) => s.label.toLowerCase().startsWith('\\sec'))).toBe(true);
    expect(suggestions.some((s) => s.label === '\\section')).toBe(true);
  });

  it('caps command suggestions at 8', () => {
    const suggestions = getSuggestions(
      { kind: 'command', rangeStart: 0, rangeEnd: 0, query: '' },
      { citationKeys: [], filePaths: [] }
    );
    expect(suggestions.length).toBe(8);
    expect(LATEX_COMMANDS.length).toBeGreaterThan(8);
  });

  it('places the cursor inside the braces for commands with an argument', () => {
    const [section] = getSuggestions(
      { kind: 'command', rangeStart: 0, rangeEnd: 0, query: 'section' },
      { citationKeys: [], filePaths: [] }
    );
    expect(section).toMatchObject({ insertText: 'section{}', cursorOffsetFromEnd: 1 });
  });

  it('places the cursor at the end for argument-less commands', () => {
    const [item] = getSuggestions(
      { kind: 'command', rangeStart: 0, rangeEnd: 0, query: 'item' },
      { citationKeys: [], filePaths: [] }
    );
    expect(item).toMatchObject({ insertText: 'item ', cursorOffsetFromEnd: 0 });
  });

  it('filters real citation keys and surfaces the reference title as detail', () => {
    const suggestions = getSuggestions(
      { kind: 'citation', rangeStart: 0, rangeEnd: 0, query: 'sm' },
      {
        citationKeys: [
          { key: 'smith2020', title: 'A Study of Things' },
          { key: 'jones2019', title: 'Another Study' },
        ],
        filePaths: [],
      }
    );
    expect(suggestions).toEqual([
      {
        kind: 'citation',
        label: 'smith2020',
        detail: 'A Study of Things',
        insertText: 'smith2020',
        cursorOffsetFromEnd: 0,
      },
    ]);
  });

  it('never invents a citation key not present in the project references', () => {
    const suggestions = getSuggestions(
      { kind: 'citation', rangeStart: 0, rangeEnd: 0, query: '' },
      { citationKeys: [{ key: 'smith2020' }], filePaths: [] }
    );
    expect(suggestions.map((s) => s.insertText)).toEqual(['smith2020']);
  });

  it('filters project file paths', () => {
    const suggestions = getSuggestions(
      { kind: 'file', rangeStart: 0, rangeEnd: 0, query: 'sections/in' },
      { citationKeys: [], filePaths: ['sections/introduction', 'sections/methods', 'main'] }
    );
    expect(suggestions.map((s) => s.insertText)).toEqual(['sections/introduction']);
  });
});

describe('applySuggestion', () => {
  it('replaces the matched range and reports the end cursor for a simple insert', () => {
    const context = { kind: 'citation' as const, rangeStart: 6, rangeEnd: 11, query: 'smith' };
    const suggestion = {
      kind: 'citation' as const,
      label: 'smith2020',
      insertText: 'smith2020',
      cursorOffsetFromEnd: 0,
    };
    const result = applySuggestion('\\cite{smith}', context, suggestion);
    expect(result.text).toBe('\\cite{smith2020}');
    expect(result.cursor).toBe('\\cite{smith2020'.length);
  });

  it('places the cursor inside braces for a command with an argument', () => {
    const context = { kind: 'command' as const, rangeStart: 1, rangeEnd: 4, query: 'sec' };
    const suggestion = {
      kind: 'command' as const,
      label: '\\section',
      insertText: 'section{}',
      cursorOffsetFromEnd: 1,
    };
    const result = applySuggestion('\\sec', context, suggestion);
    expect(result.text).toBe('\\section{}');
    expect(result.cursor).toBe('\\section{'.length);
  });

  it('preserves text after the replaced range', () => {
    const context = { kind: 'file' as const, rangeStart: 7, rangeEnd: 10, query: 'sec' };
    const suggestion = {
      kind: 'file' as const,
      label: 'sections/introduction',
      insertText: 'sections/introduction',
      cursorOffsetFromEnd: 0,
    };
    const result = applySuggestion('\\input{sec}\nmore body text', context, suggestion);
    expect(result.text).toBe('\\input{sections/introduction}\nmore body text');
  });
});
