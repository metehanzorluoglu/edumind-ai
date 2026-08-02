import type { AuthUser } from 'education-assistant-client';
import { Platform } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import DeveloperSettingsScreen from '../developer-settings';
import { ClientProvider } from '@/lib/ClientProvider';
import { PreferencesProvider } from '@/lib/Preferences';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

jest.mock('expo-router', () => ({
  useFocusEffect: (effect: () => void | (() => void)) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('react').useEffect(effect, [effect]);
  },
  useRouter: () => ({ push: jest.fn(), back: jest.fn() }),
}));

const mockUseAuth = jest.fn();
jest.mock('@/lib/AuthProvider', () => ({
  useAuth: () => mockUseAuth(),
}));

const mockUseFeatureFlags = jest.fn();
jest.mock('@/lib/FeatureFlags', () => ({
  useFeatureFlags: () => mockUseFeatureFlags(),
}));

function mockUser(): AuthUser {
  return {
    id: 'u1',
    email: 'dev@example.com',
    display_name: 'Dev User',
    avatar_url: null,
    is_dev_test_user: true,
    provider: 'dev',
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

const READY_RESPONSE = {
  status: 'ready',
  ollama_reachable: true,
  qdrant_reachable: true,
  models_available: {},
};

const STATUS_RESPONSE = {
  backend_reachable: true,
  ollama_reachable: true,
  qdrant_reachable: true,
  generation_model: 'qwen3:8b',
  embedding_model: 'mxbai-embed-large',
  document_count: 3,
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

function installFetchMock() {
  global.fetch = jest.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/health/ready')) {
      return new Response(JSON.stringify(READY_RESPONSE), { status: 200 });
    }
    if (url.includes('/status')) {
      return new Response(JSON.stringify(STATUS_RESPONSE), { status: 200 });
    }
    throw new Error(`Unexpected fetch call to ${url} in this test`);
  }) as unknown as typeof fetch;
}

let activeRenderer: ReactTestRenderer | null = null;

async function renderScreen(): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <ClientProvider>
        <PreferencesProvider initialOverrides={{}}>
          <DeveloperSettingsScreen />
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

// Everything on this screen is infrastructure detail that end users must
// never see — so the flag guard is tested in BOTH directions: off shows a
// dead end with none of the internals, on shows all of them.
describe('DeveloperSettingsScreen', () => {
  const originalOS = Platform.OS;
  const originalFetch = global.fetch;

  beforeEach(() => {
    Platform.OS = 'web';
    installWindow();
    mockUseAuth.mockReturnValue({ accessToken: 'test-token', user: mockUser() });
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
  });

  it('shows a dead end and none of the internals when the flag is off', async () => {
    mockUseFeatureFlags.mockReturnValue({
      imageGenerator: true,
      developerSettings: false,
      loaded: true,
      refresh: jest.fn(),
    });

    const renderer = await renderScreen();

    expect(
      findByText(renderer.root, 'Developer settings are not available in this build.')
    ).toBeTruthy();
    // None of the internals leak through the guard.
    expect(queryByText(renderer.root, 'Active: http://127.0.0.1:8000')).toBeNull();
    expect(queryByText(renderer.root, 'qwen3:8b')).toBeNull();
    expect(queryByText(renderer.root, '42 ms')).toBeNull();
    expect(queryByText(renderer.root, 'Ollama')).toBeNull();
    expect(renderer.root.findAll((n) => String(n.type) === 'TextInput')).toHaveLength(0);
  });

  it('shows readiness dots, model detail, latency, and the backend URL editor when the flag is on', async () => {
    mockUseFeatureFlags.mockReturnValue({
      imageGenerator: true,
      developerSettings: true,
      loaded: true,
      refresh: jest.fn(),
    });

    const renderer = await renderScreen();

    // Per-service readiness dots.
    expect(findByText(renderer.root, 'Backend')).toBeTruthy();
    expect(findByText(renderer.root, 'Ollama')).toBeTruthy();
    expect(findByText(renderer.root, 'Qdrant')).toBeTruthy();
    // Model names + latency from GET /status.
    expect(findByText(renderer.root, 'qwen3:8b')).toBeTruthy();
    expect(findByText(renderer.root, 'qwen2.5vl:7b')).toBeTruthy();
    expect(findByText(renderer.root, 'mxbai-embed-large')).toBeTruthy();
    expect(findByText(renderer.root, '42 ms')).toBeTruthy();
    expect(findByText(renderer.root, '8 ms')).toBeTruthy();
    // The backend URL editor is back (on THIS screen, not the consumer one).
    expect(findByText(renderer.root, 'Active: http://127.0.0.1:8000')).toBeTruthy();
    expect(renderer.root.findAll((n) => String(n.type) === 'TextInput')).toHaveLength(1);
  });
});
