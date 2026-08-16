import { useNotebookEntries, useNotebooks } from 'education-assistant-client';
import type { NotebookEntry } from 'education-assistant-client';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { ChevronIcon, CloseIcon } from '@/components/icons';
import { ActionSheet, type ActionSheetItem } from '@/components/ui/ActionSheet';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { IconButton } from '@/components/ui/IconButton';
import { Notice } from '@/components/ui/Notice';
import { useClient } from '@/lib/ClientProvider';
import { formatSourceIdentity } from '@/lib/format';
import { useTheme, type Theme } from '@/lib/Preferences';
import { MAX_TRANSIENT_AI_CONTEXT_ENTRIES } from '@/lib/transientAIContext';

export interface ResearchNotesPickerModalProps {
  visible: boolean;
  onUse: (entries: NotebookEntry[]) => void;
  onClose: () => void;
}

/**
 * Milestone 5.2 Part 4C — explicit multi-select of Notebook entries to use
 * as Ask EduM8's "Research Notes" scope: "Notebook entries as explicit
 * context, never silently inject all entries." Structurally mirrors
 * ReferencePickerModal (search/filter, checkbox rows, one confirm
 * button) and notes/[id].tsx's own multi-select mechanics (same
 * MAX_TRANSIENT_AI_CONTEXT_ENTRIES cap), applied to Notebook entries
 * instead of library documents — reusing the SAME useNotebooks/
 * useNotebookEntries hooks NotesPanel already uses in this Writing
 * screen (Part 1: "DO NOT create another RAG system"/second data path).
 */
export function ResearchNotesPickerModal({
  visible,
  onUse,
  onClose,
}: ResearchNotesPickerModalProps) {
  const theme = useTheme();
  const styles = useMemo(() => buildStyles(theme), [theme]);
  const { client } = useClient();
  const { notebooksState, refresh: refreshNotebooks } = useNotebooks(client);
  const { entriesState, refresh: refreshEntries } = useNotebookEntries(client);

  const [notebookId, setNotebookId] = useState<string | null>(null);
  const [notebookMenuOpen, setNotebookMenuOpen] = useState(false);
  const notebookButtonRef = useRef<View>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    setSelectedIds(new Set());
    setNotice(null);
    refreshNotebooks();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const notebooks = notebooksState.status === 'success' ? notebooksState.notebooks : [];

  useEffect(() => {
    if (visible && notebookId === null && notebooks.length > 0) setNotebookId(notebooks[0]!.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, notebooks.length]);

  useEffect(() => {
    if (visible && notebookId) refreshEntries(notebookId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, notebookId]);

  function toggleSelected(entryId: string): void {
    setNotice(null);
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(entryId)) {
        next.delete(entryId);
        return next;
      }
      if (next.size >= MAX_TRANSIENT_AI_CONTEXT_ENTRIES) {
        setNotice(`You can use up to ${MAX_TRANSIENT_AI_CONTEXT_ENTRIES} notes at once.`);
        return prev;
      }
      next.add(entryId);
      return next;
    });
  }

  const entries = entriesState.status === 'success' ? entriesState.entries : [];
  const activeNotebook = notebooks.find((n) => n.id === notebookId) ?? null;
  const notebookMenuItems: ActionSheetItem[] = notebooks.map((nb) => ({
    key: nb.id,
    label: nb.name,
    selected: nb.id === notebookId,
    onPress: () => {
      setNotebookId(nb.id);
      setNotebookMenuOpen(false);
      setSelectedIds(new Set());
    },
  }));

  function handleUse(): void {
    if (selectedIds.size === 0) return;
    const chosen = entries.filter((e) => selectedIds.has(e.id));
    onUse(chosen);
    onClose();
  }

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <Pressable
          style={styles.backdrop}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close research notes picker"
        />
        <View style={styles.panel}>
          <View style={styles.header}>
            <Text style={styles.title}>Select research notes</Text>
            <IconButton
              label="Close"
              icon={<CloseIcon size={16} color={theme.faint} />}
              size="sm"
              onPress={onClose}
            />
          </View>

          {notebooksState.status === 'loading' && (
            <ActivityIndicator color={theme.accent} style={styles.spinner} />
          )}
          {notebooksState.status === 'error' && (
            <Notice tone="danger" body={notebooksState.error.message} />
          )}
          {notebooksState.status === 'success' && notebooks.length === 0 && (
            <EmptyState
              title="No research notes yet."
              description="Save highlights or notes from the Reader/Research Notes workspace to use them here."
            />
          )}

          {notebooks.length > 0 && (
            <>
              <View ref={notebookButtonRef}>
                <Button
                  label={`Notebook: ${activeNotebook?.name ?? '…'}`}
                  variant="secondary"
                  size="sm"
                  onPress={() => setNotebookMenuOpen(true)}
                  icon={<ChevronIcon size={12} color={theme.subtext} />}
                />
              </View>

              {notice && <Notice tone="warning" body={notice} />}

              <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
                {entriesState.status === 'loading' && (
                  <ActivityIndicator color={theme.accent} style={styles.spinner} />
                )}
                {entriesState.status === 'error' && (
                  <Notice tone="danger" body={entriesState.error.message} />
                )}
                {entriesState.status === 'success' && entries.length === 0 && (
                  <Text style={styles.emptyText}>This notebook has no entries yet.</Text>
                )}
                {entries.map((entry) => {
                  const selected = selectedIds.has(entry.id);
                  const isManual = entry.entry_type === 'manual';
                  const label = isManual
                    ? 'My note'
                    : formatSourceIdentity(
                        entry.document_authors,
                        entry.document_publication_year,
                        entry.document_title
                      );
                  const preview = isManual ? entry.note_text : entry.excerpt;
                  return (
                    <Pressable
                      key={entry.id}
                      onPress={() => toggleSelected(entry.id)}
                      accessibilityRole="checkbox"
                      accessibilityState={{ checked: selected }}
                      accessibilityLabel={`Select note: ${label}`}
                      style={[styles.row, selected && styles.rowSelected]}
                    >
                      <View style={[styles.checkbox, selected && styles.checkboxActive]} />
                      <View style={styles.rowBody}>
                        <Text style={styles.rowSource} numberOfLines={1}>
                          {label}
                        </Text>
                        {preview && (
                          <Text style={styles.rowPreview} numberOfLines={2}>
                            “{preview}”
                          </Text>
                        )}
                      </View>
                    </Pressable>
                  );
                })}
              </ScrollView>
            </>
          )}

          <View style={styles.actions}>
            <Text style={styles.selectionCount}>{selectedIds.size} selected</Text>
            <Button
              label={selectedIds.size > 1 ? `Use ${selectedIds.size} notes` : 'Use this note'}
              variant="primary"
              size="sm"
              disabled={selectedIds.size === 0}
              onPress={handleUse}
            />
          </View>
        </View>
      </View>

      <ActionSheet
        visible={notebookMenuOpen}
        title="Notebook"
        items={notebookMenuItems}
        onDismiss={() => setNotebookMenuOpen(false)}
        anchorRef={notebookButtonRef}
      />
    </Modal>
  );
}

function buildStyles(theme: Theme) {
  return StyleSheet.create({
    overlay: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: theme.overlay,
      alignItems: 'center',
      justifyContent: 'center',
    },
    backdrop: { ...StyleSheet.absoluteFillObject },
    panel: {
      width: 480,
      maxWidth: '92%',
      maxHeight: '82%',
      backgroundColor: theme.card,
      borderRadius: theme.radius.lg,
      padding: 20,
      gap: 12,
    },
    header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    title: { fontSize: 16, fontFamily: theme.fonts.display, color: theme.text },
    spinner: { marginVertical: 20 },
    list: { maxHeight: 360 },
    listContent: { gap: 4 },
    emptyText: {
      fontSize: 13,
      color: theme.faint,
      fontFamily: theme.fonts.body,
      paddingVertical: 20,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: 10,
      paddingVertical: 10,
      paddingHorizontal: 8,
      borderRadius: theme.radius.sm,
    },
    rowSelected: { backgroundColor: theme.accentSoft },
    checkbox: {
      width: 16,
      height: 16,
      borderRadius: 4,
      borderWidth: 1.5,
      borderColor: theme.border,
      marginTop: 2,
    },
    checkboxActive: { backgroundColor: theme.accent, borderColor: theme.accent },
    rowBody: { flex: 1, gap: 2 },
    rowSource: { fontSize: 13, fontFamily: theme.fonts.bodySemibold, color: theme.text },
    rowPreview: {
      fontSize: 12.5,
      lineHeight: 17,
      color: theme.subtext,
      fontFamily: theme.fonts.body,
      fontStyle: 'italic',
    },
    actions: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingTop: 4,
    },
    selectionCount: { fontSize: 12, color: theme.faint, fontFamily: theme.fonts.body },
  });
}
