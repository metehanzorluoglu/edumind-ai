import { Platform } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { AuthProvider } from '@/lib/AuthProvider';
import { ClientProvider } from '@/lib/ClientProvider';
import NotebookDetailScreen from '../[id]';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

const mockPush = jest.fn();
const mockParams: { id: string } = { id: 'nb-1' };
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn() }),
  useLocalSearchParams: () => mockParams,
  usePathname: () => '/notes/nb-1',
  useGlobalSearchParams: () => ({}),
}));

const originalOS = Platform.OS;
beforeAll(() => {
  Platform.OS = 'web';
});
afterAll(() => {
  Platform.OS = originalOS;
});

function textOf(node: ReactTestInstance): string {
  return node.children
    .map((c) => (typeof c === 'string' || typeof c === 'number' ? String(c) : ''))
    .join('');
}

function findByTextIncluding(root: ReactTestInstance, substring: string): ReactTestInstance {
  const matches = root.findAll(
    (node) => String(node.type) === 'Text' && textOf(node).includes(substring)
  );
  if (matches.length === 0)
    throw new Error(`No Text node found containing ${JSON.stringify(substring)}`);
  return matches[0]!;
}

function queryByTextIncluding(
  root: ReactTestInstance,
  substring: string
): ReactTestInstance | null {
  const matches = root.findAll(
    (node) => String(node.type) === 'Text' && textOf(node).includes(substring)
  );
  return matches[0] ?? null;
}

function findPressableByLabel(root: ReactTestInstance, label: string): ReactTestInstance {
  return root.find(
    (node) => typeof node.props.onPress === 'function' && node.props.accessibilityLabel === label
  );
}

interface FetchRoute {
  method: string;
  matches: (url: string) => boolean;
  respond: () => Response;
}

function installFetchMock(routes: FetchRoute[]) {
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = (init?.method ?? 'GET').toUpperCase();
    const route = routes.find((r) => r.method === method && r.matches(url));
    if (!route) throw new Error(`Unhandled ${method} ${url} in this test`);
    return route.respond();
  }) as unknown as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

const NOTEBOOK = {
  id: 'nb-1',
  name: 'Reading List',
  entry_count: 2,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

const HIGHLIGHT_ENTRY = {
  id: 'e1',
  notebook_id: 'nb-1',
  entry_type: 'highlight',
  highlight_id: 'h1',
  document_id: 'doc-1',
  document_title: 'AI Education',
  page_number: 3,
  excerpt: 'Students completed a 12-week program.',
  note_text: 'Worth citing.',
  chunk_id: 'c0',
  chunk_index: 0,
  visual_anchor: null,
  source_available: true,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

const MANUAL_ENTRY = {
  id: 'e2',
  notebook_id: 'nb-1',
  entry_type: 'manual',
  highlight_id: null,
  document_id: null,
  document_title: null,
  page_number: null,
  excerpt: null,
  note_text: 'A standalone thought.',
  chunk_id: null,
  chunk_index: null,
  visual_anchor: null,
  source_available: false,
  created_at: '2026-01-02T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
};

// M3.1 final real-browser validation: a highlight-derived entry whose
// source document has since been deleted. document_id stays populated
// (a snapshot — see NotebookEntry's backend docstring) but
// source_available flips to false; the UI must key off THAT, never off
// document_id's mere presence.
const ORPHANED_ENTRY = {
  ...HIGHLIGHT_ENTRY,
  id: 'e3',
  source_available: false,
};

function listNotebooksRoute(): FetchRoute {
  return {
    method: 'GET',
    matches: (u) => u.includes('/notebooks?') && !u.includes('/entries'),
    respond: () => jsonResponse({ notebooks: [NOTEBOOK], total: 1 }),
  };
}

function listEntriesRoute(entries: unknown[]): FetchRoute {
  return {
    method: 'GET',
    matches: (u) => u.includes('/notebooks/nb-1/entries'),
    respond: () => jsonResponse({ entries, total: entries.length }),
  };
}

async function flushAsync(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function renderScreen(routes: FetchRoute[]): Promise<ReactTestRenderer> {
  installFetchMock(routes);
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <AuthProvider>
        <ClientProvider>
          <NotebookDetailScreen />
        </ClientProvider>
      </AuthProvider>
    );
    await flushAsync();
  });
  return renderer;
}

describe('NotebookDetailScreen', () => {
  beforeEach(() => {
    mockPush.mockClear();
  });

  it('renders SOURCE EXCERPT and MY NOTE as visually separate blocks for a highlight-derived entry', async () => {
    const renderer = await renderScreen([
      listNotebooksRoute(),
      listEntriesRoute([HIGHLIGHT_ENTRY]),
    ]);
    expect(findByTextIncluding(renderer.root, 'EXCERPT')).toBeTruthy();
    expect(
      findByTextIncluding(renderer.root, 'Students completed a 12-week program.')
    ).toBeTruthy();
    expect(findByTextIncluding(renderer.root, 'MY NOTE')).toBeTruthy();
    expect(findByTextIncluding(renderer.root, 'Worth citing.')).toBeTruthy();
  });

  it('renders a manual entry as just MY NOTE, no excerpt block', async () => {
    const renderer = await renderScreen([listNotebooksRoute(), listEntriesRoute([MANUAL_ENTRY])]);
    expect(findByTextIncluding(renderer.root, 'A standalone thought.')).toBeTruthy();
    expect(queryByTextIncluding(renderer.root, 'EXCERPT')).toBeNull();
  });

  it('shows an empty state with Add note / Browse Documents actions when the notebook has no entries', async () => {
    const renderer = await renderScreen([listNotebooksRoute(), listEntriesRoute([])]);
    expect(findByTextIncluding(renderer.root, 'No research notes here yet.')).toBeTruthy();
    expect(findPressableByLabel(renderer.root, 'Add note')).toBeTruthy();
    expect(findPressableByLabel(renderer.root, 'Browse Documents')).toBeTruthy();
  });

  it('"Open source" navigates to the document Reader with page/highlight/chunk anchors (M3.2 §5/§27)', async () => {
    const renderer = await renderScreen([
      listNotebooksRoute(),
      listEntriesRoute([HIGHLIGHT_ENTRY]),
    ]);
    act(() => {
      findPressableByLabel(renderer.root, 'Open source for entry e1').props.onPress();
    });
    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/documents/[id]',
      params: { id: 'doc-1', page: '3', highlightId: 'h1', chunkId: 'c0' },
    });
  });

  it('a manual entry with no document_id shows no "Open source" action', async () => {
    const renderer = await renderScreen([listNotebooksRoute(), listEntriesRoute([MANUAL_ENTRY])]);
    expect(
      renderer.root.findAll(
        (n) =>
          typeof n.props.onPress === 'function' &&
          n.props.accessibilityLabel === 'Open source for entry e2'
      )
    ).toHaveLength(0);
  });

  it('an entry whose source document was deleted shows "Source unavailable" and disables Open source (M3.1 preservation semantics)', async () => {
    const renderer = await renderScreen([listNotebooksRoute(), listEntriesRoute([ORPHANED_ENTRY])]);
    // The excerpt/note snapshot is still shown — the record itself is intact.
    expect(
      findByTextIncluding(renderer.root, 'Students completed a 12-week program.')
    ).toBeTruthy();
    expect(findByTextIncluding(renderer.root, 'Source unavailable')).toBeTruthy();
    // No enabled "Open source" pressable for this entry — document_id is
    // still non-null on ORPHANED_ENTRY, so this specifically proves the
    // UI keys off source_available, not document_id's mere presence.
    expect(
      renderer.root.findAll(
        (n) =>
          typeof n.props.onPress === 'function' &&
          n.props.accessibilityLabel === 'Open source for entry e3'
      )
    ).toHaveLength(0);
  });

  it('"Remove from notebook" (via the entry\'s "More" menu) DELETEs the entry and removes it from the list', async () => {
    let deleteCalled = false;
    const renderer = await renderScreen([
      listNotebooksRoute(),
      listEntriesRoute([HIGHLIGHT_ENTRY]),
      {
        method: 'DELETE',
        matches: (u) => u.includes('/notebooks/nb-1/entries/e1'),
        respond: () => {
          deleteCalled = true;
          return new Response(null, { status: 204 });
        },
      },
    ]);

    // M3.2 §6: row actions are restrained to Ask EduM8/Open source — the
    // destructive "Remove from notebook" only appears inside the entry's
    // "More" menu, not as a fifth always-visible row button.
    act(() => {
      findPressableByLabel(renderer.root, 'More actions for entry e1').props.onPress();
    });
    await act(async () => {
      findPressableByLabel(renderer.root, 'Remove from notebook').props.onPress();
      await flushAsync();
    });

    expect(deleteCalled).toBe(true);
    expect(queryByTextIncluding(renderer.root, 'Students completed a 12-week program.')).toBeNull();
  });

  it('multi-selection is an explicit "Select" mode — no checkboxes in ordinary browsing (M3.2 §15)', async () => {
    const renderer = await renderScreen([
      listNotebooksRoute(),
      listEntriesRoute([HIGHLIGHT_ENTRY]),
    ]);
    expect(
      renderer.root.findAll(
        (n) =>
          typeof n.props.onPress === 'function' &&
          n.props.accessibilityLabel === 'Select entry e1 for Ask EduM8'
      )
    ).toHaveLength(0);

    act(() => {
      findPressableByLabel(renderer.root, 'Select').props.onPress();
    });
    expect(findPressableByLabel(renderer.root, 'Select entry e1 for Ask EduM8')).toBeTruthy();
  });

  it('selecting more than 5 entries for Ask EduM8 shows a clear message, never a silent truncation', async () => {
    const entries = Array.from({ length: 6 }, (_, i) => ({
      ...HIGHLIGHT_ENTRY,
      id: `e${i}`,
      excerpt: `Excerpt ${i}.`,
    }));
    const renderer = await renderScreen([listNotebooksRoute(), listEntriesRoute(entries)]);

    act(() => {
      findPressableByLabel(renderer.root, 'Select').props.onPress();
    });

    for (let i = 0; i < 5; i += 1) {
      act(() => {
        findPressableByLabel(renderer.root, `Select entry e${i} for Ask EduM8`).props.onPress();
      });
    }
    expect(findByTextIncluding(renderer.root, '5 / 5 selected')).toBeTruthy();

    act(() => {
      findPressableByLabel(renderer.root, 'Select entry e5 for Ask EduM8').props.onPress();
    });

    expect(findByTextIncluding(renderer.root, 'up to 5 notebook entries')).toBeTruthy();
    // Still 5 selected, never silently grown to 6.
    expect(findByTextIncluding(renderer.root, '5 / 5 selected')).toBeTruthy();
  });

  it('the Sort control is one compact menu, not several always-visible chips (M3.2 §13)', async () => {
    const entries = [
      {
        ...HIGHLIGHT_ENTRY,
        id: 'e1',
        document_title: 'Zebra Paper',
        created_at: '2026-01-01T00:00:00Z',
      },
      {
        ...HIGHLIGHT_ENTRY,
        id: 'e2',
        document_title: 'Apple Paper',
        created_at: '2026-01-02T00:00:00Z',
      },
    ];
    const renderer = await renderScreen([listNotebooksRoute(), listEntriesRoute(entries)]);

    expect(findPressableByLabel(renderer.root, 'Sort: Newest')).toBeTruthy();
    act(() => {
      findPressableByLabel(renderer.root, 'Sort: Newest').props.onPress();
    });
    act(() => {
      findPressableByLabel(renderer.root, 'Source').props.onPress();
    });
    expect(findPressableByLabel(renderer.root, 'Sort: Source')).toBeTruthy();
  });

  it('Filter is honestly labeled "Filter this notebook", never "Search all research" (M3.2 §12)', async () => {
    const renderer = await renderScreen([
      listNotebooksRoute(),
      listEntriesRoute([HIGHLIGHT_ENTRY]),
    ]);
    expect(findByTextIncluding(renderer.root, 'Filter this notebook')).toBeTruthy();
  });

  it('the notebook header exposes Rename and Delete via a restrained "Notebook options" menu', async () => {
    let renamePatchBody: string | null = null;
    const renderer = await renderScreen([
      listNotebooksRoute(),
      listEntriesRoute([HIGHLIGHT_ENTRY]),
      {
        method: 'PATCH',
        matches: (u) => u.includes('/notebooks/nb-1') && !u.includes('/entries'),
        respond: () => {
          renamePatchBody = 'called';
          return jsonResponse({ ...NOTEBOOK, name: 'Renamed' });
        },
      },
    ]);

    act(() => {
      findPressableByLabel(renderer.root, 'Notebook options').props.onPress();
    });
    expect(findPressableByLabel(renderer.root, 'Rename')).toBeTruthy();
    expect(findPressableByLabel(renderer.root, 'Delete notebook')).toBeTruthy();

    act(() => {
      findPressableByLabel(renderer.root, 'Rename').props.onPress();
    });
    const input = renderer.root.find(
      (n) => String(n.type) === 'TextInput' && n.props.value === 'Reading List'
    );
    act(() => {
      input.props.onChangeText('New Name');
    });
    await act(async () => {
      findPressableByLabel(renderer.root, 'Save').props.onPress();
      await flushAsync();
    });
    expect(renamePatchBody).toBe('called');
  });

  it('"Ask EduM8" on a single entry navigates to /chat/new with a one-entry notebookContext', async () => {
    const renderer = await renderScreen([
      listNotebooksRoute(),
      listEntriesRoute([HIGHLIGHT_ENTRY]),
    ]);
    act(() => {
      findPressableByLabel(renderer.root, 'Ask EduM8 about entry e1').props.onPress();
    });

    expect(mockPush).toHaveBeenCalledWith(
      expect.objectContaining({
        pathname: '/chat/new',
        params: expect.objectContaining({
          notebookContext: JSON.stringify([
            {
              sourceType: 'notebook-entry',
              documentId: 'doc-1',
              documentTitle: 'AI Education',
              pageNumber: 3,
              excerpt: 'Students completed a 12-week program.',
              userNote: 'Worth citing.',
            },
          ]),
        }),
      })
    );
  });

  it('adding a manual note POSTs entryType manual/noteText and shows it in the list after refresh', async () => {
    let stored: unknown[] = [];
    let postBody: string | null = null;
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'POST' && url.includes('/notebooks/nb-1/entries')) {
        postBody = String(init?.body);
        stored = [MANUAL_ENTRY];
        return jsonResponse(MANUAL_ENTRY, 201);
      }
      if (method === 'GET' && url.includes('/notebooks/nb-1/entries')) {
        return jsonResponse({ entries: stored, total: stored.length });
      }
      if (method === 'GET' && url.includes('/notebooks?')) {
        return jsonResponse({ notebooks: [NOTEBOOK], total: 1 });
      }
      throw new Error(`Unhandled ${method} ${url}`);
    }) as unknown as typeof fetch;

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <AuthProvider>
          <ClientProvider>
            <NotebookDetailScreen />
          </ClientProvider>
        </AuthProvider>
      );
      await flushAsync();
    });

    act(() => {
      findPressableByLabel(renderer.root, '+ Add note').props.onPress();
    });
    const input = renderer.root.find((n) => String(n.type) === 'TextInput');
    act(() => {
      input.props.onChangeText('A fresh thought.');
    });

    await act(async () => {
      findPressableByLabel(renderer.root, 'Save').props.onPress();
      await flushAsync();
    });

    expect(postBody).toBeTruthy();
    expect(JSON.parse(postBody!)).toEqual({ entry_type: 'manual', note_text: 'A fresh thought.' });
    expect(findByTextIncluding(renderer.root, 'A standalone thought.')).toBeTruthy();
  });
});
