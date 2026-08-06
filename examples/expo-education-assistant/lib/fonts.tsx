import { useFonts } from 'expo-font';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

/**
 * EduM8's three type families (brand/BRAND_GUIDELINES.md §4): Source
 * Serif 4 for display/headings, Hanken Grotesk for UI/body, JetBrains
 * Mono for meta/citations. One weight map, loaded once at the app root
 * (see app/_layout.tsx) — every screen references these family name
 * strings rather than loading fonts of its own.
 *
 * Deliberately NOT importing from the @expo-google-fonts/* packages:
 * each of those packages' index.js unconditionally `require()`s every
 * weight + italic it ships (18-19 files), and Metro doesn't tree-shake
 * that away just because only a few named exports are actually used —
 * importing a single weight from `@expo-google-fonts/hanken-grotesk`
 * was pulling all 18 of its files (~1.3MB) into the bundle, and the
 * same for the other two families (~7MB total for 9 weights we
 * actually wanted). The 9 files this app needs are vendored directly
 * under assets/fonts/ instead — same original font files, but required
 * individually so Metro only bundles what's referenced. Only the
 * weights actually used anywhere in the app are here; each additional
 * weight is a separate file fetched at startup.
 */
export const FONT_MAP = {
  HankenGrotesk_400Regular: require('@/assets/fonts/HankenGrotesk_400Regular.ttf'),
  HankenGrotesk_500Medium: require('@/assets/fonts/HankenGrotesk_500Medium.ttf'),
  HankenGrotesk_600SemiBold: require('@/assets/fonts/HankenGrotesk_600SemiBold.ttf'),
  HankenGrotesk_700Bold: require('@/assets/fonts/HankenGrotesk_700Bold.ttf'),
  SourceSerif4_500Medium: require('@/assets/fonts/SourceSerif4_500Medium.ttf'),
  SourceSerif4_600SemiBold: require('@/assets/fonts/SourceSerif4_600SemiBold.ttf'),
  SourceSerif4_700Bold: require('@/assets/fonts/SourceSerif4_700Bold.ttf'),
  JetBrainsMono_400Regular: require('@/assets/fonts/JetBrainsMono_400Regular.ttf'),
  JetBrainsMono_500Medium: require('@/assets/fonts/JetBrainsMono_500Medium.ttf'),
} as const;

/**
 * Family name strings for use in `fontFamily` styles. Falls back to the
 * platform's system font stack for any style computed before
 * `useAppFonts()` resolves (first paint, or a slow connection) — never a
 * blank glyph, just a brief, harmless substitution to the same fonts the
 * app used before this typography system existed.
 */
const SYSTEM_SANS = 'System';

export function fontFamilies(loaded: boolean) {
  return {
    /** Headings, the wordmark, empty-state titles — Source Serif 4. */
    display: loaded ? 'SourceSerif4_600SemiBold' : SYSTEM_SANS,
    displayMedium: loaded ? 'SourceSerif4_500Medium' : SYSTEM_SANS,
    displayBold: loaded ? 'SourceSerif4_700Bold' : SYSTEM_SANS,
    /** UI chrome and body copy — Hanken Grotesk. */
    body: loaded ? 'HankenGrotesk_400Regular' : SYSTEM_SANS,
    bodyMedium: loaded ? 'HankenGrotesk_500Medium' : SYSTEM_SANS,
    bodySemibold: loaded ? 'HankenGrotesk_600SemiBold' : SYSTEM_SANS,
    bodyBold: loaded ? 'HankenGrotesk_700Bold' : SYSTEM_SANS,
    /** Citation markers, timestamps, technical metadata — JetBrains Mono. */
    mono: loaded ? 'JetBrainsMono_400Regular' : 'monospace',
    monoMedium: loaded ? 'JetBrainsMono_500Medium' : 'monospace',
  };
}

export type FontFamilies = ReturnType<typeof fontFamilies>;

/** Mounted once, at the app root. Returns [ready, error] exactly like expo-font's useFonts. */
export function useAppFonts() {
  return useFonts(FONT_MAP);
}

const FontsReadyContext = createContext(false);

/**
 * Mounts once, above everything else in app/_layout.tsx (including
 * AuthProvider/PreferencesProvider — the login screen needs brand
 * typography as much as anything behind auth does). `useTheme()` reads
 * readiness from here via `useFontsReady()` so every themed component
 * gets real font family names the moment they're available, with no
 * prop drilling and no re-fetching: expo-font's own registry is the
 * single source of truth, this context just broadcasts "done or failed"
 * to it.
 *
 * A load error is treated as "ready" too, on the system-font fallback —
 * a missing brand typeface should never be a blocking failure.
 *
 * Hydration-mismatch fix (same class of bug useTheme's own
 * systemSchemeSettled works around — see that file's docs for the full
 * explanation): the app's fonts are small bundled local files that can
 * finish loading within the client's very first render, but Node's
 * static-render pass can never load a font at all and always evaluates
 * readiness as false. Reading the raw `loaded`/`error` values directly
 * here would make the client's first render (already "ready") disagree
 * with the server-rendered HTML (always "not ready") — a real,
 * QA-visible hydration mismatch (React error #418), not a theoretical
 * one (this shipped once and was caught rendering the login page).
 * Deferring the flip to "ready" into a post-mount effect guarantees the
 * client's first render always matches the server's; the switch only
 * ever happens in a later, client-only re-render, which hydration
 * doesn't check.
 */
export function FontsProvider({ children }: { children: ReactNode }) {
  const [loaded, error] = useAppFonts();
  const rawReady = loaded || error != null;
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (rawReady) setSettled(true);
  }, [rawReady]);
  return <FontsReadyContext.Provider value={settled}>{children}</FontsReadyContext.Provider>;
}

export function useFontsReady(): boolean {
  return useContext(FontsReadyContext);
}
