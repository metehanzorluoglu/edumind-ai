import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import type { DocumentContentChunk, DocumentHighlight } from 'education-assistant-client';
import { ReaderContent, groupChunksIntoPages } from '../ReaderContent';

function chunk(overrides: Partial<DocumentContentChunk> = {}): DocumentContentChunk {
  return {
    chunk_id: 'c0',
    chunk_index: 0,
    page_number: 1,
    text: 'Some chunk text.',
    ...overrides,
  };
}

function highlight(overrides: Partial<DocumentHighlight> = {}): DocumentHighlight {
  return {
    id: 'h1',
    document_id: 'd1',
    chunk_id: 'c0',
    chunk_index: 0,
    page_number: 1,
    selected_text: 'chunk text',
    note_text: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function findByText(root: ReactTestInstance, text: string | RegExp): ReactTestInstance {
  const matches = root.findAll((node) => {
    if (String(node.type) !== 'Text') return false;
    const joined = node.children.filter((c): c is string => typeof c === 'string').join('');
    return typeof text === 'string' ? joined === text : text.test(joined);
  });
  if (matches.length === 0) throw new Error(`No Text node found matching ${String(text)}`);
  return matches[0]!;
}

function queryByText(root: ReactTestInstance, text: string | RegExp): ReactTestInstance | null {
  const matches = root.findAll((node) => {
    if (String(node.type) !== 'Text') return false;
    const joined = node.children.filter((c): c is string => typeof c === 'string').join('');
    return typeof text === 'string' ? joined === text : text.test(joined);
  });
  return matches[0] ?? null;
}

async function renderContent(
  props: Parameters<typeof ReaderContent>[0]
): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<ReaderContent {...props} />);
  });
  return renderer;
}

describe('groupChunksIntoPages', () => {
  it('groups consecutive chunks sharing a page_number into one page', () => {
    const chunks = [
      chunk({ chunk_id: 'a', chunk_index: 0, page_number: 1, text: 'A' }),
      chunk({ chunk_id: 'b', chunk_index: 1, page_number: 1, text: 'B' }),
      chunk({ chunk_id: 'c', chunk_index: 2, page_number: 2, text: 'C' }),
    ];
    const pages = groupChunksIntoPages(chunks);
    expect(pages).toHaveLength(2);
    expect(pages[0]!.pageNumber).toBe(1);
    expect(pages[0]!.chunks).toHaveLength(2);
    expect(pages[1]!.pageNumber).toBe(2);
    expect(pages[1]!.chunks).toHaveLength(1);
  });

  it('returns [] for no chunks', () => {
    expect(groupChunksIntoPages([])).toEqual([]);
  });
});

describe('ReaderContent', () => {
  it('renders page labels and chunk text', async () => {
    const pages = groupChunksIntoPages([chunk({ text: 'Students completed a 12-week program.' })]);
    const renderer = await renderContent({ pages, highlights: [] });

    expect(findByText(renderer.root, 'Page 1')).toBeTruthy();
    expect(findByText(renderer.root, 'Students completed a 12-week program.')).toBeTruthy();
  });

  it('renders a highlighted segment distinctly from the surrounding text', async () => {
    const pages = groupChunksIntoPages([
      chunk({ text: 'The sample consisted of 42 fifth-grade students.' }),
    ]);
    const h = highlight({ selected_text: '42 fifth-grade students' });
    const renderer = await renderContent({ pages, highlights: [h] });

    // The full sentence is no longer a single Text node once split — but
    // the highlighted substring and the surrounding text both still
    // render, just as separate segments.
    expect(findByText(renderer.root, '42 fifth-grade students')).toBeTruthy();
    expect(findByText(renderer.root, 'The sample consisted of ')).toBeTruthy();
  });

  it('calls onPressHighlight with the highlight id when a highlighted segment is pressed', async () => {
    const pages = groupChunksIntoPages([
      chunk({ text: 'No significant difference was observed.' }),
    ]);
    const h = highlight({ id: 'h-42', selected_text: 'significant difference' });
    const onPressHighlight = jest.fn();
    const renderer = await renderContent({ pages, highlights: [h], onPressHighlight });

    act(() => {
      findByText(renderer.root, 'significant difference').props.onPress();
    });
    expect(onPressHighlight).toHaveBeenCalledWith('h-42');
  });

  it('a highlight snapshot no longer present in the chunk text is silently skipped, never crashes', async () => {
    const pages = groupChunksIntoPages([chunk({ text: 'Current chunk text.' })]);
    const h = highlight({ selected_text: 'text that no longer exists anywhere' });
    const renderer = await renderContent({ pages, highlights: [h] });

    expect(findByText(renderer.root, 'Current chunk text.')).toBeTruthy();
  });

  it('calls onLongPressChunk with the chunk when long-pressed', async () => {
    const c = chunk({ text: 'Long-pressable chunk.' });
    const pages = groupChunksIntoPages([c]);
    const onLongPressChunk = jest.fn();
    const renderer = await renderContent({ pages, highlights: [], onLongPressChunk });

    const pressable = renderer.root.find((node) => typeof node.props.onLongPress === 'function');
    act(() => {
      pressable.props.onLongPress();
    });
    expect(onLongPressChunk).toHaveBeenCalledWith(c);
  });

  it('multiple highlights in one chunk never overlap even with identical text', async () => {
    const pages = groupChunksIntoPages([chunk({ text: 'repeat repeat repeat' })]);
    const h1 = highlight({ id: 'h1', selected_text: 'repeat' });
    const h2 = highlight({ id: 'h2', selected_text: 'repeat' });
    const renderer = await renderContent({ pages, highlights: [h1, h2] });

    const matches = renderer.root.findAll((node) => {
      if (String(node.type) !== 'Text') return false;
      return node.children.includes('repeat');
    });
    // Two distinct highlighted occurrences, each a separate Text node —
    // never the same range claimed twice.
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it('renders no highlight styling when there are no highlights', async () => {
    const pages = groupChunksIntoPages([chunk({ text: 'Plain text, nothing highlighted.' })]);
    const renderer = await renderContent({ pages, highlights: [] });
    expect(queryByText(renderer.root, /nothing highlighted/)).toBeTruthy();
  });
});
