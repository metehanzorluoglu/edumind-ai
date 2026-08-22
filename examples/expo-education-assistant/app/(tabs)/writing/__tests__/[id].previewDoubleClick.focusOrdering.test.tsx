/**
 * Writing UX Refinement milestone — real-browser validation found a
 * genuine regression in compiled-preview double-click navigation (also
 * shared by Outline entries and Find & Replace, all three funneling
 * through [id].tsx's own `navigateToOffsetRange`): the correct source
 * text DID become selected/highlighted, but the editor's VIEWPORT
 * scrolled to an unrelated location, so the highlighted match was off-
 * screen until manually scrolled to.
 *
 * Root cause: `navigateToOffsetRange` used to call
 * `editorRef.current?.focus()` SYNCHRONOUSLY, immediately after
 * `setSelection`/`setFlashLine` — i.e. BEFORE React had actually
 * re-rendered and committed the new selection into the real DOM
 * (LatexCodeEditor's own useLayoutEffect is what calls
 * `el.setSelectionRange(...)` and corrects `el.scrollTop` to reveal it).
 * The fix (still in force, unmodified by the SyncTeX milestone —
 * `navigateToOffsetRange` itself didn't change) defers the `.focus()`
 * call to the next animation frame.
 *
 * SyncTeX implementation — `handlePreviewDoubleClick` is now async (it
 * awaits the backend's inverse-search response before ever calling
 * `navigateToOffsetRange`), which makes the original "assert focus()
 * hasn't fired yet inside a bare synchronous act()" ordering check no
 * longer a clean signal on its own (the whole handler already yields at
 * its first `await`, for reasons unrelated to the focus-deferral fix).
 * What this file verifies instead: a successful SyncTeX-resolved
 * double-click still ends with the editor focused EXACTLY ONCE — a
 * regression guard against silently losing focus-on-navigate (or
 * double-focusing) now that the resolution path runs through a real
 * network round trip instead of a synchronous local computation.
 */
import type React from 'react';
import { Dimensions, Platform } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import type { PreviewClickLocation } from '@/components/writing/CompiledPdfPreview';
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

let capturedOnDoubleClickLocation: ((location: PreviewClickLocation) => void) | null = null;
jest.mock('@/components/writing/CompiledPdfPreview', () => ({
  CompiledPdfPreview: (props: {
    onDoubleClickLocation?: (location: PreviewClickLocation) => void;
  }) => {
    capturedOnDoubleClickLocation = props.onDoubleClickLocation ?? null;
    return null;
  },
}));

// Stands in for the real LatexCodeEditor purely to observe WHEN `.focus()`
// is invoked via its imperative handle — everything else (selection/value
// rendering) is irrelevant to this specific regression, which is about
// call ORDERING/COUNT, not about what selection value gets computed
// (already covered by [id].previewDoubleClick.test.tsx's real-
// LatexCodeEditor assertions).
const mockFocus = jest.fn();
jest.mock('@/components/writing/LatexCodeEditor', () => {
  const ReactActual = jest.requireActual('react');
  return {
    LatexCodeEditor: ReactActual.forwardRef(function MockLatexCodeEditor(
      _props: unknown,
      ref: React.Ref<{ focus: () => void }>
    ) {
      ReactActual.useImperativeHandle(ref, () => ({ focus: mockFocus }));
      return null;
    }),
  };
});

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
  mockFocus.mockClear();
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
  '\\end{document}',
].join('\n');

const PROJECT = {
  id: 'w-1',
  title: 'Aurelian Index Paper',
  description: null,
  main_tex_content: MAIN_TEX,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};
const ROOT_FILE_ID = 'root-file-id';

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
        files: [rootFileNode()],
        generated: [],
        root_file_id: ROOT_FILE_ID,
        total_size_bytes: MAIN_TEX.length,
        file_count: 1,
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
function patchFileRoute(): FetchRoute {
  return {
    method: 'PATCH',
    matches: (u) => u.endsWith(`/writing-projects/w-1/files/${ROOT_FILE_ID}`),
    respond: () => jsonResponse({ file: rootFileNode() }),
  };
}
function compileRoute(): FetchRoute {
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
        compile_id: 'compile-1',
        pdf_size_bytes: 16,
        source_hash: 'hash1',
      }),
  };
}
function pdfRoute(): FetchRoute {
  return {
    method: 'GET',
    matches: (u) => u.endsWith('/writing-projects/w-1/compile/compile-1/pdf'),
    respond: () =>
      new Response('%PDF-fake-bytes', {
        status: 200,
        headers: { 'content-type': 'application/pdf' },
      }),
  };
}
function inverseSearchRoute(line: number): FetchRoute {
  return {
    method: 'POST',
    matches: (u) => u.endsWith('/writing-projects/w-1/compile/compile-1/inverse-search'),
    respond: () => jsonResponse({ resolved: true, file_id: ROOT_FILE_ID, line }),
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

async function renderCompiledScreen(): Promise<ReactTestRenderer> {
  installFetchMock([
    getProjectRoute(),
    referencesRoute(),
    filesTreeRoute(),
    fileContentRoute(),
    patchFileRoute(),
    compileRoute(),
    pdfRoute(),
    inverseSearchRoute(4),
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
  return renderer;
}

describe('WritingProjectEditorScreen — preview double-click still focuses the editor exactly once (SyncTeX flow)', () => {
  it('focuses the editor exactly once after a successful SyncTeX-resolved double-click', async () => {
    const renderer = await renderCompiledScreen();
    expect(capturedOnDoubleClickLocation).not.toBeNull();

    await act(async () => {
      capturedOnDoubleClickLocation?.({ page: 1, x: 100, y: 150 });
      await flushAsync();
    });

    expect(mockFocus).toHaveBeenCalledTimes(1);

    void renderer;
  });

  it('focuses the editor exactly once per navigation across repeated double-clicks (no accumulation)', async () => {
    const renderer = await renderCompiledScreen();

    await act(async () => {
      capturedOnDoubleClickLocation?.({ page: 1, x: 100, y: 150 });
      await flushAsync();
    });
    expect(mockFocus).toHaveBeenCalledTimes(1);

    await act(async () => {
      capturedOnDoubleClickLocation?.({ page: 1, x: 100, y: 200 });
      await flushAsync();
    });
    expect(mockFocus).toHaveBeenCalledTimes(2);

    void renderer;
  });
});
