import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useColorScheme } from 'react-native';
import { getStorageItem, setStorageItem } from './platformStorage';

/**
 * User-facing preferences (Appearance / Chat preferences in the Settings
 * screen) plus the theme they resolve to. Persisted as one JSON blob in
 * platform storage so every preference survives an app restart. Nothing
 * here is ever sent to the backend and none of it is secret — secrets stay
 * in authTokenStore/platformStorage under their own keys, untouched by
 * this module.
 *
 * usePreferences() is deliberately null-safe outside a provider: components
 * rendered in tests (or previews) without the provider fall back to the
 * defaults, which are chosen to be byte-identical to the app's historical
 * behavior — so adopting a preference can never change what a screen does
 * until the user actually changes it.
 */

export type ThemeMode = 'system' | 'light' | 'dark';
export type TextSize = 'small' | 'default' | 'large';
export type ResponseStyle = 'concise' | 'balanced' | 'detailed';
export type CitationDisplay = 'shown' | 'hidden';

export interface Preferences {
  themeMode: ThemeMode;
  textSize: TextSize;
  reduceMotion: boolean;
  responseStyle: ResponseStyle;
  citationDisplay: CitationDisplay;
  autoScrollDuringStreaming: boolean;
}

export const DEFAULT_PREFERENCES: Preferences = {
  themeMode: 'system',
  textSize: 'default',
  reduceMotion: false,
  responseStyle: 'balanced',
  citationDisplay: 'shown',
  autoScrollDuringStreaming: true,
};

const STORAGE_KEY = 'edumind.preferences.v1';

/** Parses a stored blob defensively: unknown/missing/corrupt fields fall
 * back to the default for that field rather than failing app start. */
function parseStoredPreferences(raw: string | null): Preferences {
  if (!raw) return { ...DEFAULT_PREFERENCES };
  try {
    const parsed = JSON.parse(raw) as Partial<Preferences>;
    return {
      themeMode:
        parsed.themeMode === 'light' || parsed.themeMode === 'dark' || parsed.themeMode === 'system'
          ? parsed.themeMode
          : DEFAULT_PREFERENCES.themeMode,
      textSize:
        parsed.textSize === 'small' || parsed.textSize === 'large' || parsed.textSize === 'default'
          ? parsed.textSize
          : DEFAULT_PREFERENCES.textSize,
      reduceMotion:
        typeof parsed.reduceMotion === 'boolean'
          ? parsed.reduceMotion
          : DEFAULT_PREFERENCES.reduceMotion,
      responseStyle:
        parsed.responseStyle === 'concise' ||
        parsed.responseStyle === 'balanced' ||
        parsed.responseStyle === 'detailed'
          ? parsed.responseStyle
          : DEFAULT_PREFERENCES.responseStyle,
      citationDisplay:
        parsed.citationDisplay === 'shown' || parsed.citationDisplay === 'hidden'
          ? parsed.citationDisplay
          : DEFAULT_PREFERENCES.citationDisplay,
      autoScrollDuringStreaming:
        typeof parsed.autoScrollDuringStreaming === 'boolean'
          ? parsed.autoScrollDuringStreaming
          : DEFAULT_PREFERENCES.autoScrollDuringStreaming,
    };
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

interface PreferencesContextValue {
  preferences: Preferences;
  hydrated: boolean;
  update: <K extends keyof Preferences>(key: K, value: Preferences[K]) => void;
}

const PreferencesContext = createContext<PreferencesContextValue | null>(null);

/**
 * Mounts once near the app root (app/_layout.tsx). `initialOverrides`
 * exists purely for tests that need deterministic starting values without
 * going through async storage; production never passes it.
 */
export function PreferencesProvider({
  children,
  initialOverrides,
}: {
  children: ReactNode;
  initialOverrides?: Partial<Preferences>;
}) {
  const [preferences, setPreferences] = useState<Preferences>(() =>
    initialOverrides ? { ...DEFAULT_PREFERENCES, ...initialOverrides } : { ...DEFAULT_PREFERENCES }
  );
  const [hydrated, setHydrated] = useState(initialOverrides !== undefined);

  useEffect(() => {
    if (initialOverrides !== undefined) return;
    let cancelled = false;
    (async () => {
      const stored = await getStorageItem(STORAGE_KEY);
      if (cancelled) return;
      setPreferences(parseStoredPreferences(stored));
      setHydrated(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [initialOverrides]);

  const update = useCallback(<K extends keyof Preferences>(key: K, value: Preferences[K]) => {
    setPreferences((prev) => {
      const next = { ...prev, [key]: value };
      // Fire-and-forget persistence — the in-memory state is authoritative
      // for this session; a storage failure only costs the restart-survival
      // of this one change, never the change itself.
      void setStorageItem(STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const value = useMemo<PreferencesContextValue>(
    () => ({ preferences, hydrated, update }),
    [preferences, hydrated, update]
  );

  return <PreferencesContext.Provider value={value}>{children}</PreferencesContext.Provider>;
}

/** Null-safe: outside a provider returns the defaults (see module doc). */
export function usePreferences(): PreferencesContextValue {
  const ctx = useContext(PreferencesContext);
  if (ctx === null) {
    return { preferences: { ...DEFAULT_PREFERENCES }, hydrated: true, update: () => {} };
  }
  return ctx;
}

/**
 * The app's two palettes. Light keeps the existing EduMind look exactly
 * (slate surfaces, #208AEF blue); dark is the same slate family inverted,
 * with a brightened blue so the accent keeps its contrast on dark cards.
 */
export interface ThemePalette {
  background: string;
  card: string;
  cardPressed: string;
  border: string;
  divider: string;
  text: string;
  subtext: string;
  faint: string;
  accent: string;
  accentSoft: string;
  accentContrast: string;
  danger: string;
  dangerSoft: string;
  ok: string;
  warning: string;
  warningSoft: string;
  overlay: string;
}

const LIGHT_PALETTE: ThemePalette = {
  background: '#F8FAFC',
  card: '#FFFFFF',
  cardPressed: '#F1F5F9',
  border: '#E2E8F0',
  divider: '#F1F5F9',
  text: '#0F172A',
  subtext: '#64748B',
  faint: '#94A3B8',
  accent: '#208AEF',
  accentSoft: '#E8F2FE',
  accentContrast: '#FFFFFF',
  danger: '#B91C1C',
  dangerSoft: '#FEF2F2',
  ok: '#166534',
  warning: '#B45309',
  warningSoft: '#FEF3C7',
  overlay: 'rgba(15, 23, 42, 0.5)',
};

const DARK_PALETTE: ThemePalette = {
  background: '#0F172A',
  card: '#1E293B',
  cardPressed: '#263449',
  border: '#334155',
  divider: '#293548',
  text: '#F1F5F9',
  subtext: '#94A3B8',
  faint: '#64748B',
  accent: '#5AA9FF',
  accentSoft: '#17324F',
  accentContrast: '#0F172A',
  danger: '#F87171',
  dangerSoft: '#3B1B1B',
  ok: '#4ADE80',
  warning: '#FBBF24',
  warningSoft: '#3B2F14',
  overlay: 'rgba(2, 6, 23, 0.6)',
};

export interface Theme extends ThemePalette {
  /** The mode the user chose. */
  mode: ThemeMode;
  /** The palette actually in effect after resolving 'system'. */
  effective: 'light' | 'dark';
  /** Font-size multiplier for the text-size preference (0.9 / 1 / 1.12). */
  scale: (size: number) => number;
  /** True when animations should be toned down (reduce-motion setting). */
  reduceMotion: boolean;
}

const TEXT_SIZE_FACTORS: Record<TextSize, number> = {
  small: 0.9,
  default: 1,
  large: 1.12,
};

export function useTheme(): Theme {
  const { preferences } = usePreferences();
  const systemScheme = useColorScheme();
  const effective: 'light' | 'dark' =
    preferences.themeMode === 'system'
      ? systemScheme === 'dark'
        ? 'dark'
        : 'light'
      : preferences.themeMode;
  const palette = effective === 'dark' ? DARK_PALETTE : LIGHT_PALETTE;
  const factor = TEXT_SIZE_FACTORS[preferences.textSize];

  return useMemo<Theme>(
    () => ({
      ...palette,
      mode: preferences.themeMode,
      effective,
      scale: (size: number) => Math.round(size * factor * 10) / 10,
      reduceMotion: preferences.reduceMotion,
    }),
    [palette, preferences.themeMode, preferences.reduceMotion, effective, factor]
  );
}
