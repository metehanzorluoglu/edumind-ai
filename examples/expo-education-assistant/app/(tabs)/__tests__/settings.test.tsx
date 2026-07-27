import type { AuthUser } from 'education-assistant-client';
import { Image, Platform } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { ClientProvider } from '@/lib/ClientProvider';
import SettingsScreen from '../settings';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

// useFocusEffect needs a real React Navigation tree to resolve focus state,
// which isn't present when rendering this screen standalone in a test —
// treat the screen as always-focused instead, matching how it behaves as
// soon as it's the active tab in the real app. jest.mock() factories are
// hoisted above imports, so React must be required lazily here rather than
// imported at the top of the file.
jest.mock('expo-router', () => ({
  useFocusEffect: (effect: () => void | (() => void)) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('react').useEffect(effect, [effect]);
  },
}));

const mockLogout = jest.fn();
const mockUseAuth = jest.fn();
jest.mock('@/lib/AuthProvider', () => ({
  useAuth: () => mockUseAuth(),
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

/** A JSX expression like `Signed in with {label}` compiles to a Text node
 * with multiple string children (`["Signed in with ", "Google"]`), not one
 * joined string — join them before comparing so callers can match the text
 * as it actually renders on screen. */
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

const READY_RESPONSE = {
  status: 'ready',
  ollama_reachable: true,
  qdrant_reachable: true,
  models_available: { 'qwen3:8b': true, 'mxbai-embed-large': true },
};

const STATUS_RESPONSE = {
  backend_reachable: true,
  ollama_reachable: true,
  qdrant_reachable: true,
  generation_model: 'qwen3:8b',
  embedding_model: 'mxbai-embed-large',
  document_count: 999, // deliberately different from /documents' total, to prove Settings never reads this field
  chunk_count: 40,
  document_type_counts: {},
  last_ingestion_at: null,
  relevance_threshold_enabled: false,
  vision_enabled: true,
  vision_model: 'qwen2.5vl:7b',
  vision_model_available: true,
  text_model_available: true,
  embedding_model_available: true,
  ollama_latency_ms: 42.3,
  qdrant_latency_ms: 7.8,
};

function installFetchMock(
  overrides: { documentsTotal?: number; conversationsTotal?: number } = {}
) {
  const documentsTotal = overrides.documentsTotal ?? 3;
  const conversationsTotal = overrides.conversationsTotal ?? 5;

  global.fetch = jest.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/health/ready')) {
      return new Response(JSON.stringify(READY_RESPONSE), { status: 200 });
    }
    if (url.includes('/status')) {
      return new Response(JSON.stringify(STATUS_RESPONSE), { status: 200 });
    }
    if (url.includes('/documents')) {
      return new Response(JSON.stringify({ documents: [], total: documentsTotal }), {
        status: 200,
      });
    }
    if (url.includes('/conversations')) {
      return new Response(JSON.stringify({ conversations: [], total: conversationsTotal }), {
        status: 200,
      });
    }
    throw new Error(`Unexpected fetch call to ${url} in this test`);
  }) as unknown as typeof fetch;
}

// SettingsScreen keeps a live 30s readiness-polling interval, an AppState
// subscription, and async-guarded document/conversation fetches running for
// as long as it's mounted — never unmounting between tests would leave all
// of that running in the background across the whole file, eventually
// causing a state update (and a re-render, and a re-invocation of the
// mocked useFocusEffect) after Jest has already torn the test environment
// down. Track the current renderer and unmount it after every test instead.
let activeRenderer: ReactTestRenderer | null = null;

async function renderSettings(): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <ClientProvider>
        <SettingsScreen />
      </ClientProvider>
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  activeRenderer = renderer;
  return renderer;
}

describe('SettingsScreen', () => {
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
  });

  it('shows the profile section with name, email, and connected provider', async () => {
    const renderer = await renderSettings();

    expect(findByText(renderer.root, 'Ada Lovelace')).toBeTruthy();
    expect(findByText(renderer.root, 'ada@example.com')).toBeTruthy();
    expect(findByText(renderer.root, 'Signed in with Google')).toBeTruthy();
  });

  it('falls back to initials when there is no avatar_url', async () => {
    const renderer = await renderSettings();

    expect(renderer.root.findAllByType(Image)).toHaveLength(0);
    expect(findByText(renderer.root, 'A')).toBeTruthy();
  });

  it('shows a dev-login account distinctly from a real OAuth provider', async () => {
    mockUseAuth.mockReturnValue({
      accessToken: 'test-token',
      user: mockUser({ provider: 'dev', is_dev_test_user: true }),
      logout: mockLogout,
    });

    const renderer = await renderSettings();

    expect(findByText(renderer.root, 'Signed in with Developer test account')).toBeTruthy();
  });

  it('calls logout() when "Log out" is pressed', async () => {
    const renderer = await renderSettings();

    await act(async () => {
      findPressableByText(renderer.root, 'Log out').props.onPress();
    });

    expect(mockLogout).toHaveBeenCalled();
  });

  it('shows readiness dots derived from GET /health/ready', async () => {
    const renderer = await renderSettings();

    expect(findByText(renderer.root, 'Backend')).toBeTruthy();
    expect(findByText(renderer.root, 'Ollama')).toBeTruthy();
    expect(findByText(renderer.root, 'Qdrant')).toBeTruthy();
    // Three "all reachable" dots — matches READY_RESPONSE's all-true fields.
    expect(
      renderer.root.findAll((n) => String(n.type) === 'Text' && n.children.includes('🟢'))
    ).toHaveLength(3);
  });

  it("shows documents-indexed and conversation counts from the same endpoints the Documents/Chat screens use — never GET /status's document_count", async () => {
    installFetchMock({ documentsTotal: 3, conversationsTotal: 5 });
    const renderer = await renderSettings();

    expect(findByText(renderer.root, '3')).toBeTruthy();
    expect(findByText(renderer.root, '5')).toBeTruthy();
    // STATUS_RESPONSE.document_count is 999 — must never appear anywhere.
    expect(queryByText(renderer.root, '999')).toBeNull();
  });

  it('shows generation/embedding model names from GET /status', async () => {
    const renderer = await renderSettings();

    expect(findByText(renderer.root, 'qwen3:8b')).toBeTruthy();
    expect(findByText(renderer.root, 'mxbai-embed-large')).toBeTruthy();
  });

  it('keeps Developer Options collapsed by default, with no API token field anywhere', async () => {
    const renderer = await renderSettings();

    expect(queryByText(renderer.root, 'Active: http://127.0.0.1:8000')).toBeNull();
    expect(queryByText(renderer.root, 'API token')).toBeNull();
    expect(queryByText(renderer.root, 'Token stored')).toBeNull();
    expect(
      renderer.root.findAll((n) => String(n.type) === 'TextInput' && n.props.secureTextEntry)
    ).toHaveLength(0);
  });

  it('reveals the backend base URL field once Developer Options is expanded', async () => {
    const renderer = await renderSettings();

    await act(async () => {
      findPressableByText(renderer.root, 'Developer options').props.onPress();
    });

    expect(findByText(renderer.root, 'Active: http://127.0.0.1:8000')).toBeTruthy();
  });

  it('shows model names, availability, and latency from GET /status once expanded (milestone V4)', async () => {
    const renderer = await renderSettings();

    await act(async () => {
      findPressableByText(renderer.root, 'Developer options').props.onPress();
    });

    expect(findByText(renderer.root, 'qwen2.5vl:7b')).toBeTruthy();
    expect(
      renderer.root.findAll((n) => String(n.type) === 'Text' && textContent(n) === 'Available ✓')
    ).toHaveLength(3); // text, vision, embedding models are all available in STATUS_RESPONSE
    expect(findByText(renderer.root, '42 ms')).toBeTruthy();
    expect(findByText(renderer.root, '8 ms')).toBeTruthy();
  });

  it('shows an em dash for vision fields when vision is disabled', async () => {
    installFetchMock();
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/health/ready')) {
        return new Response(JSON.stringify(READY_RESPONSE), { status: 200 });
      }
      if (url.includes('/status')) {
        return new Response(
          JSON.stringify({
            ...STATUS_RESPONSE,
            vision_enabled: false,
            vision_model: null,
            vision_model_available: null,
          }),
          { status: 200 }
        );
      }
      if (url.includes('/documents')) {
        return new Response(JSON.stringify({ documents: [], total: 3 }), { status: 200 });
      }
      if (url.includes('/conversations')) {
        return new Response(JSON.stringify({ conversations: [], total: 5 }), { status: 200 });
      }
      throw new Error(`Unexpected fetch call to ${url} in this test`);
    }) as unknown as typeof fetch;

    const renderer = await renderSettings();

    await act(async () => {
      findPressableByText(renderer.root, 'Developer options').props.onPress();
    });

    expect(findByText(renderer.root, 'Vision model')).toBeTruthy();
    expect(
      renderer.root.findAll((n) => String(n.type) === 'Text' && textContent(n) === '—')
    ).not.toHaveLength(0);
  });
});
