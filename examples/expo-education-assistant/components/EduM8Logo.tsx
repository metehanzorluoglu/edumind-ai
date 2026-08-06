import Svg, { Defs, LinearGradient, Path, Rect, Stop } from 'react-native-svg';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { useTheme } from '@/lib/Preferences';

/**
 * EduM8 brand mark — single source of truth per brand/BRAND_GUIDELINES.md.
 * Replaces the earlier magnifying-glass symbol wholesale: a rounded-square
 * "E8" mark (indigo→blue gradient, #4F46E5 → #2563EB at 135°) plus an
 * "EduM8" wordmark in the app's own bold sans (Hanken Grotesk Bold) — not
 * a raster image, so it's perfectly sharp at any size/DPI and recolors
 * itself correctly in dark mode via theme.text (the reference brand sheet
 * shows the same wordmark white-on-dark / ink-on-light, which is exactly
 * what reading from the theme gives for free).
 *
 * The glyph paths themselves are baked-in vector outlines extracted from
 * this app's own HankenGrotesk_700Bold.ttf (not live <text>), so every
 * consumer — this component, and the separately-exported favicon/PWA/OG
 * assets in assets/brand/e8-icon.svg — renders pixel-identical glyphs
 * with no dependency on font availability at render time.
 *
 * Two components:
 *  - `EduM8Symbol` — the icon alone. Use anywhere space is tight: nav
 *    rail, drawer header, loading states, avatar placeholders, browser
 *    tab (favicon — see assets/brand/e8-icon.svg / public/favicon-*).
 *  - `EduM8Logo` — icon + wordmark. Use where there's room to breathe:
 *    login, splash, check-email/verify-email headers.
 *
 * Both size by height only (`size` prop) — the icon is a perfect square,
 * and the wordmark is derived from the same value, so callers can never
 * stretch or distort the mark relative to itself. Never animate rotation/
 * opacity for a "loading" state (brand guideline: an endlessly spinning
 * mark reads as "broken," not "thinking" — pair a separate
 * ActivityIndicator instead, as every loading screen in this app does).
 */

const E_PATH = 'M67 0V697H531V581H196V415H509V300H196V116H531V0Z';
const EIGHT_PATH =
  'M280 -10Q213 -10 153.5 14.0Q94 38 57.5 86.5Q21 135 21 207Q21 262 45.5 307.0Q70 352 119 379Q89 400 71.5 432.0Q54 464 54 508Q54 571 86.0 615.0Q118 659 170.0 683.0Q222 707 280 707Q341 707 392.0 682.5Q443 658 474.0 613.5Q505 569 505 507Q505 463 488.0 431.5Q471 400 441 379Q490 352 514.5 307.0Q539 262 539 207Q539 135 502.5 86.5Q466 38 407.0 14.0Q348 -10 280 -10ZM280 108Q319 108 349.5 120.5Q380 133 397.5 158.0Q415 183 415 219Q415 255 397.5 279.5Q380 304 349.5 316.5Q319 329 280 329Q241 329 210.5 316.5Q180 304 162.5 279.5Q145 255 145 219Q145 183 162.5 158.0Q180 133 211.0 120.5Q242 108 280 108ZM281 414Q326 414 354.0 437.0Q382 460 382 498Q382 539 355.0 563.5Q328 588 280 588Q250 588 227.0 577.5Q204 567 191.5 547.5Q179 528 179 500Q179 460 207.0 437.0Q235 414 281 414Z';
// Glyph transforms below position the two paths (baseline-relative font
// units) inside the icon's 0-1000 viewBox — see brand asset generation
// notes; kept in sync with assets/brand/e8-icon.svg by hand (both derive
// from the same extraction, see that file's own header comment).
const E_TRANSFORM =
  'translate(125.80344332855094,720.0) scale(0.6312769010043041,-0.6312769010043041)';
const EIGHT_TRANSFORM =
  'translate(520.6814921090388,720.0) scale(0.6312769010043041,-0.6312769010043041)';

interface EduM8MarkProps {
  /** Rendered height in px — the icon is a perfect square, so this is also its width. */
  size?: number;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
}

/** The rounded-square "E8" icon alone — no wordmark. */
export function EduM8Symbol({ size = 32, style, accessibilityLabel = 'EduM8' }: EduM8MarkProps) {
  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={accessibilityLabel}
      style={style}
    >
      <Svg width={size} height={size} viewBox="0 0 1000 1000">
        <Defs>
          <LinearGradient id="e8Gradient" x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0%" stopColor="#4F46E5" />
            <Stop offset="100%" stopColor="#2563EB" />
          </LinearGradient>
        </Defs>
        <Rect width={1000} height={1000} rx={220} ry={220} fill="url(#e8Gradient)" />
        <Path transform={E_TRANSFORM} d={E_PATH} fill="#FFFFFF" />
        <Path transform={EIGHT_TRANSFORM} d={EIGHT_PATH} fill="#FFFFFF" />
      </Svg>
    </View>
  );
}

/** The full lockup: icon + "EduM8" wordmark, in the app's bold sans. */
export function EduM8Logo({ size = 32, style, accessibilityLabel = 'EduM8' }: EduM8MarkProps) {
  const theme = useTheme();
  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={accessibilityLabel}
      style={[styles.lockup, style]}
    >
      <EduM8Symbol size={size} />
      <Text
        style={[
          styles.wordmark,
          {
            fontSize: size * 1.32,
            lineHeight: size * 1.32,
            color: theme.text,
            fontFamily: theme.fonts.bodyBold,
          },
        ]}
      >
        EduM8
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  lockup: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  wordmark: { letterSpacing: -0.5 },
});
