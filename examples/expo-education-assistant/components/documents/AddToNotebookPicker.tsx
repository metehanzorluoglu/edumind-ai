import { useNotebooks } from 'education-assistant-client';
import type { DocumentHighlight, EducationAssistantClient } from 'education-assistant-client';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { CheckIcon, CloseIcon } from '@/components/icons';
import { Button } from '@/components/ui/Button';
import { TextField } from '@/components/ui/TextField';
import { useTheme, type Theme } from '@/lib/Preferences';

export interface AddToNotebookPickerProps {
  client: EducationAssistantClient;
  documentId: string;
  highlight: DocumentHighlight;
  onClose: () => void;
}

/**
 * Frontend Milestone 3.1 — M3.1 Notebook spec §11: "Add to notebook" as
 * an action on a SAVED Highlight (opened from the Highlights panel — see
 * HighlightsPanel), not crowded into the text-selection popover. Shows
 * recent notebooks with a checkmark for ones this highlight is already
 * in (fetched once, on open — never eagerly per-highlight, to avoid an
 * N+1 fetch across the whole panel), plus inline "+ New notebook".
 * Adding is idempotent server-side (see NotebooksRepository.
 * add_highlight_entry) — pressing an already-checked notebook here is a
 * no-op rather than a duplicate.
 */
export function AddToNotebookPicker({
  client,
  documentId,
  highlight,
  onClose,
}: AddToNotebookPickerProps) {
  const theme = useTheme();
  const styles = useMemo(() => buildStyles(theme), [theme]);
  const { notebooksState, refresh, create } = useNotebooks(client);

  const [memberOf, setMemberOf] = useState<Set<string> | null>(null);
  const [addingId, setAddingId] = useState<string | null>(null);
  const [newFormOpen, setNewFormOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    refresh({ limit: 10 });
    client
      .getHighlightNotebookMembership(documentId, highlight.id)
      .then((response) => setMemberOf(new Set(response.notebooks.map((n) => n.id))))
      .catch(() => setMemberOf(new Set()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleAdd(notebookId: string): Promise<void> {
    if (memberOf?.has(notebookId) || addingId) return;
    setAddingId(notebookId);
    setErrorMessage(null);
    try {
      await client.addNotebookEntry(notebookId, {
        entryType: 'highlight',
        documentId,
        highlightId: highlight.id,
      });
      setMemberOf((prev) => new Set(prev).add(notebookId));
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Could not add to notebook.');
    } finally {
      setAddingId(null);
    }
  }

  async function handleCreateAndAdd(): Promise<void> {
    const trimmed = newName.trim();
    if (!trimmed || creating) return;
    setCreating(true);
    setErrorMessage(null);
    try {
      const notebook = await create(trimmed);
      setNewName('');
      setNewFormOpen(false);
      await handleAdd(notebook.id);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Could not create notebook.');
    } finally {
      setCreating(false);
    }
  }

  const notebooks = notebooksState.status === 'success' ? notebooksState.notebooks : [];

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <Pressable
          style={styles.backdrop}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close"
        />
        <View style={styles.sheet}>
          <View style={styles.header}>
            <Text style={styles.title}>Add to notebook</Text>
            <Pressable
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel="Close"
              hitSlop={8}
            >
              <CloseIcon size={16} color={theme.faint} />
            </Pressable>
          </View>
          <Text style={styles.excerpt} numberOfLines={3}>
            “{highlight.selected_text}”
          </Text>

          {notebooksState.status === 'loading' && (
            <ActivityIndicator style={styles.spinner} color={theme.accent} />
          )}
          {errorMessage && <Text style={styles.error}>{errorMessage}</Text>}

          <View style={styles.list}>
            {notebooks.map((notebook) => {
              const isMember = memberOf?.has(notebook.id) ?? false;
              const busy = addingId === notebook.id;
              return (
                <Pressable
                  key={notebook.id}
                  onPress={() => void handleAdd(notebook.id)}
                  disabled={isMember || busy}
                  accessibilityRole="button"
                  accessibilityLabel={
                    isMember ? `Already saved to ${notebook.name}` : `Add to ${notebook.name}`
                  }
                  style={styles.row}
                >
                  <Text style={styles.rowLabel}>{notebook.name}</Text>
                  {busy ? (
                    <ActivityIndicator size="small" color={theme.accent} />
                  ) : isMember ? (
                    // Milestone 5.5 Part 27 — "Added ✓", not just a bare
                    // icon: this picker deliberately stays open after an
                    // add (Part 27: multi-notebook adds in one sitting),
                    // so each row needs to read unambiguously as "already
                    // done" at a glance, not merely "has some icon."
                    <View style={styles.addedBadge}>
                      <Text style={styles.addedBadgeText}>Added</Text>
                      <CheckIcon size={12} color={theme.accent} />
                    </View>
                  ) : null}
                </Pressable>
              );
            })}
          </View>

          {newFormOpen ? (
            <View style={styles.newForm}>
              <TextField
                label="New notebook"
                value={newName}
                onChangeText={setNewName}
                placeholder="e.g. Literature review"
                editable={!creating}
                autoFocus
                onSubmitEditing={() => void handleCreateAndAdd()}
                returnKeyType="done"
              />
              <View style={styles.newFormActions}>
                <Button
                  label="Cancel"
                  variant="ghost"
                  size="sm"
                  onPress={() => setNewFormOpen(false)}
                />
                <Button
                  label="Create & add"
                  variant="primary"
                  size="sm"
                  loading={creating}
                  disabled={!newName.trim()}
                  onPress={() => void handleCreateAndAdd()}
                />
              </View>
            </View>
          ) : (
            <Button
              label="+ New notebook"
              variant="ghost"
              size="sm"
              onPress={() => setNewFormOpen(true)}
            />
          )}

          {/* Milestone 5.5 Part 27 — an explicit, intentional way to
              finish, alongside (never instead of) the existing backdrop/X
              close: this picker deliberately never auto-closes on its own
              after an add, since the whole point is supporting multiple
              notebooks in one sitting (Part 9/10's own docstring). */}
          <Button
            label="Done"
            variant="primary"
            size="sm"
            onPress={onClose}
            style={styles.doneButton}
          />
        </View>
      </View>
    </Modal>
  );
}

function buildStyles(theme: Theme) {
  return StyleSheet.create({
    overlay: {
      ...StyleSheet.absoluteFillObject,
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 50,
    },
    backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: theme.overlay },
    sheet: {
      width: 340,
      maxWidth: '90%',
      backgroundColor: theme.card,
      borderRadius: theme.radius.lg,
      padding: 16,
      gap: 10,
    },
    header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    title: { fontSize: 14, fontFamily: theme.fonts.bodySemibold, color: theme.text },
    excerpt: {
      fontSize: 12.5,
      lineHeight: 18,
      color: theme.subtext,
      fontFamily: theme.fonts.body,
      fontStyle: 'italic',
    },
    spinner: { marginVertical: 8 },
    error: { fontSize: 12, color: theme.danger, fontFamily: theme.fonts.body },
    list: { gap: 2, maxHeight: 220 },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingVertical: 8,
      paddingHorizontal: 6,
      borderRadius: theme.radius.sm,
    },
    rowLabel: { fontSize: 13, fontFamily: theme.fonts.body, color: theme.text },
    addedBadge: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    addedBadgeText: { fontSize: 11.5, fontFamily: theme.fonts.bodySemibold, color: theme.accent },
    newForm: { gap: 8, marginTop: 4 },
    newFormActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8 },
    doneButton: { marginTop: 4, alignSelf: 'flex-end' },
  });
}
