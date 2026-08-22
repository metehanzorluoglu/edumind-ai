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
import { fontFamilies, useFontsReady, type FontFamilies } from './fonts';
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
/** Milestone 4.2 (Citation & BibTeX Foundation) Section 6 — the user's
 * preferred bibliographic citation style. Local-only, same as
 * documentsViewMode (no backend setting — this is a display preference,
 * not something the server needs to know or enforce). */
export type CitationStyle = 'apa7' | 'ieee';

export interface Preferences {
  themeMode: ThemeMode;
  textSize: TextSize;
  reduceMotion: boolean;
  responseStyle: ResponseStyle;
  citationDisplay: CitationDisplay;
  autoScrollDuringStreaming: boolean;
  /** Collapsed state of the app drawer (conversation history / projects /
   * shortcuts) on wide web — persisted so a user's chosen layout survives
   * a reload. Never applies on narrow/native, where the drawer is always
   * an overlay regardless of this value. */
  sidebarCollapsed: boolean;
  /** Drawer width in px on wide web, user-adjustable via a drag handle.
   * Clamped to SIDEBAR_WIDTH_MIN/MAX (see below) wherever it's read, so a
   * corrupted or hand-edited stored value can never render an unusable
   * (zero-width or overflowing) drawer. */
  sidebarWidth: number;
  /** Frontend Milestone 1 (Finder-style Document Library): the user's last
   * chosen Documents view — persisted locally only (no backend setting, per
   * the milestone's own requirement) so reopening Documents preserves it.
   * Defaults to 'grid', matching the pre-redesign card-like document list. */
  documentsViewMode: 'grid' | 'list';
  /** Milestone 4.2 Section 6 — persisted across sessions so choosing IEEE
   * once doesn't need to be repeated on every citation popover open. */
  citationStyle: CitationStyle;
  /** Milestone 5.5 Part 9 — the Writing workspace's left "Research" panel
   * (Files/Outline/References/Notes/Tools; Ask EduM8 is a separate
   * header-level action, not a tab of this panel — see the Writing UX
   * Refinement milestone) restores its last-open tab, so returning to a
   * project (or coming back from the Reader — Part 19) lands where the
   * researcher left off rather than always resetting to References.
   * `'outline'` and `'tools'` are additive (Writing UX Refinement
   * milestone); `'ask'` is kept as a valid stored value for backward
   * compatibility with preferences persisted before that milestone (a
   * user who last had the Ask EduM8 view open still lands there), even
   * though it's no longer offered as a pill in the tab strip itself —
   * it's still reachable via the header's own "Ask EduM8" button, which
   * sets this same field. */
  writingPanelTab: 'project' | 'references' | 'notes' | 'outline' | 'tools' | 'ask';
  /** Milestone 5.5.1 Part 4/5 — the Research panel (Files/References/
   * Notes/Ask EduM8) is a true collapsible drawer, not an always-visible
   * column: this is that drawer's own open/closed state, independent of
   * `writingPanelTab` (which tab is showing) so closing and reopening the
   * drawer always lands back on the same tab. Defaults to open (true) —
   * preserves today's "always visible" appearance for every existing
   * user; only becomes closed once someone actually closes it. */
  writingResearchDrawerOpen: boolean;
  /** Mirrors sidebarCollapsed's own reasoning, for the Writing PDF
   * preview column on wide web. */
  writingPreviewCollapsed: boolean;
  /** Drag-resize width (Part 8) for the Writing workspace's Research
   * side column, wide-web only. Clamped wherever read — see
   * WRITING_RESEARCH_PANEL_WIDTH_MIN/MAX. The Preview column's own
   * split (Editor ↔ Preview) is deliberately NOT here as of the
   * M5.5.3 final-acceptance spec's own explicit requirement — "Do NOT
   * persist exact pixel widths in user database... session-scoped"
   * only, via lib/sessionNavCache.ts (see app/(tabs)/writing/[id].tsx's
   * own previewPanelResize wiring) — this field used to exist and
   * persisted it here (a real, if minor, spec deviation the owner's
   * own report implicitly flagged); removed rather than left dead. */
  writingResearchPanelWidth: number;
}

/** Drag-resize bounds for the drawer — narrow enough to still show full
 * conversation titles, wide enough to never crowd out the reading canvas. */
export const SIDEBAR_WIDTH_MIN = 220;
export const SIDEBAR_WIDTH_MAX = 400;
export const SIDEBAR_WIDTH_DEFAULT = 280;

/** Milestone 5.5 Part 8 — narrow enough to leave the editor most of the
 * width, wide enough that Ask EduM8's turn history/composer stay usable. */
export const WRITING_RESEARCH_PANEL_WIDTH_MIN = 240;
export const WRITING_RESEARCH_PANEL_WIDTH_MAX = 480;
export const WRITING_RESEARCH_PANEL_WIDTH_DEFAULT = 320;
export const WRITING_PREVIEW_PANEL_WIDTH_MIN = 280;
// Writing UX Refinement milestone — this used to be a hard 640px cap,
// well short of "the compiled preview can expand to use the full
// available workspace size" (the actual product requirement). The real
// ceiling that matters — never letting the Editor column get squeezed
// below EDITOR_MIN_WIDTH_PX — is already enforced dynamically by
// computePreviewSafeWidth in app/(tabs)/writing/[id].tsx, which reacts
// to the live window width and the Research panel's own width. This
// constant only needs to stop being the *binding* constraint; it no
// longer needs to be a realistic pixel value in its own right, so it's
// set high enough that no real desktop window width will ever hit it
// first (computePreviewSafeWidth's own arithmetic always wins before
// this would).
export const WRITING_PREVIEW_PANEL_WIDTH_MAX = 4000;
export const WRITING_PREVIEW_PANEL_WIDTH_DEFAULT = 420;

export const DEFAULT_PREFERENCES: Preferences = {
  themeMode: 'system',
  textSize: 'default',
  reduceMotion: false,
  responseStyle: 'balanced',
  citationDisplay: 'shown',
  autoScrollDuringStreaming: true,
  sidebarCollapsed: false,
  sidebarWidth: SIDEBAR_WIDTH_DEFAULT,
  documentsViewMode: 'grid',
  citationStyle: 'apa7',
  writingPanelTab: 'project',
  writingResearchDrawerOpen: true,
  writingPreviewCollapsed: false,
  writingResearchPanelWidth: WRITING_RESEARCH_PANEL_WIDTH_DEFAULT,
};

// Intentionally NOT renamed to "edum8.*" despite the EduM8 rebrand — this
// is a storage key, not display text. Changing it would silently reset
// every existing user's stored preferences (theme, text size, etc.) back
// to defaults on their next launch, with no migration. Brand renames
// apply to what users read, never to storage/DB keys (see
// brand/BRAND_GUIDELINES.md's own scope note).
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
      sidebarCollapsed:
        typeof parsed.sidebarCollapsed === 'boolean'
          ? parsed.sidebarCollapsed
          : DEFAULT_PREFERENCES.sidebarCollapsed,
      sidebarWidth:
        typeof parsed.sidebarWidth === 'number' &&
        parsed.sidebarWidth >= SIDEBAR_WIDTH_MIN &&
        parsed.sidebarWidth <= SIDEBAR_WIDTH_MAX
          ? parsed.sidebarWidth
          : DEFAULT_PREFERENCES.sidebarWidth,
      documentsViewMode:
        parsed.documentsViewMode === 'grid' || parsed.documentsViewMode === 'list'
          ? parsed.documentsViewMode
          : DEFAULT_PREFERENCES.documentsViewMode,
      citationStyle:
        parsed.citationStyle === 'apa7' || parsed.citationStyle === 'ieee'
          ? parsed.citationStyle
          : DEFAULT_PREFERENCES.citationStyle,
      writingPanelTab:
        parsed.writingPanelTab === 'project' ||
        parsed.writingPanelTab === 'references' ||
        parsed.writingPanelTab === 'notes' ||
        parsed.writingPanelTab === 'outline' ||
        parsed.writingPanelTab === 'tools' ||
        parsed.writingPanelTab === 'ask'
          ? parsed.writingPanelTab
          : DEFAULT_PREFERENCES.writingPanelTab,
      writingResearchDrawerOpen:
        typeof parsed.writingResearchDrawerOpen === 'boolean'
          ? parsed.writingResearchDrawerOpen
          : DEFAULT_PREFERENCES.writingResearchDrawerOpen,
      writingPreviewCollapsed:
        typeof parsed.writingPreviewCollapsed === 'boolean'
          ? parsed.writingPreviewCollapsed
          : DEFAULT_PREFERENCES.writingPreviewCollapsed,
      writingResearchPanelWidth:
        typeof parsed.writingResearchPanelWidth === 'number' &&
        parsed.writingResearchPanelWidth >= WRITING_RESEARCH_PANEL_WIDTH_MIN &&
        parsed.writingResearchPanelWidth <= WRITING_RESEARCH_PANEL_WIDTH_MAX
          ? parsed.writingResearchPanelWidth
          : DEFAULT_PREFERENCES.writingResearchPanelWidth,
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
 * The app's two palettes — EduM8 brand tokens (see
 * brand/BRAND_GUIDELINES.md §3 at the repo root for the full system and
 * the contrast ratios behind these choices).
 *
 * Light uses the brand's actual UI colors as-is: surface #F6F7FA, ink
 * #14161F, accent blue #2F5FE0 (5.5:1 on white — passes AA text).
 *
 * Dark keeps the same slate-family structure this palette always had, but
 * swaps `background` for the brand's ink (#14161F) and `accent` for the
 * product design system's own `inverse-primary` (#B5C4FF) rather than the
 * raw brand blue — #2F5FE0 only reaches 3.3:1 against ink, enough for the
 * logo itself but not for small text (see BRAND_GUIDELINES.md §8).
 */
export interface ThemePalette {
  background: string;
  card: string;
  cardPressed: string;
  border: string;
  borderStrong: string;
  divider: string;
  text: string;
  subtext: string;
  faint: string;
  accent: string;
  accentSoft: string;
  accentContrast: string;
  /** Citations / AI-grounding badges specifically — ochre, never the
   * general accent blue. See brand/BRAND_GUIDELINES.md §3: "the moment
   * orange carries text or a functional signal, switch from amber to
   * ochre." Light uses ochre (4.5:1 on white); dark uses amber (8:1 on
   * ink) — amber is decorative-only on light backgrounds but is the
   * *more* accessible of the two oranges once the background is dark. */
  citation: string;
  citationSoft: string;
  danger: string;
  dangerSoft: string;
  ok: string;
  warning: string;
  warningSoft: string;
  /** One step above `card` for floating dark UI (context menus, the active
   * conversation row) — the value the sidebar's popup menus have always
   * used, promoted to a token so rows/menus/other elevated dark surfaces
   * can't drift apart. */
  elevated: string;
  /** Code blocks are deliberately always-dark (a contrast surface even in
   * light mode, like most documentation sites) — these two tokens are the
   * pair, instead of hardcoded hexes at the call site. */
  codeSurface: string;
  codeText: string;
  overlay: string;
  /** Focus ring for keyboard navigation — visible against both card and
   * background in this theme, distinct enough from `accent` to remain
   * legible when the focused element is itself accent-colored. */
  focusRing: string;
}

const LIGHT_PALETTE: ThemePalette = {
  background: '#F6F7FA',
  card: '#FFFFFF',
  cardPressed: '#EDEEF3',
  border: '#E2E4EA',
  borderStrong: '#C9CCDA',
  divider: '#ECEDF2',
  text: '#14161F',
  subtext: '#434654',
  faint: '#85889A',
  accent: '#2F5FE0',
  accentSoft: '#E6EBFC',
  accentContrast: '#FFFFFF',
  citation: '#B0641F',
  citationSoft: '#FBF3EA',
  danger: '#B91C1C',
  dangerSoft: '#FEF2F2',
  ok: '#166534',
  warning: '#B45309',
  warningSoft: '#FEF3C7',
  elevated: '#FFFFFF',
  codeSurface: '#14161F',
  codeText: '#E2E8F0',
  overlay: 'rgba(20, 22, 31, 0.5)',
  focusRing: '#2F5FE0',
};

/**
 * Exported (unlike LIGHT_PALETTE) because ConversationSidebar is
 * deliberately always-dark regardless of the user's theme choice — a
 * ChatGPT-style persistent dark rail — and should draw from the same
 * dark tokens as everything else rather than duplicating hex values.
 */
export const DARK_PALETTE: ThemePalette = {
  background: '#14161F',
  card: '#1B1E29',
  cardPressed: '#232635',
  border: '#2F3242',
  borderStrong: '#3D4157',
  divider: '#262838',
  text: '#F0F0FB',
  subtext: '#B7BAC9',
  faint: '#7C7F92',
  accent: '#B5C4FF',
  accentSoft: '#212C4F',
  accentContrast: '#00164E',
  citation: '#DDA14B',
  citationSoft: '#2E2A22',
  danger: '#F87171',
  dangerSoft: '#3B1B1B',
  ok: '#4ADE80',
  warning: '#FBBF24',
  warningSoft: '#3B2F14',
  elevated: '#1E293B',
  codeSurface: '#14161F',
  codeText: '#E2E8F0',
  overlay: 'rgba(2, 6, 23, 0.6)',
  focusRing: '#B5C4FF',
};

/**
 * Spacing scale, 4px base — matches brand/BRAND_GUIDELINES.md's spacing
 * unit. Components are free to use raw numbers where a one-off value
 * genuinely doesn't fit the scale, but should reach for these first so
 * gaps/padding stay visually consistent across screens built at
 * different times.
 */
export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  xxxl: 48,
} as const;

/** Corner radius scale — 10px is the brand guideline's documented default
 * for cards/panels; sm/lg cover the few places that genuinely need
 * something tighter or rounder (chips vs. modals), pill for fully-round
 * controls (the composer, avatar fallbacks). */
export const radius = {
  sm: 6,
  md: 10,
  lg: 14,
  pill: 999,
} as const;

export interface Theme extends ThemePalette {
  /** The mode the user chose. */
  mode: ThemeMode;
  /** The palette actually in effect after resolving 'system'. */
  effective: 'light' | 'dark';
  /** Font-size multiplier for the text-size preference (0.9 / 1 / 1.12). */
  scale: (size: number) => number;
  /** True when animations should be toned down (reduce-motion setting). */
  reduceMotion: boolean;
  /** Brand type family names — see lib/fonts.tsx. Falls back to the
   * system font stack until the brand fonts finish loading. */
  fonts: FontFamilies;
  space: typeof space;
  radius: typeof radius;
}

const TEXT_SIZE_FACTORS: Record<TextSize, number> = {
  small: 0.9,
  default: 1,
  large: 1.12,
};

export function useTheme(): Theme {
  const { preferences } = usePreferences();
  const systemScheme = useColorScheme();
  // Hydration-mismatch fix (QA-reported "Minified React error #418"):
  // Expo's static web export (app.json's web.output: "static") pre-renders
  // this app's HTML in Node, where useColorScheme() has no real OS
  // preference to read and falls back to a default; the real browser's very
  // first client render, by contrast, can read the actual OS preference
  // synchronously (no effect needed for react-native-web's implementation)
  // — so a user whose OS is set to dark mode got a light-themed static
  // markup reconciled against a dark-themed real DOM on the very first
  // paint, a genuine server/client mismatch. `preferences` itself already
  // avoids this (see usePreferences below: it always initializes to
  // DEFAULT_PREFERENCES and only applies the real stored value from a
  // post-mount effect) — `systemScheme` needs the identical treatment,
  // deferred here rather than in usePreferences since 'system' theme mode
  // is the only thing that ever reads it.
  const [systemSchemeSettled, setSystemSchemeSettled] = useState(false);
  useEffect(() => {
    setSystemSchemeSettled(true);
  }, []);
  const effective: 'light' | 'dark' =
    preferences.themeMode === 'system'
      ? systemSchemeSettled && systemScheme === 'dark'
        ? 'dark'
        : 'light'
      : preferences.themeMode;
  const palette = effective === 'dark' ? DARK_PALETTE : LIGHT_PALETTE;
  const factor = TEXT_SIZE_FACTORS[preferences.textSize];
  const fontsReady = useFontsReady();

  return useMemo<Theme>(
    () => ({
      ...palette,
      mode: preferences.themeMode,
      effective,
      scale: (size: number) => Math.round(size * factor * 10) / 10,
      reduceMotion: preferences.reduceMotion,
      fonts: fontFamilies(fontsReady),
      space,
      radius,
    }),
    [palette, preferences.themeMode, preferences.reduceMotion, effective, factor, fontsReady]
  );
}
