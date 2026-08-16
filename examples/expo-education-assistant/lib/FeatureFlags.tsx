import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
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
  /** Mirrors rag-backend's folder_library_enabled (see app/config.py +
   * app/api/routes_status.py, Milestone 1: Document Library / Folder
   * Management). When false, the Documents screen falls back to its
   * pre-Milestone-1 flat list and every folder-only backend endpoint
   * (POST/PATCH/DELETE /folders, GET /folders/contents, PATCH
   * /documents/{id}) 404s regardless of what this flag says client-side —
   * this only controls which UI is shown, never enforces the boundary
   * itself (the backend already does, see routes_folders.py). */
  folderLibrary: boolean;
  /** Mirrors rag-backend's conversation_scope_enabled (see app/config.py +
   * app/api/routes_status.py, Milestone 2/3: conversation document scope /
   * Chat Sources). When false, the composer's Sources control is hidden
   * entirely (see ChatSourcesButton) and GET/POST/PUT
   * /conversations/{id}/documents 404 regardless of what this flag says
   * client-side — same "backend enforces, frontend only hides" split as
   * folderLibrary above. DELETE .../documents/{id} and existing chat
   * retrieval are never gated by this (see the Milestone 2 report's flag
   * docstring) — a conversation's already-selected sources keep working
   * even with this off; the user just can't change the selection through
   * this UI until it's back on. */
  conversationScope: boolean;
  /** Mirrors rag-backend's zoom_in_enabled (see app/config.py +
   * app/api/routes_status.py, Milestone 4: Zoom-In / strict
   * selected-source mode). Independent of conversationScope above — when
   * false, ChatSourcesPicker's mode toggle is hidden (only "Prioritize"
   * selection remains available) and PATCH .../scope requests that try to
   * turn zoom_in_mode on 404 regardless of what this flag says
   * client-side — same "backend enforces, frontend only hides" split as
   * every other flag here. A conversation already in Zoom-In when this is
   * off keeps its badge and keeps retrieving strictly; only the entry
   * point to turn it ON is hidden. */
  zoomIn: boolean;
  /** Mirrors rag-backend's latex_compilation_enabled (see app/config.py +
   * app/api/routes_status.py, Milestone 5.1: Secure LaTeX Compilation
   * Service). When false, the Writing editor's Compile button and PDF
   * Preview panel/tab are hidden entirely, and
   * POST/GET .../compile[/...] 404 regardless of what this flag says
   * client-side — same "backend enforces, frontend only hides" split as
   * every other flag here. Defaults to false (not true, unlike most flags
   * above) — this ships off until a human operator deliberately reviews
   * Milestone 5.1's security report and flips it (see app/config.py's
   * `latex_compilation_enabled` docstring), so a fresh deploy never
   * exposes an unreviewed untrusted-code-execution surface even
   * transiently before the first /status resolves. */
  latexCompilation: boolean;
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

function bootstrapFolderLibraryFlag(): boolean {
  const env = readEnvBool('EXPO_PUBLIC_FOLDER_LIBRARY_ENABLED');
  // Same reasoning as imageGenerator above: true by default (this is the
  // new standard Documents experience, not an opt-in beta), overridden by
  // GET /status the moment it resolves.
  return env ?? true;
}

function bootstrapConversationScopeFlag(): boolean {
  const env = readEnvBool('EXPO_PUBLIC_CONVERSATION_SCOPE_ENABLED');
  // Same reasoning as folderLibrary above: true by default (this is the
  // new standard Chat experience, not an opt-in beta), overridden by
  // GET /status the moment it resolves.
  return env ?? true;
}

function bootstrapZoomInFlag(): boolean {
  const env = readEnvBool('EXPO_PUBLIC_ZOOM_IN_ENABLED');
  // Same reasoning as conversationScope above: true by default (the new
  // standard Chat Sources mode toggle, not an opt-in beta), overridden by
  // GET /status the moment it resolves.
  return env ?? true;
}

function bootstrapLatexCompilationFlag(): boolean {
  const env = readEnvBool('EXPO_PUBLIC_LATEX_COMPILATION_ENABLED');
  // Opposite default from every flag above (folderLibrary/conversationScope/
  // zoomIn all default true) — matches the backend's own
  // latex_compilation_enabled default of false, for the same reason: an
  // untrusted-code-execution surface should never appear, even for one
  // frame before /status resolves, without an explicit opt-in.
  return env ?? false;
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
    folderLibrary: bootstrapFolderLibraryFlag(),
    conversationScope: bootstrapConversationScopeFlag(),
    zoomIn: bootstrapZoomInFlag(),
    latexCompilation: bootstrapLatexCompilationFlag(),
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
        folderLibrary: status.folder_library_enabled,
        conversationScope: status.conversation_scope_enabled,
        zoomIn: status.zoom_in_enabled,
        latexCompilation: status.latex_compilation_enabled,
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
    [snapshot, refresh]
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
