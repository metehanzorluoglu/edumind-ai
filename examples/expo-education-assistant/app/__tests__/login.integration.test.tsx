/**
 * End-to-end coverage that the two existing test files (AuthProvider.test.tsx,
 * login.test.tsx) each leave a gap for: both mock the boundary BETWEEN
 * AuthProvider and LoginScreen (one renders AuthProvider with a bare Probe,
 * the other renders LoginScreen with a mocked useAuth()) — neither actually
 * renders the real AuthProvider wrapping the real LoginScreen and drives a
 * real GET /auth/providers response all the way through to rendered text.
 * This file closes that gap, using the exact response from the bug report:
 * `{ providers: [], dev_login_enabled: true }`.
 */
import { Platform } from 'react-native';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { AuthProvider } from '@/lib/AuthProvider';
import LoginScreen from '../login';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

jest.mock('expo-router', () => ({
  Redirect: () => null,
}));

function installWindow(): void {
  const backing = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => backing.set(key, value),
    removeItem: (key: string) => backing.delete(key),
  };
  // @ts-expect-error minimal window stub sufficient for this test
  global.window = { localStorage };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function findByText(root: ReactTestInstance, text: string): ReactTestInstance | null {
  const matches = root.findAll(
    (node) => String(node.type) === 'Text' && node.children.includes(text)
  );
  return matches[0] ?? null;
}

function findPressableByLabel(root: ReactTestInstance, label: string): ReactTestInstance | null {
  const matches = root.findAll(
    (node) => typeof node.props.onPress === 'function' && node.props.accessibilityLabel === label
  );
  return matches[0] ?? null;
}

describe('AuthProvider + LoginScreen, wired together end to end', () => {
  const originalOS = Platform.OS;
  const originalFetch = global.fetch;

  beforeEach(() => {
    Platform.OS = 'web';
    installWindow();
  });

  afterEach(() => {
    // @ts-expect-error test cleanup
    delete global.window;
    Platform.OS = originalOS;
    global.fetch = originalFetch;
  });

  it(
    'a real GET /auth/providers response of {providers: [], dev_login_enabled: true} ' +
      'renders the dev-login form, never "No sign-in providers are configured"',
    async () => {
      global.fetch = jest.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/auth/refresh')) return jsonResponse({ detail: 'none' }, 401);
        if (url.includes('/auth/providers')) {
          // Exactly the wire body from the bug report.
          return jsonResponse({ providers: [], dev_login_enabled: true });
        }
        throw new Error(`unexpected fetch to ${url}`);
      }) as unknown as typeof fetch;

      let renderer!: ReturnType<typeof create>;
      await act(async () => {
        renderer = create(
          <AuthProvider>
            <LoginScreen />
          </AuthProvider>
        );
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(
        findByText(renderer.root, 'No sign-in providers are configured on this backend yet.')
      ).toBeNull();
      expect(
        findByText(
          renderer.root,
          'No OAuth sign-in providers are configured — use developer sign-in below.'
        )
      ).toBeTruthy();
      expect(findPressableByLabel(renderer.root, 'Dev sign in')).toBeTruthy();
    }
  );

  it('a real GET /auth/providers response of {providers: [], dev_login_enabled: false} still shows the empty state', async () => {
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/auth/refresh')) return jsonResponse({ detail: 'none' }, 401);
      if (url.includes('/auth/providers')) {
        return jsonResponse({ providers: [], dev_login_enabled: false });
      }
      throw new Error(`unexpected fetch to ${url}`);
    }) as unknown as typeof fetch;

    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <AuthProvider>
          <LoginScreen />
        </AuthProvider>
      );
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      findByText(renderer.root, 'No sign-in providers are configured on this backend yet.')
    ).toBeTruthy();
    expect(findPressableByLabel(renderer.root, 'Dev sign in')).toBeNull();
  });

  it('a real GET /auth/providers response with an OAuth provider renders its button', async () => {
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/auth/refresh')) return jsonResponse({ detail: 'none' }, 401);
      if (url.includes('/auth/providers')) {
        return jsonResponse({
          providers: [{ provider: 'google', display_name: 'Google' }],
          dev_login_enabled: false,
        });
      }
      throw new Error(`unexpected fetch to ${url}`);
    }) as unknown as typeof fetch;

    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <AuthProvider>
          <LoginScreen />
        </AuthProvider>
      );
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(findPressableByLabel(renderer.root, 'Continue with Google')).toBeTruthy();
    expect(
      findByText(renderer.root, 'No sign-in providers are configured on this backend yet.')
    ).toBeNull();
  });
});
