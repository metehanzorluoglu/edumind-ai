import { useState } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet } from 'react-native';
import { useTheme } from '@/lib/Preferences';

export interface IconButtonProps {
  /** Accessible name — these are icon-only by design, never for a screen reader. */
  label: string;
  onPress: () => void;
  /** The glyph — an icon from components/icons.tsx, colored by the caller. */
  icon: React.ReactNode;
  /** 'outline' draws a bordered square (composer actions); 'ghost' is a
   *  bare hover-tinted target (toolbars, close buttons). */
  variant?: 'outline' | 'ghost';
  size?: 'md' | 'sm';
  disabled?: boolean;
  loading?: boolean;
  /** Persistent highlighted state (e.g. an open menu trigger). */
  active?: boolean;
  /** Icon color at rest — defaults to theme.subtext. */
  color?: string;
  testID?: string;
}

/**
 * The one icon-only button. Every glyph action in the app (composer
 * attach/generate, close buttons, toolbar triggers) goes through here so
 * hover/focus/pressed/disabled behavior and a >=36px hit target are the
 * same everywhere instead of being re-derived per screen.
 */
export function IconButton({
  label,
  onPress,
  icon,
  variant = 'ghost',
  size = 'md',
  disabled = false,
  loading = false,
  active = false,
  color,
  testID,
}: IconButtonProps) {
  const theme = useTheme();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const isDisabled = disabled || loading;
  const dimension = size === 'sm' ? 36 : 44;

  return (
    <Pressable
      onPress={onPress}
      disabled={isDisabled}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: isDisabled, busy: loading }}
      testID={testID}
      style={({ pressed }) => [
        styles.base,
        {
          width: dimension,
          minHeight: dimension,
          borderRadius: theme.radius.md,
          borderWidth: variant === 'outline' ? StyleSheet.hairlineWidth * 2 : 0,
          borderColor: variant === 'outline' ? theme.border : 'transparent',
          backgroundColor:
            pressed || hovered || active
              ? theme.cardPressed
              : variant === 'outline'
                ? theme.card
                : 'transparent',
          opacity: isDisabled ? 0.5 : 1,
        },
        focused && !isDisabled && { borderColor: theme.focusRing, borderWidth: 2 },
      ]}
    >
      {loading ? <ActivityIndicator size="small" color={color ?? theme.subtext} /> : (icon ?? null)}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    alignItems: 'center',
    justifyContent: 'center',
    ...(Platform.OS === 'web'
      ? ({
          transitionProperty: 'background-color, border-color, opacity',
          transitionDuration: '150ms',
        } as object)
      : null),
  },
});
