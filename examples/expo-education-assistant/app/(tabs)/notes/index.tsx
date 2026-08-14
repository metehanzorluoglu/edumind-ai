import { useNotebooks } from 'education-assistant-client';
import type { Notebook } from 'education-assistant-client';
import { useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Notice } from '@/components/ui/Notice';
import { PageHeader } from '@/components/ui/PageHeader';
import { TextField } from '@/components/ui/TextField';
import { useClient } from '@/lib/ClientProvider';
import { formatLibraryDate } from '@/lib/libraryItems';
import { useTheme, type Theme } from '@/lib/Preferences';

/**
 * Frontend Milestone 3.1 — M3.1 Notebook spec ("Research Notes
 * Workspace"): the Notes home screen. Simple, no analytics — lists the
 * caller's notebooks (name, entry count) with "+ New notebook". Never a
 * folder tree, never tags/backlinks/graph view (explicitly out of scope
 * — see the milestone spec's "NOT building" list).
 */
export default function NotesHomeScreen() {
  const theme = useTheme();
  const styles = useMemo(() => buildStyles(theme), [theme]);
  const router = useRouter();
  const { client } = useClient();
  const { notebooksState, refresh, create } = useNotebooks(client);

  const [formOpen, setFormOpen] = useState(false);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleCreate(): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed || creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      const notebook = await create(trimmed);
      setFormOpen(false);
      setName('');
      router.push(`/notes/${notebook.id}`);
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : 'Could not create notebook.');
    } finally {
      setCreating(false);
    }
  }

  const notebooks: Notebook[] = notebooksState.status === 'success' ? notebooksState.notebooks : [];

  return (
    <View style={styles.container}>
      <PageHeader
        title="Research Notes"
        action={
          <Button
            label="+ New notebook"
            accessibilityLabel="New notebook"
            variant="primary"
            size="sm"
            onPress={() => setFormOpen((prev) => !prev)}
          />
        }
      />

      <ScrollView contentContainerStyle={styles.content}>
        {formOpen && (
          <View style={styles.newForm}>
            <TextField
              label="Notebook name"
              value={name}
              onChangeText={setName}
              placeholder="e.g. Literature review"
              editable={!creating}
              autoFocus
              onSubmitEditing={() => void handleCreate()}
              returnKeyType="done"
            />
            {createError && <Notice tone="danger" body={createError} />}
            <View style={styles.newFormActions}>
              <Button
                label="Cancel"
                variant="ghost"
                size="sm"
                disabled={creating}
                onPress={() => {
                  setFormOpen(false);
                  setName('');
                  setCreateError(null);
                }}
              />
              <Button
                label="Create"
                variant="primary"
                size="sm"
                loading={creating}
                disabled={!name.trim()}
                onPress={() => void handleCreate()}
              />
            </View>
          </View>
        )}

        {notebooksState.status === 'loading' && (
          <ActivityIndicator style={styles.spinner} color={theme.accent} />
        )}
        {notebooksState.status === 'error' && (
          <EmptyState
            title="Couldn't load your notebooks."
            description={notebooksState.error.message}
            actionLabel="Try again"
            onAction={() => refresh()}
          />
        )}
        {notebooksState.status === 'success' && notebooks.length === 0 && !formOpen && (
          <View style={styles.emptyWrap}>
            <EmptyState
              title="No research notes here yet."
              description="Save a highlighted passage from the Document Reader, or create a notebook here, to start building a research record."
              actionLabel="+ New notebook"
              onAction={() => setFormOpen(true)}
            />
          </View>
        )}
        {notebooks.length > 0 && (
          <View style={styles.grid}>
            {notebooks.map((notebook) => (
              <Pressable
                key={notebook.id}
                onPress={() => router.push(`/notes/${notebook.id}`)}
                accessibilityRole="button"
                accessibilityLabel={`Open notebook ${notebook.name}`}
                style={styles.card}
              >
                <Text style={styles.cardTitle} numberOfLines={1}>
                  {notebook.name}
                </Text>
                <Text style={styles.cardMeta}>
                  {notebook.entry_count} {notebook.entry_count === 1 ? 'entry' : 'entries'}
                  {' · '}Updated {formatLibraryDate(notebook.updated_at)}
                </Text>
              </Pressable>
            ))}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

function buildStyles(theme: Theme) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: theme.background },
    // Frontend/Platform Milestone 3.2.1 §B3 — bounded + centered (was
    // unbounded before: a single small 220px card just sat at the
    // top-left of however wide the window happened to be, "floating in a
    // large empty area" — this milestone's report). Same 900 max-width
    // as the Notebook detail page for a consistent Notes section measure.
    content: { padding: 24, gap: 16, maxWidth: 900, width: '100%', alignSelf: 'center' },
    spinner: { marginTop: 40 },
    emptyWrap: { paddingTop: 40 },
    newForm: {
      gap: 10,
      padding: 14,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      borderRadius: theme.radius.md,
      backgroundColor: theme.card,
      maxWidth: 360,
    },
    newFormActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8 },
    // flexBasis (not a fixed width) lets cards actually fill the
    // available row instead of leaving a ragged remainder — roughly 3
    // columns at 900px, 2 at tablet, 1 at mobile widths, without a fixed
    // breakpoint list.
    grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
    card: {
      flexGrow: 1,
      flexBasis: 240,
      maxWidth: 320,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      borderRadius: theme.radius.md,
      backgroundColor: theme.card,
      padding: 16,
      gap: 5,
    },
    cardTitle: { fontSize: 15, fontFamily: theme.fonts.bodySemibold, color: theme.text },
    cardMeta: { fontSize: 12, fontFamily: theme.fonts.body, color: theme.subtext },
  });
}
