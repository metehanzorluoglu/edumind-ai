/**
 * End-to-end coverage that the two other test files (AuthProvider.test.tsx,
 * login.test.tsx) each leave a gap for: both mock the boundary BETWEEN
 * AuthProvider and LoginScreen — neither actually renders the real
 * AuthProvider wrapping the real LoginScreen and drives a real
 * GET /auth/providers response all the way through to rendered text.
 * This file closes that gap.
 *
 * The motivating bug: the login page showed "No sign-in providers are
 * configured on this backend yet." — a dead end with no way to sign in —
 * whenever GET /auth/providers returned an empty `providers` array,
 * *even when local email/password sign-in was fully available*
 * (`local_auth_enabled: true`), because the old page conflated "no OAuth
 * providers configured" with "no authentication available at all". These
 * tests drive the real wire response shape through the real provider and
 * the real screen to prove that's fixed.
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
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
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

function findInputByLabel(root: ReactTestInstance, label: string): ReactTestInstance | null {
  const matches = root.findAll(
    (node) => String(node.type) === 'TextInput' && node.props.accessibilityLabel === label
  );
  return matches[0] ?? null;
}

const UNAVAILABLE_MESSAGE =
  'No sign-in method is configured on this backend yet. An administrator needs to enable local sign-in or configure an OAuth provider.';

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
    'a real GET /auth/providers response of {providers: [], local_auth_enabled: true} ' +
      'renders the email/password form, never the old dead-end message',
    async () => {
      global.fetch = jest.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/auth/refresh')) return jsonResponse({ detail: 'none' }, 401);
        if (url.includes('/auth/providers')) {
          return jsonResponse({
            providers: [],
            dev_login_enabled: false,
            local_auth_enabled: true,
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

      expect(findByText(renderer.root, UNAVAILABLE_MESSAGE)).toBeNull();
      expect(findInputByLabel(renderer.root, 'Email')).toBeTruthy();
      expect(findInputByLabel(renderer.root, 'Password')).toBeTruthy();
      expect(findPressableByLabel(renderer.root, 'Sign in')).toBeTruthy();
    }
  );

  it(
    'a real GET /auth/providers response of {providers: [], dev_login_enabled: true, ' +
      'local_auth_enabled: false} renders the dev-login form, never the unavailable message',
    async () => {
      global.fetch = jest.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/auth/refresh')) return jsonResponse({ detail: 'none' }, 401);
        if (url.includes('/auth/providers')) {
          return jsonResponse({
            providers: [],
            dev_login_enabled: true,
            local_auth_enabled: false,
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

      expect(findByText(renderer.root, UNAVAILABLE_MESSAGE)).toBeNull();
      expect(findPressableByLabel(renderer.root, 'Dev sign in')).toBeTruthy();
      expect(findInputByLabel(renderer.root, 'Email')).toBeNull();
    }
  );

  it('a real GET /auth/providers response with everything disabled shows the administrator-facing unavailable message', async () => {
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/auth/refresh')) return jsonResponse({ detail: 'none' }, 401);
      if (url.includes('/auth/providers')) {
        return jsonResponse({
          providers: [],
          dev_login_enabled: false,
          local_auth_enabled: false,
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

    expect(findByText(renderer.root, UNAVAILABLE_MESSAGE)).toBeTruthy();
    expect(findInputByLabel(renderer.root, 'Email')).toBeNull();
  });

  it('a real GET /auth/providers response with an OAuth provider and local auth both enabled renders both, with a divider', async () => {
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/auth/refresh')) return jsonResponse({ detail: 'none' }, 401);
      if (url.includes('/auth/providers')) {
        return jsonResponse({
          providers: [{ provider: 'google', display_name: 'Google' }],
          dev_login_enabled: false,
          local_auth_enabled: true,
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
    expect(findInputByLabel(renderer.root, 'Email')).toBeTruthy();
    expect(findByText(renderer.root, 'or continue with email')).toBeTruthy();
    expect(findByText(renderer.root, UNAVAILABLE_MESSAGE)).toBeNull();
  });

  it('a real end-to-end POST /auth/login through the real form reaches the authenticated app', async () => {
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/auth/refresh')) return jsonResponse({ detail: 'none' }, 401);
      if (url.includes('/auth/providers')) {
        return jsonResponse({ providers: [], dev_login_enabled: false, local_auth_enabled: true });
      }
      if (url.includes('/auth/login')) {
        const body = JSON.parse(String(init?.body));
        expect(body).toEqual({ email: 'user@example.com', password: 'correct-password-1' });
        return jsonResponse({
          access_token: 'access-1',
          refresh_token: 'refresh-1',
          token_type: 'bearer',
          expires_in: 900,
          user: {
            id: 'u1',
            email: 'user@example.com',
            display_name: null,
            avatar_url: null,
            is_dev_test_user: false,
            provider: null,
          },
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

    act(() => {
      findInputByLabel(renderer.root, 'Email')!.props.onChangeText('user@example.com');
    });
    act(() => {
      findInputByLabel(renderer.root, 'Password')!.props.onChangeText('correct-password-1');
    });
    await act(async () => {
      findPressableByLabel(renderer.root, 'Sign in')!.props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });

    // LoginScreen redirects to /chat once status becomes 'authenticated'
    // (mocked to a no-op Redirect above) — the login form itself
    // unmounting from the tree is this test's observable proxy for that.
    expect(findInputByLabel(renderer.root, 'Email')).toBeNull();
  });
});
