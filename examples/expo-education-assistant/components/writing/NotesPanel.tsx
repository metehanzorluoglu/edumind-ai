import { useNotebookEntries, useNotebooks } from 'education-assistant-client';
import type { NotebookEntry } from 'education-assistant-client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { ChevronIcon } from '@/components/icons';
import { ActionSheet, type ActionSheetItem } from '@/components/ui/ActionSheet';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Notice } from '@/components/ui/Notice';
import { TextField } from '@/components/ui/TextField';
import { useClient } from '@/lib/ClientProvider';
import { formatSourceIdentity } from '@/lib/format';
import { useTheme, type Theme } from '@/lib/Preferences';

export interface NotesPanelProps {
  /** Inserts the user's own note text verbatim at the editor's cursor —
   * never the source excerpt as if it were authored prose (Part 15). */
  onInsertNote: (noteText: string) => void;
  /** Resolves the entry's source document's stable citation key and
   * inserts `\cite{key}` — never fabricates a key (Part 17). */
  onInsertCitationForDocument: (documentId: string) => Promise<void>;
  onOpenSource: (entry: NotebookEntry) => void;
}

/**
 * Milestone 5 (Academic Writing & LaTeX Foundation) Parts 14-18 —
 * Supporting Material panel, Research Notes tab: browse/search one
 * notebook's entries, with Insert note / Insert citation / Open source
 * per entry. Reuses the exact M3.1 Notebook backend unchanged — this is
 * a new consumer of it, not a rebuild (see notes/[id].tsx for the
 * precedent this borrows its row shape from).
 */
export function NotesPanel({
  onInsertNote,
  onInsertCitationForDocument,
  onOpenSource,
}: NotesPanelProps) {
  const theme = useTheme();
  const styles = useMemo(() => buildStyles(theme), [theme]);
  const { client } = useClient();
  const { notebooksState, refresh: refreshNotebooks } = useNotebooks(client);
  const { entriesState, refresh: refreshEntries } = useNotebookEntries(client);

  const [notebookId, setNotebookId] = useState<string | null>(null);
  const [notebookMenuOpen, setNotebookMenuOpen] = useState(false);
  const notebookButtonRef = useRef<View>(null);
  const [filterText, setFilterText] = useState('');
  const [citingId, setCitingId] = useState<string | null>(null);
  const [citeError, setCiteError] = useState<string | null>(null);

  useEffect(() => {
    refreshNotebooks();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const notebooks = notebooksState.status === 'success' ? notebooksState.notebooks : [];

  useEffect(() => {
    if (notebookId === null && notebooks.length > 0) setNotebookId(notebooks[0]!.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notebooks.length]);

  useEffect(() => {
    if (notebookId) refreshEntries(notebookId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notebookId]);

  async function handleInsertCitation(entry: NotebookEntry): Promise<void> {
    if (!entry.document_id || citingId) return;
    setCitingId(entry.id);
    setCiteError(null);
    try {
      await onInsertCitationForDocument(entry.document_id);
    } catch (error) {
      setCiteError(error instanceof Error ? error.message : 'Could not resolve a citation key.');
    } finally {
      setCitingId(null);
    }
  }

  const visibleEntries = useMemo(() => {
    const entries = entriesState.status === 'success' ? entriesState.entries : [];
    const needle = filterText.trim().toLowerCase();
    if (!needle) return entries;
    return entries.filter((e) => {
      const haystack = [e.excerpt, e.note_text, e.document_title, ...(e.document_authors ?? [])]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(needle);
    });
  }, [entriesState, filterText]);

  const activeNotebook = notebooks.find((n) => n.id === notebookId) ?? null;
  const notebookMenuItems: ActionSheetItem[] = notebooks.map((nb) => ({
    key: nb.id,
    label: nb.name,
    selected: nb.id === notebookId,
    onPress: () => {
      setNotebookId(nb.id);
      setNotebookMenuOpen(false);
    },
  }));

  if (notebooksState.status === 'loading') {
    return <ActivityIndicator color={theme.accent} style={styles.spinner} />;
  }
  if (notebooksState.status === 'error') {
    return <Notice tone="danger" body={notebooksState.error.message} />;
  }
  if (notebooks.length === 0) {
    return (
      <EmptyState
        title="No research notes yet."
        description="Save highlights or notes from the Reader/Research Notes workspace to use them here."
      />
    );
  }

  return (
    <View style={styles.container}>
      <View ref={notebookButtonRef}>
        <Button
          label={`Notebook: ${activeNotebook?.name ?? '…'}`}
          variant="secondary"
          size="sm"
          onPress={() => setNotebookMenuOpen(true)}
          icon={<ChevronIcon size={12} color={theme.subtext} />}
        />
      </View>

      <TextField
        label="Filter this notebook"
        value={filterText}
        onChangeText={setFilterText}
        placeholder="Search excerpt, note, or source…"
      />

      {citeError && <Notice tone="danger" body={citeError} />}

      <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
        {entriesState.status === 'loading' && (
          <ActivityIndicator color={theme.accent} style={styles.spinner} />
        )}
        {entriesState.status === 'error' && (
          <Notice tone="danger" body={entriesState.error.message} />
        )}
        {entriesState.status === 'success' && visibleEntries.length === 0 && (
          <Text style={styles.emptyText}>No entries match.</Text>
        )}
        {visibleEntries.map((entry) => {
          const isManual = entry.entry_type === 'manual';
          const noteText = isManual ? entry.note_text : entry.note_text;
          return (
            <View key={entry.id} style={styles.row}>
              <Text style={styles.rowSource} numberOfLines={1}>
                {isManual
                  ? 'My note'
                  : formatSourceIdentity(
                      entry.document_authors,
                      entry.document_publication_year,
                      entry.document_title
                    )}
              </Text>
              {!isManual && (
                <Text style={styles.excerpt} numberOfLines={2}>
                  “{entry.excerpt}”
                </Text>
              )}
              {noteText && (
                <Text style={styles.note} numberOfLines={2}>
                  {noteText}
                </Text>
              )}
              <View style={styles.actionsRow}>
                <Pressable
                  onPress={() => noteText && onInsertNote(noteText)}
                  disabled={!noteText}
                  accessibilityRole="button"
                  accessibilityLabel={`Insert note from entry ${entry.id}`}
                  hitSlop={6}
                >
                  <Text style={noteText ? styles.actionText : styles.actionTextDisabled}>
                    Insert note
                  </Text>
                </Pressable>
                {!isManual && (
                  <Pressable
                    onPress={() => void handleInsertCitation(entry)}
                    disabled={
                      !entry.document_id || !entry.source_available || citingId === entry.id
                    }
                    accessibilityRole="button"
                    accessibilityLabel={`Insert citation for entry ${entry.id}`}
                    hitSlop={6}
                  >
                    <Text
                      style={
                        entry.document_id && entry.source_available
                          ? styles.actionText
                          : styles.actionTextDisabled
                      }
                    >
                      {citingId === entry.id ? 'Inserting…' : 'Insert citation'}
                    </Text>
                  </Pressable>
                )}
                {!isManual && entry.source_available && (
                  <Pressable
                    onPress={() => onOpenSource(entry)}
                    accessibilityRole="button"
                    accessibilityLabel={`Open source for entry ${entry.id}`}
                    hitSlop={6}
                  >
                    <Text style={styles.actionText}>Open source</Text>
                  </Pressable>
                )}
                {!isManual && !entry.source_available && (
                  <Text style={styles.actionTextDisabled}>Source unavailable</Text>
                )}
              </View>
            </View>
          );
        })}
      </ScrollView>

      <ActionSheet
        visible={notebookMenuOpen}
        title="Notebook"
        items={notebookMenuItems}
        onDismiss={() => setNotebookMenuOpen(false)}
        anchorRef={notebookButtonRef}
      />
    </View>
  );
}

function buildStyles(theme: Theme) {
  return StyleSheet.create({
    container: { flex: 1, gap: 10 },
    spinner: { marginTop: 20 },
    list: { flex: 1 },
    listContent: { gap: 4, paddingBottom: 12 },
    emptyText: {
      fontSize: 13,
      color: theme.subtext,
      fontFamily: theme.fonts.body,
      paddingVertical: 20,
      textAlign: 'center',
    },
    row: {
      gap: 4,
      paddingVertical: 10,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.border,
    },
    rowSource: { fontSize: 11, fontFamily: theme.fonts.bodySemibold, color: theme.faint },
    excerpt: {
      fontSize: 12.5,
      lineHeight: 18,
      color: theme.text,
      fontFamily: theme.fonts.body,
      fontStyle: 'italic',
    },
    note: { fontSize: 12.5, lineHeight: 18, color: theme.text, fontFamily: theme.fonts.body },
    actionsRow: { flexDirection: 'row', gap: 14, marginTop: 2 },
    actionText: { fontSize: 12, fontFamily: theme.fonts.bodySemibold, color: theme.accent },
    actionTextDisabled: { fontSize: 12, fontFamily: theme.fonts.body, color: theme.faint },
  });
}
