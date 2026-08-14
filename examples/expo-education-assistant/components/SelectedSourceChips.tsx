import { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { PendingSourceDoc } from '@/components/ChatSourcesPicker';
import { CloseIcon, FileIcon } from '@/components/icons';
import { useTheme, type Theme } from '@/lib/Preferences';

const MAX_VISIBLE_CHIPS = 2;

export interface SelectedSourceChipsProps {
  sources: PendingSourceDoc[];
  onRemove: (documentId: string) => void;
}

/**
 * Frontend Milestone 2 §8 — a very compact preview of the current
 * selection, immediately above the composer, so the user doesn't have to
 * open the full Sources workspace just to see (or quickly drop) what's
 * selected. Deliberately terse: at most 2 chips plus a "+N" overflow
 * badge, never a wall of chips (see requirement #8's own "do not show 10
 * large chips"). Desktop/wide-web only — see chat/new.tsx and
 * chat/[id].tsx, which only render this above a width breakpoint; on
 * narrow/mobile the Sources button's own count is the sole indicator, so
 * this component never has to solve small-screen wrapping.
 */
export function SelectedSourceChips({ sources, onRemove }: SelectedSourceChipsProps) {
  const theme = useTheme();
  const styles = useMemo(() => buildStyles(theme), [theme]);

  if (sources.length === 0) return null;

  const visible = sources.slice(0, MAX_VISIBLE_CHIPS);
  const overflow = sources.length - visible.length;

  return (
    <View style={styles.row} accessibilityRole="none">
      {visible.map((doc) => (
        <View key={doc.documentId} style={styles.chip}>
          <FileIcon size={12} color={theme.subtext} />
          <Text style={styles.chipText} numberOfLines={1}>
            {doc.displayName}
          </Text>
          <Pressable
            onPress={() => onRemove(doc.documentId)}
            accessibilityRole="button"
            accessibilityLabel={`Remove ${doc.displayName} from selected sources`}
            hitSlop={6}
          >
            <CloseIcon size={11} color={theme.subtext} />
          </Pressable>
        </View>
      ))}
      {overflow > 0 && (
        <View style={styles.overflowChip}>
          <Text style={styles.overflowText}>+{overflow}</Text>
        </View>
      )}
    </View>
  );
}

function buildStyles(theme: Theme) {
  return StyleSheet.create({
    row: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
    chip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 5,
      maxWidth: 160,
      paddingVertical: 4,
      paddingHorizontal: 8,
      borderRadius: theme.radius.pill,
      backgroundColor: theme.cardPressed,
    },
    chipText: { color: theme.text, fontSize: 11.5, fontFamily: theme.fonts.body, flexShrink: 1 },
    overflowChip: {
      paddingVertical: 4,
      paddingHorizontal: 8,
      borderRadius: theme.radius.pill,
      backgroundColor: theme.cardPressed,
    },
    overflowText: { color: theme.subtext, fontSize: 11.5, fontFamily: theme.fonts.bodySemibold },
  });
}
