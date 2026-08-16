import { useWritingProjects } from 'education-assistant-client';
import type { WritingProjectSummary } from 'education-assistant-client';
import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { CloseIcon } from '@/components/icons';
import { EmptyState } from '@/components/ui/EmptyState';
import { IconButton } from '@/components/ui/IconButton';
import { Notice } from '@/components/ui/Notice';
import { useClient } from '@/lib/ClientProvider';
import { useTheme, type Theme } from '@/lib/Preferences';

export interface AddToWritingProjectModalProps {
  visible: boolean;
  documentIds: string[];
  onClose: () => void;
}

/**
 * Milestone 5 (Academic Writing & LaTeX Foundation) Part 34 — "Add to
 * writing project": the shared modal used from Documents' multi-select
 * bar, the Reader's action menu, and (indirectly) Notebook's "Use in
 * writing." Cleanly reuses POST /writing-projects/{id}/references — the
 * exact same reference-association API the Writing editor's own
 * "+ Add references" picker calls — rather than a parallel mechanism.
 */
export function AddToWritingProjectModal({
  visible,
  documentIds,
  onClose,
}: AddToWritingProjectModalProps) {
  const theme = useTheme();
  const styles = useMemo(() => buildStyles(theme), [theme]);
  const { client } = useClient();
  const { listState, refresh } = useWritingProjects(client);

  const [addingId, setAddingId] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    setResult(null);
    setError(null);
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  async function handleAdd(project: WritingProjectSummary): Promise<void> {
    if (addingId) return;
    setAddingId(project.id);
    setError(null);
    setResult(null);
    try {
      const response = await client.addWritingProjectReferences(project.id, documentIds);
      const added = response.results.filter((r) => r.outcome === 'added').length;
      const already = response.results.filter((r) => r.outcome === 'already_present').length;
      setResult(
        already > 0
          ? `Added ${added} to "${project.title}" (${already} already there).`
          : `Added ${added} to "${project.title}".`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add to that project.');
    } finally {
      setAddingId(null);
    }
  }

  const projects = listState.status === 'success' ? listState.projects : [];

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <Pressable
          style={styles.backdrop}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close"
        />
        <View style={styles.panel}>
          <View style={styles.header}>
            <Text style={styles.title}>Add to writing project</Text>
            <IconButton
              label="Close"
              icon={<CloseIcon size={16} color={theme.faint} />}
              size="sm"
              onPress={onClose}
            />
          </View>

          {result && <Notice tone="ok" body={result} />}
          {error && <Notice tone="danger" body={error} />}

          <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
            {listState.status === 'loading' && (
              <ActivityIndicator color={theme.accent} style={styles.spinner} />
            )}
            {listState.status === 'error' && (
              <Notice tone="danger" body={listState.error.message} />
            )}
            {listState.status === 'success' && projects.length === 0 && (
              <EmptyState
                title="No writing projects yet."
                description="Create a writing project first, from the Writing tab."
              />
            )}
            {projects.map((project) => (
              <Pressable
                key={project.id}
                onPress={() => void handleAdd(project)}
                disabled={addingId !== null}
                accessibilityRole="button"
                accessibilityLabel={`Add to ${project.title}`}
                style={styles.row}
              >
                <View style={styles.rowBody}>
                  <Text style={styles.rowTitle} numberOfLines={1}>
                    {project.title}
                  </Text>
                  <Text style={styles.rowMeta}>
                    {project.reference_count}{' '}
                    {project.reference_count === 1 ? 'reference' : 'references'}
                  </Text>
                </View>
                {addingId === project.id && <ActivityIndicator size="small" color={theme.accent} />}
              </Pressable>
            ))}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

function buildStyles(theme: Theme) {
  return StyleSheet.create({
    overlay: {
      ...StyleSheet.absoluteFillObject,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 45,
      elevation: 45,
    },
    backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: theme.overlay },
    panel: {
      width: 420,
      maxWidth: '92%',
      maxHeight: '80%',
      backgroundColor: theme.card,
      borderRadius: theme.radius.lg,
      padding: 16,
      gap: 10,
    },
    header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    title: { fontSize: 16, fontFamily: theme.fonts.display, color: theme.text },
    list: { maxHeight: 320 },
    listContent: { gap: 2, paddingVertical: 4 },
    spinner: { marginVertical: 20 },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 8,
      paddingVertical: 10,
      paddingHorizontal: 6,
      borderRadius: theme.radius.sm,
    },
    rowBody: { flex: 1, gap: 1 },
    rowTitle: { fontSize: 13, fontFamily: theme.fonts.bodySemibold, color: theme.text },
    rowMeta: { fontSize: 11, fontFamily: theme.fonts.body, color: theme.faint },
  });
}
