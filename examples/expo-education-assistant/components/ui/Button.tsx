import { useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useTheme } from '@/lib/Preferences';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'md' | 'sm';

export interface ButtonProps {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  size?: ButtonSize;
  disabled?: boolean;
  loading?: boolean;
  /** Rendered before the label — a ProviderIcon, a small glyph, etc. */
  icon?: React.ReactNode;
  fullWidth?: boolean;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/**
 * The one button component every screen should reach for. Covers every
 * interaction state a real control needs — hover (web), focus (keyboard
 * nav, visible ring), pressed, disabled, loading — so no screen has to
 * reinvent them, and so they're consistent everywhere at once instead of
 * drifting screen to screen. Font is always `theme.fonts.bodySemibold`:
 * buttons are UI chrome, never the display serif.
 */
export function Button({
  label,
  onPress,
  variant = 'primary',
  size = 'md',
  disabled = false,
  loading = false,
  icon,
  fullWidth = false,
  accessibilityLabel,
  style,
  testID,
}: ButtonProps) {
  const theme = useTheme();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const isDisabled = disabled || loading;

  const palette = variantPalette(theme, variant);
  const height = size === 'sm' ? 36 : 44;
  const fontSize = theme.scale(size === 'sm' ? 13 : 15);

  return (
    <Pressable
      onPress={onPress}
      disabled={isDisabled}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: isDisabled, busy: loading }}
      testID={testID}
      style={({ pressed }) => [
        styles.base,
        {
          height,
          minWidth: fullWidth ? undefined : 88,
          width: fullWidth ? '100%' : undefined,
          paddingHorizontal: theme.space.lg,
          borderRadius: theme.radius.md,
          backgroundColor: pressed
            ? palette.backgroundActive
            : hovered
              ? palette.backgroundHover
              : palette.background,
          borderWidth: palette.borderWidth,
          borderColor: palette.borderColor,
          opacity: isDisabled ? 0.5 : 1,
          // A 1px lift on hover, settling back down (and slightly
          // compressing) on press — the same primary-CTA micro-interaction
          // most premium SaaS sign-in buttons use. Primary-only: repeating
          // it on every secondary/ghost button on a page would read as
          // busy rather than considered.
          transform:
            variant === 'primary' && !isDisabled
              ? [{ translateY: pressed ? 0 : hovered ? -1 : 0 }, { scale: pressed ? 0.99 : 1 }]
              : undefined,
          // A soft, accent-colored shadow under primary CTAs — the same
          // "the button itself glows" treatment premium SaaS sign-in/
          // submit buttons use, rather than a flat neutral drop shadow.
          // Primary-only for the same reason the hover lift is: every
          // button on a page glowing would cancel the effect out.
          ...(variant === 'primary' && !isDisabled
            ? {
                shadowColor: theme.accent,
                shadowOffset: { width: 0, height: hovered ? 10 : 6 },
                shadowOpacity: hovered ? 0.32 : 0.24,
                shadowRadius: hovered ? 20 : 14,
                elevation: 6,
              }
            : null),
        },
        focused && !isDisabled && { ...styles.focusRing, borderColor: theme.focusRing },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={palette.text} size="small" />
      ) : (
        <View style={styles.content}>
          {icon}
          <Text
            style={[
              styles.label,
              { color: palette.text, fontSize, fontFamily: theme.fonts.bodySemibold },
            ]}
            numberOfLines={1}
          >
            {label}
          </Text>
        </View>
      )}
    </Pressable>
  );
}

function variantPalette(theme: ReturnType<typeof useTheme>, variant: ButtonVariant) {
  switch (variant) {
    case 'primary':
      return {
        background: theme.accent,
        backgroundHover: theme.accent,
        backgroundActive: theme.accent,
        text: theme.accentContrast,
        borderWidth: 0,
        borderColor: 'transparent',
      };
    case 'danger':
      return {
        background: theme.danger,
        backgroundHover: theme.danger,
        backgroundActive: theme.danger,
        text: '#FFFFFF',
        borderWidth: 0,
        borderColor: 'transparent',
      };
    case 'secondary':
      return {
        background: theme.card,
        backgroundHover: theme.cardPressed,
        backgroundActive: theme.cardPressed,
        text: theme.text,
        borderWidth: StyleSheet.hairlineWidth * 2,
        borderColor: theme.border,
      };
    case 'ghost':
    default:
      return {
        background: 'transparent',
        backgroundHover: theme.cardPressed,
        backgroundActive: theme.cardPressed,
        text: theme.accent,
        borderWidth: 0,
        borderColor: 'transparent',
      };
  }
}

const styles = StyleSheet.create({
  base: {
    alignItems: 'center',
    justifyContent: 'center',
    // Web only — RN's transition props are silently ignored on native,
    // which is exactly the "no unnecessary animation on native" outcome
    // we want; this just smooths the hover/press color swap in-browser.
    ...(Platform.OS === 'web'
      ? ({
          transitionProperty: 'background-color, transform, box-shadow',
          transitionDuration: '180ms',
        } as object)
      : null),
  },
  content: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  label: { fontWeight: '600' },
  focusRing: {
    borderWidth: 2,
    ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as object) : null),
  },
});
