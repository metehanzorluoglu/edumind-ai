import { useMemo } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { DocumentHighlight, Notebook } from 'education-assistant-client';
import { CloseIcon } from '@/components/icons';
import { IconButton } from '@/components/ui/IconButton';
import { EmptyState } from '@/components/ui/EmptyState';
import { useTheme, type Theme } from '@/lib/Preferences';

export interface HighlightsPanelProps {
  highlights: DocumentHighlight[];
  loading: boolean;
  onClose?: () => void;
  onGoTo: (highlight: DocumentHighlight) => void;
  onEditNote: (highlight: DocumentHighlight) => void;
  onDelete: (highlight: DocumentHighlight) => void;
  deletingIds: ReadonlySet<string>;
  /** Frontend Milestone 3.1 — M3.1 Notebook spec §11: "Add to notebook" as
   * an action on the saved Highlight (preferred placement over crowding
   * the selection popover). Optional so this panel keeps working
   * unchanged anywhere Notebook isn't wired up. */
  onAddToNotebook?: (highlight: DocumentHighlight) => void;
  /** Frontend Milestone 3.2 §22 — "Saved to: <notebook>" per highlight.
   * Optional and additive: a highlight missing from the map (still
   * loading, or genuinely in zero notebooks) simply shows nothing here —
   * this is a quiet enhancement, never a loading spinner blocking the
   * list. */
  notebookMembership?: ReadonlyMap<string, Notebook[]>;
}

/**
 * Frontend Milestone 3 §20 — the annotation panel: excerpt, optional
 * note, page, and Go to/Edit note/Delete actions, kept minimal (no
 * folders/tags/dates beyond what's asked for). Desktop renders this as a
 * permanent right-side panel (see [id].tsx); mobile renders the exact
 * same component inside a full-screen Modal sheet instead — one
 * component, two containers, never two different implementations of the
 * same list.
 */
function describeMembership(notebooks: readonly Notebook[]): string {
  const first = notebooks[0];
  return notebooks.length === 1 && first ? first.name : `${notebooks.length} notebooks`;
}

export function HighlightsPanel({
  highlights,
  loading,
  onClose,
  onGoTo,
  onEditNote,
  onDelete,
  deletingIds,
  onAddToNotebook,
  notebookMembership,
}: HighlightsPanelProps) {
  const theme = useTheme();
  const styles = useMemo(() => buildStyles(theme), [theme]);

  return (
    <View style={styles.panel}>
      <View style={styles.header}>
        <Text style={styles.title}>Highlights ({highlights.length})</Text>
        {onClose && (
          <IconButton
            label="Close highlights panel"
            icon={<CloseIcon size={14} color={theme.subtext} />}
            size="sm"
            onPress={onClose}
          />
        )}
      </View>
      {loading && highlights.length === 0 ? (
        <ActivityIndicator style={styles.spinner} color={theme.accent} />
      ) : highlights.length === 0 ? (
        <EmptyState
          title="No highlights yet."
          description="Select text in the document and choose Highlight or Add note to save a passage here."
        />
      ) : (
        <ScrollView contentContainerStyle={styles.list}>
          {highlights.map((h) => {
            const deleting = deletingIds.has(h.id);
            const savedTo = notebookMembership?.get(h.id);
            return (
              <View key={h.id} style={styles.card}>
                <Pressable
                  onPress={() => onGoTo(h)}
                  accessibilityRole="button"
                  accessibilityLabel={`Go to highlighted passage on page ${h.page_number}: ${h.selected_text}`}
                >
                  <Text style={styles.pageLabel}>Page {h.page_number}</Text>
                  <Text style={styles.excerpt} numberOfLines={4}>
                    “{h.selected_text}”
                  </Text>
                  {h.note_text ? <Text style={styles.note}>{h.note_text}</Text> : null}
                </Pressable>
                {savedTo && savedTo.length > 0 && (
                  <Text
                    style={styles.savedTo}
                    accessibilityLabel={`Saved to ${describeMembership(savedTo)}`}
                  >
                    Saved to: {describeMembership(savedTo)}
                  </Text>
                )}
                <View style={styles.actionsRow}>
                  <Pressable
                    onPress={() => onEditNote(h)}
                    accessibilityRole="button"
                    accessibilityLabel={
                      h.note_text
                        ? `Edit note for highlight on page ${h.page_number}`
                        : `Add note for highlight on page ${h.page_number}`
                    }
                    hitSlop={6}
                  >
                    <Text style={styles.actionText}>{h.note_text ? 'Edit note' : 'Add note'}</Text>
                  </Pressable>
                  {onAddToNotebook && (
                    <Pressable
                      onPress={() => onAddToNotebook(h)}
                      accessibilityRole="button"
                      accessibilityLabel={`Add highlight on page ${h.page_number} to a notebook`}
                      hitSlop={6}
                    >
                      <Text style={styles.actionText}>Add to notebook</Text>
                    </Pressable>
                  )}
                  {deleting ? (
                    <ActivityIndicator size="small" color={theme.faint} />
                  ) : (
                    <Pressable
                      onPress={() => onDelete(h)}
                      accessibilityRole="button"
                      accessibilityLabel={`Delete highlight on page ${h.page_number}`}
                      hitSlop={6}
                    >
                      <Text style={[styles.actionText, styles.deleteText]}>Delete</Text>
                    </Pressable>
                  )}
                </View>
              </View>
            );
          })}
        </ScrollView>
      )}
    </View>
  );
}

function buildStyles(theme: Theme) {
  return StyleSheet.create({
    panel: { flex: 1, gap: 10 },
    header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    title: { fontSize: 13, fontFamily: theme.fonts.bodySemibold, color: theme.text },
    spinner: { marginTop: 24 },
    list: { gap: 10, paddingBottom: 12 },
    card: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      borderRadius: theme.radius.md,
      padding: 10,
      gap: 6,
      backgroundColor: theme.card,
    },
    pageLabel: {
      fontSize: 10,
      fontFamily: theme.fonts.bodySemibold,
      color: theme.faint,
      textTransform: 'uppercase',
      letterSpacing: 0.3,
    },
    excerpt: { fontSize: 13, lineHeight: 19, color: theme.text, fontFamily: theme.fonts.body },
    note: {
      fontSize: 12,
      color: theme.subtext,
      fontFamily: theme.fonts.body,
      fontStyle: 'italic',
      marginTop: 2,
    },
    savedTo: {
      fontSize: 10.5,
      color: theme.faint,
      fontFamily: theme.fonts.body,
      marginTop: 4,
    },
    actionsRow: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
      gap: 16,
      marginTop: 2,
    },
    actionText: { fontSize: 12, fontFamily: theme.fonts.bodySemibold, color: theme.accent },
    deleteText: { color: theme.danger },
  });
}
