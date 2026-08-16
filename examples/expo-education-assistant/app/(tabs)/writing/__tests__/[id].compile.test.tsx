import { Platform } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { AuthProvider } from '@/lib/AuthProvider';
import { ClientProvider } from '@/lib/ClientProvider';
import { FeatureFlagsProvider } from '@/lib/FeatureFlags';
import WritingProjectEditorScreen from '../[id]';

/**
 * Milestone 5.1 Part 24/25/33/36 — the Compile button + PDF preview
 * wiring, kept in its own file (separate from the pre-existing M5
 * [id].test.tsx) so the flag-on setup (bootstrap env var + a mocked
 * lib/pdfjs) doesn't leak into that file's flag-off-by-default tests.
 * Never exercises real pdfjs-dist parsing (see CompiledPdfPreview.test's
 * own docstring for why) — `getPdfjs()` is mocked to a minimal
 * controllable fake here.
 */
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

jest.mock('@/lib/pdfjs', () => ({
  getPdfjs: jest.fn().mockResolvedValue({
    getDocument: () => ({
      promise: Promise.resolve({
        numPages: 1,
        getPage: async () => ({
          getViewport: () => ({ width: 100, height: 100 }),
          render: () => ({ promise: Promise.resolve() }),
        }),
      }),
    }),
    renderTextLayer: () => ({ promise: Promise.resolve(), cancel: () => {} }),
  }),
}));

const originalOS = Platform.OS;
beforeAll(() => {
  Platform.OS = 'web';
});
afterAll(() => {
  Platform.OS = originalOS;
});

beforeEach(() => {
  process.env.EXPO_PUBLIC_LATEX_COMPILATION_ENABLED = 'true';
});
afterEach(() => {
  delete process.env.EXPO_PUBLIC_LATEX_COMPILATION_ENABLED;
});

function findPressableByLabel(root: ReactTestInstance, label: string): ReactTestInstance {
  return root.find(
    (node) => typeof node.props.onPress === 'function' && node.props.accessibilityLabel === label
  );
}

function findAllPressablesByLabel(root: ReactTestInstance, label: string): ReactTestInstance[] {
  return root.findAll(
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
    matches: (u) => u.endsWith('/writing-projects/w-1'),
    respond: () => jsonResponse(PROJECT),
  };
}

function referencesRoute(sourceHash = 'hash1'): FetchRoute {
  return {
    method: 'GET',
    matches: (u) => u.endsWith('/writing-projects/w-1/references'),
    respond: () =>
      jsonResponse({
        references: [],
        total: 0,
        missing_citation_keys: [],
        source_hash: sourceHash,
      }),
  };
}

function compileRoute(response: Record<string, unknown>): FetchRoute {
  return {
    method: 'POST',
    matches: (u) => u.endsWith('/writing-projects/w-1/compile'),
    respond: () => jsonResponse(response),
  };
}

function pdfRoute(compileId: string): FetchRoute {
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

// Milestone 5.3 — useWritingProjectFiles fetches the file tree + the
// root file's content on mount, exactly like the pre-M5.3 editor's own
// useWritingProject fetched main_tex_content directly. Every test here
// gets this one-file default unless it lists its own override earlier.
const ROOT_FILE_ID = 'root-file-id';

function rootFileNode() {
  return {
    id: ROOT_FILE_ID,
    parent_id: null,
    kind: 'text',
    name: 'main.tex',
    path: 'main.tex',
    mime_type: null,
    size_bytes: PROJECT.main_tex_content.length,
    is_root: true,
  };
}

function filesTreeRoute(): FetchRoute {
  return {
    method: 'GET',
    matches: (u) => u.endsWith('/writing-projects/w-1/files'),
    respond: () =>
      jsonResponse({
        files: [rootFileNode()],
        generated: [{ name: 'references.bib', path: 'references.bib', read_only: true, reference_count: 0 }],
        root_file_id: ROOT_FILE_ID,
        total_size_bytes: PROJECT.main_tex_content.length,
        file_count: 1,
        max_files: 150,
        max_total_bytes: 100_000_000,
      }),
  };
}

function fileContentRoute(content: string = PROJECT.main_tex_content): FetchRoute {
  return {
    method: 'GET',
    matches: (u) => u.endsWith(`/writing-projects/w-1/files/${ROOT_FILE_ID}`),
    respond: () => jsonResponse({ file: rootFileNode(), content_text: content }),
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

async function renderScreen(routes: FetchRoute[]): Promise<ReactTestRenderer> {
  installFetchMock([...routes, filesTreeRoute(), fileContentRoute()]);
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
  return renderer;
}

describe('WritingProjectEditorScreen — Compile (Milestone 5.1)', () => {
  it('shows a Compile button when latexCompilation is enabled', async () => {
    const renderer = await renderScreen([getProjectRoute(), referencesRoute()]);
    expect(findAllPressablesByLabel(renderer.root, 'Compile')).toHaveLength(1);
  });

  it('a successful compile fetches the PDF and shows a Download PDF action', async () => {
    const renderer = await renderScreen([
      getProjectRoute(),
      referencesRoute('hash1'),
      compileRoute({
        status: 'success',
        diagnostics: [],
        log_excerpt: '',
        duration_ms: 250,
        page_count: 1,
        compile_id: 'c1',
        pdf_size_bytes: 16,
        source_hash: 'hash1',
      }),
      pdfRoute('c1'),
    ]);

    await act(async () => {
      findPressableByLabel(renderer.root, 'Compile').props.onPress();
      await flushAsync();
    });

    // jest-expo's default test viewport is narrow (mobile tabs) — the
    // Download PDF action lives inside the Preview tab's own content,
    // same as References/Notes' own tab-gated content elsewhere in this
    // screen (see the pre-existing M5 [id].test.tsx's identical
    // "click a mobile tab first" pattern).
    act(() => {
      findPressableByLabel(renderer.root, 'Preview').props.onPress();
    });

    expect(findAllPressablesByLabel(renderer.root, 'Download PDF')).toHaveLength(1);
  });

  it('a failed compile shows diagnostics and never fetches a PDF', async () => {
    const renderer = await renderScreen([
      getProjectRoute(),
      referencesRoute('hash1'),
      compileRoute({
        status: 'error',
        diagnostics: [{ severity: 'error', message: 'Undefined control sequence', line: 3 }],
        log_excerpt: '! Undefined control sequence.',
        duration_ms: 100,
        source_hash: 'hash1',
      }),
    ]);

    await act(async () => {
      findPressableByLabel(renderer.root, 'Compile').props.onPress();
      await flushAsync();
    });

    const matches = renderer.root.findAll(
      (node) =>
        String(node.type) === 'Text' &&
        node.children.some((c) => typeof c === 'string' && c.includes('Undefined control sequence'))
    );
    expect(matches.length).toBeGreaterThan(0);
    expect(findAllPressablesByLabel(renderer.root, 'Download PDF')).toHaveLength(0);
  });

  it('regression: a transport-level compile failure (e.g. 429 rate limit) shows an error message, not silence', async () => {
    // Reproduces a real gap found during Milestone 5.1 local browser
    // validation: hitting the compile rate limit produced a rejected
    // promise that was silently caught with no visible feedback — the
    // button just reverted to "Compile" as if nothing happened. Fixed
    // by setting compileTransportError and rendering it via the same
    // error-bar pattern as save/export/delete.
    const renderer = await renderScreen([
      getProjectRoute(),
      referencesRoute('hash1'),
      {
        method: 'POST',
        matches: (u) => u.endsWith('/writing-projects/w-1/compile'),
        respond: () =>
          new Response(JSON.stringify({ detail: 'Too many compile requests recently.' }), {
            status: 429,
          }),
      },
    ]);

    await act(async () => {
      findPressableByLabel(renderer.root, 'Compile').props.onPress();
      await flushAsync();
    });

    const matches = renderer.root.findAll(
      (node) =>
        String(node.type) === 'Text' &&
        node.children.some(
          (c) => typeof c === 'string' && c.includes('Too many compile requests recently.')
        )
    );
    expect(matches.length).toBeGreaterThan(0);
  });

  it('never contacts the compiler for anything other than the compile/pdf endpoints (no LLM/embedding calls)', async () => {
    const renderer = await renderScreen([
      getProjectRoute(),
      referencesRoute('hash1'),
      compileRoute({
        status: 'success',
        diagnostics: [],
        log_excerpt: '',
        duration_ms: 250,
        compile_id: 'c1',
        pdf_size_bytes: 16,
        source_hash: 'hash1',
      }),
      pdfRoute('c1'),
    ]);

    const calls: string[] = [];
    const originalFetch = global.fetch;
    global.fetch = jest.fn(async (input, init) => {
      calls.push(`${(init?.method ?? 'GET').toUpperCase()} ${input}`);
      return (originalFetch as typeof fetch)(input as RequestInfo, init);
    }) as unknown as typeof fetch;

    await act(async () => {
      findPressableByLabel(renderer.root, 'Compile').props.onPress();
      await flushAsync();
    });

    for (const call of calls) {
      expect(call).not.toMatch(/ollama|qdrant|crossref|openalex/i);
    }
  });
});
