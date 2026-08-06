import { StyleSheet, Text, View, Pressable } from 'react-native';
import { useTheme } from '@/lib/Preferences';

/**
 * One settings row inside a SettingsSection card: label (+ optional muted
 * description), an optional current value, and a chevron when the row
 * navigates or opens something. Minimum 46px tall for comfortable touch
 * targets. Pressed/hover feedback is a subtle background tint — no layout
 * shift, no flash. Pass `tone="danger"` for destructive actions; they also
 * get visually separated by callers (own section / spacing).
 */
export function SettingsRow({
  label,
  description,
  value,
  onPress,
  chevron = false,
  tone = 'default',
  disabled = false,
  testID,
}: {
  label: string;
  description?: string;
  /** Right-aligned muted value text (e.g. "12 documents", "Google"). */
  value?: string;
  onPress?: () => void;
  chevron?: boolean;
  tone?: 'default' | 'accent' | 'danger';
  disabled?: boolean;
  testID?: string;
}) {
  const theme = useTheme();
  const labelColor =
    tone === 'danger' ? theme.danger : tone === 'accent' ? theme.accent : theme.text;

  const body = (
    <>
      <View style={styles.labelBlock}>
        <Text
          style={[
            styles.label,
            {
              color: disabled ? theme.faint : labelColor,
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
      <View style={styles.trailing}>
        {value ? (
          <Text
            style={[
              styles.value,
              { color: theme.subtext, fontSize: theme.scale(13), fontFamily: theme.fonts.body },
            ]}
          >
            {value}
          </Text>
        ) : null}
        {chevron ? <Text style={[styles.chevron, { color: theme.faint }]}>›</Text> : null}
      </View>
    </>
  );

  if (!onPress || disabled) {
    return (
      <View
        style={[styles.row, { backgroundColor: theme.card }]}
        accessibilityLabel={onPress ? undefined : label}
        testID={testID}
      >
        {body}
      </View>
    );
  }

  return (
    <Pressable
      style={({ pressed }) => [
        styles.row,
        { backgroundColor: pressed ? theme.cardPressed : theme.card },
      ]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      testID={testID}
    >
      {body}
    </Pressable>
  );
}

/** Hairline separator between rows inside a SettingsSection card. */
export function RowDivider() {
  const theme = useTheme();
  return <View style={[styles.divider, { backgroundColor: theme.divider }]} />;
}

const styles = StyleSheet.create({
  divider: { height: 1, marginStart: 16 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 13,
    minHeight: 46,
  },
  labelBlock: { flexShrink: 1, gap: 2 },
  label: { fontWeight: '500' },
  description: { lineHeight: 16 },
  trailing: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 0 },
  value: {},
  chevron: { fontSize: 20, fontWeight: '600', marginLeft: 2 },
});
