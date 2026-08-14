import { StyleSheet, Text, View } from 'react-native';
import { EduM8Symbol } from '@/components/EduM8Logo';
import { useTheme } from '@/lib/Preferences';
import { Button } from './Button';

export interface EmptyStateProps {
  title: string;
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
  /** Shows the action button's spinner and blocks presses while a
   * follow-up load (e.g. a dev sample upload) is in flight. */
  actionLoading?: boolean;
  /** Frontend Milestone 3.2 — an optional second, lower-emphasis action
   * (e.g. empty Notebook's "Add note" + "Browse Documents" — M3.2 spec
   * §11). Every other empty state keeps its single action untouched;
   * this is additive only. */
  secondaryActionLabel?: string;
  onSecondaryAction?: () => void;
  /** Swaps the brand symbol for a different glyph — an error state
   * showing the symbol would misread as "this is normal," so error
   * empty-states pass their own icon (or none). */
  icon?: React.ReactNode;
}

/**
 * One consistent empty state for every list that can legitimately be
 * empty (no conversations, no documents, no projects, no search
 * results). Deliberately plain — brand/BRAND_GUIDELINES.md's own rule
 * for the symbol applies here too: it's evidence-and-search branding,
 * not a mascot, so it sits quietly rather than trying to be cute about
 * having nothing to show yet.
 */
export function EmptyState({
  title,
  description,
  actionLabel,
  onAction,
  actionLoading = false,
  icon,
  secondaryActionLabel,
  onSecondaryAction,
}: EmptyStateProps) {
  const theme = useTheme();
  return (
    <View style={styles.container}>
      {icon ?? <EduM8Symbol size={32} style={styles.icon} />}
      <Text
        style={[
          styles.title,
          { color: theme.text, fontFamily: theme.fonts.bodySemibold, fontSize: theme.scale(16) },
        ]}
      >
        {title}
      </Text>
      {description ? (
        <Text
          style={[
            styles.description,
            { color: theme.subtext, fontFamily: theme.fonts.body, fontSize: theme.scale(14) },
          ]}
        >
          {description}
        </Text>
      ) : null}
      {actionLabel && onAction ? (
        <View style={styles.actionsRow}>
          <Button
            label={actionLabel}
            onPress={onAction}
            loading={actionLoading}
            variant="secondary"
            size="sm"
            style={styles.action}
          />
          {secondaryActionLabel && onSecondaryAction ? (
            <Button
              label={secondaryActionLabel}
              onPress={onSecondaryAction}
              variant="ghost"
              size="sm"
              style={styles.action}
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { alignItems: 'center', justifyContent: 'center', padding: 32, gap: 8 },
  icon: { marginBottom: 4, opacity: 0.5 },
  title: { textAlign: 'center' },
  description: { textAlign: 'center', lineHeight: 20, maxWidth: 320 },
  actionsRow: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 8 },
  action: { marginTop: 8 },
});
