/**
 * Frontend Milestone 1 (Finder-style Document Library) — the redesigned
 * Documents workspace (grid/list views, drag-and-drop move, multi-select,
 * details panel, actions-menu fallback), gated on featureFlags.folderLibrary
 * exactly like its Milestone 1 (Document Library / Folder Management)
 * predecessor. The pre-existing flat-list UI (folderLibrary=false) is
 * covered by documents.test.tsx, which forces the flag off for its entire
 * file and is untouched by this redesign.
 */
import { Dimensions, Platform } from 'react-native';
import { act, create, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer';
import { AuthProvider } from '@/lib/AuthProvider';
import { ClientProvider } from '@/lib/ClientProvider';
import { FeatureFlagsProvider } from '@/lib/FeatureFlags';
import { PreferencesProvider } from '@/lib/Preferences';
import { MoveToFolderDialog } from '@/components/MoveToFolderDialog';
import { DetailsPanel } from '@/components/documents/DetailsPanel';
import { planLibraryMove } from '@/lib/useLibraryDnD';
import DocumentsScreen from '../index';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

jest.mock('expo-document-picker', () => ({
  getDocumentAsync: jest.fn(),
}));

// Frontend Milestone 2 — documents.tsx's only expo-router import is
// useRouter() (for the "Use in chat" action); every other test in this
// file runs happily against the REAL module (no mock needed), but this
// override lets the "Use in chat" tests below assert on exactly what was
// navigated to.
const mockRouterPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockRouterPush, replace: jest.fn() }),
  usePathname: () => '/documents',
  useGlobalSearchParams: () => ({}),
  useLocalSearchParams: () => ({}),
}));

const DESKTOP_WINDOW = { width: 1200, height: 900, scale: 1, fontScale: 1 };
const MOBILE_WINDOW = { width: 380, height: 800, scale: 1, fontScale: 1 };

function installWindow() {
  const backing = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => backing.set(key, value),
    removeItem: (key: string) => backing.delete(key),
  };
  // @ts-expect-error minimal window stub sufficient for this test
  global.window = { localStorage, confirm: jest.fn(() => true) };
  return { localStorage };
}

function textContent(node: ReactTestInstance): string {
  return node.children.filter((child): child is string => typeof child === 'string').join('');
}

// `findAll(...)[0]`, not `.find(...)`: react-native-web's <Text
// numberOfLines={n}> can render more than one underlying Text-typed node
// for the same visible string (a measurement/truncation implementation
// detail) — `.find()` throws unless exactly one match exists.
function findByText(root: ReactTestInstance, text: string): ReactTestInstance {
  const matches = root.findAll(
    (node) => String(node.type) === 'Text' && textContent(node) === text
  );
  if (matches.length === 0)
    throw new Error(`No Text node found with content ${JSON.stringify(text)}`);
  return matches[0]!;
}

function queryByText(root: ReactTestInstance, text: string): ReactTestInstance | null {
  const matches = root.findAll(
    (node) => String(node.type) === 'Text' && textContent(node) === text
  );
  return matches[0] ?? null;
}

function findPressableByText(root: ReactTestInstance, text: string): ReactTestInstance {
  const matches = root.findAll(
    (node) => typeof node.props.onPress === 'function' && queryByText(node, text) !== null
  );
  if (matches.length === 0) {
    throw new Error(`No pressable found containing text ${JSON.stringify(text)}`);
  }
  return matches[0]!;
}

function findPressableByAccessibilityLabel(
  root: ReactTestInstance,
  label: string
): ReactTestInstance {
  return root.find(
    (node) => typeof node.props.onPress === 'function' && node.props.accessibilityLabel === label
  );
}

function queryPressableByAccessibilityLabel(
  root: ReactTestInstance,
  label: string
): ReactTestInstance | null {
  const matches = root.findAll(
    (node) => typeof node.props.onPress === 'function' && node.props.accessibilityLabel === label
  );
  return matches[0] ?? null;
}

/**
 * Finds a rendered entry's own inner Pressable (selection/activation
 * target), not the `LibraryEntry` composite instance wrapping it —
 * `findPressableByText`'s `typeof node.props.onPress === 'function'` check
 * also matches `LibraryEntry` itself (its own `onPress` prop passes
 * straight through to this inner Pressable). Distinguished by
 * `accessibilityState`: LibraryEntry.tsx sets that directly on its own
 * Pressable JSX, never passes it through as one of LibraryEntry's own
 * props, so only the real Pressable instance carries it.
 */
function entryPressable(root: ReactTestInstance, name: string): ReactTestInstance {
  const matches = root.findAll(
    (node) =>
      'accessibilityState' in node.props &&
      typeof node.props.onPress === 'function' &&
      queryByText(node, name) !== null
  );
  if (matches.length === 0) {
    throw new Error(`No entry Pressable found containing text ${JSON.stringify(name)}`);
  }
  return matches[0]!;
}

async function flushAsync(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

const AI_FOLDER = {
  id: 'f-ai',
  name: 'AI',
  parent_id: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  folder_count: 0,
  document_count: 1,
};

const CLIMATE_FOLDER = {
  id: 'f-climate',
  name: 'Climate',
  parent_id: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
  folder_count: 0,
  document_count: 0,
};

const PAPER_A = {
  document_id: 'd-paper-a',
  source_filename: 'paper-a.pdf',
  folder_id: null,
  document_type: 'report',
  chunk_count: 4,
  ingested_at: '2026-01-01T00:00:00Z',
};

const NOTES = {
  document_id: 'd-notes',
  source_filename: 'notes.txt',
  folder_id: null,
  document_type: 'report',
  chunk_count: 1,
  ingested_at: '2026-01-03T00:00:00Z',
};

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
    if (!route) {
      throw new Error(`Unhandled ${method} ${url} in this test`);
    }
    return route.respond(url, init);
  }) as unknown as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** The root listing used by most tests: two folders (AI, Climate) and two
 * documents (paper-a.pdf, notes.txt), all at root. */
function rootContentsRoute(): FetchRoute {
  return {
    method: 'GET',
    matches: (u) => u.includes('/folders/contents') && !u.includes('folder_id'),
    respond: () =>
      jsonResponse({
        folder: null,
        breadcrumbs: [],
        folders: [AI_FOLDER, CLIMATE_FOLDER],
        documents: [PAPER_A, NOTES],
        documents_total: 2,
      }),
  };
}

function statusRoute(): FetchRoute {
  return {
    method: 'GET',
    matches: (u) => u.includes('/status'),
    respond: () => jsonResponse({ folder_library_enabled: true }),
  };
}

/**
 * A fake DOM node standing in for the real HTMLElement a web-only ref
 * resolves to in a browser — react-test-renderer never provides one.
 * `createNodeMock`'s per-testid registry lets a test grab the exact node a
 * given entry/breadcrumb resolved to and fire synthetic drag events at it,
 * exercising the real dragstart/dragenter/dragover/drop listeners
 * useLibraryDnD registers — not a parallel test-only path.
 */
function createLibraryNodeRegistry() {
  const nodes = new Map<
    string,
    {
      listeners: Record<string, ((event: unknown) => void)[]>;
      addEventListener: jest.Mock;
      removeEventListener: jest.Mock;
      setAttribute: jest.Mock;
    }
  >();

  function get(testId: string) {
    let node = nodes.get(testId);
    if (!node) {
      const listeners: Record<string, ((event: unknown) => void)[]> = {};
      node = {
        listeners,
        addEventListener: jest.fn((type: string, handler: (event: unknown) => void) => {
          (listeners[type] ??= []).push(handler);
        }),
        removeEventListener: jest.fn((type: string, handler: (event: unknown) => void) => {
          listeners[type] = (listeners[type] ?? []).filter((h) => h !== handler);
        }),
        setAttribute: jest.fn(),
      };
      nodes.set(testId, node);
    }
    return node;
  }

  const createNodeMock = (element: unknown) => {
    const typed = element as { type?: unknown; props?: Record<string, unknown> };
    const testId = typed.props?.['data-testid'];
    if (typed.type === 'div' && typeof testId === 'string') {
      return get(testId);
    }
    return null;
  };

  return { get, createNodeMock };
}

function fire(
  node: ReturnType<ReturnType<typeof createLibraryNodeRegistry>['get']>,
  type: string,
  event: unknown
): void {
  for (const handler of [...(node.listeners[type] ?? [])]) handler(event);
}

function makeDnDEvent(overrides: { types?: string[]; files?: unknown[] } = {}) {
  return {
    preventDefault: jest.fn(),
    dataTransfer: {
      types: overrides.types ?? [],
      files: overrides.files ?? [],
      setData: jest.fn(),
      effectAllowed: undefined as string | undefined,
      dropEffect: undefined as string | undefined,
    },
  };
}

function makeRealFile(name: string, size: number, type: string): File {
  return new File([new Uint8Array(size)], name, { type });
}

/** Drags `sourceEntryId` (a `library-entry-*` node) onto `targetNode` —
 * dragstart on the source, then dragenter+dragover+drop on the target,
 * mirroring exactly what a real browser fires in that order. Returns the
 * dragover event so a test can assert whether preventDefault() was called
 * (requirement #6: an invalid target never gets it, so the browser itself
 * refuses the drop). */
function performInternalDrag(
  registry: ReturnType<typeof createLibraryNodeRegistry>,
  sourceEntryId: string,
  targetNode: ReturnType<ReturnType<typeof createLibraryNodeRegistry>['get']>
) {
  const sourceNode = registry.get(`library-entry-${sourceEntryId}`);
  fire(sourceNode, 'dragstart', makeDnDEvent());
  const enterEvent = makeDnDEvent();
  fire(targetNode, 'dragenter', enterEvent);
  const overEvent = makeDnDEvent();
  fire(targetNode, 'dragover', overEvent);
  const dropEvent = makeDnDEvent();
  fire(targetNode, 'drop', dropEvent);
  fire(sourceNode, 'dragend', makeDnDEvent());
  return { overEvent, dropEvent };
}

async function renderScreen(
  routes: FetchRoute[],
  registry?: ReturnType<typeof createLibraryNodeRegistry>
): Promise<ReactTestRenderer> {
  installFetchMock(routes);
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <AuthProvider>
        <ClientProvider>
          <PreferencesProvider>
            <FeatureFlagsProvider>
              <DocumentsScreen />
            </FeatureFlagsProvider>
          </PreferencesProvider>
        </ClientProvider>
      </AuthProvider>,
      registry ? { createNodeMock: registry.createNodeMock } : undefined
    );
    await flushAsync();
  });
  return renderer;
}

const originalOS = Platform.OS;
const originalFetch = global.fetch;

beforeEach(() => {
  Platform.OS = 'web';
  installWindow();
  Dimensions.set({ window: DESKTOP_WINDOW, screen: DESKTOP_WINDOW });
});

afterEach(() => {
  // @ts-expect-error test cleanup
  delete global.window;
  Platform.OS = originalOS;
  global.fetch = originalFetch;
});

describe('DocumentsScreen folder library navigation', () => {
  it('renders root contents as grid cards by default', async () => {
    const renderer = await renderScreen([statusRoute(), rootContentsRoute()]);
    expect(findByText(renderer.root, 'AI')).toBeTruthy();
    expect(findByText(renderer.root, 'Climate')).toBeTruthy();
    expect(findByText(renderer.root, 'paper-a.pdf')).toBeTruthy();
    expect(findByText(renderer.root, 'notes.txt')).toBeTruthy();
    // Grid layout, no list column header row.
    expect(renderer.root.findAllByProps({ testID: 'library-grid' }).length).toBeGreaterThan(0);
    expect(renderer.root.findAllByProps({ testID: 'library-list-header' }).length).toBe(0);
  });

  it('switches to list view via the toolbar toggle, showing column headers', async () => {
    const renderer = await renderScreen([statusRoute(), rootContentsRoute()]);
    await act(async () => {
      findPressableByAccessibilityLabel(renderer.root, 'List view').props.onPress();
    });
    expect(renderer.root.findAllByProps({ testID: 'library-list' }).length).toBeGreaterThan(0);
    expect(findByText(renderer.root, 'Date modified')).toBeTruthy();
    expect(findByText(renderer.root, 'AI')).toBeTruthy();
    expect(findByText(renderer.root, 'paper-a.pdf')).toBeTruthy();
  });

  it('persists the chosen view mode across a remount (localStorage)', async () => {
    const { localStorage } = installWindow();
    const routes = [statusRoute(), rootContentsRoute()];
    const renderer = await renderScreen(routes);
    await act(async () => {
      findPressableByAccessibilityLabel(renderer.root, 'List view').props.onPress();
    });
    expect(renderer.root.findAllByProps({ testID: 'library-list' }).length).toBeGreaterThan(0);
    // Persisted synchronously (see Preferences.tsx's update()) — a second
    // provider tree reading the same storage key comes up already in list
    // mode, without the user re-choosing it (requirement: "Persist the
    // user's preferred view locally so reopening Documents preserves it").
    expect(localStorage.getItem('edumind.preferences.v1')).toContain('"documentsViewMode":"list"');

    const renderer2 = await renderScreen(routes);
    expect(renderer2.root.findAllByProps({ testID: 'library-list' }).length).toBeGreaterThan(0);
  });

  it('double-click opens a folder; a single click only selects it', async () => {
    const renderer = await renderScreen([
      statusRoute(),
      rootContentsRoute(),
      {
        method: 'GET',
        matches: (u) => u.includes('/folders/contents') && u.includes('folder_id=f-ai'),
        respond: () =>
          jsonResponse({
            folder: AI_FOLDER,
            breadcrumbs: [{ id: 'f-ai', name: 'AI' }],
            folders: [],
            documents: [PAPER_A],
            documents_total: 1,
          }),
      },
    ]);

    // A single click selects (no navigation) — /folders/contents was never
    // requested for f-ai.
    await act(async () => {
      entryPressable(renderer.root, 'AI').props.onPress({});
    });
    expect(
      (global.fetch as jest.Mock).mock.calls.some(([url]: [string]) =>
        String(url).includes('folder_id=f-ai')
      )
    ).toBe(false);

    // A second click on the same folder within the double-click window
    // opens it.
    await act(async () => {
      entryPressable(renderer.root, 'AI').props.onPress({});
      await flushAsync();
    });
    expect(
      (global.fetch as jest.Mock).mock.calls.some(([url]: [string]) =>
        String(url).includes('folder_id=f-ai')
      )
    ).toBe(true);
  });

  it('breadcrumb navigation returns to root from a nested folder', async () => {
    const renderer = await renderScreen([
      statusRoute(),
      {
        method: 'GET',
        matches: (u) => u.includes('/folders/contents') && !u.includes('folder_id'),
        respond: () =>
          jsonResponse({
            folder: null,
            breadcrumbs: [],
            folders: [AI_FOLDER, CLIMATE_FOLDER],
            documents: [],
            documents_total: 0,
          }),
      },
      {
        method: 'GET',
        matches: (u) => u.includes('/folders/contents') && u.includes('folder_id=f-ai'),
        respond: () =>
          jsonResponse({
            folder: AI_FOLDER,
            breadcrumbs: [{ id: 'f-ai', name: 'AI' }],
            folders: [],
            documents: [PAPER_A],
            documents_total: 1,
          }),
      },
    ]);

    await act(async () => {
      entryPressable(renderer.root, 'AI').props.onPress({});
      entryPressable(renderer.root, 'AI').props.onPress({});
      await flushAsync();
    });
    expect(findByText(renderer.root, 'paper-a.pdf')).toBeTruthy();

    await act(async () => {
      findPressableByAccessibilityLabel(renderer.root, 'My Library (root)').props.onPress();
      await flushAsync();
    });
    expect(findByText(renderer.root, 'Climate')).toBeTruthy();
  });
});

describe('DocumentsScreen folder library drag-and-drop', () => {
  it('drags a document onto a folder and PATCHes /documents/{id}', async () => {
    const registry = createLibraryNodeRegistry();
    let patchBody: unknown = null;
    await renderScreen(
      [
        statusRoute(),
        rootContentsRoute(),
        {
          method: 'PATCH',
          matches: (u) => u.includes('/documents/d-paper-a'),
          respond: (_u, init) => {
            patchBody = JSON.parse(String(init?.body));
            return jsonResponse({ ...PAPER_A, folder_id: 'f-ai' });
          },
        },
      ],
      registry
    );

    const targetNode = registry.get('library-entry-f-ai');
    let overEvent!: ReturnType<typeof makeDnDEvent>;
    await act(async () => {
      ({ overEvent } = performInternalDrag(registry, 'd-paper-a', targetNode));
      await flushAsync();
    });
    expect(overEvent.preventDefault).toHaveBeenCalled();

    expect(patchBody).toEqual({ folder_id: 'f-ai' });
    // One refresh after the move settles, not a re-fetch per item.
    const contentsCalls = (global.fetch as jest.Mock).mock.calls.filter(([url]: [string]) =>
      String(url).includes('/folders/contents')
    );
    expect(contentsCalls.length).toBeGreaterThanOrEqual(2);
    // Never re-uploads/re-embeds the document as part of the move.
    expect(
      (global.fetch as jest.Mock).mock.calls.some(
        ([url, init]: [string, RequestInit | undefined]) =>
          String(url).endsWith('/documents') && (init?.method ?? 'GET').toUpperCase() === 'POST'
      )
    ).toBe(false);
  });

  it('drags a folder onto another folder and PATCHes /folders/{id}', async () => {
    const registry = createLibraryNodeRegistry();
    let patchBody: unknown = null;
    const renderer = await renderScreen(
      [
        statusRoute(),
        rootContentsRoute(),
        {
          method: 'PATCH',
          matches: (u) => u.includes('/folders/f-ai'),
          respond: (_u, init) => {
            patchBody = JSON.parse(String(init?.body));
            return jsonResponse({ ...AI_FOLDER, parent_id: 'f-climate' });
          },
        },
      ],
      registry
    );

    const targetNode = registry.get('library-entry-f-climate');
    await act(async () => {
      performInternalDrag(registry, 'f-ai', targetNode);
      await flushAsync();
    });

    expect(patchBody).toEqual({ parent_id: 'f-climate' });
    expect(renderer.root).toBeTruthy();
  });

  it('blocks a folder dropped onto itself — no PATCH is ever sent', async () => {
    const registry = createLibraryNodeRegistry();
    const patchSpy = jest.fn();
    const renderer = await renderScreen(
      [
        statusRoute(),
        rootContentsRoute(),
        {
          method: 'PATCH',
          matches: (u) => u.includes('/folders/f-ai'),
          respond: (_u, init) => {
            patchSpy(JSON.parse(String(init?.body)));
            return jsonResponse(AI_FOLDER);
          },
        },
      ],
      registry
    );

    const selfNode = registry.get('library-entry-f-ai');
    let overEvent!: ReturnType<typeof makeDnDEvent>;
    await act(async () => {
      ({ overEvent } = performInternalDrag(registry, 'f-ai', selfNode));
      await flushAsync();
    });

    // Invalid target: dragover never gets preventDefault(), so the browser
    // itself refuses the drop — and the drop handler's own guard means no
    // request is sent even though we still fire a synthetic 'drop' above.
    expect(overEvent.preventDefault).not.toHaveBeenCalled();
    expect(patchSpy).not.toHaveBeenCalled();
    expect(renderer.root).toBeTruthy();
  });

  it('blocks a folder dropped onto its own descendant (planLibraryMove)', () => {
    // Pure-function unit test (requirement #6) — a folder A dragged onto a
    // target whose root-to-target ancestor chain contains A's own id (i.e.
    // the target is nested somewhere under A) must never be treated as a
    // valid move, however that ancestor chain was constructed. In the
    // rendered UI this case is unreachable by mouse (see useLibraryDnD's
    // own doc comment: a folder is only draggable from its parent's
    // listing, where every reachable target is a sibling, an ancestor, or
    // root — never a descendant) — this test instead exercises the guard
    // directly against a hand-built cyclic-looking ancestor chain, so the
    // protection doesn't silently depend on that reachability argument
    // remaining true forever.
    const folderA = {
      kind: 'folder' as const,
      data: { ...AI_FOLDER, id: 'a', parent_id: null },
    };
    const plan = planLibraryMove([folderA], {
      kind: 'folder',
      folderId: 'a-grandchild',
      ancestorChain: ['a', 'a-child', 'a-grandchild'],
    });
    expect(plan.valid).toBe(false);
    expect(plan.itemsToMove).toEqual([]);
  });

  it('drags a document onto the "My Library" root breadcrumb — moves it to root', async () => {
    // Scenario E from the milestone's manual validation: paper-a.pdf
    // already lives inside AI (folder_id: 'f-ai') — the user is browsing
    // *inside* AI (so "My Library" appears as an ancestor breadcrumb) and
    // drags it onto that root crumb to send it back to root.
    const registry = createLibraryNodeRegistry();
    let patchBody: unknown = null;
    const paperInAI = { ...PAPER_A, folder_id: 'f-ai' };
    const renderer = await renderScreen(
      [
        statusRoute(),
        {
          method: 'GET',
          matches: (u) => u.includes('/folders/contents') && u.includes('folder_id=f-ai'),
          respond: () =>
            jsonResponse({
              folder: AI_FOLDER,
              breadcrumbs: [{ id: 'f-ai', name: 'AI' }],
              folders: [],
              documents: [paperInAI],
              documents_total: 1,
            }),
        },
        {
          method: 'GET',
          matches: (u) => u.includes('/folders/contents') && !u.includes('folder_id'),
          respond: () =>
            jsonResponse({
              folder: null,
              breadcrumbs: [],
              folders: [AI_FOLDER],
              documents: [],
              documents_total: 0,
            }),
        },
        {
          method: 'PATCH',
          matches: (u) => u.includes('/documents/d-paper-a'),
          respond: (_u, init) => {
            patchBody = JSON.parse(String(init?.body));
            return jsonResponse({ ...paperInAI, folder_id: null });
          },
        },
      ],
      registry
    );

    // Navigate into AI first (double-click).
    await act(async () => {
      entryPressable(renderer.root, 'AI').props.onPress({});
      entryPressable(renderer.root, 'AI').props.onPress({});
      await flushAsync();
    });
    expect(findByText(renderer.root, 'paper-a.pdf')).toBeTruthy();

    const rootNode = registry.get('breadcrumb-root-drop');
    await act(async () => {
      performInternalDrag(registry, 'd-paper-a', rootNode);
      await flushAsync();
    });

    expect(patchBody).toEqual({ folder_id: null });
  });

  it('rolls back cleanly on a failed move — item stays visible, error shown, no data loss', async () => {
    const registry = createLibraryNodeRegistry();
    const renderer = await renderScreen(
      [
        statusRoute(),
        rootContentsRoute(),
        {
          method: 'PATCH',
          matches: (u) => u.includes('/documents/d-paper-a'),
          respond: () => jsonResponse({ detail: 'Server error' }, 500),
        },
      ],
      registry
    );

    const targetNode = registry.get('library-entry-f-ai');
    await act(async () => {
      performInternalDrag(registry, 'd-paper-a', targetNode);
      await flushAsync();
    });

    // Never optimistically removed — still rendered even though the move
    // failed (requirement #5: "never lose the item visually").
    expect(findByText(renderer.root, 'paper-a.pdf')).toBeTruthy();
    // A concise error is surfaced.
    expect(
      renderer.root.findAll(
        (node) =>
          String(node.type) === 'Text' &&
          textContent(node).length > 0 &&
          /error|500/i.test(textContent(node))
      ).length
    ).toBeGreaterThan(0);
  });
});

describe('DocumentsScreen folder library external file drop', () => {
  it('dropping an OS file onto the library area stages it for review (reuses the upload pipeline)', async () => {
    const registry = createLibraryNodeRegistry();
    let previewCalled = false;
    const renderer = await renderScreen(
      [
        statusRoute(),
        rootContentsRoute(),
        {
          method: 'POST',
          matches: (u) => u.includes('/documents/metadata-preview'),
          respond: () => {
            previewCalled = true;
            return jsonResponse({
              title: null,
              authors: [],
              publication_year: null,
              source_venue: null,
              doi: null,
              source_url: null,
              page_count: 1,
              file_format: 'pdf',
              extraction_sources: {},
              extraction_confidence: {},
            });
          },
        },
      ],
      registry
    );

    const targetNode = registry.get('library-entry-f-ai');
    // External OS drag: no dragstart fired from within the page (no
    // internal item is being dragged) — only dataTransfer's Files type,
    // exactly like a real OS-originated drag.
    const file = makeRealFile('field-notes.pdf', 2048, 'application/pdf');
    await act(async () => {
      fire(targetNode, 'dragenter', makeDnDEvent({ types: ['Files'] }));
      fire(targetNode, 'dragover', makeDnDEvent({ types: ['Files'] }));
      fire(targetNode, 'drop', makeDnDEvent({ types: ['Files'], files: [file] }));
      await flushAsync();
    });

    expect(previewCalled).toBe(true);
    // Staged into the existing review form, not uploaded immediately.
    expect(findByText(renderer.root, 'field-notes.pdf')).toBeTruthy();
    expect(findByText(renderer.root, 'Upload')).toBeTruthy();
    expect(
      (global.fetch as jest.Mock).mock.calls.some(
        ([url, init]: [string, RequestInit | undefined]) =>
          String(url).endsWith('/documents') && (init?.method ?? 'GET').toUpperCase() === 'POST'
      )
    ).toBe(false);
  });
});

describe('DocumentsScreen folder library selection', () => {
  it('single click selects exactly one item', async () => {
    const renderer = await renderScreen([statusRoute(), rootContentsRoute()]);
    await act(async () => {
      entryPressable(renderer.root, 'paper-a.pdf').props.onPress({});
    });
    const pressable = entryPressable(renderer.root, 'paper-a.pdf');
    expect(pressable.props.accessibilityState.selected).toBe(true);
    const other = entryPressable(renderer.root, 'notes.txt');
    expect(other.props.accessibilityState.selected).toBe(false);
  });

  it('Cmd/Ctrl+click toggles additional items into the selection', async () => {
    const renderer = await renderScreen([statusRoute(), rootContentsRoute()]);
    await act(async () => {
      entryPressable(renderer.root, 'paper-a.pdf').props.onPress({});
    });
    await act(async () => {
      entryPressable(renderer.root, 'notes.txt').props.onPress({ nativeEvent: { metaKey: true } });
    });
    expect(entryPressable(renderer.root, 'paper-a.pdf').props.accessibilityState.selected).toBe(
      true
    );
    expect(entryPressable(renderer.root, 'notes.txt').props.accessibilityState.selected).toBe(true);

    // A plain click afterward collapses back to a single selection.
    await act(async () => {
      entryPressable(renderer.root, 'notes.txt').props.onPress({});
    });
    expect(entryPressable(renderer.root, 'paper-a.pdf').props.accessibilityState.selected).toBe(
      false
    );
  });

  it('dragging one of several Cmd-selected documents moves the whole group', async () => {
    const registry = createLibraryNodeRegistry();
    const patchedIds: string[] = [];
    const renderer = await renderScreen(
      [
        statusRoute(),
        rootContentsRoute(),
        {
          method: 'PATCH',
          matches: (u) => u.includes('/documents/'),
          respond: (u, init) => {
            const id = u.split('/documents/')[1]!;
            patchedIds.push(id);
            expect(JSON.parse(String(init?.body))).toEqual({ folder_id: 'f-ai' });
            return jsonResponse({ document_id: id, folder_id: 'f-ai' });
          },
        },
      ],
      registry
    );

    await act(async () => {
      entryPressable(renderer.root, 'paper-a.pdf').props.onPress({});
    });
    await act(async () => {
      entryPressable(renderer.root, 'notes.txt').props.onPress({ nativeEvent: { metaKey: true } });
    });

    const targetNode = registry.get('library-entry-f-ai');
    await act(async () => {
      performInternalDrag(registry, 'd-paper-a', targetNode);
      await flushAsync();
    });

    expect(patchedIds.sort()).toEqual(['d-notes', 'd-paper-a']);
    // Concurrent calls, one shared refresh — not a serial per-item refresh.
    const contentsCalls = (global.fetch as jest.Mock).mock.calls.filter(
      ([url]: [string]) =>
        String(url).includes('/folders/contents') && !String(url).includes('folder_id')
    );
    expect(contentsCalls.length).toBe(2); // initial load + one post-move refresh
    expect(renderer.root).toBeTruthy();
  });
});

describe('DocumentsScreen folder library actions menu (no-drag fallback)', () => {
  it('moves a document via the actions menu, without any drag', async () => {
    let moveCalled = false;
    const renderer = await renderScreen([
      statusRoute(),
      rootContentsRoute(),
      {
        method: 'PATCH',
        matches: (u) => u.includes('/documents/d-paper-a'),
        respond: (_u, init) => {
          moveCalled = true;
          expect(JSON.parse(String(init?.body))).toEqual({ folder_id: 'f-ai' });
          return jsonResponse({ ...PAPER_A, folder_id: 'f-ai' });
        },
      },
    ]);

    await act(async () => {
      findPressableByAccessibilityLabel(
        renderer.root,
        'More actions for paper-a.pdf'
      ).props.onPress();
    });
    await act(async () => {
      findPressableByText(renderer.root, 'Move…').props.onPress();
    });

    const dialog = renderer.root.findByType(MoveToFolderDialog);
    await act(async () => {
      findPressableByText(dialog, 'AI').props.onPress();
      await flushAsync();
    });
    await act(async () => {
      findPressableByText(dialog, 'Move here').props.onPress();
      await flushAsync();
    });

    expect(moveCalled).toBe(true);
  });

  it('deletes a folder via the actions menu after confirming', async () => {
    let deleteCalled = false;
    const routes: FetchRoute[] = [
      statusRoute(),
      {
        method: 'GET',
        matches: (u) => u.includes('/folders/contents') && !u.includes('folder_id'),
        respond: () =>
          jsonResponse({
            folder: null,
            breadcrumbs: [],
            folders: deleteCalled ? [] : [{ ...AI_FOLDER, folder_count: 0, document_count: 0 }],
            documents: [],
            documents_total: 0,
          }),
      },
      {
        method: 'DELETE',
        matches: (u) => u.includes('/folders/f-ai'),
        respond: () => {
          deleteCalled = true;
          return jsonResponse({
            deleted: true,
            folder_id: 'f-ai',
            moved_folders: 0,
            moved_documents: 0,
          });
        },
      },
    ];
    const renderer = await renderScreen(routes);

    await act(async () => {
      findPressableByAccessibilityLabel(renderer.root, 'More actions for AI').props.onPress();
    });
    await act(async () => {
      findPressableByText(renderer.root, 'Delete').props.onPress();
      await flushAsync();
    });

    expect(deleteCalled).toBe(true);
    expect(queryByText(renderer.root, 'AI')).toBeNull();
  });
});

describe('DocumentsScreen folder library details panel', () => {
  it('shows metadata for a single selected document on desktop width', async () => {
    const renderer = await renderScreen([statusRoute(), rootContentsRoute()]);
    await act(async () => {
      entryPressable(renderer.root, 'paper-a.pdf').props.onPress({});
    });
    expect(findByText(renderer.root, 'Details')).toBeTruthy();
    expect(findByText(renderer.root, 'paper-a.pdf')).toBeTruthy();
    expect(findByText(renderer.root, 'Uploaded')).toBeTruthy();
    // No fabricated file size in the details panel specifically — "Size"
    // legitimately appears elsewhere on the page (the toolbar's sort
    // chips) — see the milestone report's Limitations section.
    const panel = renderer.root.findByType(DetailsPanel);
    expect(queryByText(panel, 'Size')).toBeNull();
  });

  it('shows folder/document counts for a single selected folder', async () => {
    const renderer = await renderScreen([statusRoute(), rootContentsRoute()]);
    await act(async () => {
      entryPressable(renderer.root, 'Climate').props.onPress({});
    });
    expect(findByText(renderer.root, 'Subfolders')).toBeTruthy();
    expect(findByText(renderer.root, 'Documents')).toBeTruthy();
  });

  it('is collapsible via the toolbar toggle', async () => {
    const renderer = await renderScreen([statusRoute(), rootContentsRoute()]);
    await act(async () => {
      entryPressable(renderer.root, 'paper-a.pdf').props.onPress({});
    });
    expect(findByText(renderer.root, 'Details')).toBeTruthy();
    await act(async () => {
      findPressableByAccessibilityLabel(renderer.root, 'Hide details panel').props.onPress();
    });
    expect(queryByText(renderer.root, 'Details')).toBeNull();
  });
});

describe('DocumentsScreen folder library mobile fallback', () => {
  it('hides the details panel toggle and drag wiring on a narrow/native surface, but keeps tap + Move working', async () => {
    Platform.OS = 'ios';
    Dimensions.set({ window: MOBILE_WINDOW, screen: MOBILE_WINDOW });
    const renderer = await renderScreen([statusRoute(), rootContentsRoute()]);

    // No details-panel toggle at this width.
    expect(queryPressableByAccessibilityLabel(renderer.root, 'Show details panel')).toBeNull();
    expect(queryPressableByAccessibilityLabel(renderer.root, 'Hide details panel')).toBeNull();

    // No web-only drag wrapper div is rendered on native.
    expect(renderer.root.findAll((node) => node.type === 'div').length).toBe(0);

    // Tap selection + the actions-menu Move fallback still both work.
    await act(async () => {
      entryPressable(renderer.root, 'paper-a.pdf').props.onPress({});
    });
    expect(entryPressable(renderer.root, 'paper-a.pdf').props.accessibilityState.selected).toBe(
      true
    );
    await act(async () => {
      findPressableByAccessibilityLabel(
        renderer.root,
        'More actions for paper-a.pdf'
      ).props.onPress();
    });
    expect(findByText(renderer.root, 'Move…')).toBeTruthy();
  });
});

describe('DocumentsScreen folder library create', () => {
  it('creating a folder POSTs /folders with the current folder as parent, then refreshes', async () => {
    let createCalled = false;
    const renderer = await renderScreen([
      statusRoute(),
      {
        method: 'GET',
        matches: (u) => u.includes('/folders/contents') && !u.includes('folder_id'),
        respond: () =>
          jsonResponse({
            folder: null,
            breadcrumbs: [],
            folders: createCalled ? [{ ...AI_FOLDER, id: 'new', name: 'New Folder' }] : [],
            documents: [],
            documents_total: 0,
          }),
      },
      {
        method: 'POST',
        matches: (u) => u.endsWith('/folders'),
        respond: (_u, init) => {
          createCalled = true;
          const body = JSON.parse(String(init?.body));
          expect(body).toEqual({ name: 'New Folder', parent_id: null });
          return jsonResponse(
            { ...AI_FOLDER, id: 'new', name: 'New Folder', folder_count: 0, document_count: 0 },
            201
          );
        },
      },
    ]);

    await act(async () => {
      findPressableByText(renderer.root, 'New folder').props.onPress();
    });
    const input = renderer.root.find(
      (node) => String(node.type) === 'TextInput' && node.props.placeholder === 'e.g. Research'
    );
    await act(async () => {
      input.props.onChangeText('New Folder');
    });
    await act(async () => {
      findPressableByText(renderer.root, 'Create').props.onPress();
      await flushAsync();
    });

    expect(createCalled).toBe(true);
    expect(findByText(renderer.root, 'New Folder')).toBeTruthy();
  });
});

describe('DocumentsScreen folder library "Use in chat" (Frontend Milestone 2)', () => {
  function statusRouteWithConversationScope(): FetchRoute {
    return {
      method: 'GET',
      matches: (u) => u.includes('/status'),
      respond: () =>
        jsonResponse({ folder_library_enabled: true, conversation_scope_enabled: true }),
    };
  }

  it("a single document's actions menu navigates to /chat/new with that document as a pending source — no re-upload", async () => {
    mockRouterPush.mockClear();
    const renderer = await renderScreen([statusRouteWithConversationScope(), rootContentsRoute()]);

    await act(async () => {
      findPressableByAccessibilityLabel(
        renderer.root,
        'More actions for paper-a.pdf'
      ).props.onPress();
    });
    await act(async () => {
      findPressableByText(renderer.root, 'Use in chat').props.onPress();
    });

    expect(mockRouterPush).toHaveBeenCalledWith({
      pathname: '/chat/new',
      params: {
        sources: JSON.stringify([{ documentId: 'd-paper-a', displayName: 'paper-a.pdf' }]),
      },
    });
    // Purely a navigation — never re-uploads/re-embeds the document.
    expect(
      (global.fetch as jest.Mock).mock.calls.some(
        ([url, init]: [string, RequestInit | undefined]) =>
          String(url).endsWith('/documents') && (init?.method ?? 'GET').toUpperCase() === 'POST'
      )
    ).toBe(false);
  });

  it('hides "Use in chat" from the actions menu when the conversation-scope feature flag is off', async () => {
    const renderer = await renderScreen([statusRoute(), rootContentsRoute()]);

    await act(async () => {
      findPressableByAccessibilityLabel(
        renderer.root,
        'More actions for paper-a.pdf'
      ).props.onPress();
    });

    expect(queryByText(renderer.root, 'Use in chat')).toBeNull();
  });

  it('multi-selecting two documents and using the details panel action navigates with both as pending sources', async () => {
    mockRouterPush.mockClear();
    const renderer = await renderScreen([statusRouteWithConversationScope(), rootContentsRoute()]);

    await act(async () => {
      entryPressable(renderer.root, 'paper-a.pdf').props.onPress({});
    });
    await act(async () => {
      entryPressable(renderer.root, 'notes.txt').props.onPress({ nativeEvent: { metaKey: true } });
    });

    await act(async () => {
      findPressableByText(renderer.root, 'Use 2 in chat').props.onPress();
    });

    expect(mockRouterPush).toHaveBeenCalledWith({
      pathname: '/chat/new',
      params: {
        sources: JSON.stringify([
          { documentId: 'd-paper-a', displayName: 'paper-a.pdf' },
          { documentId: 'd-notes', displayName: 'notes.txt' },
        ]),
      },
    });
  });
});
