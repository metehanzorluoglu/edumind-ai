import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '@/lib/Preferences';

export type NoticeTone = 'danger' | 'warning' | 'ok' | 'info' | 'neutral';

export interface NoticeProps {
  tone?: NoticeTone;
  /** Bold lead line — optional; body-only notices are fine. */
  title?: string;
  body: string;
  /** Right-aligned text action ("Retry", "Dismiss") — optional. */
  actionLabel?: string;
  onAction?: () => void;
  actionBusy?: boolean;
  style?: React.ComponentProps<typeof View>['style'];
}

/**
 * The one inline banner for anything the app needs to tell the user
 * outside a dialog: form errors, upload results, service degradation,
 * success confirmations. One component keeps tone colors, radii, and
 * action placement identical on Login, Chat, Documents, and Settings,
 * where these used to be five separate ad-hoc boxes.
 */
export function Notice({
  tone = 'neutral',
  title,
  body,
  actionLabel,
  onAction,
  actionBusy = false,
  style,
}: NoticeProps) {
  const theme = useTheme();
  const { bg, fg } = toneColors(theme, tone);

  return (
    <View
      style={[styles.box, { backgroundColor: bg, borderRadius: theme.radius.md }, style]}
      accessibilityRole="alert"
    >
      <View style={styles.textColumn}>
        {title ? (
          <Text style={[styles.title, { color: fg, fontFamily: theme.fonts.bodySemibold }]}>
            {title}
          </Text>
        ) : null}
        <Text style={[styles.body, { color: fg, fontFamily: theme.fonts.body }]}>{body}</Text>
      </View>
      {actionLabel && onAction ? (
        <Pressable
          onPress={onAction}
          disabled={actionBusy}
          accessibilityRole="button"
          accessibilityLabel={actionLabel}
          hitSlop={8}
          style={({ pressed }) => [styles.action, pressed && styles.actionPressed]}
        >
          <Text style={[styles.actionText, { color: fg, fontFamily: theme.fonts.bodySemibold }]}>
            {actionBusy ? `${actionLabel}…` : actionLabel}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function toneColors(theme: ReturnType<typeof useTheme>, tone: NoticeTone) {
  switch (tone) {
    case 'danger':
      return { bg: theme.dangerSoft, fg: theme.danger };
    case 'warning':
      return { bg: theme.warningSoft, fg: theme.warning };
    case 'ok':
      return { bg: theme.warningSoft, fg: theme.ok };
    case 'info':
      return { bg: theme.accentSoft, fg: theme.accent };
    case 'neutral':
    default:
      return { bg: theme.cardPressed, fg: theme.subtext };
  }
}

const styles = StyleSheet.create({
  box: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    padding: 12,
    gap: 8,
  },
  textColumn: { flex: 1, minWidth: 0, gap: 2 },
  title: { fontSize: 13 },
  body: { fontSize: 12, lineHeight: 18 },
  action: { paddingVertical: 2, paddingHorizontal: 4, borderRadius: 4 },
  actionPressed: { opacity: 0.7 },
  actionText: { fontSize: 12 },
});
