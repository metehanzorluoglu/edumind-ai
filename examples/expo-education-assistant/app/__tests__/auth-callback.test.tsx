/**
 * Regression coverage for a real production bug: after a Google
 * login -> logout -> login cycle, the app got stuck on "Completing
 * sign-in…" even though the backend had already completed the new
 * login. Root cause: AuthProvider's ambient, mount-time
 * silentRefresh() (restores an existing session from the refresh
 * cookie) and AuthCallbackScreen's exchangeCode() (redeems the OAuth
 * auth_code) both run on the very same /auth-callback page load and
 * share one generation counter (see AuthProvider.tsx's
 * authGenerationRef/beginAuthAction) — silentRefresh reliably *starts*
 * after exchangeCode (it's gated behind an async base-URL hydration
 * read), so exchangeCode's own successful result was discarded as
 * "stale" the instant silentRefresh started, regardless of which
 * network request actually finished first. The fix: skip the ambient
 * silentRefresh() entirely when landing on the callback route with an
 * auth_code already present — exchangeCode is the sole authority for
 * that page load.
 *
 * These tests render the *real* AuthProvider wrapping the *real*
 * AuthCallbackScreen (not a mocked useAuth()) — the bug only exists in
 * how the two are wired together, so a test mocking either one away
 * would not have caught it.
 */
import type { ReactNode } from 'react';
import { Platform } from 'react-native';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { AuthProvider } from '@/lib/AuthProvider';
import AuthCallbackScreen from '../auth-callback';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

let mockCallbackParams: { auth_code?: string; auth_error?: string } = {};
jest.mock('expo-router', () => ({
  Redirect: ({ href }: { href: string }) => `Redirect(${href})`,
  Link: ({ children }: { children: ReactNode }) => children,
  useLocalSearchParams: () => mockCallbackParams,
  usePathname: () => '/auth-callback',
  useGlobalSearchParams: () => mockCallbackParams,
}));

function installWindow(): void {
  const backing = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => backing.set(key, value),
    removeItem: (key: string) => backing.delete(key),
  };
  // @ts-expect-error minimal window stub sufficient for this test
  global.window = { localStorage, location: { origin: 'https://edum8.us' } };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function tokenResponseFor(userId: string, email: string) {
  return {
    access_token: `access-${userId}`,
    refresh_token: `refresh-${userId}`,
    token_type: 'bearer',
    expires_in: 900,
    user: {
      id: userId,
      email,
      display_name: null,
      avatar_url: null,
      is_dev_test_user: false,
      provider: 'google',
    },
  };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function findByText(root: ReactTestInstance, text: string): ReactTestInstance | null {
  const matches = root.findAll(
    (node) => String(node.type) === 'Text' && node.children.includes(text)
  );
  return matches[0] ?? null;
}

describe('AuthCallbackScreen + AuthProvider, wired together end to end', () => {
  const originalOS = Platform.OS;
  const originalFetch = global.fetch;

  beforeEach(() => {
    Platform.OS = 'web';
    installWindow();
    mockCallbackParams = {};
  });

  afterEach(() => {
    // @ts-expect-error test cleanup
    delete global.window;
    Platform.OS = originalOS;
    global.fetch = originalFetch;
  });

  it(
    'exchangeCode() always wins even when an ambient session-restore for a ' +
      'DIFFERENT, still-valid prior session resolves later — proves the race is fixed, ' +
      'not just usually-fast-enough',
    async () => {
      mockCallbackParams = { auth_code: 'fresh-google-code' };
      let refreshCalled = false;

      global.fetch = jest.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/auth/refresh')) {
          refreshCalled = true;
          // Deliberately resolves a DIFFERENT, still-"valid" session,
          // slower than the exchange below — if this were ever allowed
          // to run and win, the test would observe the WRONG user.
          await new Promise((resolve) => setTimeout(resolve, 20));
          return jsonResponse(tokenResponseFor('stale-user', 'stale@example.com'));
        }
        if (url.includes('/auth/session/exchange')) {
          return jsonResponse(tokenResponseFor('fresh-user', 'fresh@example.com'));
        }
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
            <AuthCallbackScreen />
          </AuthProvider>
        );
      });
      await flush();
      // Give the (should-never-fire) silentRefresh's artificial delay a
      // chance to elapse too, so a regression would have time to clobber
      // the correct state before we assert.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
      });

      expect(refreshCalled).toBe(false);
      const json = renderer.toJSON();
      expect(JSON.stringify(json)).toContain('Redirect(/chat)');
    }
  );

  it('runs 20 consecutive fresh login cycles, each reaching the authenticated redirect with no stuck spinner', async () => {
    for (let cycle = 0; cycle < 20; cycle += 1) {
      mockCallbackParams = { auth_code: `google-code-cycle-${cycle}` };

      global.fetch = jest.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/auth/refresh')) {
          // A fresh page load (this is what a real Google OAuth round
          // trip is on web) has no prior in-memory state, but may still
          // have a leftover cookie from an earlier cycle in this same
          // test's cookie-less fetch mock — either way, this must never
          // even be called on the callback route with a code present.
          throw new Error('silentRefresh must not run on the callback route with an auth_code');
        }
        if (url.includes('/auth/session/exchange')) {
          return jsonResponse(tokenResponseFor(`user-${cycle}`, `user${cycle}@example.com`));
        }
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
            <AuthCallbackScreen />
          </AuthProvider>
        );
      });
      await flush();

      const json = renderer.toJSON();
      expect(JSON.stringify(json)).toContain('Redirect(/chat)');
      expect(JSON.stringify(json)).not.toContain('Completing sign');

      // Simulate navigating away (logout / closing the page) before the
      // next cycle's fresh page load.
      await act(async () => {
        renderer.unmount();
      });
    }
  });

  it('a genuine auth_error still resolves to the error screen, AND silentRefresh still runs normally (no auth_code to compete with)', async () => {
    mockCallbackParams = { auth_error: 'provider_error' };
    let refreshCalled = false;
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/auth/refresh')) {
        refreshCalled = true;
        return jsonResponse({ detail: 'none' }, 401);
      }
      if (url.includes('/auth/providers')) {
        return jsonResponse({ providers: [], dev_login_enabled: false, local_auth_enabled: true });
      }
      throw new Error(`unexpected fetch to ${url}`);
    }) as unknown as typeof fetch;

    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <AuthProvider>
          <AuthCallbackScreen />
        </AuthProvider>
      );
    });
    await flush();

    expect(refreshCalled).toBe(true);
    expect(findByText(renderer.root, 'Sign-in failed')).toBeTruthy();
  });

  it('a callback with no params at all still lets silentRefresh run normally', async () => {
    mockCallbackParams = {};
    let refreshCalled = false;
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/auth/refresh')) {
        refreshCalled = true;
        return jsonResponse({ detail: 'none' }, 401);
      }
      if (url.includes('/auth/providers')) {
        return jsonResponse({ providers: [], dev_login_enabled: false, local_auth_enabled: true });
      }
      throw new Error(`unexpected fetch to ${url}`);
    }) as unknown as typeof fetch;

    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <AuthProvider>
          <AuthCallbackScreen />
        </AuthProvider>
      );
    });
    await flush();

    expect(refreshCalled).toBe(true);
    expect(findByText(renderer.root, 'Sign-in failed')).toBeTruthy();
  });

  it('an invalid/expired auth_code resolves to a clean error, never a stuck spinner', async () => {
    mockCallbackParams = { auth_code: 'already-used-or-bogus-code' };
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/auth/refresh')) {
        throw new Error('silentRefresh must not run on the callback route with an auth_code');
      }
      if (url.includes('/auth/session/exchange')) {
        return jsonResponse({ detail: 'Invalid or expired auth_code' }, 400);
      }
      if (url.includes('/auth/providers')) {
        return jsonResponse({ providers: [], dev_login_enabled: false, local_auth_enabled: true });
      }
      throw new Error(`unexpected fetch to ${url}`);
    }) as unknown as typeof fetch;

    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <AuthProvider>
          <AuthCallbackScreen />
        </AuthProvider>
      );
    });
    await flush();

    // exchangeCode's own catch block sets status='unauthenticated' and a
    // provider-level `error`, which the screen now also reads (see
    // auth-callback.tsx) — must show the real error screen, never sit on
    // the spinner forever.
    const json = JSON.stringify(renderer.toJSON());
    expect(json).not.toContain('Completing sign-in');
    expect(findByText(renderer.root, 'Sign-in failed')).toBeTruthy();
    expect(findByText(renderer.root, 'Invalid or expired auth_code')).toBeTruthy();
  });

  it(
    'a route that merely CONTAINS "auth-callback" as a substring (not an exact match) never ' +
      'skips silentRefresh — proves the check is an exact pathname match, not includes()',
    async () => {
      mockCallbackParams = { auth_code: 'some-code' };
      let refreshCalled = false;
      global.fetch = jest.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/auth/refresh')) {
          refreshCalled = true;
          return jsonResponse({ detail: 'none' }, 401);
        }
        if (url.includes('/auth/providers')) {
          return jsonResponse({
            providers: [],
            dev_login_enabled: false,
            local_auth_enabled: true,
          });
        }
        throw new Error(`unexpected fetch to ${url}`);
      }) as unknown as typeof fetch;

      // Temporarily override the module-level pathname mock for this one
      // test — a hypothetical route whose path merely contains the
      // "auth-callback" substring but is not the real callback route.
      const routerModule = jest.requireMock('expo-router') as { usePathname: () => string };
      const originalUsePathname = routerModule.usePathname;
      routerModule.usePathname = () => '/settings/auth-callback-history';

      let renderer!: ReturnType<typeof create>;
      await act(async () => {
        renderer = create(
          <AuthProvider>
            <AuthCallbackScreen />
          </AuthProvider>
        );
      });
      await flush();

      routerModule.usePathname = originalUsePathname;

      expect(refreshCalled).toBe(true);
      void renderer;
    }
  );

  it('silentRefresh runs normally on an ordinary, non-callback page (e.g. /login)', async () => {
    let refreshCalled = false;
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/auth/refresh')) {
        refreshCalled = true;
        return jsonResponse({ detail: 'none' }, 401);
      }
      if (url.includes('/auth/providers')) {
        return jsonResponse({ providers: [], dev_login_enabled: false, local_auth_enabled: true });
      }
      throw new Error(`unexpected fetch to ${url}`);
    }) as unknown as typeof fetch;

    const routerModule = jest.requireMock('expo-router') as { usePathname: () => string };
    const originalUsePathname = routerModule.usePathname;
    routerModule.usePathname = () => '/login';

    await act(async () => {
      create(
        <AuthProvider>
          <AuthCallbackScreen />
        </AuthProvider>
      );
    });
    await flush();

    routerModule.usePathname = originalUsePathname;

    expect(refreshCalled).toBe(true);
  });
});
