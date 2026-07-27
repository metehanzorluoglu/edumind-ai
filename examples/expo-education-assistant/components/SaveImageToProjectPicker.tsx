import { useProjects } from 'education-assistant-client';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useClient } from '@/lib/ClientProvider';
import { describeApiError } from '@/lib/errorDisplay';

export interface SaveImageToProjectPickerProps {
  visible: boolean;
  /** null if this image isn't currently saved to any project. */
  currentProjectId: string | null;
  onClose: () => void;
  /** Called after a successful PATCH /attachments/{id}/project — `projectId` is null when the user picked "Don't save to a project" (un-saving it). */
  onSaved: (projectId: string | null) => Promise<void>;
}

/**
 * Single-select project picker for a generated image's "Save to project"
 * action (see GeneratedImageGallery.tsx) — a simple gallery bookmark
 * (rag-backend's MessageAttachment.saved_project_id), not the
 * many-to-many "which projects is this conversation in" membership
 * AddToProjectPicker.tsx manages, so this is deliberately a separate,
 * simpler component rather than a variant of that one. Uses its own
 * useProjects() instance (a fresh, idempotent GET /projects) rather than
 * sharing chat/_layout.tsx's — that instance lives at the layout level
 * for the sidebar and isn't threaded down to individual chat screens.
 */
export function SaveImageToProjectPicker({
  visible,
  currentProjectId,
  onClose,
  onSaved,
}: SaveImageToProjectPickerProps) {
  const { client, baseUrl } = useClient();
  const projects = useProjects(client);
  const [pendingProjectId, setPendingProjectId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (visible) projects.refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  async function handleSelect(projectId: string | null): Promise<void> {
    setPendingProjectId(projectId ?? '__none__');
    setError(null);
    try {
      await onSaved(projectId);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPendingProjectId(null);
    }
  }

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <Pressable
          style={styles.backdrop}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close save to project dialog"
        />
        <View style={styles.panel}>
          <Text style={styles.title}>Save image to a project</Text>

          {projects.listState.status === 'loading' && <ActivityIndicator style={styles.spinner} />}
          {projects.listState.status === 'error' && (
            <Text style={styles.errorText}>
              {describeApiError('GET', baseUrl, '/projects', projects.listState.error)}
            </Text>
          )}
          {projects.listState.status === 'success' && projects.listState.projects.length === 0 && (
            <Text style={styles.emptyText}>You don&apos;t have any projects yet.</Text>
          )}

          {projects.listState.status === 'success' && (
            <ScrollView style={styles.projectList}>
              <Pressable
                style={styles.projectRow}
                onPress={() => handleSelect(null)}
                disabled={pendingProjectId !== null}
                accessibilityRole="radio"
                accessibilityState={{ checked: currentProjectId === null }}
                accessibilityLabel="Don't save to a project"
              >
                <Text style={styles.radio}>{currentProjectId === null ? '◉' : '◯'}</Text>
                <Text style={styles.projectRowText}>Don&apos;t save to a project</Text>
                {pendingProjectId === '__none__' && <ActivityIndicator size="small" />}
              </Pressable>
              {projects.listState.projects.map((project) => (
                <Pressable
                  key={project.id}
                  style={styles.projectRow}
                  onPress={() => handleSelect(project.id)}
                  disabled={pendingProjectId !== null}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: currentProjectId === project.id }}
                  accessibilityLabel={`Save to ${project.name}`}
                >
                  <Text style={styles.radio}>{currentProjectId === project.id ? '◉' : '◯'}</Text>
                  <Text style={styles.projectRowText} numberOfLines={1}>
                    {project.name}
                  </Text>
                  {pendingProjectId === project.id && <ActivityIndicator size="small" />}
                </Pressable>
              ))}
            </ScrollView>
          )}

          {error && <Text style={styles.errorText}>{error}</Text>}

          <Pressable
            style={styles.doneButton}
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Close"
          >
            <Text style={styles.doneButtonText}>Close</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 30,
    elevation: 30,
  },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(15, 23, 42, 0.5)' },
  panel: {
    width: 320,
    maxHeight: 420,
    backgroundColor: '#1E293B',
    borderRadius: 12,
    padding: 16,
    gap: 8,
  },
  title: { color: '#F8FAFC', fontSize: 14, fontWeight: '700', marginBottom: 4 },
  spinner: { marginVertical: 12 },
  errorText: { color: '#FCA5A5', fontSize: 12 },
  emptyText: { color: '#94A3B8', fontSize: 12 },
  projectList: { maxHeight: 280 },
  projectRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 8,
    minHeight: 36,
  },
  radio: { color: '#93C5FD', fontSize: 14 },
  projectRowText: { color: '#E2E8F0', fontSize: 13, flex: 1 },
  doneButton: {
    marginTop: 8,
    alignSelf: 'flex-end',
    paddingVertical: 8,
    paddingHorizontal: 12,
    minHeight: 36,
    justifyContent: 'center',
  },
  doneButtonText: { color: '#F8FAFC', fontSize: 13, fontWeight: '600' },
});
