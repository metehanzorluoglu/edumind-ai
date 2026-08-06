import { StyleSheet, Switch, Text, View } from 'react-native';
import { useTheme } from '@/lib/Preferences';

/**
 * A settings row with a trailing Switch — label (+ optional description)
 * on the left, the toggle on the right. The switch's track/thumb colors
 * follow the active theme; the whole row stays a plain View (only the
 * switch itself is interactive, matching platform settings conventions).
 */
export function SettingsToggleRow({
  label,
  description,
  value,
  onValueChange,
  disabled = false,
  testID,
}: {
  label: string;
  description?: string;
  value: boolean;
  onValueChange: (next: boolean) => void;
  disabled?: boolean;
  testID?: string;
}) {
  const theme = useTheme();
  return (
    <View style={[styles.row, { backgroundColor: theme.card }]} testID={testID}>
      <View style={styles.labelBlock}>
        <Text
          style={[
            styles.label,
            {
              color: disabled ? theme.faint : theme.text,
              fontSize: theme.scale(15),
              fontFamily: theme.fonts.bodyMedium,
            },
          ]}
        >
          {label}
        </Text>
        {description ? (
          <Text
            style={[
              styles.description,
              { color: theme.faint, fontSize: theme.scale(12), fontFamily: theme.fonts.body },
            ]}
          >
            {description}
          </Text>
        ) : null}
      </View>
      <Switch
        value={value}
        onValueChange={onValueChange}
        disabled={disabled}
        trackColor={{ true: theme.accent, false: theme.border }}
        thumbColor={theme.card}
        accessibilityLabel={label}
      />
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
  labelBlock: { flexShrink: 1, gap: 2 },
  label: { fontWeight: '500' },
  description: { lineHeight: 16 },
});
