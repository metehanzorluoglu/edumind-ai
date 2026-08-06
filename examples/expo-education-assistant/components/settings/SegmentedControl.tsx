import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '@/lib/Preferences';

/**
 * A three-way (or n-way) segmented picker used for Theme and Text size —
 * equal-width segments inside a bordered track, the selected one tinted
 * with the accent. Keyboard/screen-reader friendly: each segment is a
 * labeled button with a selected state.
 */
export function SegmentedControl<T extends string>({
  label,
  options,
  value,
  onChange,
  testID,
}: {
  /** Accessible group label (e.g. "Theme"). */
  label: string;
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (next: T) => void;
  testID?: string;
}) {
  const theme = useTheme();
  return (
    <View
      style={[styles.row, { backgroundColor: theme.card }]}
      accessibilityRole="adjustable"
      accessibilityLabel={label}
      testID={testID}
    >
      <Text
        style={[
          styles.label,
          { color: theme.text, fontSize: theme.scale(15), fontFamily: theme.fonts.bodyMedium },
        ]}
      >
        {label}
      </Text>
      <View
        style={[styles.track, { backgroundColor: theme.background, borderColor: theme.border }]}
      >
        {options.map((option) => {
          const selected = option.value === value;
          return (
            <Pressable
              key={option.value}
              style={({ pressed }) => [
                styles.segment,
                selected
                  ? { backgroundColor: theme.accentSoft }
                  : { backgroundColor: pressed ? theme.cardPressed : 'transparent' },
              ]}
              onPress={() => onChange(option.value)}
              accessibilityRole="button"
              accessibilityLabel={`${label}: ${option.label}`}
              accessibilityState={{ selected }}
            >
              <Text
                style={[
                  styles.segmentText,
                  {
                    color: selected ? theme.accent : theme.subtext,
                    fontSize: theme.scale(13),
                    fontFamily: selected ? theme.fonts.bodyBold : theme.fonts.bodyMedium,
                  },
                ]}
              >
                {option.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 11,
    minHeight: 46,
  },
  label: { fontWeight: '500', flexShrink: 1 },
  track: {
    flexDirection: 'row',
    borderRadius: 9,
    borderWidth: 1,
    padding: 3,
    gap: 3,
  },
  segment: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 7,
    minWidth: 52,
    alignItems: 'center',
  },
  segmentText: {},
});
