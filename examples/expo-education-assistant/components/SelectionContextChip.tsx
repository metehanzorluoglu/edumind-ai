import { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { CloseIcon } from '@/components/icons';
import { useTheme, type Theme } from '@/lib/Preferences';

export interface PendingSelectionContext {
  documentId: string;
  documentName: string;
  pageNumber: number;
  selectedText: string;
}

export interface SelectionContextChipProps {
  context: PendingSelectionContext;
  onRemove: () => void;
}

/**
 * Frontend Milestone 3 §17 — shows exactly what passage the AI is about
 * to answer about (the reader's "Ask EduM8" hands this off via
 * chat/new.tsx's `selectionContext` param), with the source document and
 * page for orientation, and a Remove control — never silently injected.
 * The full passage still reaches the model (see chat/new.tsx's
 * handleAsk), this is just the honest on-screen preview of it.
 */
export function SelectionContextChip({ context, onRemove }: SelectionContextChipProps) {
  const theme = useTheme();
  const styles = useMemo(() => buildStyles(theme), [theme]);

  return (
    <View style={styles.chip} accessibilityRole="none">
      <View style={styles.textCol}>
        <Text style={styles.label}>
          Selected passage — {context.documentName}
          {context.pageNumber ? `, page ${context.pageNumber}` : ''}
        </Text>
        <Text style={styles.excerpt} numberOfLines={2}>
          “{context.selectedText}”
        </Text>
      </View>
      <Pressable
        onPress={onRemove}
        accessibilityRole="button"
        accessibilityLabel="Remove selected passage from this question"
        hitSlop={8}
        style={styles.removeButton}
      >
        <CloseIcon size={13} color={theme.subtext} />
      </Pressable>
    </View>
  );
}

function buildStyles(theme: Theme) {
  return StyleSheet.create({
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
