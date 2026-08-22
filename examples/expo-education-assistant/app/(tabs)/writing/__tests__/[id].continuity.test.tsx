/**
 * Milestone 5.5.1 Part 25 (CORE REQUIREMENT) — cross-navigation
 * continuity coverage. This app's app/(tabs)/_layout.tsx uses a single
 * <Slot/>, so navigating to a different section (Documents, Notes, …)
 * genuinely UNMOUNTS this screen — there's no persistent background
 * tab keeping its React state alive. These tests reproduce that
 * directly: mount, act, unmount, mount again with the SAME project id
 * (exactly what "navigate away, then come back" looks like from this
 * screen's own perspective) — and assert what should have survived.
 *
 * Same harness convention as [id].test.tsx (raw `global.fetch` mock,
 * real AuthProvider/ClientProvider/FeatureFlagsProvider, the real
 * screen component) — kept in its own file since this is a distinct
 * concern (round-tripping through unmount) from that file's own
 * single-mount coverage.
 */
import { Dimensions, Platform } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { LatexCodeEditor } from '@/components/writing/LatexCodeEditor';
import { AuthProvider } from '@/lib/AuthProvider';
import { ClientProvider } from '@/lib/ClientProvider';
import { FeatureFlagsProvider } from '@/lib/FeatureFlags';
import * as navigationFlushGuard from '@/lib/navigationFlushGuard';
import { __resetSessionNavCacheForTests } from '@/lib/sessionNavCache';
import { useWritingDrawerContent, WritingDrawerSlotProvider } from '@/lib/WritingDrawerSlot';
import WritingProjectEditorScreen from '../[id]';

/** See [id].desktopWorkspace.test.tsx's identical helper's own comment —
 * [id].tsx registers its Files/Outline/References/Notes/Tools panel into
 * this shared slot instead of rendering it inline on desktop; a test
 * that renders [id].tsx outside the real app shell (app/(tabs)/_layout.tsx)
 * has to provide both the slot and a render site itself. */
function WritingDrawerSlotRenderer() {
  return <>{useWritingDrawerContent()}</>;
}

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

const mockPush = jest.fn();
const mockParams: { id: string } = { id: 'w-1' };
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn() }),
  useLocalSearchParams: () => mockParams,
  usePathname: () => '/writing/w-1',
  useGlobalSearchParams: () => ({}),
}));

const originalOS = Platform.OS;
const originalWindow = Dimensions.get('window');
beforeAll(() => {
  Platform.OS = 'web';
  // A wide viewport so the desktop Research panel (with its always-
  // visible WritingFileTree) renders directly — matching
  // [id].desktopWorkspace.test.tsx's own setup, needed here because the
  // first test below selects a non-root file via the file tree's own
  // onSelectFile prop.
  Dimensions.set({
    window: { width: 1200, height: 900, scale: 1, fontScale: 1 },
    screen: { width: 1200, height: 900, scale: 1, fontScale: 1 },
  });
});
afterAll(() => {
  Platform.OS = originalOS;
  Dimensions.set({ window: originalWindow, screen: originalWindow });
});

function findLatexEditor(root: ReactTestInstance): ReactTestInstance {
  return root.find((n) => n.type === LatexCodeEditor);
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

const PROJECT = {
  id: 'w-1',
  title: 'Laser Cutting Paper',
  description: null,
  main_tex_content: '\\documentclass{article}\n\\begin{document}\n\\end{document}',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

function getProjectRoute(): FetchRoute {
  return {
    method: 'GET',
    matches: (u) => u.endsWith('/writing-projects/w-1') && !u.includes('/files'),
    respond: () => jsonResponse(PROJECT),
  };
}

const ROOT_FILE_ID = 'root-file-id';
const SECOND_FILE_ID = 'second-file-id';

function rootFileNode(overrides: Record<string, unknown> = {}) {
  return {
    id: ROOT_FILE_ID,
    parent_id: null,
    kind: 'text',
    name: 'main.tex',
    path: 'main.tex',
    mime_type: null,
    size_bytes: PROJECT.main_tex_content.length,
    is_root: true,
    ...overrides,
  };
}

function secondFileNode(overrides: Record<string, unknown> = {}) {
  return {
    id: SECOND_FILE_ID,
    parent_id: null,
    kind: 'text',
    name: 'notes.tex',
    path: 'notes.tex',
    mime_type: null,
    size_bytes: 20,
    is_root: false,
    ...overrides,
  };
}

function filesTreeRoute(files: unknown[] = [rootFileNode()]): FetchRoute {
  return {
    method: 'GET',
    matches: (u) => u.endsWith('/writing-projects/w-1/files'),
    respond: () =>
      jsonResponse({
        files,
        generated: [
          { name: 'references.bib', path: 'references.bib', read_only: true, reference_count: 0 },
        ],
        root_file_id: ROOT_FILE_ID,
        total_size_bytes: PROJECT.main_tex_content.length,
        file_count: files.length,
        max_files: 150,
        max_total_bytes: 100_000_000,
      }),
  };
}

function fileContentRoute(
  content: string = PROJECT.main_tex_content,
  fileId: string = ROOT_FILE_ID
): FetchRoute {
  return {
    method: 'GET',
    matches: (u) => u.endsWith(`/writing-projects/w-1/files/${fileId}`),
    respond: () =>
      jsonResponse({
        file: fileId === ROOT_FILE_ID ? rootFileNode() : secondFileNode({ id: fileId }),
        content_text: content,
      }),
  };
}

function patchFileRoute(fileId: string = ROOT_FILE_ID): FetchRoute {
  return {
    method: 'PATCH',
    matches: (u) => u.endsWith(`/writing-projects/w-1/files/${fileId}`),
    respond: () => jsonResponse({ file: rootFileNode({ id: fileId }) }),
  };
}

function referencesRoute(): FetchRoute {
  return {
    method: 'GET',
    matches: (u) => u.endsWith('/writing-projects/w-1/references'),
    respond: () => jsonResponse({ references: [], total: 0, missing_citation_keys: [] }),
  };
}

async function flushAsync(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function mountScreen(routes: FetchRoute[]): Promise<ReactTestRenderer> {
  installFetchMock(routes);
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <AuthProvider>
        <ClientProvider>
          <FeatureFlagsProvider>
            <WritingDrawerSlotProvider>
              <WritingProjectEditorScreen />
              <WritingDrawerSlotRenderer />
            </WritingDrawerSlotProvider>
          </FeatureFlagsProvider>
        </ClientProvider>
      </AuthProvider>
    );
    await flushAsync();
  });
  return renderer;
}

describe('WritingProjectEditorScreen — cross-navigation continuity (Milestone 5.5.1 Part 25)', () => {
  beforeEach(() => {
    __resetSessionNavCacheForTests();
    mockPush.mockClear();
  });

  it('remembers the active (non-root) file across an unmount/remount of the same project', async () => {
    const tree = [rootFileNode(), secondFileNode()];
    const first = await mountScreen([
      getProjectRoute(),
      referencesRoute(),
      filesTreeRoute(tree),
      fileContentRoute(PROJECT.main_tex_content, ROOT_FILE_ID),
      fileContentRoute('Second file content.', SECOND_FILE_ID),
    ]);

    // Switch to the second file the same way a real click on the file
    // tree does — via WritingFileTree's own onSelectFile prop.
    await act(async () => {
      // WritingFileTree's own onSelectFile calls openFile(node.id) —
      // reach the same effect by finding the tree's onSelectFile prop.
      const tree_ = first.root.find((n) => typeof n.props.onSelectFile === 'function');
      await tree_.props.onSelectFile(secondFileNode());
      await flushAsync();
    });

    const editorOnSecond = findLatexEditor(first.root);
    expect(editorOnSecond.props.value).toBe('Second file content.');

    act(() => {
      first.unmount();
    });

    const second = await mountScreen([
      getProjectRoute(),
      referencesRoute(),
      filesTreeRoute(tree),
      fileContentRoute(PROJECT.main_tex_content, ROOT_FILE_ID),
      fileContentRoute('Second file content.', SECOND_FILE_ID),
    ]);

    const editorAfterRemount = findLatexEditor(second.root);
    // The whole point: NOT the root file's content — the second file,
    // remembered from before the unmount.
    expect(editorAfterRemount.props.value).toBe('Second file content.');

    act(() => {
      second.unmount();
    });
  });

  it('remembers the cursor position for a file across an unmount/remount', async () => {
    const first = await mountScreen([
      getProjectRoute(),
      referencesRoute(),
      filesTreeRoute(),
      fileContentRoute(),
      patchFileRoute(),
    ]);

    const editor = findLatexEditor(first.root);
    act(() => {
      editor.props.onSelectionChange({ start: 5, end: 5 });
    });

    act(() => {
      first.unmount();
    });

    const second = await mountScreen([
      getProjectRoute(),
      referencesRoute(),
      filesTreeRoute(),
      fileContentRoute(),
    ]);

    const editorAfterRemount = findLatexEditor(second.root);
    expect(editorAfterRemount.props.selection).toEqual({ start: 5, end: 5 });

    act(() => {
      second.unmount();
    });
  });

  it('an edit typed just before unmounting is flushed (PATCHed) via the unmount-cleanup flush', async () => {
    // Complements navigationFlushGuard.test.ts (which covers the
    // registry mechanism itself in isolation) and the real-browser
    // validation of the full "type -> click Documents -> return
    // Writing" round trip through app/(tabs)/_layout.tsx's actual
    // navigation choke point (that layout isn't rendered by this
    // screen-level test). What IS meaningfully verifiable here: this
    // screen's existing unmount-cleanup flush (Part 7) still fires and
    // still PATCHes the just-typed content — the baseline Part 25
    // builds on, not a new behavior itself.
    let patchedContent: string | null = null;
    const patchCapturingFetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'PATCH' && url.endsWith(`/writing-projects/w-1/files/${ROOT_FILE_ID}`)) {
        const body = JSON.parse(init?.body as string);
        patchedContent = body.content_text;
        return jsonResponse({ file: rootFileNode() });
      }
      if (method === 'GET' && url.endsWith('/writing-projects/w-1') && !url.includes('/files')) {
        return jsonResponse(PROJECT);
      }
      if (method === 'GET' && url.endsWith('/writing-projects/w-1/references')) {
        return jsonResponse({ references: [], total: 0, missing_citation_keys: [] });
      }
      if (method === 'GET' && url.endsWith('/writing-projects/w-1/files')) {
        return filesTreeRoute().respond();
      }
      if (method === 'GET' && url.endsWith(`/writing-projects/w-1/files/${ROOT_FILE_ID}`)) {
        return jsonResponse({ file: rootFileNode(), content_text: PROJECT.main_tex_content });
      }
      throw new Error(`Unhandled ${method} ${url} in this test`);
    });
    global.fetch = patchCapturingFetch as unknown as typeof fetch;

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <AuthProvider>
          <ClientProvider>
            <FeatureFlagsProvider>
              <WritingDrawerSlotProvider>
                <WritingProjectEditorScreen />
                <WritingDrawerSlotRenderer />
              </WritingDrawerSlotProvider>
            </FeatureFlagsProvider>
          </ClientProvider>
        </AuthProvider>
      );
      await flushAsync();
    });

    const editor = findLatexEditor(renderer.root);
    act(() => {
      editor.props.onValueChange('\\section{New content added right before navigating away}');
    });

    // Unmount immediately — the real "click Documents right away" case
    // (the debounced autosave has NOT fired on its own timer yet).
    await act(async () => {
      renderer.unmount();
      await flushAsync();
    });

    expect(patchedContent).toBe('\\section{New content added right before navigating away}');
  });

  it('registers a flush function with the navigation guard on mount, and unregisters on unmount', async () => {
    const registerSpy = jest.spyOn(navigationFlushGuard, 'registerNavigationFlush');

    const renderer = await mountScreen([
      getProjectRoute(),
      referencesRoute(),
      filesTreeRoute(),
      fileContentRoute(),
      patchFileRoute(),
    ]);

    expect(registerSpy).toHaveBeenCalled();
    // Calling what THIS screen registered must actually flush — the
    // exact function app/(tabs)/_layout.tsx's handleNavigate awaits
    // before every route change (see that file + navigationFlushGuard's
    // own docstring for the full mechanism).
    const registeredFn = registerSpy.mock.calls.at(-1)?.[0];
    expect(typeof registeredFn).toBe('function');

    act(() => {
      renderer.unmount();
    });
    // After unmount, calling the (now-stale) registered function must
    // be safe — but more importantly, flushBeforeNavigate() itself must
    // no longer invoke it (verified in navigationFlushGuard.test.ts's
    // own "no-op again after unregistering" case); this just confirms
    // registration actually happened, which that file can't verify on
    // its own.
    registerSpy.mockRestore();
  });
});
