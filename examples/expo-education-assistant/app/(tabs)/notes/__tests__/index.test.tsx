import { Platform } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { AuthProvider } from '@/lib/AuthProvider';
import { ClientProvider } from '@/lib/ClientProvider';
import NotesHomeScreen from '../index';

// Matches [id].test.tsx's own convention: forcing 'web' here (not just
// relying on the jest-expo default platform) is what gives every
// RN-Pressable-backed Button a single, unambiguous fiber match for
// react-test-renderer's `.find()` — the native (non-web) Pressable
// implementation resolves to a different internal shape that can
// double-match a `.find()` predicate based only on onPress + text.
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
  usePathname: () => '/notes',
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

function listNotebooksRoute(notebooks: unknown[] = []): FetchRoute {
  return {
    method: 'GET',
    matches: (u) => u.includes('/notebooks') && !u.includes('/entries'),
    respond: () => jsonResponse({ notebooks, total: notebooks.length }),
  };
}

function createNotebookRoute(response: unknown): FetchRoute {
  return {
    method: 'POST',
    matches: (u) => u.endsWith('/notebooks'),
    respond: () => jsonResponse(response, 201),
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
          <NotesHomeScreen />
        </ClientProvider>
      </AuthProvider>
    );
    await flushAsync();
  });
  return renderer;
}

const NOTEBOOK = {
  id: 'nb-1',
  name: 'Reading List',
  entry_count: 3,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

describe('NotesHomeScreen', () => {
  beforeEach(() => {
    mockPush.mockClear();
  });

  it('shows the page title and each notebook with its entry count', async () => {
    const renderer = await renderScreen([listNotebooksRoute([NOTEBOOK])]);
    expect(findByTextIncluding(renderer.root, 'Research Notes')).toBeTruthy();
    expect(findByTextIncluding(renderer.root, 'Reading List')).toBeTruthy();
    expect(findByTextIncluding(renderer.root, '3 entries')).toBeTruthy();
  });

  it('shows an empty state with a create action when there are no notebooks', async () => {
    const renderer = await renderScreen([listNotebooksRoute([])]);
    expect(findByTextIncluding(renderer.root, 'No research notes here yet.')).toBeTruthy();
  });

  it('opening a notebook card navigates to /notes/[id]', async () => {
    const renderer = await renderScreen([listNotebooksRoute([NOTEBOOK])]);
    act(() => {
      renderer.root
        .find((n) => n.props.accessibilityLabel === 'Open notebook Reading List')
        .props.onPress();
    });
    expect(mockPush).toHaveBeenCalledWith('/notes/nb-1');
  });

  it('creating a notebook POSTs its name and navigates to the new notebook', async () => {
    const renderer = await renderScreen([
      listNotebooksRoute([]),
      createNotebookRoute({ ...NOTEBOOK, id: 'nb-2', name: 'New One', entry_count: 0 }),
    ]);

    act(() => {
      findPressableByLabel(renderer.root, 'New notebook').props.onPress();
    });

    const input = renderer.root.find((n) => String(n.type) === 'TextInput' && n.props.value === '');
    act(() => {
      input.props.onChangeText('New One');
    });

    await act(async () => {
      findPressableByText(renderer.root, 'Create').props.onPress();
      await flushAsync();
    });

    const postCall = (global.fetch as jest.Mock).mock.calls.find(
      ([url, init]: [string, RequestInit]) =>
        init?.method === 'POST' && String(url).endsWith('/notebooks')
    );
    expect(postCall).toBeTruthy();
    expect(JSON.parse(postCall[1].body as string)).toEqual({ name: 'New One' });
    expect(mockPush).toHaveBeenCalledWith('/notes/nb-2');
  });
});
