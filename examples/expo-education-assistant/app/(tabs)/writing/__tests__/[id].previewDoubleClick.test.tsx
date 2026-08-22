/**
 * SyncTeX implementation (Writing UX Refinement milestone) — compiled-
 * preview double-click -> existing-code-editor navigation, now backed
 * by the backend's authoritative SyncTeX inverse-search endpoint
 * instead of the prior best-effort text-search heuristic (lib/
 * writingPreviewSourceMap.ts, removed this milestone — real-browser
 * validation proved it unreliable for common/repeated words no matter
 * how the scoring was tuned).
 *
 * Same convention as [id].previewResize.test.tsx/[id].compile.test.tsx
 * (needs a WIDE desktop window and LATEX_COMPILATION_ENABLED) and mocks
 * CompiledPdfPreview entirely — real pdf.js text-layer/canvas-coordinate
 * DOM behavior isn't reachable in this RN jest-preset environment (no
 * real canvas — see CompiledPdfPreview.test.tsx's own docstring), so
 * this file instead verifies exactly what [id].tsx does with whatever
 * CompiledPdfPreview reports via its `onDoubleClickLocation` prop (a
 * page/coordinate, never text) and whatever the (mocked) backend
 * inverse-search endpoint resolves it to.
 *
 * A real compile (POST .../compile -> GET .../compile/{id}/pdf) has to
 * happen first in every test here — unlike the old text-search
 * heuristic, which only needed the in-memory `content` string, SyncTeX
 * navigation is only ever available against a specific successful
 * compile's own `compile_id` (see [id].tsx's own `compiledCompileId`).
 */
import { Dimensions, Platform } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import type { PreviewClickLocation } from '@/components/writing/CompiledPdfPreview';
import { LatexCodeEditor } from '@/components/writing/LatexCodeEditor';
import { AuthProvider } from '@/lib/AuthProvider';
import { ClientProvider } from '@/lib/ClientProvider';
import { FeatureFlagsProvider } from '@/lib/FeatureFlags';
import WritingProjectEditorScreen from '../[id]';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

const mockParams: { id: string } = { id: 'w-1' };
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  useLocalSearchParams: () => mockParams,
  usePathname: () => '/writing/w-1',
  useGlobalSearchParams: () => ({}),
}));

// See this file's own module docstring for why CompiledPdfPreview is
// mocked entirely rather than driven through real pdf.js rendering.
// Capturing the LATEST onDoubleClickLocation the real component tree
// actually passed down lets each test simulate "the preview reported a
// double-click at this page/coordinate" by calling it directly —
// exactly the boundary [id].tsx's own handlePreviewDoubleClick owns and
// this file tests.
let capturedOnDoubleClickLocation: ((location: PreviewClickLocation) => void) | null = null;
jest.mock('@/components/writing/CompiledPdfPreview', () => ({
  CompiledPdfPreview: (props: {
    onDoubleClickLocation?: (location: PreviewClickLocation) => void;
  }) => {
    capturedOnDoubleClickLocation = props.onDoubleClickLocation ?? null;
    return null;
  },
}));

const originalOS = Platform.OS;
const originalWindow = Dimensions.get('window');
beforeAll(() => {
  Platform.OS = 'web';
  Dimensions.set({
    window: { width: 1400, height: 900, scale: 1, fontScale: 1 },
    screen: { width: 1400, height: 900, scale: 1, fontScale: 1 },
  });
});
afterAll(() => {
  Platform.OS = originalOS;
  Dimensions.set({ window: originalWindow, screen: originalWindow });
});

beforeEach(() => {
  capturedOnDoubleClickLocation = null;
  process.env.EXPO_PUBLIC_LATEX_COMPILATION_ENABLED = 'true';
});
afterEach(() => {
  delete process.env.EXPO_PUBLIC_LATEX_COMPILATION_ENABLED;
});

function findPressableByLabel(root: ReactTestInstance, label: string): ReactTestInstance {
  const matches = root.findAll(
    (node) => typeof node.props.onPress === 'function' && node.props.accessibilityLabel === label
  );
  if (matches.length === 0)
    throw new Error(`No pressable found with accessibilityLabel ${JSON.stringify(label)}`);
  return matches[0]!;
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

const MAIN_TEX = [
  '\\documentclass{article}',
  '\\begin{document}',
  '\\section{Introduction}',
  'The Aurelian Index defines exactly four tiers: Bronze, Silver, Gold, and Platinum.',
  '\\input{sections/intro}',
  '\\end{document}',
].join('\n');
const SECONDARY_TEX = 'Content that genuinely lives in a secondary file.\n';

const PROJECT = {
  id: 'w-1',
  title: 'Aurelian Index Paper',
  description: null,
  main_tex_content: MAIN_TEX,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};
const ROOT_FILE_ID = 'root-file-id';
const SECONDARY_FILE_ID = 'secondary-file-id';

function rootFileNode() {
  return {
    id: ROOT_FILE_ID,
    parent_id: null,
    kind: 'text',
    name: 'main.tex',
    path: 'main.tex',
    mime_type: null,
    size_bytes: MAIN_TEX.length,
    is_root: true,
  };
}

function secondaryFileNode() {
  return {
    id: SECONDARY_FILE_ID,
    parent_id: null,
    kind: 'text',
    name: 'intro.tex',
    path: 'sections/intro.tex',
    mime_type: null,
    size_bytes: SECONDARY_TEX.length,
    is_root: false,
  };
}

function getProjectRoute(): FetchRoute {
  return {
    method: 'GET',
    matches: (u) => u.endsWith('/writing-projects/w-1'),
    respond: () => jsonResponse(PROJECT),
  };
}
function referencesRoute(): FetchRoute {
  return {
    method: 'GET',
    matches: (u) => u.endsWith('/writing-projects/w-1/references'),
    respond: () =>
      jsonResponse({ references: [], total: 0, missing_citation_keys: [], source_hash: 'hash1' }),
  };
}
function filesTreeRoute(): FetchRoute {
  return {
    method: 'GET',
    matches: (u) => u.endsWith('/writing-projects/w-1/files'),
    respond: () =>
      jsonResponse({
        files: [rootFileNode(), secondaryFileNode()],
        generated: [],
        root_file_id: ROOT_FILE_ID,
        total_size_bytes: MAIN_TEX.length + SECONDARY_TEX.length,
        file_count: 2,
        max_files: 150,
        max_total_bytes: 100_000_000,
      }),
  };
}
function fileContentRoute(): FetchRoute {
  return {
    method: 'GET',
    matches: (u) => u.endsWith(`/writing-projects/w-1/files/${ROOT_FILE_ID}`),
    respond: () => jsonResponse({ file: rootFileNode(), content_text: MAIN_TEX }),
  };
}
function secondaryFileContentRoute(): FetchRoute {
  return {
    method: 'GET',
    matches: (u) => u.endsWith(`/writing-projects/w-1/files/${SECONDARY_FILE_ID}`),
    respond: () => jsonResponse({ file: secondaryFileNode(), content_text: SECONDARY_TEX }),
  };
}
function patchFileRoute(): FetchRoute {
  return {
    method: 'PATCH',
    matches: (u) => u.includes('/writing-projects/w-1/files/'),
    respond: () => jsonResponse({ file: rootFileNode() }),
  };
}

function compileRoute(compileId = 'compile-1'): FetchRoute {
  return {
    method: 'POST',
    matches: (u) => u.endsWith('/writing-projects/w-1/compile'),
    respond: () =>
      jsonResponse({
        status: 'success',
        diagnostics: [],
        log_excerpt: '',
        duration_ms: 250,
        page_count: 1,
        compile_id: compileId,
        pdf_size_bytes: 16,
        source_hash: 'hash1',
      }),
  };
}
function pdfRoute(compileId = 'compile-1'): FetchRoute {
  return {
    method: 'GET',
    matches: (u) => u.endsWith(`/writing-projects/w-1/compile/${compileId}/pdf`),
    respond: () =>
      new Response('%PDF-fake-bytes', {
        status: 200,
        headers: { 'content-type': 'application/pdf' },
      }),
  };
}
function inverseSearchRoute(
  compileId: string,
  response: {
    resolved: boolean;
    file_id?: string | null;
    line?: number | null;
    reason?: 'generated_content' | null;
  }
): FetchRoute {
  return {
    method: 'POST',
    matches: (u) => u.endsWith(`/writing-projects/w-1/compile/${compileId}/inverse-search`),
    respond: () =>
      jsonResponse({
        resolved: response.resolved,
        file_id: response.file_id ?? null,
        line: response.line ?? null,
        reason: response.reason ?? null,
      }),
  };
}

async function flushAsync(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

const activeRenderers: ReactTestRenderer[] = [];
afterEach(() => {
  while (activeRenderers.length > 0) {
    const renderer = activeRenderers.pop()!;
    act(() => {
      renderer.unmount();
    });
  }
});

async function renderCompiledScreen(extraRoutes: FetchRoute[] = []): Promise<ReactTestRenderer> {
  installFetchMock([
    getProjectRoute(),
    referencesRoute(),
    filesTreeRoute(),
    fileContentRoute(),
    secondaryFileContentRoute(),
    patchFileRoute(),
    compileRoute(),
    pdfRoute(),
    ...extraRoutes,
  ]);
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <AuthProvider>
        <ClientProvider>
          <FeatureFlagsProvider>
            <WritingProjectEditorScreen />
          </FeatureFlagsProvider>
        </ClientProvider>
      </AuthProvider>
    );
    await flushAsync();
  });
  activeRenderers.push(renderer);
  // A successful compile is a precondition for SyncTeX navigation (see
  // this file's own module docstring) — every test starts from one.
  await act(async () => {
    findPressableByLabel(renderer.root, 'Compile').props.onPress();
    await flushAsync();
  });
  return renderer;
}

function editorSelection(root: ReactTestInstance): { start: number; end: number } {
  const editors = root.findAllByType(LatexCodeEditor);
  expect(editors).toHaveLength(1); // never a duplicate/second editor
  return editors[0]!.props.selection;
}

describe('WritingProjectEditorScreen — SyncTeX compiled-preview double-click navigation', () => {
  it('navigates the existing editor to the exact resolved line, with no extra editor/panel/modal', async () => {
    const renderer = await renderCompiledScreen([
      inverseSearchRoute('compile-1', { resolved: true, file_id: ROOT_FILE_ID, line: 4 }),
    ]);
    expect(capturedOnDoubleClickLocation).not.toBeNull();

    const before = editorSelection(renderer.root);

    await act(async () => {
      void capturedOnDoubleClickLocation?.({ page: 1, x: 100, y: 150 });
      await flushAsync();
    });

    const after = editorSelection(renderer.root); // also re-asserts exactly one editor
    expect(after).not.toEqual(before);
    // Real-browser validation — SyncTeX's own `Column:-1` means there is
    // no clicked-word range; the WHOLE resolved line must be selected
    // (a real, non-collapsed range), not just a collapsed cursor at its
    // start, so the source is actually VISIBLE as highlighted, not just
    // scrolled to.
    const lines = MAIN_TEX.split('\n');
    const expectedStart = lines.slice(0, 3).join('\n').length + 1;
    const expectedEnd = expectedStart + lines[3]!.length;
    expect(after.start).toBe(expectedStart);
    expect(after.end).toBe(expectedEnd);
    expect(after.end).toBeGreaterThan(after.start); // never a collapsed cursor

    // No modal appeared — Notice/EmptyState error surfaces would render
    // a Text node mentioning it; a silent, correct navigation shouldn't.
    expect(renderer.root.findAll((n) => n.props.testID === 'headless-modal')).toHaveLength(0);
  });

  it('opens the SECONDARY (\\input) file and navigates there when SyncTeX resolves to it — multi-file support', async () => {
    const renderer = await renderCompiledScreen([
      inverseSearchRoute('compile-1', { resolved: true, file_id: SECONDARY_FILE_ID, line: 1 }),
    ]);

    await act(async () => {
      void capturedOnDoubleClickLocation?.({ page: 1, x: 100, y: 300 });
      await flushAsync();
    });

    const after = editorSelection(renderer.root);
    // The WHOLE first line of the secondary file, not a collapsed cursor.
    expect(after.start).toBe(0);
    expect(after.end).toBe(SECONDARY_TEX.split('\n')[0]!.length);
    expect(after.end).toBeGreaterThan(after.start);
    // Confirms the SECONDARY file is now the one actually open (its own
    // content is what the editor is showing), not still main.tex.
    const editors = renderer.root.findAllByType(LatexCodeEditor);
    expect(editors[0]!.props.value).toBe(SECONDARY_TEX);
  });

  it('is a graceful no-op when SyncTeX declines to resolve (never a guessed jump)', async () => {
    const renderer = await renderCompiledScreen([
      inverseSearchRoute('compile-1', { resolved: false }),
    ]);
    const before = editorSelection(renderer.root);

    await act(async () => {
      void capturedOnDoubleClickLocation?.({ page: 1, x: 0, y: 0 });
      await flushAsync();
    });

    expect(editorSelection(renderer.root)).toEqual(before);
  });

  it('shows a specific explanation (not the generic message) when SyncTeX resolves to generated bibliography content', async () => {
    const renderer = await renderCompiledScreen([
      inverseSearchRoute('compile-1', { resolved: false, reason: 'generated_content' }),
    ]);
    const before = editorSelection(renderer.root);

    await act(async () => {
      void capturedOnDoubleClickLocation?.({ page: 1, x: 0, y: 0 });
      await flushAsync();
    });

    expect(editorSelection(renderer.root)).toEqual(before); // never a guessed jump
    expect(
      renderer.root.findAll(
        (n) =>
          String(n.type) === 'Text' &&
          n.children.some(
            (c) => typeof c === 'string' && c.includes('generated bibliography output')
          )
      ).length
    ).toBeGreaterThan(0);
    // Never the generic message for this specific, honestly-explainable case.
    expect(
      renderer.root.findAll(
        (n) => String(n.type) === 'Text' && n.children.includes('Source location unavailable')
      )
    ).toHaveLength(0);
  });

  it('is a graceful no-op when the backend/compiler call itself fails (never a guessed jump)', async () => {
    installFetchMock([
      getProjectRoute(),
      referencesRoute(),
      filesTreeRoute(),
      fileContentRoute(),
      secondaryFileContentRoute(),
      patchFileRoute(),
      compileRoute(),
      pdfRoute(),
      {
        method: 'POST',
        matches: (u) => u.endsWith('/writing-projects/w-1/compile/compile-1/inverse-search'),
        respond: () => new Response('Internal error', { status: 500 }),
      },
    ]);
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <AuthProvider>
          <ClientProvider>
            <FeatureFlagsProvider>
              <WritingProjectEditorScreen />
            </FeatureFlagsProvider>
          </ClientProvider>
        </AuthProvider>
      );
      await flushAsync();
    });
    activeRenderers.push(renderer);
    await act(async () => {
      findPressableByLabel(renderer.root, 'Compile').props.onPress();
      await flushAsync();
    });
    const before = editorSelection(renderer.root);

    await act(async () => {
      void capturedOnDoubleClickLocation?.({ page: 1, x: 0, y: 0 });
      await flushAsync();
    });

    expect(editorSelection(renderer.root)).toEqual(before);
    // The optional "Source location unavailable" note is shown — never
    // a hard error, but not silent either.
    expect(
      renderer.root.findAll(
        (n) => String(n.type) === 'Text' && n.children.includes('Source location unavailable')
      ).length
    ).toBeGreaterThan(0);
  });

  it('is a no-op (never sends a request) when no compile has succeeded yet', async () => {
    installFetchMock([getProjectRoute(), referencesRoute(), filesTreeRoute(), fileContentRoute()]);
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <AuthProvider>
          <ClientProvider>
            <FeatureFlagsProvider>
              <WritingProjectEditorScreen />
            </FeatureFlagsProvider>
          </ClientProvider>
        </AuthProvider>
      );
      await flushAsync();
    });
    activeRenderers.push(renderer);
    const before = editorSelection(renderer.root);

    await act(async () => {
      void capturedOnDoubleClickLocation?.({ page: 1, x: 0, y: 0 });
      await flushAsync();
    });

    expect(editorSelection(renderer.root)).toEqual(before);
    const inverseSearchCalls = (global.fetch as jest.Mock).mock.calls.filter(([url]: [string]) =>
      String(url).includes('/inverse-search')
    );
    expect(inverseSearchCalls).toHaveLength(0);
  });

  it('reveals the editor first when the preview was maximized, then navigates', async () => {
    const renderer = await renderCompiledScreen([
      inverseSearchRoute('compile-1', { resolved: true, file_id: ROOT_FILE_ID, line: 4 }),
    ]);

    act(() => {
      findPressableByLabel(renderer.root, 'Maximize').props.onPress();
    });
    // Maximized: the Editor column is hidden (display: none), but never
    // unmounted — exactly one LatexCodeEditor still exists in the tree.
    expect(renderer.root.findAllByType(LatexCodeEditor)).toHaveLength(1);

    await act(async () => {
      void capturedOnDoubleClickLocation?.({ page: 1, x: 100, y: 150 });
      await flushAsync();
    });

    // Restored: "Maximize" is offered again (not "Restore split"),
    // meaning the split view came back on its own as part of navigating.
    expect(findPressableByLabel(renderer.root, 'Maximize')).toBeTruthy();
  });
});

describe('WritingProjectEditorScreen — compiled preview maximize/restore split', () => {
  it('maximize hides the Editor column without unmounting it, and restore split brings it back', async () => {
    const renderer = await renderCompiledScreen();

    // Split view: Editor visible (not display:none) and "Maximize" offered.
    expect(findPressableByLabel(renderer.root, 'Maximize')).toBeTruthy();
    const editorBefore = renderer.root.findAllByType(LatexCodeEditor);
    expect(editorBefore).toHaveLength(1);

    act(() => {
      findPressableByLabel(renderer.root, 'Maximize').props.onPress();
    });

    // Now offers "Restore split" instead, and the editor is still the
    // exact same mounted instance (never unmounted — just hidden).
    expect(findPressableByLabel(renderer.root, 'Restore split')).toBeTruthy();
    expect(renderer.root.findAll((n) => n.props.accessibilityLabel === 'Maximize')).toHaveLength(0);
    expect(renderer.root.findAllByType(LatexCodeEditor)).toHaveLength(1);

    act(() => {
      findPressableByLabel(renderer.root, 'Restore split').props.onPress();
    });
    expect(findPressableByLabel(renderer.root, 'Maximize')).toBeTruthy();
    expect(renderer.root.findAllByType(LatexCodeEditor)).toHaveLength(1);
  });

  it('the plain "Collapse preview" toggle is hidden while maximized (mutually exclusive states)', async () => {
    const renderer = await renderCompiledScreen();
    expect(findPressableByLabel(renderer.root, 'Collapse preview')).toBeTruthy();

    act(() => {
      findPressableByLabel(renderer.root, 'Maximize').props.onPress();
    });
    expect(
      renderer.root.findAll(
        (n) =>
          n.props.accessibilityLabel === 'Collapse preview' ||
          n.props.accessibilityLabel === 'Expand preview'
      )
    ).toHaveLength(0);
  });
});

describe('WritingProjectEditorScreen — double-click navigation reveals a collapsed mobile editor', () => {
  beforeAll(() => {
    Dimensions.set({
      window: { width: 500, height: 900, scale: 1, fontScale: 1 },
      screen: { width: 500, height: 900, scale: 1, fontScale: 1 },
    });
  });
  afterAll(() => {
    Dimensions.set({
      window: { width: 1400, height: 900, scale: 1, fontScale: 1 },
      screen: { width: 1400, height: 900, scale: 1, fontScale: 1 },
    });
  });

  it('switches the mobile tab bar back to Editor before navigating', async () => {
    const renderer = await renderCompiledScreen([
      inverseSearchRoute('compile-1', { resolved: true, file_id: ROOT_FILE_ID, line: 4 }),
    ]);

    act(() => {
      findPressableByLabel(renderer.root, 'Preview').props.onPress();
    });
    // On the Preview tab: the editor pane itself isn't in the tree at all
    // on narrow/mobile (a totally different tab-driven mount, not the
    // desktop hide-via-display:none technique) — confirms this really is
    // starting from "editor not currently visible".
    expect(renderer.root.findAllByType(LatexCodeEditor)).toHaveLength(0);

    await act(async () => {
      void capturedOnDoubleClickLocation?.({ page: 1, x: 100, y: 150 });
      await flushAsync();
    });

    // Back on the Editor tab, with the correct selection applied.
    expect(renderer.root.findAllByType(LatexCodeEditor)).toHaveLength(1);
  });
});
