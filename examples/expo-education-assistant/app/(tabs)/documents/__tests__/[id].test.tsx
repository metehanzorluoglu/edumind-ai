import { Platform } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { AuthProvider } from '@/lib/AuthProvider';
import { ClientProvider } from '@/lib/ClientProvider';
import DocumentReaderScreen from '../[id]';
import type { ReaderSelection } from '@/lib/useReaderSelection';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

const mockPush = jest.fn();
const mockParams: { id: string; page?: string; highlightId?: string; chunkId?: string } = {
  id: 'doc-1',
};
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn() }),
  useLocalSearchParams: () => mockParams,
  usePathname: () => '/documents/doc-1',
  useGlobalSearchParams: () => ({}),
}));

// useReaderSelection is real-DOM-selection-driven (see its own module
// docs) — react-test-renderer has no real DOM, so this mock lets tests
// drive the SelectionToolbar/Ask-EduM8/Highlight/Add-note flows
// deterministically via `setMockSelection`, the same way the milestone's
// real-browser scenarios exercise the real hook.
let mockSelection: ReaderSelection | null = null;
const mockClearSelection = jest.fn(() => {
  mockSelection = null;
});
jest.mock('@/lib/useReaderSelection', () => ({
  useReaderSelection: () => ({ selection: mockSelection, clear: mockClearSelection }),
}));

function setMockSelection(selection: ReaderSelection | null): void {
  mockSelection = selection;
}

function textOf(node: ReactTestInstance): string {
  return node.children
    .map((c) => (typeof c === 'string' || typeof c === 'number' ? String(c) : ''))
    .join('');
}

function findByText(root: ReactTestInstance, text: string | RegExp): ReactTestInstance {
  const matches = root.findAll((node) => {
    if (String(node.type) !== 'Text') return false;
    const joined = textOf(node);
    return typeof text === 'string' ? joined === text : text.test(joined);
  });
  if (matches.length === 0) throw new Error(`No Text node found matching ${String(text)}`);
  return matches[0]!;
}

function queryByText(root: ReactTestInstance, text: string | RegExp): ReactTestInstance | null {
  const matches = root.findAll((node) => {
    if (String(node.type) !== 'Text') return false;
    const joined = textOf(node);
    return typeof text === 'string' ? joined === text : text.test(joined);
  });
  return matches[0] ?? null;
}

function findPressableByText(root: ReactTestInstance, text: string): ReactTestInstance {
  return root.find(
    (node) =>
      typeof node.props.onPress === 'function' &&
      node.findAll((n) => String(n.type) === 'Text' && textOf(n) === text).length > 0
  );
}

function findPressableByLabel(root: ReactTestInstance, label: string): ReactTestInstance {
  return root.find(
    (node) => typeof node.props.onPress === 'function' && node.props.accessibilityLabel === label
  );
}

/** The jest/RN test environment's default window width is narrower than
 * MOBILE_BREAKPOINT_PX, so the highlights panel only exists inside the
 * mobile sheet (closed by default) — open it first, exactly like a real
 * mobile user would via the toolbar's "Highlights (N)" button, before any
 * test that needs to reach panel content. A no-op if the panel is already
 * visible (desktop-width real-browser runs). */
function ensureHighlightsPanelOpen(root: ReactTestInstance): void {
  const toggle = root.findAll(
    (node) =>
      typeof node.props.onPress === 'function' &&
      node.findAll((n) => String(n.type) === 'Text' && textOf(n).startsWith('Highlights ('))
        .length > 0
  );
  if (toggle.length > 0) {
    act(() => {
      toggle[0]!.props.onPress();
    });
  }
}

interface FetchRoute {
  method: string;
  matches: (url: string) => boolean;
  respond: (url: string, init?: RequestInit) => Response;
}

function installFetchMock(routes: FetchRoute[]) {
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = (init?.method ?? 'GET').toUpperCase();
    const route = routes.find((r) => r.method === method && r.matches(url));
    if (!route) throw new Error(`Unhandled ${method} ${url} in this test`);
    return route.respond(url, init);
  }) as unknown as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

const CONTENT = {
  document_id: 'doc-1',
  title: 'A Study',
  source_filename: 'paper-a.pdf',
  file_format: 'pdf',
  page_count: 1,
  chunks: [
    {
      chunk_id: 'chunk-0',
      chunk_index: 0,
      page_number: 1,
      text: 'Students completed a 12-week program.',
    },
  ],
};

function contentRoute(body: unknown = CONTENT, status = 200): FetchRoute {
  return {
    method: 'GET',
    matches: (u) => u.includes('/documents/doc-1/content'),
    respond: () => jsonResponse(body, status),
  };
}

function highlightsRoute(highlights: unknown[] = []): FetchRoute {
  return {
    method: 'GET',
    // Deliberately excludes the .../highlights/{id}/notebooks membership
    // endpoint (a different, more specific route below) even though it's
    // a URL substring match of this one — route arrays are matched in
    // order, but keeping the two mutually exclusive here avoids relying
    // on that ordering.
    matches: (u) => u.includes('/documents/doc-1/highlights') && !u.endsWith('/notebooks'),
    respond: () => jsonResponse({ highlights }),
  };
}

function notebookMembershipRoute(byHighlightId: Record<string, unknown[]>): FetchRoute {
  return {
    method: 'GET',
    matches: (u) => u.includes('/documents/doc-1/highlights/') && u.endsWith('/notebooks'),
    respond: (u) => {
      const highlightId = u.split('/highlights/')[1]?.split('/')[0] ?? '';
      return jsonResponse({ notebooks: byHighlightId[highlightId] ?? [] });
    },
  };
}

function createHighlightRoute(response: unknown): FetchRoute {
  return {
    method: 'POST',
    matches: (u) => u.includes('/documents/doc-1/highlights'),
    respond: () => jsonResponse(response, 201),
  };
}

function patchHighlightRoute(response: unknown): FetchRoute {
  return {
    method: 'PATCH',
    matches: (u) => u.includes('/documents/doc-1/highlights/'),
    respond: () => jsonResponse(response),
  };
}

function deleteHighlightRoute(): FetchRoute {
  return {
    method: 'DELETE',
    matches: (u) => u.includes('/documents/doc-1/highlights/'),
    respond: () => new Response(null, { status: 204 }),
  };
}

async function flushAsync(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function renderReader(routes: FetchRoute[]): Promise<ReactTestRenderer> {
  installFetchMock(routes);
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <AuthProvider>
        <ClientProvider>
          <DocumentReaderScreen />
        </ClientProvider>
      </AuthProvider>
    );
    await flushAsync();
  });
  return renderer;
}

const SELECTION: ReaderSelection = {
  text: 'a 12-week program',
  chunkId: 'chunk-0',
  chunkIndex: 0,
  pageNumber: 1,
  rect: { top: 100, left: 100, width: 80, height: 20 },
};

describe('DocumentReaderScreen', () => {
  beforeEach(() => {
    mockParams.id = 'doc-1';
    mockParams.page = undefined;
    mockParams.highlightId = undefined;
    mockParams.chunkId = undefined;
    setMockSelection(null);
    mockPush.mockClear();
    mockClearSelection.mockClear();
  });

  it('shows the document title, page, and extracted text once loaded', async () => {
    const renderer = await renderReader([contentRoute(), highlightsRoute()]);
    expect(findByText(renderer.root, 'A Study')).toBeTruthy();
    expect(findByText(renderer.root, 'Page 1')).toBeTruthy();
    expect(findByText(renderer.root, 'Students completed a 12-week program.')).toBeTruthy();
  });

  it('Milestone 4: shows an author/year byline alongside the title when known', async () => {
    const renderer = await renderReader([
      contentRoute({ ...CONTENT, authors: ['Jeff Forrester', 'Jane Doe'], publication_year: 2004 }),
      highlightsRoute(),
    ]);
    expect(findByText(renderer.root, 'Forrester et al. · 2004')).toBeTruthy();
  });

  it('Milestone 4: shows no byline at all for a document with no known authors/year', async () => {
    const renderer = await renderReader([contentRoute(), highlightsRoute()]);
    // CONTENT has no authors/publication_year — nothing fabricated, no
    // empty "·" separator floating in the header either.
    expect(queryByText(renderer.root, /·/)).toBeNull();
  });

  it('shows a "no readable text" state with a Use in chat fallback when there are no chunks', async () => {
    const renderer = await renderReader([
      contentRoute({ ...CONTENT, chunks: [] }),
      highlightsRoute(),
    ]);
    expect(findByText(renderer.root, 'No readable text for this document.')).toBeTruthy();
  });

  it('shows an error state with a retry action on a failed content load', async () => {
    const renderer = await renderReader([contentRoute({ detail: 'not found' }, 404)]);
    expect(findByText(renderer.root, "Couldn't load this document.")).toBeTruthy();
  });

  it('shows saved highlights in the panel', async () => {
    const highlight = {
      id: 'h1',
      document_id: 'doc-1',
      chunk_id: 'chunk-0',
      chunk_index: 0,
      page_number: 1,
      selected_text: 'a 12-week program',
      note_text: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    };
    const renderer = await renderReader([contentRoute(), highlightsRoute([highlight])]);
    expect(findByText(renderer.root, 'Highlights (1)')).toBeTruthy();
  });

  it('Back to Documents navigates to /documents', async () => {
    const renderer = await renderReader([contentRoute(), highlightsRoute()]);
    act(() => {
      findPressableByLabel(renderer.root, 'Back to Documents').props.onPress();
    });
    expect(mockPush).toHaveBeenCalledWith('/documents');
  });

  it('Use in chat navigates to /chat/new with this document as a source, no re-upload', async () => {
    const renderer = await renderReader([contentRoute(), highlightsRoute()]);
    act(() => {
      findPressableByText(renderer.root, 'Use in chat').props.onPress();
    });
    expect(mockPush).toHaveBeenCalledWith(
      expect.objectContaining({
        pathname: '/chat/new',
        params: { sources: JSON.stringify([{ documentId: 'doc-1', displayName: 'A Study' }]) },
      })
    );
  });

  describe('selection toolbar (desktop)', () => {
    const originalOS = Platform.OS;
    beforeEach(() => {
      Platform.OS = 'web';
    });
    afterEach(() => {
      Platform.OS = originalOS;
    });

    it('Highlight creates a highlight anchored to the selection and refreshes the list', async () => {
      installFetchMock([
        contentRoute(),
        highlightsRoute(),
        createHighlightRoute({
          id: 'h1',
          document_id: 'doc-1',
          chunk_id: 'chunk-0',
          chunk_index: 0,
          page_number: 1,
          selected_text: 'a 12-week program',
          note_text: null,
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
        }),
      ]);
      let renderer!: ReactTestRenderer;
      await act(async () => {
        renderer = create(
          <AuthProvider>
            <ClientProvider>
              <DocumentReaderScreen />
            </ClientProvider>
          </AuthProvider>
        );
        await flushAsync();
      });

      setMockSelection(SELECTION);
      await act(async () => {
        renderer.update(
          <AuthProvider>
            <ClientProvider>
              <DocumentReaderScreen />
            </ClientProvider>
          </AuthProvider>
        );
      });

      await act(async () => {
        findPressableByText(renderer.root, 'Highlight').props.onPress();
        await flushAsync();
      });

      const postCall = (global.fetch as jest.Mock).mock.calls.find(
        ([url, init]: [string, RequestInit]) =>
          init?.method === 'POST' && String(url).includes('/highlights')
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse(postCall[1].body as string);
      expect(body).toEqual({
        chunk_id: 'chunk-0',
        chunk_index: 0,
        page_number: 1,
        selected_text: 'a 12-week program',
        note_text: null,
        visual_anchor: null,
      });
      expect(mockClearSelection).toHaveBeenCalled();
    });

    it('Add note opens the note editor prefilled with the selection', async () => {
      installFetchMock([contentRoute(), highlightsRoute()]);
      let renderer!: ReactTestRenderer;
      await act(async () => {
        renderer = create(
          <AuthProvider>
            <ClientProvider>
              <DocumentReaderScreen />
            </ClientProvider>
          </AuthProvider>
        );
        await flushAsync();
      });
      setMockSelection(SELECTION);
      await act(async () => {
        renderer.update(
          <AuthProvider>
            <ClientProvider>
              <DocumentReaderScreen />
            </ClientProvider>
          </AuthProvider>
        );
      });

      act(() => {
        findPressableByText(renderer.root, 'Add note').props.onPress();
      });

      expect(findByText(renderer.root, '“a 12-week program”')).toBeTruthy();
    });

    it('Ask EduM8 navigates to /chat/new with sources AND selectionContext', async () => {
      installFetchMock([contentRoute(), highlightsRoute()]);
      let renderer!: ReactTestRenderer;
      await act(async () => {
        renderer = create(
          <AuthProvider>
            <ClientProvider>
              <DocumentReaderScreen />
            </ClientProvider>
          </AuthProvider>
        );
        await flushAsync();
      });
      setMockSelection(SELECTION);
      await act(async () => {
        renderer.update(
          <AuthProvider>
            <ClientProvider>
              <DocumentReaderScreen />
            </ClientProvider>
          </AuthProvider>
        );
      });

      act(() => {
        findPressableByText(renderer.root, 'Ask EduM8').props.onPress();
      });

      expect(mockPush).toHaveBeenCalledWith(
        expect.objectContaining({
          pathname: '/chat/new',
          params: expect.objectContaining({
            sources: JSON.stringify([{ documentId: 'doc-1', displayName: 'A Study' }]),
            selectionContext: JSON.stringify({
              documentId: 'doc-1',
              documentName: 'A Study',
              pageNumber: 1,
              selectedText: 'a 12-week program',
            }),
          }),
        })
      );
      expect(mockClearSelection).toHaveBeenCalled();
    });
  });

  describe('highlights panel actions', () => {
    const HIGHLIGHT = {
      id: 'h1',
      document_id: 'doc-1',
      chunk_id: 'chunk-0',
      chunk_index: 0,
      page_number: 1,
      selected_text: 'a 12-week program',
      note_text: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    };

    it('Delete removes the highlight', async () => {
      installFetchMock([contentRoute(), highlightsRoute([HIGHLIGHT]), deleteHighlightRoute()]);
      let renderer!: ReactTestRenderer;
      await act(async () => {
        renderer = create(
          <AuthProvider>
            <ClientProvider>
              <DocumentReaderScreen />
            </ClientProvider>
          </AuthProvider>
        );
        await flushAsync();
      });
      ensureHighlightsPanelOpen(renderer.root);

      await act(async () => {
        findPressableByLabel(renderer.root, 'Delete highlight on page 1').props.onPress();
        await flushAsync();
      });

      const deleteCall = (global.fetch as jest.Mock).mock.calls.find(
        ([url, init]: [string, RequestInit]) =>
          init?.method === 'DELETE' && String(url).includes('/highlights/')
      );
      expect(deleteCall).toBeTruthy();
    });

    it('Edit note opens the editor and Save PATCHes the note', async () => {
      installFetchMock([
        contentRoute(),
        highlightsRoute([HIGHLIGHT]),
        patchHighlightRoute({ ...HIGHLIGHT, note_text: 'Worth revisiting.' }),
      ]);
      let renderer!: ReactTestRenderer;
      await act(async () => {
        renderer = create(
          <AuthProvider>
            <ClientProvider>
              <DocumentReaderScreen />
            </ClientProvider>
          </AuthProvider>
        );
        await flushAsync();
      });
      ensureHighlightsPanelOpen(renderer.root);

      act(() => {
        findPressableByLabel(renderer.root, 'Add note for highlight on page 1').props.onPress();
      });

      const input = renderer.root.find((n) => String(n.type) === 'TextInput');
      act(() => {
        input.props.onChangeText('Worth revisiting.');
      });
      await act(async () => {
        findPressableByText(renderer.root, 'Save').props.onPress();
        await flushAsync();
      });

      const patchCall = (global.fetch as jest.Mock).mock.calls.find(
        ([url, init]: [string, RequestInit]) =>
          init?.method === 'PATCH' && String(url).includes('/highlights/')
      );
      expect(patchCall).toBeTruthy();
      expect(JSON.parse(patchCall[1].body as string)).toEqual({
        note_text: 'Worth revisiting.',
      });
    });
  });

  describe('mobile long-press fallback', () => {
    it('long-pressing a chunk opens the action sheet with the whole chunk text', async () => {
      const renderer = await renderReader([contentRoute(), highlightsRoute()]);

      const pressableChunk = renderer.root.find(
        (node) => typeof node.props.onLongPress === 'function'
      );
      act(() => {
        pressableChunk.props.onLongPress();
      });

      expect(findByText(renderer.root, '“Students completed a 12-week program.”')).toBeTruthy();
      expect(queryByText(renderer.root, 'Highlight')).toBeTruthy();
    });
  });

  describe('M3.2 §5/§27 — incoming page/highlight/chunk anchor from a Notebook "Open source"', () => {
    it('flashes the matching chunk when arriving with page+chunkId params (no retained original file)', async () => {
      mockParams.page = '1';
      mockParams.chunkId = 'chunk-0';
      const renderer = await renderReader([contentRoute(), highlightsRoute()]);

      const readerContent = renderer.root.find(
        (n) => n.props && Object.prototype.hasOwnProperty.call(n.props, 'highlightedChunkId')
      );
      expect(readerContent.props.highlightedChunkId).toBe('chunk-0');

      // Let the component's own FLASH_DURATION_MS timer (which clears
      // flashedChunkId) fire inside act() rather than after the test
      // finishes, so it doesn't warn on a later test's render.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 1650));
      });
    });

    it('does nothing extra when no page param is present (ordinary open, unchanged M3.1 behavior)', async () => {
      const renderer = await renderReader([contentRoute(), highlightsRoute()]);
      const readerContent = renderer.root.find(
        (n) => n.props && Object.prototype.hasOwnProperty.call(n.props, 'highlightedChunkId')
      );
      expect(readerContent.props.highlightedChunkId).toBeNull();
    });
  });

  describe('M3.2 §22 — Reader highlight "Saved to" notebook membership', () => {
    it('shows "Saved to: <notebook>" for a highlight already saved to one notebook', async () => {
      const renderer = await renderReader([
        contentRoute(),
        highlightsRoute([
          {
            id: 'h1',
            document_id: 'doc-1',
            chunk_id: 'chunk-0',
            chunk_index: 0,
            page_number: 1,
            selected_text: 'a 12-week program',
            note_text: null,
            visual_anchor: null,
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
          },
        ]),
        notebookMembershipRoute({
          h1: [{ id: 'nb-1', name: 'Lit Review', entry_count: 1, created_at: '', updated_at: '' }],
        }),
      ]);
      ensureHighlightsPanelOpen(renderer.root);
      await act(async () => {
        await flushAsync();
      });
      expect(findByText(renderer.root, 'Saved to: Lit Review')).toBeTruthy();
    });

    it('shows "Saved to: N notebooks" when saved to more than one', async () => {
      const renderer = await renderReader([
        contentRoute(),
        highlightsRoute([
          {
            id: 'h1',
            document_id: 'doc-1',
            chunk_id: 'chunk-0',
            chunk_index: 0,
            page_number: 1,
            selected_text: 'a 12-week program',
            note_text: null,
            visual_anchor: null,
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
          },
        ]),
        notebookMembershipRoute({
          h1: [
            { id: 'nb-1', name: 'Lit Review', entry_count: 1, created_at: '', updated_at: '' },
            { id: 'nb-2', name: 'Methods', entry_count: 1, created_at: '', updated_at: '' },
          ],
        }),
      ]);
      ensureHighlightsPanelOpen(renderer.root);
      await act(async () => {
        await flushAsync();
      });
      expect(findByText(renderer.root, 'Saved to: 2 notebooks')).toBeTruthy();
    });
  });
});
