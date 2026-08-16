import { Platform } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { AuthProvider } from '@/lib/AuthProvider';
import { ClientProvider } from '@/lib/ClientProvider';
import WritingHomeScreen from '../index';

// Matches notes/__tests__/index.test.tsx's own convention.
const originalOS = Platform.OS;
beforeAll(() => {
  Platform.OS = 'web';
});
afterAll(() => {
  Platform.OS = originalOS;
});

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

function listWritingProjectsRoute(projects: unknown[] = []): FetchRoute {
  return {
    method: 'GET',
    // Milestone 5.3 Part 26/27/28/30 — the dashboard now sends
    // `?q=...&sort=...&archived=...` (any subset), so this matches by
    // path prefix rather than requiring an exact `endsWith` on the bare
    // URL.
    matches: (u) => {
      const path = u.split('?')[0]!;
      return path.endsWith('/writing-projects');
    },
    respond: () => jsonResponse({ projects, total: projects.length }),
  };
}

function duplicateWritingProjectRoute(sourceId: string, response: unknown): FetchRoute {
  return {
    method: 'POST',
    matches: (u) => u.endsWith(`/writing-projects/${sourceId}/duplicate`),
    respond: () => jsonResponse(response, 201),
  };
}

function archiveWritingProjectRoute(projectId: string, response: unknown): FetchRoute {
  return {
    method: 'POST',
    matches: (u) => u.endsWith(`/writing-projects/${projectId}/archive`),
    respond: () => jsonResponse(response),
  };
}

function createWritingProjectRoute(response: unknown): FetchRoute {
  return {
    method: 'POST',
    matches: (u) => u.endsWith('/writing-projects'),
    respond: () => jsonResponse(response, 201),
  };
}

function deleteWritingProjectRoute(projectId: string): FetchRoute {
  return {
    method: 'DELETE',
    matches: (u) => u.endsWith(`/writing-projects/${projectId}`),
    respond: () => new Response(null, { status: 204 }),
  };
}

async function flushAsync(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

// Milestone 5.3 — tracks every renderer so afterEach can unmount it.
// Without this, a debounce scheduled by one test (the search field's
// 300ms setTimeout, or a still-pending refresh()) can still be live when
// a LATER test replaces global.fetch — firing against a torn-down mock
// throws "Unhandled ... in this test" from a stale component instance,
// which manifested as whole-suite hangs/timeouts once Milestone 5.3
// added the debounced search + extra filter-change effects. Matches
// [id].test.tsx's own identical, already-documented fix for the same
// class of bug.
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

const PROJECT = {
  id: 'w-1',
  title: 'Laser Cutting Paper',
  description: null,
  reference_count: 2,
  file_count: 3,
  archived_at: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

describe('WritingHomeScreen', () => {
  beforeEach(() => {
    mockPush.mockClear();
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

  it('shows the page title and each project with its reference count', async () => {
    const renderer = await renderScreen([listWritingProjectsRoute([PROJECT])]);
    expect(findByTextIncluding(renderer.root, 'Writing')).toBeTruthy();
    expect(findByTextIncluding(renderer.root, 'Laser Cutting Paper')).toBeTruthy();
    expect(findByTextIncluding(renderer.root, '2 references')).toBeTruthy();
  });

  it('shows an empty state with a create action when there are no projects', async () => {
    const renderer = await renderScreen([listWritingProjectsRoute([])]);
    expect(findByTextIncluding(renderer.root, 'No writing projects yet.')).toBeTruthy();
  });

  it('opening a project card navigates to /writing/[id]', async () => {
    const renderer = await renderScreen([listWritingProjectsRoute([PROJECT])]);
    act(() => {
      renderer.root
        .find((n) => n.props.accessibilityLabel === 'Open writing project Laser Cutting Paper')
        .props.onPress();
    });
    expect(mockPush).toHaveBeenCalledWith('/writing/w-1');
  });

  it('creating a project POSTs its title and navigates to the new project', async () => {
    const renderer = await renderScreen([
      listWritingProjectsRoute([]),
      createWritingProjectRoute({
        id: 'w-2',
        title: 'New Paper',
        description: null,
        main_tex_content: '\\documentclass{article}',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      }),
    ]);

    act(() => {
      findPressableByLabel(renderer.root, 'New writing project').props.onPress();
    });

    // Milestone 5.3 — the dashboard now also has a "Search writing
    // projects" TextInput (also starting at value === ''), so this
    // locates the create form's title field specifically.
    const input = renderer.root.find(
      (n) => String(n.type) === 'TextInput' && n.props.accessibilityLabel === 'Project title'
    );
    act(() => {
      input.props.onChangeText('New Paper');
    });

    await act(async () => {
      findPressableByText(renderer.root, 'Create').props.onPress();
      await flushAsync();
    });

    const postCall = (global.fetch as jest.Mock).mock.calls.find(
      ([url, init]: [string, RequestInit]) =>
        init?.method === 'POST' && String(url).endsWith('/writing-projects')
    );
    expect(postCall).toBeTruthy();
    expect(JSON.parse(postCall[1].body as string)).toEqual({
      title: 'New Paper',
      description: null,
    });
    expect(mockPush).toHaveBeenCalledWith('/writing/w-2');
  });

  it('deleting a project removes it from the list after confirmation', async () => {
    const originalConfirm = (global as { confirm?: unknown }).confirm;
    const confirmMock = jest.fn(() => true);
    // @ts-expect-error test stub
    global.window = { confirm: confirmMock };
    global.confirm = confirmMock as unknown as typeof confirm;

    try {
      const renderer = await renderScreen([
        listWritingProjectsRoute([PROJECT]),
        deleteWritingProjectRoute('w-1'),
      ]);

      act(() => {
        findPressableByLabel(renderer.root, 'Options for Laser Cutting Paper').props.onPress();
      });

      await act(async () => {
        findPressableByText(renderer.root, 'Delete project').props.onPress();
        await flushAsync();
      });

      expect(confirmMock).toHaveBeenCalled();
      expect(() => findByTextIncluding(renderer.root, 'Laser Cutting Paper')).toThrow();
    } finally {
      // @ts-expect-error test cleanup
      delete global.window;
      global.confirm = originalConfirm as typeof confirm;
    }
  });

  it('shows the file count alongside the reference count', async () => {
    const renderer = await renderScreen([listWritingProjectsRoute([PROJECT])]);
    expect(findByTextIncluding(renderer.root, '3 files')).toBeTruthy();
  });

  it('Milestone 5.3 Part 27 — typing in the search field re-fetches with ?q=... after a debounce', async () => {
    // Render with REAL timers first — renderScreen's own flushAsync()
    // relies on a real setTimeout(0), which would otherwise hang
    // forever once fake timers freeze the clock (matches [id].test.tsx's
    // identical established convention).
    const renderer = await renderScreen([listWritingProjectsRoute([PROJECT])]);
    jest.useFakeTimers();
    try {
      const callsBefore = (global.fetch as jest.Mock).mock.calls.length;

      const searchInput = renderer.root.find(
        (n) =>
          String(n.type) === 'TextInput' &&
          n.props.accessibilityLabel === 'Search writing projects'
      );
      act(() => {
        searchInput.props.onChangeText('climate');
      });
      // No request fires synchronously — debounced.
      expect((global.fetch as jest.Mock).mock.calls.length).toBe(callsBefore);

      await act(async () => {
        await jest.advanceTimersByTimeAsync(400);
      });

      const searchCall = (global.fetch as jest.Mock).mock.calls.find(([url]: [string]) =>
        String(url).includes('q=climate')
      );
      expect(searchCall).toBeTruthy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('Milestone 5.3 Part 28 — choosing a sort option re-fetches with ?sort=name', async () => {
    const renderer = await renderScreen([listWritingProjectsRoute([PROJECT])]);

    act(() => {
      findPressableByLabel(renderer.root, 'Sort: Last modified').props.onPress();
    });
    await act(async () => {
      findPressableByText(renderer.root, 'Name').props.onPress();
      await flushAsync();
    });

    const sortCall = (global.fetch as jest.Mock).mock.calls.find(([url]: [string]) =>
      String(url).includes('sort=name')
    );
    expect(sortCall).toBeTruthy();
  });

  it('Milestone 5.3 Part 30 — "Show archived" re-fetches with ?archived=true and shows the ARCHIVED badge', async () => {
    const archivedProject = { ...PROJECT, id: 'w-3', archived_at: '2026-01-05T00:00:00Z' };
    const renderer = await renderScreen([
      // The archived-specific route MUST be listed before the generic
      // listWritingProjectsRoute() default below — installFetchMock
      // picks the FIRST matching route, and the generic one would
      // otherwise also match this ?archived=true request.
      {
        method: 'GET',
        matches: (u) => u.includes('/writing-projects') && u.includes('archived=true'),
        respond: () => jsonResponse({ projects: [archivedProject], total: 1 }),
      },
      listWritingProjectsRoute([PROJECT]),
    ]);

    await act(async () => {
      findPressableByText(renderer.root, 'Show archived').props.onPress();
      await flushAsync();
    });

    const archivedCall = (global.fetch as jest.Mock).mock.calls.find(([url]: [string]) =>
      String(url).includes('archived=true')
    );
    expect(archivedCall).toBeTruthy();
    expect(findByTextIncluding(renderer.root, 'ARCHIVED')).toBeTruthy();
  });

  it('Milestone 5.3 Part 29 — "Duplicate" POSTs to the duplicate endpoint and navigates to the copy', async () => {
    const renderer = await renderScreen([
      listWritingProjectsRoute([PROJECT]),
      duplicateWritingProjectRoute('w-1', {
        id: 'w-copy',
        title: 'Laser Cutting Paper (copy)',
        description: null,
        main_tex_content: '\\documentclass{article}',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      }),
    ]);

    act(() => {
      findPressableByLabel(renderer.root, 'Options for Laser Cutting Paper').props.onPress();
    });
    await act(async () => {
      findPressableByText(renderer.root, 'Duplicate').props.onPress();
      await flushAsync();
    });

    const duplicateCall = (global.fetch as jest.Mock).mock.calls.find(
      ([url, init]: [string, RequestInit]) =>
        init?.method === 'POST' && String(url).endsWith('/writing-projects/w-1/duplicate')
    );
    expect(duplicateCall).toBeTruthy();
    expect(mockPush).toHaveBeenCalledWith('/writing/w-copy');
  });

  it('Milestone 5.3 Part 30 — "Archive" POSTs to the archive endpoint and removes the project from the active list', async () => {
    const renderer = await renderScreen([
      listWritingProjectsRoute([PROJECT]),
      archiveWritingProjectRoute('w-1', { ...PROJECT, archived_at: '2026-01-05T00:00:00Z' }),
    ]);

    act(() => {
      findPressableByLabel(renderer.root, 'Options for Laser Cutting Paper').props.onPress();
    });
    await act(async () => {
      findPressableByText(renderer.root, 'Archive').props.onPress();
      await flushAsync();
    });

    const archiveCall = (global.fetch as jest.Mock).mock.calls.find(
      ([url, init]: [string, RequestInit]) =>
        init?.method === 'POST' && String(url).endsWith('/writing-projects/w-1/archive')
    );
    expect(archiveCall).toBeTruthy();
    expect(() => findByTextIncluding(renderer.root, 'Laser Cutting Paper')).toThrow();
  });
});
