import type { ReactNode } from 'react';
import { Platform } from 'react-native';
import { act, create } from 'react-test-renderer';
import { AuthProvider } from '../AuthProvider';
import { ClientProvider, DEFAULT_BASE_URL, useClient } from '../ClientProvider';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

/** ClientProvider now reads the real access token from AuthProvider (mounted above it in app/_layout.tsx) — every render here needs the same nesting. */
function withProviders(children: ReactNode) {
  return (
    <AuthProvider>
      <ClientProvider>{children}</ClientProvider>
    </AuthProvider>
  );
}

/**
 * AuthProvider makes its own background /auth/refresh and /auth/providers
 * calls on mount, regardless of what a given test is actually exercising —
 * a safe, fast default keeps every test in this file from depending on
 * real network access (or a slow real timeout) for calls it doesn't care
 * about. Describe blocks that need to assert on fetch calls of their own
 * install a more specific mock afterward, in their own beforeEach, which
 * runs after this one and so takes precedence for their tests.
 */
function installDefaultAuthAwareFetchMock(): void {
  global.fetch = jest.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/auth/refresh')) {
      return new Response(JSON.stringify({ detail: 'No refresh token provided' }), {
        status: 401,
      });
    }
    if (url.includes('/auth/providers')) {
      return new Response(JSON.stringify({ providers: [], dev_login_enabled: false }), {
        status: 200,
      });
    }
    throw new Error(`Unexpected fetch call to ${url} in this test`);
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  installDefaultAuthAwareFetchMock();
});

function Probe({ onRender }: { onRender: (hydrated: boolean, baseUrl: string) => void }) {
  const { hydrated, baseUrl } = useClient();
  onRender(hydrated, baseUrl);
  return null;
}

function installWindow() {
  const backing = new Map<string, string>();
  const localStorage = {
    getItem: jest.fn((key: string) => backing.get(key) ?? null),
    setItem: jest.fn((key: string, value: string) => {
      backing.set(key, value);
    }),
    removeItem: jest.fn((key: string) => {
      backing.delete(key);
    }),
  };
  // @ts-expect-error minimal window stub sufficient for this test
  global.window = { localStorage };
  return localStorage;
}

describe('ClientProvider on web', () => {
  const originalOS = Platform.OS;

  beforeEach(() => {
    Platform.OS = 'web';
  });

  afterEach(() => {
    // @ts-expect-error test cleanup
    delete global.window;
    Platform.OS = originalOS;
  });

  it('hydrates via window.localStorage without throwing', async () => {
    installWindow();
    const renders: { hydrated: boolean; baseUrl: string }[] = [];

    await act(async () => {
      create(
        withProviders(
          <Probe onRender={(hydrated, baseUrl) => renders.push({ hydrated, baseUrl })} />
        )
      );
      // Flushes the async hydration effect (Promise.all of getStoredBaseUrl/getStoredToken).
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(renders.some((render) => render.hydrated)).toBe(true);
    expect(renders[renders.length - 1]?.baseUrl).toBe(DEFAULT_BASE_URL);
  });

  it('reloads a previously saved base URL from window.localStorage', async () => {
    const localStorage = installWindow();
    localStorage.setItem('eac_dev_base_url', 'http://localhost:9000');
    const renders: { hydrated: boolean; baseUrl: string }[] = [];

    await act(async () => {
      create(
        withProviders(
          <Probe onRender={(hydrated, baseUrl) => renders.push({ hydrated, baseUrl })} />
        )
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    const lastHydrated = [...renders].reverse().find((render) => render.hydrated);
    expect(lastHydrated?.baseUrl).toBe('http://localhost:9000');
  });

  it('is not hydrated on the very first synchronous render, before storage has been read', async () => {
    installWindow();
    let firstRenderHydrated: boolean | null = null;

    act(() => {
      create(
        withProviders(
          <Probe
            onRender={(hydrated) => {
              if (firstRenderHydrated === null) firstRenderHydrated = hydrated;
            }}
          />
        )
      );
    });
    expect(firstRenderHydrated).toBe(false);

    // Flushes the hydration effect's pending state update inside act(), so
    // it can't leak into (and log an act() warning against) a later test.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  });
});

type Ctx = ReturnType<typeof useClient>;

describe('ClientProvider client recreation', () => {
  const originalOS = Platform.OS;

  beforeEach(() => {
    Platform.OS = 'web';
    installWindow();
  });

  afterEach(() => {
    // @ts-expect-error test cleanup
    delete global.window;
    Platform.OS = originalOS;
  });

  it('recreates the client when baseUrl changes', async () => {
    let ctx!: Ctx;
    function CaptureProbe() {
      ctx = useClient();
      return null;
    }

    await act(async () => {
      create(withProviders(<CaptureProbe />));
      await Promise.resolve();
      await Promise.resolve();
    });

    const clientBefore = ctx.client;
    await act(async () => {
      await ctx.setBaseUrl('http://localhost:9999');
    });

    expect(ctx.client).not.toBe(clientBefore);
    expect(ctx.baseUrl).toBe('http://localhost:9999');
  });

  it('normalizes a trailing slash off a base URL passed to setBaseUrl', async () => {
    let ctx!: Ctx;
    function CaptureProbe() {
      ctx = useClient();
      return null;
    }

    await act(async () => {
      create(withProviders(<CaptureProbe />));
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      await ctx.setBaseUrl('http://localhost:8000/');
    });

    expect(ctx.baseUrl).toBe('http://localhost:8000');
  });
});

describe('POST /chat Authorization header', () => {
  const originalOS = Platform.OS;
  const originalFetch = global.fetch;
  let captured: { headers: Record<string, string> } | null;

  function fakeSseResponse(): Response {
    const body =
      'data: {"type":"done","citations":[],"citation_warnings":[],"insufficient_evidence":true}\n\n';
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }

  beforeEach(() => {
    Platform.OS = 'web';
    installWindow();
    captured = null;
    global.fetch = jest.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((value, key) => {
        headers[key] = value;
      });
      captured = { headers };
      return fakeSseResponse();
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    // @ts-expect-error test cleanup
    delete global.window;
    Platform.OS = originalOS;
    global.fetch = originalFetch;
  });

  it('sends no Authorization header at all when there is no signed-in user', async () => {
    let ctx!: Ctx;
    function CaptureProbe() {
      ctx = useClient();
      return null;
    }

    await act(async () => {
      create(withProviders(<CaptureProbe />));
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      await ctx.client.chat({ query: 'test question' });
    });

    expect(captured?.headers.authorization).toBeUndefined();
  });
});
