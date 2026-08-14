import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import type { DocumentHighlight } from 'education-assistant-client';
import { HighlightsPanel } from '../HighlightsPanel';

function highlight(overrides: Partial<DocumentHighlight> = {}): DocumentHighlight {
  return {
    id: 'h1',
    document_id: 'd1',
    chunk_id: 'c0',
    chunk_index: 0,
    page_number: 3,
    selected_text: 'Students completed a 12-week program.',
    note_text: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function textOf(node: ReactTestInstance): string {
  return node.children
    .map((c) => (typeof c === 'string' || typeof c === 'number' ? String(c) : ''))
    .join('');
}

function findByText(root: ReactTestInstance, text: string): ReactTestInstance {
  const matches = root.findAll((node) => String(node.type) === 'Text' && textOf(node) === text);
  if (matches.length === 0) throw new Error(`No Text node found with content "${text}"`);
  return matches[0]!;
}

function queryByText(root: ReactTestInstance, text: string): ReactTestInstance | null {
  const matches = root.findAll((node) => String(node.type) === 'Text' && textOf(node) === text);
  return matches[0] ?? null;
}

function findPressableByLabel(root: ReactTestInstance, label: string): ReactTestInstance {
  return root.find(
    (node) => typeof node.props.onPress === 'function' && node.props.accessibilityLabel === label
  );
}

async function renderPanel(props: Partial<Parameters<typeof HighlightsPanel>[0]> = {}) {
  let renderer!: ReactTestRenderer;
  const defaults: Parameters<typeof HighlightsPanel>[0] = {
    highlights: [],
    loading: false,
    onGoTo: jest.fn(),
    onEditNote: jest.fn(),
    onDelete: jest.fn(),
    deletingIds: new Set(),
  };
  await act(async () => {
    renderer = create(<HighlightsPanel {...defaults} {...props} />);
  });
  return renderer;
}

describe('HighlightsPanel', () => {
  it('shows an empty state when there are no highlights', async () => {
    const renderer = await renderPanel();
    expect(findByText(renderer.root, 'No highlights yet.')).toBeTruthy();
  });

  it('shows a loading spinner while loading with no highlights yet', async () => {
    const renderer = await renderPanel({ loading: true });
    expect(renderer.root.find((n) => String(n.type) === 'ActivityIndicator')).toBeTruthy();
  });

  it('renders each highlight excerpt, page, and note', async () => {
    const h = highlight({ note_text: 'Worth revisiting.' });
    const renderer = await renderPanel({ highlights: [h] });

    expect(findByText(renderer.root, 'Page 3')).toBeTruthy();
    expect(findByText(renderer.root, '“Students completed a 12-week program.”')).toBeTruthy();
    expect(findByText(renderer.root, 'Worth revisiting.')).toBeTruthy();
    expect(findByText(renderer.root, 'Highlights (1)')).toBeTruthy();
  });

  it('shows "Add note" for a highlight with no note, "Edit note" for one that has one', async () => {
    const withoutNote = await renderPanel({ highlights: [highlight({ note_text: null })] });
    expect(queryByText(withoutNote.root, 'Add note')).toBeTruthy();
    expect(queryByText(withoutNote.root, 'Edit note')).toBeNull();

    const withNote = await renderPanel({ highlights: [highlight({ note_text: 'A note.' })] });
    expect(queryByText(withNote.root, 'Edit note')).toBeTruthy();
  });

  it('calls onGoTo when the excerpt is pressed', async () => {
    const onGoTo = jest.fn();
    const h = highlight();
    const renderer = await renderPanel({ highlights: [h], onGoTo });

    act(() => {
      findPressableByLabel(
        renderer.root,
        `Go to highlighted passage on page 3: ${h.selected_text}`
      ).props.onPress();
    });
    expect(onGoTo).toHaveBeenCalledWith(h);
  });

  it('calls onEditNote when "Add note"/"Edit note" is pressed', async () => {
    const onEditNote = jest.fn();
    const h = highlight();
    const renderer = await renderPanel({ highlights: [h], onEditNote });

    act(() => {
      findPressableByLabel(renderer.root, 'Add note for highlight on page 3').props.onPress();
    });
    expect(onEditNote).toHaveBeenCalledWith(h);
  });

  it('calls onDelete when Delete is pressed, and shows a spinner instead while deleting', async () => {
    const onDelete = jest.fn();
    const h = highlight();
    const renderer = await renderPanel({ highlights: [h], onDelete });

    act(() => {
      findPressableByLabel(renderer.root, 'Delete highlight on page 3').props.onPress();
    });
    expect(onDelete).toHaveBeenCalledWith(h);

    const deleting = await renderPanel({ highlights: [h], deletingIds: new Set([h.id]) });
    expect(queryByText(deleting.root, 'Delete')).toBeNull();
  });

  it('renders a close button only when onClose is provided (mobile sheet)', async () => {
    const withoutClose = await renderPanel();
    expect(
      withoutClose.root.findAll((n) => n.props.accessibilityLabel === 'Close highlights panel')
    ).toHaveLength(0);

    const onClose = jest.fn();
    const withClose = await renderPanel({ onClose });
    act(() => {
      findPressableByLabel(withClose.root, 'Close highlights panel').props.onPress();
    });
    expect(onClose).toHaveBeenCalled();
  });
});
