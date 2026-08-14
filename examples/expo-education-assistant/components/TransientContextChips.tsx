import { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { CloseIcon } from '@/components/icons';
import { useTheme, type Theme } from '@/lib/Preferences';
import type { TransientAIContextEntry } from '@/lib/transientAIContext';

export interface TransientContextChipsProps {
  entries: TransientAIContextEntry[];
  onRemove: (index: number) => void;
}

/**
 * Frontend Milestone 3.1 (M3.1 Notebook spec §18) — renders the Notebook's
 * multi-select "Ask EduM8" context as one distinct chip per entry
 * ("Evidence 1", "Evidence 2", ...), each individually removable, never
 * merged into a single block. The Reader's single-selection flow keeps
 * using SelectionContextChip unchanged (see chat/new.tsx) — this
 * component is only mounted for the (rarer) 2+-entry case.
 */
export function TransientContextChips({ entries, onRemove }: TransientContextChipsProps) {
  const theme = useTheme();
  const styles = useMemo(() => buildStyles(theme), [theme]);

  if (entries.length === 0) return null;

  return (
    <View style={styles.list}>
      {/* Frontend Milestone 3.2 §17 — a small heading names this block
          "Research context," never "attachments": these are Notebook
          excerpts/notes the user explicitly selected to ask about, not
          uploaded files. */}
      <Text style={styles.heading}>Research context</Text>
      {entries.map((entry, index) => (
        <View key={`${entry.documentId}-${index}`} style={styles.chip} accessibilityRole="none">
          <View style={styles.textCol}>
            <Text style={styles.label}>
              Evidence {index + 1} — {entry.documentTitle ?? 'Unknown source'}
              {entry.pageNumber ? `, page ${entry.pageNumber}` : ''}
            </Text>
            <Text style={styles.excerpt} numberOfLines={2}>
              “{entry.excerpt}”
            </Text>
          </View>
          <Pressable
            onPress={() => onRemove(index)}
            accessibilityRole="button"
            accessibilityLabel={`Remove evidence ${index + 1} from this question`}
            hitSlop={8}
            style={styles.removeButton}
          >
            <CloseIcon size={13} color={theme.subtext} />
          </Pressable>
        </View>
      ))}
    </View>
  );
}

function buildStyles(theme: Theme) {
  return StyleSheet.create({
    list: { gap: 6 },
    heading: {
      fontSize: 10.5,
      fontFamily: theme.fonts.bodySemibold,
      color: theme.faint,
      textTransform: 'uppercase',
      letterSpacing: 0.4,
    },
    chip: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: 8,
      backgroundColor: theme.accentSoft,
      borderRadius: theme.radius.md,
      paddingVertical: 8,
      paddingHorizontal: 10,
    },
    textCol: { flex: 1, gap: 2 },
    label: {
      fontSize: 10.5,
      fontFamily: theme.fonts.bodySemibold,
      color: theme.accent,
      textTransform: 'uppercase',
      letterSpacing: 0.3,
    },
    excerpt: {
      fontSize: 12.5,
      lineHeight: 17,
      color: theme.text,
      fontFamily: theme.fonts.body,
      fontStyle: 'italic',
    },
    removeButton: { paddingTop: 2 },
  });
}
