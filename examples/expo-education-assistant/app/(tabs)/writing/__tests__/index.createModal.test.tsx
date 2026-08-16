import { Platform } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { AuthProvider } from '@/lib/AuthProvider';
import { ClientProvider } from '@/lib/ClientProvider';
import WritingHomeScreen from '../index';

/**
 * Milestone 5.4 (LaTeX Templates & Project Import) Part 24/44 — the
 * "+ New writing project" flow's three creation paths (Blank / EduM8
 * template / Upload .zip), kept in its own file (separate from the
 * pre-existing M5.3 index.test.tsx) matching [id].compile.test.tsx's
 * own established convention for milestone-scoped additions to an
 * already-large screen test file.
 */
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn() }),
  useLocalSearchParams: () => ({}),
  usePathname: () => '/writing',
  useGlobalSearchParams: () => ({}),
}));

jest.mock('expo-document-picker', () => ({
  getDocumentAsync: jest.fn(),
}));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getDocumentAsync } = require('expo-document-picker') as { getDocumentAsync: jest.Mock };

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
  const matches = root.findAll((node) => {
    if (String(node.type) !== 'Text') return false;
    return textOf(node).includes(substring);
  });
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

function findPressableByText(root: ReactTestInstance, text: string): ReactTestInstance {
  return root.find(
    (node) =>
      typeof node.props.onPress === 'function' &&
      node.findAll((n) => String(n.type) === 'Text' && textOf(n) === text).length > 0
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

function listWritingProjectsRoute(): FetchRoute {
  return {
    method: 'GET',
    matches: (u) => u.split('?')[0]!.endsWith('/writing-projects'),
    respond: () => jsonResponse({ projects: [], total: 0 }),
  };
}

const TEMPLATE_SUMMARY = {
  id: 'academic-article',
  name: 'Academic Article',
  description: 'A structured, multi-file article starter.',
  category: 'Article',
  license: 'EduM8-authored',
  source: 'EduM8',
  version: 1,
  file_count: 6,
};

const TEMPLATE_DETAIL = {
  ...TEMPLATE_SUMMARY,
  root: 'main.tex',
  files: [
    { path: 'main.tex', kind: 'text' },
    { path: 'sections/introduction.tex', kind: 'text' },
  ],
};

function listWritingTemplatesRoute(): FetchRoute {
  return {
    method: 'GET',
    matches: (u) => u.endsWith('/writing-templates'),
    respond: () => jsonResponse({ templates: [TEMPLATE_SUMMARY], total: 1 }),
  };
}

function getWritingTemplateRoute(): FetchRoute {
  return {
    method: 'GET',
    matches: (u) => u.endsWith('/writing-templates/academic-article'),
    respond: () => jsonResponse(TEMPLATE_DETAIL),
  };
}

function createFromTemplateRoute(response: unknown): FetchRoute {
  return {
    method: 'POST',
    matches: (u) => u.endsWith('/writing-templates/academic-article/create'),
    respond: () => jsonResponse(response, 201),
  };
}

function inspectImportRoute(response: unknown, status = 200): FetchRoute {
  return {
    method: 'POST',
    matches: (u) => u.endsWith('/writing-projects/import/inspect'),
    respond: () => jsonResponse(response, status),
  };
}

function confirmImportRoute(sessionId: string, response: unknown, status = 201): FetchRoute {
  return {
    method: 'POST',
    matches: (u) => u.endsWith(`/writing-projects/import/${sessionId}/confirm`),
    respond: () => jsonResponse(response, status),
  };
}

function cancelImportRoute(sessionId: string): FetchRoute {
  return {
    method: 'DELETE',
    matches: (u) => u.endsWith(`/writing-projects/import/${sessionId}`),
    respond: () => new Response(null, { status: 204 }),
  };
}

async function flushAsync(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

let activeRenderers: ReactTestRenderer[] = [];

async function renderScreen(routes: FetchRoute[]): Promise<ReactTestRenderer> {
  installFetchMock(routes);
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <AuthProvider>
        <ClientProvider>
          <WritingHomeScreen />
        </ClientProvider>
      </AuthProvider>
    );
    await flushAsync();
  });
  activeRenderers.push(renderer);
  return renderer;
}

function openCreateModal(renderer: ReactTestRenderer): void {
  act(() => {
    findPressableByLabel(renderer.root, 'New writing project').props.onPress();
  });
}

describe('CreateWritingProjectModal (Milestone 5.4)', () => {
  beforeEach(() => {
    mockPush.mockClear();
    getDocumentAsync.mockReset();
    activeRenderers = [];
  });

  afterEach(async () => {
    for (const renderer of activeRenderers) {
      await act(async () => {
        renderer.unmount();
        await flushAsync();
      });
    }
  });

  it('opening the modal shows all three creation choices', async () => {
    const renderer = await renderScreen([listWritingProjectsRoute()]);
    openCreateModal(renderer);

    expect(findByTextIncluding(renderer.root, 'Blank project')).toBeTruthy();
    expect(findByTextIncluding(renderer.root, 'EduM8 template')).toBeTruthy();
    expect(findByTextIncluding(renderer.root, 'Upload .zip')).toBeTruthy();
  });

  it('Blank project: filling a title and confirming POSTs /writing-projects and navigates', async () => {
    const renderer = await renderScreen([
      listWritingProjectsRoute(),
      {
        method: 'POST',
        matches: (u) => u.endsWith('/writing-projects'),
        respond: () =>
          jsonResponse(
            {
              id: 'w-blank',
              title: 'My Blank Paper',
              description: null,
              main_tex_content: '\\documentclass{article}',
              created_at: '2026-01-01T00:00:00Z',
              updated_at: '2026-01-01T00:00:00Z',
            },
            201
          ),
      },
    ]);
    openCreateModal(renderer);

    act(() => {
      findPressableByLabel(renderer.root, 'Blank project').props.onPress();
    });

    const input = renderer.root.find(
      (n) => String(n.type) === 'TextInput' && n.props.accessibilityLabel === 'Project title'
    );
    act(() => {
      input.props.onChangeText('My Blank Paper');
    });

    await act(async () => {
      findPressableByText(renderer.root, 'Create').props.onPress();
      await flushAsync();
    });

    expect(mockPush).toHaveBeenCalledWith('/writing/w-blank');
  });

  it('EduM8 template: gallery lists templates; Use template -> preview -> Create project navigates', async () => {
    const renderer = await renderScreen([
      listWritingProjectsRoute(),
      listWritingTemplatesRoute(),
      getWritingTemplateRoute(),
      createFromTemplateRoute({
        id: 'w-template',
        title: 'Academic Article',
        description: null,
        main_tex_content: '\\documentclass{article}',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      }),
    ]);
    openCreateModal(renderer);

    await act(async () => {
      findPressableByLabel(renderer.root, 'EduM8 template').props.onPress();
      await flushAsync();
    });

    expect(findByTextIncluding(renderer.root, 'Academic Article')).toBeTruthy();

    await act(async () => {
      findPressableByLabel(renderer.root, 'Use template Academic Article').props.onPress();
      await flushAsync();
    });

    // Preview shows the file tree with the root document marked.
    expect(findByTextIncluding(renderer.root, 'sections/introduction.tex')).toBeTruthy();

    await act(async () => {
      findPressableByText(renderer.root, 'Create project').props.onPress();
      await flushAsync();
    });

    const createCall = (global.fetch as jest.Mock).mock.calls.find(
      ([url, init]: [string, RequestInit]) =>
        init?.method === 'POST' &&
        String(url).endsWith('/writing-templates/academic-article/create')
    );
    expect(createCall).toBeTruthy();
    expect(mockPush).toHaveBeenCalledWith('/writing/w-template');
  });

  it('Upload .zip: a clean archive is inspected, previewed, and confirmed', async () => {
    getDocumentAsync.mockResolvedValue({
      canceled: false,
      assets: [
        {
          name: 'project.zip',
          mimeType: 'application/zip',
          uri: 'blob:mock',
          file: new File(['zip bytes'], 'project.zip', { type: 'application/zip' }),
        },
      ],
    });

    const renderer = await renderScreen([
      listWritingProjectsRoute(),
      inspectImportRoute({
        session_id: 's1',
        suggested_title: 'Imported Project',
        files: [{ path: 'main.tex', kind: 'text', size_bytes: 20 }],
        root_candidates: ['main.tex'],
        preselected_root: 'main.tex',
        warnings: [],
        total_size_bytes: 20,
        expires_at: '2026-01-01T00:30:00Z',
      }),
      confirmImportRoute('s1', {
        id: 'w-imported',
        title: 'Imported Project',
        description: null,
        main_tex_content: '\\documentclass{article}',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      }),
    ]);
    openCreateModal(renderer);

    act(() => {
      findPressableByLabel(renderer.root, 'Upload .zip').props.onPress();
    });

    await act(async () => {
      findPressableByLabel(renderer.root, 'Choose a .zip file to upload').props.onPress();
      await flushAsync();
    });

    // Preview: single file listed, no warnings.
    expect(findByTextIncluding(renderer.root, 'main.tex')).toBeTruthy();
    expect(queryByTextIncluding(renderer.root, 'skipped')).toBeNull();

    await act(async () => {
      findPressableByText(renderer.root, 'Create project').props.onPress();
      await flushAsync();
    });

    const confirmCall = (global.fetch as jest.Mock).mock.calls.find(
      ([url, init]: [string, RequestInit]) =>
        init?.method === 'POST' && String(url).endsWith('/writing-projects/import/s1/confirm')
    );
    expect(confirmCall).toBeTruthy();
    expect(JSON.parse(confirmCall[1].body as string)).toEqual({
      title: 'Imported Project',
      description: null,
      root_path: 'main.tex',
    });
    expect(mockPush).toHaveBeenCalledWith('/writing/w-imported');
  });

  it('Upload .zip: warnings are shown, and a rejected archive shows a clear error with a retry option', async () => {
    getDocumentAsync.mockResolvedValue({
      canceled: false,
      assets: [
        {
          name: 'evil.zip',
          mimeType: 'application/zip',
          uri: 'blob:mock',
          file: new File(['zip bytes'], 'evil.zip', { type: 'application/zip' }),
        },
      ],
    });

    const renderer = await renderScreen([
      listWritingProjectsRoute(),
      inspectImportRoute({ detail: 'Archive contains an unsafe path' }, 422),
    ]);
    openCreateModal(renderer);

    act(() => {
      findPressableByLabel(renderer.root, 'Upload .zip').props.onPress();
    });

    await act(async () => {
      findPressableByLabel(renderer.root, 'Choose a .zip file to upload').props.onPress();
      await flushAsync();
    });

    expect(findByTextIncluding(renderer.root, "Couldn't import this archive")).toBeTruthy();
    expect(findPressableByText(renderer.root, 'Choose a different file')).toBeTruthy();
  });

  it('Upload .zip: multiple root candidates require an explicit choice before "Create project" is enabled', async () => {
    getDocumentAsync.mockResolvedValue({
      canceled: false,
      assets: [
        {
          name: 'project.zip',
          mimeType: 'application/zip',
          uri: 'blob:mock',
          file: new File(['zip bytes'], 'project.zip', { type: 'application/zip' }),
        },
      ],
    });

    const renderer = await renderScreen([
      listWritingProjectsRoute(),
      inspectImportRoute({
        session_id: 's2',
        suggested_title: 'Imported Project',
        files: [
          { path: 'main.tex', kind: 'text', size_bytes: 20 },
          { path: 'alt.tex', kind: 'text', size_bytes: 20 },
        ],
        root_candidates: ['main.tex', 'alt.tex'],
        preselected_root: null,
        warnings: [],
        total_size_bytes: 40,
        expires_at: '2026-01-01T00:30:00Z',
      }),
      confirmImportRoute('s2', {
        id: 'w-multi',
        title: 'Imported Project',
        description: null,
        main_tex_content: '\\documentclass{article}',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      }),
    ]);
    openCreateModal(renderer);

    act(() => {
      findPressableByLabel(renderer.root, 'Upload .zip').props.onPress();
    });
    await act(async () => {
      findPressableByLabel(renderer.root, 'Choose a .zip file to upload').props.onPress();
      await flushAsync();
    });

    expect(findByTextIncluding(renderer.root, 'Which file is your main document?')).toBeTruthy();
    const createButton = findPressableByText(renderer.root, 'Create project');
    expect(
      createButton.props.accessibilityState?.disabled ?? createButton.props.disabled
    ).toBeTruthy();

    act(() => {
      findPressableByLabel(renderer.root, 'Set alt.tex as the root document').props.onPress();
    });

    await act(async () => {
      findPressableByText(renderer.root, 'Create project').props.onPress();
      await flushAsync();
    });

    const confirmCall = (global.fetch as jest.Mock).mock.calls.find(
      ([url, init]: [string, RequestInit]) =>
        init?.method === 'POST' && String(url).endsWith('/writing-projects/import/s2/confirm')
    );
    expect(JSON.parse(confirmCall[1].body as string).root_path).toBe('alt.tex');
  });

  it('Upload .zip: closing the modal after a successful inspection cancels the staged session', async () => {
    getDocumentAsync.mockResolvedValue({
      canceled: false,
      assets: [
        {
          name: 'project.zip',
          mimeType: 'application/zip',
          uri: 'blob:mock',
          file: new File(['zip bytes'], 'project.zip', { type: 'application/zip' }),
        },
      ],
    });

    const renderer = await renderScreen([
      listWritingProjectsRoute(),
      inspectImportRoute({
        session_id: 's3',
        suggested_title: 'Imported Project',
        files: [{ path: 'main.tex', kind: 'text', size_bytes: 20 }],
        root_candidates: ['main.tex'],
        preselected_root: 'main.tex',
        warnings: [],
        total_size_bytes: 20,
        expires_at: '2026-01-01T00:30:00Z',
      }),
      cancelImportRoute('s3'),
    ]);
    openCreateModal(renderer);

    act(() => {
      findPressableByLabel(renderer.root, 'Upload .zip').props.onPress();
    });
    await act(async () => {
      findPressableByLabel(renderer.root, 'Choose a .zip file to upload').props.onPress();
      await flushAsync();
    });

    await act(async () => {
      findPressableByLabel(renderer.root, 'Close').props.onPress();
      await flushAsync();
    });

    const cancelCall = (global.fetch as jest.Mock).mock.calls.find(
      ([url, init]: [string, RequestInit]) =>
        init?.method === 'DELETE' && String(url).endsWith('/writing-projects/import/s3')
    );
    expect(cancelCall).toBeTruthy();
  });
});
