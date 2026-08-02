import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';
import { useClient } from './ClientProvider';

/**
 * Centralized feature flags for the example app. Backend config is the
 * source of truth — every supported flag here MUST also be exposed on the
 * backend's GET /status response, so toggling it server-side re-gates the
 * UI without an app rebuild. The bootstrap value (EXPO_PUBLIC_*) is only
 * used until /status resolves, so a user-facing UI element never flashes
 * visible just because the very first /status call is slow.
 *
 * To add a new flag:
 *  1. Add the server-side setting + return it from app/api/routes_status.py.
 *  2. Add the field to packages/.../src/types/generated.ts's StatusResponse.
 *  3. Extend FeatureSnapshot here, reading the new field from client.status().
 *  4. Consume it via useFeatureFlags().<newFlag> from any gated screen.
 *  5. (Optional) Document a build-time default in .env.example.
 */

export interface FeatureSnapshot {
  /** Mirrors rag-backend's IMAGE_GENERATION_ENABLED (see app/config.py + app/api/routes_status.py).
   * When false, every image-gen UI entry point is hidden, /images/* is not
   * mounted on the backend, and existing generated images remain viewable
   * but cannot be regenerated. */
  imageGenerator: boolean;
  /**
   * Gates the Developer settings entry point + screen (backend URL, model
   * names, latency, per-service readiness). A deliberate deviation from the
   * "/status is the source of truth" rule above: this flag is client-build
   * configuration only (EXPO_PUBLIC_DEVELOPER_SETTINGS_ENABLED), defaults
   * to FALSE, and is never overridden by the server — a production bundle
   * that doesn't set the variable can never show developer tooling, even
   * transiently, and no backend field exists or should exist for it.
   */
  developerSettings: boolean;
  /** True once the first successful /status fetch has populated the snapshot. */
  loaded: boolean;
}

interface FeatureFlagsContextValue extends FeatureSnapshot {
  /** Forces a refresh from the server — use on focus events / app foreground
   * to keep this in sync with the backend without an app restart. */
  refresh: () => Promise<void>;
}

const FeatureFlagsContext = createContext<FeatureFlagsContextValue | null>(null);

// EXPO_PUBLIC_* vars are inlined at JS bundle build time (https:// docs.expo.dev/guides/environment-variables/).
// `true` is the only reserved treated-true case; case-insensitive so "true"/"True"/"TRUE" all opt in,
// and any other value (unset, "", "false", "0", typo) falls through to false. The backend's
// /status value always overrides this once it resolves — this is purely a pre-fetch default
// so the very first paint of an image-gen-aware screen already matches the backend's intent
// instead of flashing the wrong button in and immediately hiding it.
/* eslint-disable @typescript-eslint/no-explicit-any */
function readEnvBool(name: string): boolean | undefined {
  const raw = (process.env as Record<string, string | undefined>)[name];
  if (raw === undefined) return undefined;
  if (raw.trim().toLowerCase() === 'true') return true;
  if (raw.trim().toLowerCase() === 'false') return false;
  return undefined;
}

function bootstrapImageGeneratorFlag(): boolean {
  const env = readEnvBool('EXPO_PUBLIC_IMAGE_GENERATOR_ENABLED');
  // Default to true to preserve today's behavior for anyone who hasn't set
  // the build-time default. A typo / unset / unrecognized value falls
  // through to the same default rather than throwing on app start.
  return env ?? true;
}

function bootstrapDeveloperSettingsFlag(): boolean {
  const env = readEnvBool('EXPO_PUBLIC_DEVELOPER_SETTINGS_ENABLED');
  // Default to FALSE — the opposite of imageGenerator, on purpose: anything
  // other than an explicit opt-in ("true", case-insensitive) keeps
  // developer tooling hidden, so production builds never expose it.
  return env ?? false;
}

/**
 * Returns the bootstrap snapshot for this Provider mount. Exported so the
 * test suite can read the default without re-implementing the env parser,
 * and so the function is the source of truth (a single place that reads
 * `process.env.EXPO_PUBLIC_IMAGE_GENERATOR_ENABLED`) rather than being
 * read at module-load time. Reading at mount time is what lets the test
 * suite set EXPO_PUBLIC_IMAGE_GENERATOR_ENABLED before each test and see
 * the chosen default on the very first render of the provider — the
 * inlined-at-build-time behavior stays correct in production (env never
 * changes during the app's lifetime), and the single function makes the
 * intent obvious in code.
 */
export function buildBootstrapSnapshot(): FeatureSnapshot {
  return {
    imageGenerator: bootstrapImageGeneratorFlag(),
    developerSettings: bootstrapDeveloperSettingsFlag(),
    loaded: false,
  };
}

export function FeatureFlagsProvider({ children }: { children: ReactNode }) {
  const { client } = useClient();
  // Re-evaluated every mount (not module-load) — see buildBootstrapSnapshot's
  // doc comment for why this matters for test bootstrapping. In production
  // the env never changes at runtime, so reading once-per-mount is fine.
  const [snapshot, setSnapshot] = useState<FeatureSnapshot>(buildBootstrapSnapshot);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const status = await client.status();
      // developerSettings is deliberately carried over from the bootstrap,
      // not derived from /status — see FeatureSnapshot's doc for why this
      // one flag is client-build configuration only.
      setSnapshot((prev) => ({
        imageGenerator: status.image_generation_enabled,
        developerSettings: prev.developerSettings,
        loaded: true,
      }));
    } catch {
      // Transients — network blip, auth timeout, backend bouncing — must
      // not flicker the UI. Keep the last known / build-time-default value
      // and stay marked-not-loaded if we never had a successful fetch, so a
      // consumer can still distinguish "haven't checked yet" from "checked,
      // and the backend says off."
      setSnapshot((prev) => ({ ...prev, loaded: false }));
    }
  }, [client]);

  // Initial fetch on mount, plus a refresh whenever the app returns to the
  // foreground — a backend admin flipping IMAGE_GENERATION_ENABLED between
  // sessions shouldn't require a full app restart to take effect.
  useEffect(() => {
    void refresh();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void refresh();
    });
    return () => subscription.remove();
  }, [refresh]);

  const value = useMemo<FeatureFlagsContextValue>(
    () => ({ ...snapshot, refresh }),
    [snapshot, refresh],
  );

  return <FeatureFlagsContext.Provider value={value}>{children}</FeatureFlagsContext.Provider>;
}

export function useFeatureFlags(): FeatureFlagsContextValue {
  const ctx = useContext(FeatureFlagsContext);
  if (ctx === null) {
    throw new Error('useFeatureFlags() must be used within a <FeatureFlagsProvider>');
  }
  return ctx;
}
