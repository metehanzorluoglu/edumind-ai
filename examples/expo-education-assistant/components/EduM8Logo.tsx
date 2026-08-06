import { Image, type ImageStyle, type StyleProp } from 'react-native';

/**
 * EduM8 brand mark — see brand/BRAND_GUIDELINES.md at the repo root for the
 * full system (this is the "single source of truth" it refers to).
 *
 * Two components, matching the guideline's two approved forms:
 *  - `EduM8Symbol` — the magnifying glass + orange "8" alone. Use anywhere
 *    space is tight: nav/sidebar, favicon-adjacent UI, loading states,
 *    avatar placeholders.
 *  - `EduM8Logo` — the full lockup (symbol + "edum8" wordmark). Use where
 *    there's room to breathe: login, splash, marketing surfaces.
 *
 * Both render from fixed-aspect-ratio source art and size by height only
 * (`size` prop), so callers can never stretch or distort the mark — the
 * brand guideline's #1 "incorrect usage" example is exactly that. Do not
 * pass a `style` that sets width independently of height.
 *
 * Never animate these components' rotation/opacity for a "loading" state —
 * brand guideline §7: an endlessly spinning magnifying glass reads as
 * "broken," not "thinking." Pair a separate ActivityIndicator instead.
 */

export type LogoVariant = 'color' | 'mono-ink' | 'mono-white';

interface EduM8MarkProps {
  /** Rendered height in px. Width is derived from the mark's fixed aspect ratio. */
  size?: number;
  /**
   * 'color' (default) — full brand color, safe on both light and dark
   * surfaces (see brand/BRAND_GUIDELINES.md §2.7). 'mono-ink' / 'mono-white'
   * are for single-color contexts only (e.g. a footer wordmark).
   */
  variant?: LogoVariant;
  style?: StyleProp<ImageStyle>;
  accessibilityLabel?: string;
}

// width / height of the source art — see brand/final/*.png
const SYMBOL_ASPECT_RATIO = 284 / 270;
const LOCKUP_ASPECT_RATIO = 820 / 270;

const SYMBOL_SOURCES = {
  color: require('@/assets/brand/symbol.png'),
  'mono-ink': require('@/assets/brand/symbol-mono-ink.png'),
  'mono-white': require('@/assets/brand/symbol-mono-white.png'),
} as const;

const LOCKUP_SOURCES = {
  color: require('@/assets/brand/logo-primary.png'),
  'mono-ink': require('@/assets/brand/logo-mono-ink.png'),
  'mono-white': require('@/assets/brand/logo-mono-white.png'),
} as const;

/** The magnifying glass + orange "8" alone — no wordmark. */
export function EduM8Symbol({
  size = 32,
  variant = 'color',
  style,
  accessibilityLabel = 'EduM8',
}: EduM8MarkProps) {
  return (
    <Image
      source={SYMBOL_SOURCES[variant]}
      accessibilityLabel={accessibilityLabel}
      resizeMode="contain"
      style={[{ width: size * SYMBOL_ASPECT_RATIO, height: size }, style]}
    />
  );
}

/** The full lockup: symbol + "edum8" wordmark. */
export function EduM8Logo({
  size = 32,
  variant = 'color',
  style,
  accessibilityLabel = 'EduM8',
}: EduM8MarkProps) {
  return (
    <Image
      source={LOCKUP_SOURCES[variant]}
      accessibilityLabel={accessibilityLabel}
      resizeMode="contain"
      style={[{ width: size * LOCKUP_ASPECT_RATIO, height: size }, style]}
    />
  );
}
