import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '@/lib/Preferences';

export type BadgeTone = 'citation' | 'warning' | 'danger' | 'ok' | 'neutral';

export interface BadgeProps {
  label: string;
  tone?: BadgeTone;
}

/** Small status pill — sample-content notices, citation/grounding tags,
 * dev-only markers. Mono type reinforces "metadata," matching how
 * citations render everywhere else (brand/BRAND_GUIDELINES.md §4). */
export function Badge({ label, tone = 'neutral' }: BadgeProps) {
  const theme = useTheme();
  const { bg, fg } = toneColors(theme, tone);
  return (
    <View style={[styles.badge, { backgroundColor: bg, borderRadius: theme.radius.sm }]}>
      <Text
        style={[
          styles.text,
          { color: fg, fontFamily: theme.fonts.mono, fontSize: theme.scale(10) },
        ]}
        numberOfLines={1}
      >
        {label}
      </Text>
    </View>
  );
}

function toneColors(theme: ReturnType<typeof useTheme>, tone: BadgeTone) {
  switch (tone) {
    case 'citation':
      return { bg: theme.citationSoft, fg: theme.citation };
    case 'warning':
      return { bg: theme.warningSoft, fg: theme.warning };
    case 'danger':
      return { bg: theme.dangerSoft, fg: theme.danger };
    case 'ok':
      return { bg: theme.warningSoft, fg: theme.ok };
    case 'neutral':
    default:
      return { bg: theme.cardPressed, fg: theme.subtext };
  }
}

const styles = StyleSheet.create({
  badge: { paddingHorizontal: 6, paddingVertical: 2, alignSelf: 'flex-start' },
  text: { fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.3 },
});
