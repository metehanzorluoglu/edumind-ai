import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '@/lib/Preferences';

/**
 * One grouped settings card: a small-caps section label above a rounded,
 * bordered card whose children are stacked rows. The label sits OUTSIDE
 * the card (ChatGPT/Claude-style grouping), so the card itself stays a
 * quiet container with hairline dividers between rows (each row renders
 * its own divider — see SettingsRow).
 */
export function SettingsSection({
  title,
  children,
  footer,
}: {
  title: string;
  children: ReactNode;
  /** Small muted note under the card (e.g. privacy explanations). */
  footer?: string;
}) {
  const theme = useTheme();
  return (
    <View style={styles.wrap}>
      <Text style={[styles.title, { color: theme.subtext, fontSize: theme.scale(12) }]}>
        {title.toUpperCase()}
      </Text>
      <View style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
        {children}
      </View>
      {footer ? (
        <Text style={[styles.footer, { color: theme.faint, fontSize: theme.scale(12) }]}>
          {footer}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 6 },
  title: { fontWeight: '700', letterSpacing: 0.8, paddingHorizontal: 4 },
  card: { borderRadius: 12, borderWidth: 1, overflow: 'hidden' },
  footer: { lineHeight: 17, paddingHorizontal: 4, paddingTop: 2 },
});
