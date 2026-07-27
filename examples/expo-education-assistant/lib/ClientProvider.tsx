import { EducationAssistantClient } from 'education-assistant-client';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useAuth } from './AuthProvider';
import { getStoredBaseUrl, setStoredBaseUrl } from './authStore';

// EXPO_PUBLIC_* vars are inlined at build time from this app's .env (see
// .env.example). Falls back to the unambiguous loopback literal 127.0.0.1,
// not "localhost" — "localhost" can resolve to ::1 (IPv6) first in a
// browser while a backend started with `uvicorn --host 0.0.0.0` only
// listens on IPv4, so that attempt just hangs instead of falling back,
// surfacing as a generic "Network request failed" with no HTTP status at
// all (see .env.example for the full explanation and the LAN-IP
// alternative for multi-device testing). This is still just the
// *default* — the Settings screen's "Developer Options" per-device
// override (see lib/authStore.ts) always takes precedence once set.
export const DEFAULT_BASE_URL =
  process.env.EXPO_PUBLIC_API_BASE_URL?.trim() || 'http://127.0.0.1:8000';

interface ClientContextValue {
  client: EducationAssistantClient;
  baseUrl: string;
  setBaseUrl: (url: string) => Promise<void>;
  /** Non-null when baseUrl couldn't be used as-is (invalid URL) — the client below falls back to DEFAULT_BASE_URL until this is fixed. */
  baseUrlError: string | null;
  /** Non-null when baseUrl is valid but uses plain HTTP against a non-local host (see normalizeBaseUrl). */
  baseUrlWarning: string | null;
  /** False until the stored baseUrl override has finished loading from SecureStore/localStorage. */
  hydrated: boolean;
}

const ClientContext = createContext<ClientContextValue | null>(null);

/** Strips trailing slashes for storage/display hygiene only — request URLs are always correctly built regardless (EducationAssistantClient's own normalizeBaseUrl handles this independently on every construction). */
function stripTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, '');
}

export function ClientProvider({ children }: { children: ReactNode }) {
  // The real signed-in user's access token (see AuthProvider, mounted
  // above this in app/_layout.tsx) is the only credential this client ever
  // sends — there is no separate static-token override.
  const { accessToken } = useAuth();
  const [baseUrl, setBaseUrlState] = useState(DEFAULT_BASE_URL);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const storedUrl = await getStoredBaseUrl();
      if (cancelled) return;
      if (storedUrl) setBaseUrlState(stripTrailingSlashes(storedUrl));
      // The state update above happens before this flips, and `client`
      // below recreates synchronously in the same render it lands in — so
      // nothing can observe a "hydrated but still using a stale/default
      // baseUrl" render.
      setHydrated(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Recreated whenever baseUrl or accessToken changes — not memoized
  // against baseUrl alone. getAccessToken closes over accessToken by value
  // (not a ref), so a stale closure from an earlier client instance can
  // never be reached: every change produces a new client, deterministically.
  const { client, baseUrlError, baseUrlWarning } = useMemo(() => {
    try {
      const created = new EducationAssistantClient({
        baseUrl,
        getAccessToken: async () => accessToken,
        timeoutMs: 30_000,
      });
      return { client: created, baseUrlError: null, baseUrlWarning: created.warning };
    } catch (error) {
      // An invalid base URL must not crash the app — fall back to the
      // default so every other screen keeps working, and surface the
      // problem via baseUrlError for the Settings screen to display.
      const fallback = new EducationAssistantClient({
        baseUrl: DEFAULT_BASE_URL,
        getAccessToken: async () => accessToken,
        timeoutMs: 30_000,
      });
      return {
        client: fallback,
        baseUrlError: error instanceof Error ? error.message : String(error),
        baseUrlWarning: null,
      };
    }
  }, [baseUrl, accessToken]);

  const value: ClientContextValue = {
    client,
    baseUrl,
    setBaseUrl: async (url: string) => {
      const normalized = stripTrailingSlashes(url);
      await setStoredBaseUrl(normalized);
      setBaseUrlState(normalized);
    },
    baseUrlError,
    baseUrlWarning,
    hydrated,
  };

  return <ClientContext.Provider value={value}>{children}</ClientContext.Provider>;
}

export function useClient(): ClientContextValue {
  const ctx = useContext(ClientContext);
  if (!ctx) throw new Error('useClient() must be used within a <ClientProvider>');
  return ctx;
}
