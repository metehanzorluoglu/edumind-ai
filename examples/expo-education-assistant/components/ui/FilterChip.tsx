import { useState } from 'react';
import { Platform, Pressable, StyleSheet, Text } from 'react-native';
import { useTheme } from '@/lib/Preferences';

export interface FilterChipProps {
  label: string;
  selected: boolean;
  onPress: () => void;
  disabled?: boolean;
}

/**
 * The one filter chip for every facet row (Search filters, Documents
 * upload metadata). Selected state is a tinted treatment (accentSoft fill
 * + accent text/border) rather than a solid fill — quieter, and it keeps
 * the row reading as one family of equal-weight options with one chosen,
 * instead of a row of tiny solid buttons. Hover/focus/pressed feedback
 * matches Button.tsx's web behavior; the focus ring keeps keyboard
 * navigation visible on what are otherwise small targets.
 */
export function FilterChip({ label, selected, onPress, disabled = false }: FilterChipProps) {
  const theme = useTheme();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      style={({ pressed }) => [
        styles.chip,
        {
          borderRadius: theme.radius.pill,
          borderColor: selected ? theme.accent : hovered ? theme.borderStrong : theme.border,
          backgroundColor: selected
            ? theme.accentSoft
            : pressed || hovered
              ? theme.cardPressed
              : 'transparent',
          opacity: disabled ? 0.5 : 1,
        },
        focused && !disabled && { borderColor: theme.focusRing, borderWidth: 2 },
      ]}
    >
      <Text
        style={[
          styles.chipText,
          {
            color: selected ? theme.accent : theme.subtext,
            fontFamily: selected ? theme.fonts.bodySemibold : theme.fonts.body,
            fontSize: theme.scale(12),
          },
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chip: {
    borderWidth: StyleSheet.hairlineWidth * 2,
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginRight: 6,
    ...(Platform.OS === 'web'
      ? ({
          transitionProperty: 'background-color, border-color, color',
          transitionDuration: '150ms',
        } as object)
      : null),
  },
  chipText: { lineHeight: 16 },
});
