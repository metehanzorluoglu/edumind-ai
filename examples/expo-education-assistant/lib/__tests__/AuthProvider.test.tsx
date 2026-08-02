import { Platform } from 'react-native';
import { act, create } from 'react-test-renderer';
import { AuthProvider, describeAuthError, useAuth } from '../AuthProvider';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

type Ctx = ReturnType<typeof useAuth>;
interface CtxBox {
  current: Ctx;
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Returns a box whose `.current` is reassigned on every AuthProvider
 * render — not a one-time snapshot. `useAuth()` returns a fresh object
 * literal every render, so capturing its *return value* once (as an
 * earlier version of this helper did) goes stale the instant the provider
 * re-renders; only a ref/box that Probe keeps rewriting stays live.
 */
async function renderAuth(): Promise<CtxBox> {
  const box = {} as CtxBox;
  function Probe() {
    box.current = useAuth();
    return null;
  }
  await act(async () => {
    create(
      <AuthProvider>
        <Probe />
      </AuthProvider>
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  return box;
}

describe('AuthProvider', () => {
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

  it('resolves to unauthenticated when there is no existing session to restore', async () => {
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/auth/refresh')) {
        return jsonResponse({ detail: 'No refresh token provided' }, 401);
      }
      if (url.includes('/auth/providers')) {
        return jsonResponse({
          providers: [{ provider: 'google', display_name: 'Google' }],
          dev_login_enabled: false,
        });
      }
      throw new Error(`unexpected fetch to ${url}`);
    }) as unknown as typeof fetch;

    const box = await renderAuth();

    expect(box.current.status).toBe('unauthenticated');
    expect(box.current.user).toBeNull();
    expect(box.current.providers).toEqual([{ provider: 'google', display_name: 'Google' }]);
    expect(box.current.devLoginEnabled).toBe(false);
  });

  it('silentRefresh() restores an existing session automatically on mount when a valid refresh token/cookie exists — e.g. an expired access token but a still-valid refresh token', async () => {
    // On every fresh page load (including a normal reload), the app
    // holds no access token in memory at all yet — silentRefresh()'s
    // entire job is exchanging whatever refresh credential exists
    // (an HttpOnly cookie on web) for a fresh access token, with no
    // user action required. This is what "expired access token, valid
    // refresh token" actually looks like from this provider's
    // perspective: nothing to do with any *stale* access token value,
    // since one is never persisted across a reload in the first place.
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/auth/refresh')) {
        return jsonResponse({
          access_token: 'restored-access-token',
          refresh_token: 'restored-refresh-token',
          token_type: 'bearer',
          expires_in: 900,
          user: {
            id: 'u1',
            email: 'restored@example.com',
            display_name: null,
            avatar_url: null,
            is_dev_test_user: false,
            provider: 'google',
          },
        });
      }
      if (url.includes('/auth/providers')) {
        return jsonResponse({ providers: [], dev_login_enabled: false, local_auth_enabled: true });
      }
      throw new Error(`unexpected fetch to ${url}`);
    }) as unknown as typeof fetch;

    const box = await renderAuth();

    expect(box.current.status).toBe('authenticated');
    expect(box.current.accessToken).toBe('restored-access-token');
    expect(box.current.user?.email).toBe('restored@example.com');
  });

  it('normalizes the snake_case GET /auth/providers response (dev_login_enabled) into camelCase state (devLoginEnabled)', async () => {
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/auth/refresh')) return jsonResponse({ detail: 'none' }, 401);
      if (url.includes('/auth/providers')) {
        // Exactly the wire shape reported by a real backend: providers: [],
        // dev_login_enabled: true — snake_case, matching app/schemas/auth.py.
        return jsonResponse({ providers: [], dev_login_enabled: true });
      }
      throw new Error(`unexpected fetch to ${url}`);
    }) as unknown as typeof fetch;

    const box = await renderAuth();

    expect(box.current.providers).toEqual([]);
    expect(box.current.devLoginEnabled).toBe(true);
  });

  it('a failed GET /auth/providers surfaces a visible error, instead of silently looking like "no dev login configured"', async () => {
    // Before this fix, a failed providers fetch set providers: [] and
    // devLoginEnabled: false with error left untouched (still null) —
    // indistinguishable from a real backend response reporting the same
    // values. This proves the failure is now visible via `error`.
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/auth/refresh')) return jsonResponse({ detail: 'none' }, 401);
      if (url.includes('/auth/providers'))
        return jsonResponse({ detail: 'Internal Server Error' }, 500);
      throw new Error(`unexpected fetch to ${url}`);
    }) as unknown as typeof fetch;

    const box = await renderAuth();

    expect(box.current.providers).toEqual([]);
    expect(box.current.devLoginEnabled).toBe(false);
    expect(box.current.error).toBeTruthy();
  });

  it('requests the stored per-device base URL (e.g. a LAN IP), never a stale/default one', async () => {
    window.localStorage.setItem('eac_dev_base_url', 'http://192.168.0.99:8000');
    const requestedUrls: string[] = [];
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url.includes('/auth/refresh')) return jsonResponse({ detail: 'none' }, 401);
      if (url.includes('/auth/providers')) {
        return jsonResponse({ providers: [], dev_login_enabled: true });
      }
      throw new Error(`unexpected fetch to ${url}`);
    }) as unknown as typeof fetch;

    const box = await renderAuth();

    expect(requestedUrls.some((url) => url === 'http://192.168.0.99:8000/auth/providers')).toBe(
      true
    );
    expect(
      requestedUrls.some((url) => url.includes('127.0.0.1') || url.includes('localhost'))
    ).toBe(false);
    expect(box.current.devLoginEnabled).toBe(true);
  });

  it('a stale, slower providers fetch can never overwrite a newer, faster one — success is never replaced by fallback state', async () => {
    // Reproduces the exact race requirement 6 describes: an OLDER call
    // (generation 1, e.g. the automatic mount-time fetch) that resolves
    // AFTER a NEWER call (generation 2, e.g. a remount or a user-triggered
    // Retry) must never be allowed to clobber the newer call's — correct —
    // result, even when the older call's own outcome is a failure.
    let resolveAuthRefresh!: (value: Response) => void;
    const authRefreshPromise = new Promise<Response>((resolve) => {
      resolveAuthRefresh = resolve;
    });

    let providersCallCount = 0;
    let resolveFirstProvidersCall!: (value: Response) => void;
    let resolveSecondProvidersCall!: (value: Response) => void;
    const firstProvidersCall = new Promise<Response>((resolve) => {
      resolveFirstProvidersCall = resolve;
    });
    const secondProvidersCall = new Promise<Response>((resolve) => {
      resolveSecondProvidersCall = resolve;
    });

    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/auth/refresh')) return authRefreshPromise;
      if (url.includes('/auth/providers')) {
        providersCallCount += 1;
        return providersCallCount === 1 ? firstProvidersCall : secondProvidersCall;
      }
      throw new Error(`unexpected fetch to ${url}`);
    }) as unknown as typeof fetch;

    const box = {} as CtxBox;
    function Probe() {
      box.current = useAuth();
      return null;
    }
    await act(async () => {
      create(
        <AuthProvider>
          <Probe />
        </AuthProvider>
      );
      await Promise.resolve();
    });

    // The automatic mount-time call (generation 1) is now in flight.
    // Before it resolves, something triggers a second, more recent call
    // (generation 2) — a remount, or the user pressing Retry.
    await act(async () => {
      box.current.refreshProviders();
      await Promise.resolve();
    });
    expect(providersCallCount).toBe(2);

    // The NEWER call (generation 2) resolves first, with the correct data.
    await act(async () => {
      resolveSecondProvidersCall(jsonResponse({ providers: [], dev_login_enabled: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(box.current.providers).toEqual([]);
    expect(box.current.devLoginEnabled).toBe(true);

    // The OLDER call (generation 1) resolves afterward, as a failure —
    // this must be a no-op now, not an overwrite back to the empty state.
    await act(async () => {
      resolveFirstProvidersCall(jsonResponse({ detail: 'Internal Server Error' }, 500));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(box.current.providers).toEqual([]);
    expect(box.current.devLoginEnabled).toBe(true);

    await act(async () => {
      resolveAuthRefresh(jsonResponse({ detail: 'none' }, 401));
      await Promise.resolve();
      await Promise.resolve();
    });
  });

  it('devLogin() authenticates and stores the returned user', async () => {
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/auth/refresh')) return jsonResponse({ detail: 'none' }, 401);
      if (url.includes('/auth/providers')) {
        return jsonResponse({ providers: [], dev_login_enabled: true });
      }
      if (url.includes('/auth/dev-login')) {
        return jsonResponse({
          access_token: 'dev-access-token',
          refresh_token: 'dev-refresh-token',
          token_type: 'bearer',
          expires_in: 900,
          user: {
            id: 'u1',
            email: 'dev@example.com',
            display_name: 'Dev User',
            avatar_url: null,
            is_dev_test_user: true,
          },
        });
      }
      throw new Error(`unexpected fetch to ${url}`);
    }) as unknown as typeof fetch;

    const box = await renderAuth();
    expect(box.current.status).toBe('unauthenticated');

    await act(async () => {
      await box.current.devLogin('dev@example.com');
    });

    expect(box.current.status).toBe('authenticated');
    expect(box.current.accessToken).toBe('dev-access-token');
    expect(box.current.user?.email).toBe('dev@example.com');
    expect(box.current.user?.is_dev_test_user).toBe(true);
  });

  it('devLogin() failure surfaces a readable error and stays unauthenticated', async () => {
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/auth/refresh')) return jsonResponse({ detail: 'none' }, 401);
      if (url.includes('/auth/providers')) {
        return jsonResponse({ providers: [], dev_login_enabled: true });
      }
      if (url.includes('/auth/dev-login')) return jsonResponse({ detail: 'Not found' }, 404);
      throw new Error(`unexpected fetch to ${url}`);
    }) as unknown as typeof fetch;

    const box = await renderAuth();

    await act(async () => {
      await box.current.devLogin('dev@example.com');
    });

    expect(box.current.status).toBe('unauthenticated');
    expect(box.current.error).toBeTruthy();
  });

  it('logout() clears the authenticated session', async () => {
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/auth/refresh')) return jsonResponse({ detail: 'none' }, 401);
      if (url.includes('/auth/providers')) {
        return jsonResponse({ providers: [], dev_login_enabled: true });
      }
      if (url.includes('/auth/dev-login')) {
        return jsonResponse({
          access_token: 'dev-access-token',
          refresh_token: 'dev-refresh-token',
          token_type: 'bearer',
          expires_in: 900,
          user: {
            id: 'u1',
            email: 'dev@example.com',
            display_name: null,
            avatar_url: null,
            is_dev_test_user: true,
          },
        });
      }
      if (url.includes('/auth/logout')) return new Response(null, { status: 204 });
      throw new Error(`unexpected fetch to ${url}`);
    }) as unknown as typeof fetch;

    const box = await renderAuth();
    await act(async () => {
      await box.current.devLogin('dev@example.com');
    });
    expect(box.current.status).toBe('authenticated');

    await act(async () => {
      await box.current.logout();
    });

    expect(box.current.status).toBe('unauthenticated');
    expect(box.current.user).toBeNull();
    expect(box.current.accessToken).toBeNull();
  });

  it('logout() clears local session state even if the network call fails', async () => {
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/auth/refresh')) return jsonResponse({ detail: 'none' }, 401);
      if (url.includes('/auth/providers')) {
        return jsonResponse({ providers: [], dev_login_enabled: true });
      }
      if (url.includes('/auth/dev-login')) {
        return jsonResponse({
          access_token: 'dev-access-token',
          refresh_token: 'dev-refresh-token',
          token_type: 'bearer',
          expires_in: 900,
          user: {
            id: 'u1',
            email: 'dev@example.com',
            display_name: null,
            avatar_url: null,
            is_dev_test_user: true,
          },
        });
      }
      if (url.includes('/auth/logout')) throw new Error('network down');
      throw new Error(`unexpected fetch to ${url}`);
    }) as unknown as typeof fetch;

    const box = await renderAuth();
    await act(async () => {
      await box.current.devLogin('dev@example.com');
    });

    await act(async () => {
      await box.current.logout();
    });

    expect(box.current.status).toBe('unauthenticated');
    expect(box.current.user).toBeNull();
  });

  it('normalizes the snake_case GET /auth/providers response (local_auth_enabled) into camelCase state (localAuthEnabled)', async () => {
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/auth/refresh')) return jsonResponse({ detail: 'none' }, 401);
      if (url.includes('/auth/providers')) {
        return jsonResponse({ providers: [], dev_login_enabled: false, local_auth_enabled: true });
      }
      throw new Error(`unexpected fetch to ${url}`);
    }) as unknown as typeof fetch;

    const box = await renderAuth();

    expect(box.current.localAuthEnabled).toBe(true);
  });

  it('login() authenticates and stores the returned user', async () => {
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
          access_token: 'login-access-token',
          refresh_token: 'login-refresh-token',
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

    const box = await renderAuth();

    await act(async () => {
      await box.current.login('user@example.com', 'correct-password-1');
    });

    expect(box.current.status).toBe('authenticated');
    expect(box.current.accessToken).toBe('login-access-token');
    expect(box.current.user?.email).toBe('user@example.com');
  });

  it('login() failure surfaces the backend\'s generic error message and stays unauthenticated', async () => {
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/auth/refresh')) return jsonResponse({ detail: 'none' }, 401);
      if (url.includes('/auth/providers')) {
        return jsonResponse({ providers: [], dev_login_enabled: false, local_auth_enabled: true });
      }
      if (url.includes('/auth/login')) {
        return jsonResponse({ detail: 'Invalid email or password' }, 401);
      }
      throw new Error(`unexpected fetch to ${url}`);
    }) as unknown as typeof fetch;

    const box = await renderAuth();

    await act(async () => {
      await box.current.login('user@example.com', 'wrong-password');
    });

    expect(box.current.status).toBe('unauthenticated');
    expect(box.current.error).toBe('Invalid email or password');
  });

  it('register() creates an account, signs in, and never sends a stale generation result', async () => {
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/auth/refresh')) return jsonResponse({ detail: 'none' }, 401);
      if (url.includes('/auth/providers')) {
        return jsonResponse({ providers: [], dev_login_enabled: false, local_auth_enabled: true });
      }
      if (url.includes('/auth/register')) {
        const body = JSON.parse(String(init?.body));
        expect(body).toEqual({
          email: 'new@example.com',
          password: 'correct-password-1',
          display_name: 'New User',
        });
        return jsonResponse(
          {
            access_token: 'register-access-token',
            refresh_token: 'register-refresh-token',
            token_type: 'bearer',
            expires_in: 900,
            user: {
              id: 'u2',
              email: 'new@example.com',
              display_name: 'New User',
              avatar_url: null,
              is_dev_test_user: false,
              provider: null,
            },
          },
          201
        );
      }
      throw new Error(`unexpected fetch to ${url}`);
    }) as unknown as typeof fetch;

    const box = await renderAuth();

    await act(async () => {
      await box.current.register('new@example.com', 'correct-password-1', 'New User');
    });

    expect(box.current.status).toBe('authenticated');
    expect(box.current.user?.email).toBe('new@example.com');
  });

  it('register() failure (duplicate email) surfaces an error and stays unauthenticated', async () => {
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/auth/refresh')) return jsonResponse({ detail: 'none' }, 401);
      if (url.includes('/auth/providers')) {
        return jsonResponse({ providers: [], dev_login_enabled: false, local_auth_enabled: true });
      }
      if (url.includes('/auth/register')) {
        return jsonResponse({ detail: 'An account with this email already exists.' }, 409);
      }
      throw new Error(`unexpected fetch to ${url}`);
    }) as unknown as typeof fetch;

    const box = await renderAuth();

    await act(async () => {
      await box.current.register('dupe@example.com', 'correct-password-1');
    });

    expect(box.current.status).toBe('unauthenticated');
    expect(box.current.error).toBe('An account with this email already exists.');
  });

  it('register() with email_verification_required=true reports it and never establishes a session', async () => {
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/auth/refresh')) return jsonResponse({ detail: 'none' }, 401);
      if (url.includes('/auth/providers')) {
        return jsonResponse({ providers: [], dev_login_enabled: false, local_auth_enabled: true });
      }
      if (url.includes('/auth/register')) {
        return jsonResponse(
          {
            email_verification_required: true,
            message: 'Account created. Check your email.',
            access_token: null,
            refresh_token: null,
            token_type: 'bearer',
            expires_in: null,
            user: null,
          },
          201
        );
      }
      throw new Error(`unexpected fetch to ${url}`);
    }) as unknown as typeof fetch;

    const box = await renderAuth();

    let result!: { emailVerificationRequired: boolean };
    await act(async () => {
      result = await box.current.register('needsverify@example.com', 'correct-password-1');
    });

    expect(result.emailVerificationRequired).toBe(true);
    expect(box.current.status).toBe('unauthenticated');
    expect(box.current.accessToken).toBeNull();
  });

  it('login() with a 403 email_verification_required response sets unverifiedEmail, not the generic error', async () => {
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/auth/refresh')) return jsonResponse({ detail: 'none' }, 401);
      if (url.includes('/auth/providers')) {
        return jsonResponse({ providers: [], dev_login_enabled: false, local_auth_enabled: true });
      }
      if (url.includes('/auth/login')) {
        return jsonResponse({ detail: 'email_verification_required' }, 403);
      }
      throw new Error(`unexpected fetch to ${url}`);
    }) as unknown as typeof fetch;

    const box = await renderAuth();

    await act(async () => {
      await box.current.login('unverified@example.com', 'correct-password-1');
    });

    expect(box.current.status).toBe('unauthenticated');
    expect(box.current.unverifiedEmail).toBe('unverified@example.com');
    expect(box.current.error).toBeNull();
  });

  it('resendVerification() POSTs to /auth/resend-verification and never throws', async () => {
    let resendCalled = false;
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/auth/refresh')) return jsonResponse({ detail: 'none' }, 401);
      if (url.includes('/auth/providers')) {
        return jsonResponse({ providers: [], dev_login_enabled: false, local_auth_enabled: true });
      }
      if (url.includes('/auth/resend-verification')) {
        resendCalled = true;
        return jsonResponse({ detail: 'generic response' });
      }
      throw new Error(`unexpected fetch to ${url}`);
    }) as unknown as typeof fetch;

    const box = await renderAuth();

    await act(async () => {
      await box.current.resendVerification('someone@example.com');
    });

    expect(resendCalled).toBe(true);
  });

  it('clearError() also clears unverifiedEmail', async () => {
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/auth/refresh')) return jsonResponse({ detail: 'none' }, 401);
      if (url.includes('/auth/providers')) {
        return jsonResponse({ providers: [], dev_login_enabled: false, local_auth_enabled: true });
      }
      if (url.includes('/auth/login')) {
        return jsonResponse({ detail: 'email_verification_required' }, 403);
      }
      throw new Error(`unexpected fetch to ${url}`);
    }) as unknown as typeof fetch;

    const box = await renderAuth();
    await act(async () => {
      await box.current.login('unverified@example.com', 'correct-password-1');
    });
    expect(box.current.unverifiedEmail).toBe('unverified@example.com');

    act(() => {
      box.current.clearError();
    });
    expect(box.current.unverifiedEmail).toBeNull();
  });
});

describe('describeAuthError', () => {
  it('maps email_required to a readable, actionable message', () => {
    expect(describeAuthError('email_required')).toMatch(/email/i);
  });

  it('maps email_conflict to a readable message that never confirms the account exists', () => {
    const message = describeAuthError('email_conflict');
    expect(message).toMatch(/email/i);
    expect(message.toLowerCase()).not.toContain('already registered');
    expect(message.toLowerCase()).not.toContain('already exists');
  });

  it('maps provider_error to a readable message', () => {
    expect(describeAuthError('provider_error')).toMatch(/sign-in|provider/i);
  });

  it('falls back to a generic readable message for an unknown code', () => {
    expect(describeAuthError('something_unexpected')).toBe('Sign-in failed. Please try again.');
  });
});
