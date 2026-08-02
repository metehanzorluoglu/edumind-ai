import type { AuthUser } from 'education-assistant-client';
import { Image, Platform, Switch } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { ClientProvider } from '@/lib/ClientProvider';
import { PreferencesProvider } from '@/lib/Preferences';
import SettingsScreen from '../settings';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

jest.mock('expo-linking', () => ({
  openURL: jest.fn(async () => true),
}));

// useFocusEffect needs a real React Navigation tree; treat the screen as
// always-focused, matching its real behavior as the active tab. The
// redesigned screen also navigates (Manage documents, Developer settings),
// so useRouter is mocked alongside it.
const mockRouterPush = jest.fn();
jest.mock('expo-router', () => ({
  useFocusEffect: (effect: () => void | (() => void)) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('react').useEffect(effect, [effect]);
  },
  useRouter: () => ({ push: mockRouterPush, back: jest.fn() }),
}));

const mockLogout = jest.fn(async () => undefined);
const mockUseAuth = jest.fn();
jest.mock('@/lib/AuthProvider', () => ({
  useAuth: () => mockUseAuth(),
}));

// Feature flags are mocked so tests can flip developerSettings on/off
// without a real /status round trip.
const mockUseFeatureFlags = jest.fn();
jest.mock('@/lib/FeatureFlags', () => ({
  useFeatureFlags: () => mockUseFeatureFlags(),
}));

const mockRefreshSidebar = jest.fn();
jest.mock('@/lib/ChatConversationsContext', () => ({
  useRefreshConversations: () => mockRefreshSidebar,
}));

function mockUser(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    id: 'u1',
    email: 'ada@example.com',
    display_name: 'Ada Lovelace',
    avatar_url: null,
    is_dev_test_user: false,
    provider: 'google',
    ...overrides,
  };
}

function installWindow() {
  const backing = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => backing.set(key, value),
    removeItem: (key: string) => backing.delete(key),
  };
  // @ts-expect-error minimal window stub sufficient for this test
  global.window = { localStorage };
}

/** Joins a node's direct string children — JSX expressions compile to
 * multiple children, so compare against the joined text as rendered. */
function textContent(node: ReactTestInstance): string {
  return node.children.filter((child): child is string => typeof child === 'string').join('');
}

function findByText(root: ReactTestInstance, text: string): ReactTestInstance {
  return root.find((node) => String(node.type) === 'Text' && textContent(node) === text);
}

function queryByText(root: ReactTestInstance, text: string): ReactTestInstance | null {
  const matches = root.findAll(
    (node) => String(node.type) === 'Text' && textContent(node) === text
  );
  return matches[0] ?? null;
}

function findPressableByText(root: ReactTestInstance, text: string): ReactTestInstance {
  return root.find(
    (node) =>
      typeof node.props.onPress === 'function' &&
      node.findAll((n) => String(n.type) === 'Text' && textContent(n) === text).length > 0
  );
}

function findTextInputByLabel(root: ReactTestInstance, label: string): ReactTestInstance {
  return root.find(
    (node) => String(node.type) === 'TextInput' && node.props.accessibilityLabel === label
  );
}

interface FetchCall {
  url: string;
  method: string;
}

const fetchCalls: FetchCall[] = [];

function installFetchMock(options: { readyFails?: boolean } = {}) {
  fetchCalls.length = 0;
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    fetchCalls.push({ url, method });

    if (url.includes('/health/ready')) {
      if (options.readyFails) return new Response('boom', { status: 500 });
      return new Response(
        JSON.stringify({
          status: 'ready',
          ollama_reachable: true,
          qdrant_reachable: true,
          models_available: {},
        }),
        { status: 200 }
      );
    }
    if (method === 'DELETE' && url.includes('/documents/')) {
      return new Response(null, { status: 204 });
    }
    if (method === 'DELETE' && url.includes('/conversations/')) {
      return new Response(null, { status: 204 });
    }
    if (url.includes('/conversations/c1') || url.includes('/conversations/c2')) {
      return new Response(JSON.stringify({ id: 'x', title: 'x', messages: [] }), { status: 200 });
    }
    if (url.includes('/documents')) {
      return new Response(
        JSON.stringify({
          documents: [
            { document_id: 'doc-1', source_filename: 'a.pdf' },
            { document_id: 'doc-2', source_filename: 'b.pdf' },
          ],
          total: 2,
        }),
        { status: 200 }
      );
    }
    if (url.includes('/conversations')) {
      return new Response(
        JSON.stringify({
          conversations: [
            { id: 'c1', title: 'First' },
            { id: 'c2', title: 'Second' },
          ],
          total: 2,
        }),
        { status: 200 }
      );
    }
    throw new Error(`Unexpected fetch call to ${url} in this test`);
  }) as unknown as typeof fetch;
}

// The screen keeps a 30s readiness-poll interval and async-guarded fetches
// alive while mounted — unmount after every test so nothing updates state
// once Jest tears the environment down.
let activeRenderer: ReactTestRenderer | null = null;

async function renderSettings(): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <ClientProvider>
        <PreferencesProvider initialOverrides={{}}>
          <SettingsScreen />
        </PreferencesProvider>
      </ClientProvider>
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  activeRenderer = renderer;
  return renderer;
}

describe('SettingsScreen (consumer redesign)', () => {
  const originalOS = Platform.OS;
  const originalFetch = global.fetch;

  beforeEach(() => {
    Platform.OS = 'web';
    installWindow();
    mockUseAuth.mockReturnValue({
      accessToken: 'test-token',
      user: mockUser(),
      logout: mockLogout,
    });
    mockUseFeatureFlags.mockReturnValue({
      imageGenerator: true,
      developerSettings: false,
      loaded: true,
      refresh: jest.fn(),
    });
    installFetchMock();
  });

  afterEach(async () => {
    if (activeRenderer) {
      await act(async () => {
        activeRenderer!.unmount();
      });
      activeRenderer = null;
    }
    // @ts-expect-error test cleanup
    delete global.window;
    Platform.OS = originalOS;
    global.fetch = originalFetch;
    mockLogout.mockReset();
    mockRouterPush.mockReset();
    mockRefreshSidebar.mockReset();
  });

  describe('Account', () => {
    it('shows the profile with name, email, provider, and an initials avatar', async () => {
      const renderer = await renderSettings();

      expect(findByText(renderer.root, 'Ada Lovelace')).toBeTruthy();
      expect(findByText(renderer.root, 'ada@example.com')).toBeTruthy();
      expect(findByText(renderer.root, 'Signed in with Google')).toBeTruthy();
      // No avatar_url → initials fallback, no Image.
      expect(renderer.root.findAllByType(Image)).toHaveLength(0);
      expect(findByText(renderer.root, 'A')).toBeTruthy();
    });

    it('labels a dev-login account distinctly', async () => {
      mockUseAuth.mockReturnValue({
        accessToken: 'test-token',
        user: mockUser({ provider: 'dev', is_dev_test_user: true }),
        logout: mockLogout,
      });

      const renderer = await renderSettings();
      expect(findByText(renderer.root, 'Signed in with Developer test account')).toBeTruthy();
    });

    it('logs out when "Log out" is pressed', async () => {
      const renderer = await renderSettings();

      await act(async () => {
        findPressableByText(renderer.root, 'Log out').props.onPress();
      });

      expect(mockLogout).toHaveBeenCalled();
    });
  });

  describe('production hiding — no infrastructure detail for normal users', () => {
    it('shows none of the backend/model/latency/service internals anywhere', async () => {
      const renderer = await renderSettings();

      // No model names, no per-service status, no latency, no URLs.
      expect(queryByText(renderer.root, 'qwen3:8b')).toBeNull();
      expect(queryByText(renderer.root, 'mxbai-embed-large')).toBeNull();
      expect(queryByText(renderer.root, 'Ollama')).toBeNull();
      expect(queryByText(renderer.root, 'Qdrant')).toBeNull();
      expect(queryByText(renderer.root, 'Backend')).toBeNull();
      expect(queryByText(renderer.root, '42 ms')).toBeNull();
      expect(queryByText(renderer.root, 'http://127.0.0.1:8000')).toBeNull();
      // No raw text inputs (the backend URL editor is gone from this page).
      expect(renderer.root.findAll((n) => String(n.type) === 'TextInput')).toHaveLength(0);
    });

    it('hides the Developer settings entry when the flag is off', async () => {
      const renderer = await renderSettings();

      expect(queryByText(renderer.root, 'Developer settings')).toBeNull();
      expect(queryByText(renderer.root, 'DEVELOPER')).toBeNull();
    });

    it('reveals the Developer settings entry (and only an entry) when the flag is on', async () => {
      mockUseFeatureFlags.mockReturnValue({
        imageGenerator: true,
        developerSettings: true,
        loaded: true,
        refresh: jest.fn(),
      });

      const renderer = await renderSettings();

      const row = findPressableByText(renderer.root, 'Developer settings');
      await act(async () => {
        row.props.onPress();
      });
      expect(mockRouterPush).toHaveBeenCalledWith('/developer-settings');

      // The entry exists — but the internals still do not live on this page.
      expect(queryByText(renderer.root, 'http://127.0.0.1:8000')).toBeNull();
      expect(renderer.root.findAll((n) => String(n.type) === 'TextInput')).toHaveLength(0);
    });

    it('shows no status banner while all services are healthy', async () => {
      const renderer = await renderSettings();

      expect(
        queryByText(
          renderer.root,
          'EduMind services are currently unreachable. Your data is safe — please try again in a moment.'
        )
      ).toBeNull();
    });

    it('shows one plain-language banner when the backend is unreachable', async () => {
      installFetchMock({ readyFails: true });
      const renderer = await renderSettings();

      // A single user-facing warning — still no service names.
      const banner = renderer.root.findAll(
        (n) =>
          String(n.type) === 'Text' &&
          textContent(n).includes('EduMind services are currently unreachable')
      );
      expect(banner.length).toBe(1);
      expect(queryByText(renderer.root, 'Ollama')).toBeNull();
      expect(queryByText(renderer.root, 'Qdrant')).toBeNull();
    });
  });

  describe('Appearance and chat preferences', () => {
    it('changes the theme preference from the segmented control', async () => {
      const renderer = await renderSettings();

      const darkSegment = renderer.root.find((n) => n.props.accessibilityLabel === 'Theme: Dark');
      expect(darkSegment.props.accessibilityState.selected).toBe(false);

      await act(async () => {
        darkSegment.props.onPress();
      });

      expect(
        renderer.root.find((n) => n.props.accessibilityLabel === 'Theme: Dark').props
          .accessibilityState.selected
      ).toBe(true);
    });

    it('toggles Reduce motion', async () => {
      const renderer = await renderSettings();

      const toggle = renderer.root.find(
        (n) => n.type === Switch && n.props.accessibilityLabel === 'Reduce motion'
      );
      expect(toggle.props.value).toBe(false);

      await act(async () => {
        toggle.props.onValueChange(true);
      });

      expect(
        renderer.root.find(
          (n) => n.type === Switch && n.props.accessibilityLabel === 'Reduce motion'
        ).props.value
      ).toBe(true);
    });

    it('navigates to the Documents tab from the Documents section', async () => {
      const renderer = await renderSettings();

      await act(async () => {
        findPressableByText(renderer.root, 'Manage documents').props.onPress();
      });

      expect(mockRouterPush).toHaveBeenCalledWith('/documents');
    });

    it('shows the uploaded-documents count from GET /documents', async () => {
      const renderer = await renderSettings();

      // The "Uploaded documents" row shows the real total (2).
      const row = findPressableByText(renderer.root, 'Uploaded documents');
      expect(row.findAll((n) => String(n.type) === 'Text' && textContent(n) === '2').length).toBe(
        1
      );
    });
  });

  describe('destructive actions require confirmation', () => {
    it('clears conversation history only after confirming, deleting every conversation', async () => {
      const renderer = await renderSettings();

      await act(async () => {
        findPressableByText(renderer.root, 'Clear conversation history').props.onPress();
      });

      // The confirmation dialog is up — nothing deleted yet.
      expect(findByText(renderer.root, 'Clear conversation history?')).toBeTruthy();
      expect(fetchCalls.filter((c) => c.method === 'DELETE')).toHaveLength(0);

      await act(async () => {
        findPressableByText(renderer.root, 'Clear history').props.onPress();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      const deletes = fetchCalls.filter((c) => c.method === 'DELETE');
      expect(deletes.some((c) => c.url.includes('/conversations/c1'))).toBe(true);
      expect(deletes.some((c) => c.url.includes('/conversations/c2'))).toBe(true);
      // The dialog closed and the user got feedback.
      expect(queryByText(renderer.root, 'Clear conversation history?')).toBeNull();
      expect(
        queryByText(renderer.root, 'Your conversation history has been cleared.')
      ).toBeTruthy();
      expect(mockRefreshSidebar).toHaveBeenCalled();
    });

    it('removes all documents only after typing DELETE, deleting every document', async () => {
      const renderer = await renderSettings();

      await act(async () => {
        findPressableByText(renderer.root, 'Remove all documents').props.onPress();
      });
      expect(findByText(renderer.root, 'Remove all documents?')).toBeTruthy();

      // The confirm button stays disabled until the strong word is typed
      // (case-insensitive — "delete" satisfies "DELETE").
      expect(findPressableByText(renderer.root, 'Remove all').props.disabled).toBe(true);

      await act(async () => {
        findTextInputByLabel(renderer.root, 'Type DELETE to confirm').props.onChangeText('delete');
      });
      expect(findPressableByText(renderer.root, 'Remove all').props.disabled).toBe(false);

      await act(async () => {
        findPressableByText(renderer.root, 'Remove all').props.onPress();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      const deletes = fetchCalls.filter((c) => c.method === 'DELETE');
      expect(deletes.some((c) => c.url.includes('/documents/doc-1'))).toBe(true);
      expect(deletes.some((c) => c.url.includes('/documents/doc-2'))).toBe(true);
      expect(queryByText(renderer.root, 'All documents have been removed.')).toBeTruthy();
    });

    it('"Delete all my data" erases conversations AND documents, then signs out — and never claims the account itself is deleted', async () => {
      const renderer = await renderSettings();

      // Honest labeling: there is no backend account-deletion endpoint, so
      // the UI must not say "Delete account".
      expect(queryByText(renderer.root, 'Delete account')).toBeNull();

      await act(async () => {
        findPressableByText(renderer.root, 'Delete all my data').props.onPress();
      });
      expect(findByText(renderer.root, 'Delete your EduMind data?')).toBeTruthy();
      // The dialog copy discloses that the account itself remains.
      expect(
        renderer.root.findAll(
          (n) =>
            String(n.type) === 'Text' &&
            textContent(n).includes('Your EduMind account itself is not deleted')
        ).length
      ).toBeGreaterThan(0);

      await act(async () => {
        findTextInputByLabel(renderer.root, 'Type DELETE to confirm').props.onChangeText('DELETE');
      });
      await act(async () => {
        findPressableByText(renderer.root, 'Delete everything').props.onPress();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      const deletes = fetchCalls.filter((c) => c.method === 'DELETE');
      expect(deletes.some((c) => c.url.includes('/conversations/'))).toBe(true);
      expect(deletes.some((c) => c.url.includes('/documents/'))).toBe(true);
      expect(mockLogout).toHaveBeenCalled();
    });

    it('cancelling a confirmation deletes nothing', async () => {
      const renderer = await renderSettings();

      await act(async () => {
        findPressableByText(renderer.root, 'Clear conversation history').props.onPress();
      });
      await act(async () => {
        findPressableByText(renderer.root, 'Cancel').props.onPress();
      });

      expect(queryByText(renderer.root, 'Clear conversation history?')).toBeNull();
      expect(fetchCalls.filter((c) => c.method === 'DELETE')).toHaveLength(0);
    });
  });

  describe('About', () => {
    it('shows the version and opens the privacy policy dialog', async () => {
      const renderer = await renderSettings();

      expect(findByText(renderer.root, 'Version')).toBeTruthy();

      await act(async () => {
        findPressableByText(renderer.root, 'Privacy policy').props.onPress();
      });
      // Row label + dialog title now both read "Privacy policy".
      expect(
        renderer.root.findAll(
          (n) => String(n.type) === 'Text' && textContent(n) === 'Privacy policy'
        ).length
      ).toBe(2);
      // Dialog body copy is honest about document handling.
      expect(
        renderer.root.findAll(
          (n) => String(n.type) === 'Text' && textContent(n).includes('never used to train')
        ).length
      ).toBeGreaterThan(0);
    });
  });
});
