import { EducationAssistantError, type UseProjectsResult } from 'education-assistant-client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { ProjectRow } from '@/components/ProjectRow';
import { useAuth } from '@/lib/AuthProvider';
import { useClient } from '@/lib/ClientProvider';
import { describeApiError } from '@/lib/errorDisplay';
import { DARK_PALETTE, useTheme, type Theme } from '@/lib/Preferences';
import { loadExpandedProjectIds, saveExpandedProjectIds } from '@/lib/projectsStorage';

// Always-dark — this section only ever renders inside the sidebar (see
// ConversationSidebar's docs for why that rail ignores the app's own
// light/dark theme preference).
const dark = DARK_PALETTE;

const MAX_PROJECT_NAME_LENGTH = 80;

export interface ProjectsSectionProps {
  projects: UseProjectsResult;
  activeConversationId: string | null;
  onSelectConversation: (id: string) => void;
  onAddToProject: (conversationId: string, title: string, restoreFocus: () => void) => void;
  onRenameConversation: (id: string, title: string) => void | Promise<unknown>;
  onDeleteConversation: (id: string) => void;
  deletingConversationIds: ReadonlySet<string>;
}

/**
 * The sidebar's Projects section: heading, "+ New project" form, and one
 * ProjectRow per project — rendered above the normal date-grouped
 * conversation history (see ConversationSidebar.tsx). Expand/collapse
 * state is restored from local storage on mount and persisted back on
 * every change (see lib/projectsStorage.ts), so re-opening the app
 * doesn't silently collapse everything the user had open.
 */
export function ProjectsSection({
  projects,
  activeConversationId,
  onSelectConversation,
  onAddToProject,
  onRenameConversation,
  onDeleteConversation,
  deletingConversationIds,
}: ProjectsSectionProps) {
  const theme = useTheme();
  const styles = useMemo(() => buildStyles(theme), [theme]);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const hasRestoredExpansionRef = useRef(false);
  const { status: authStatus, accessToken } = useAuth();
  const { baseUrl } = useClient();

  // Guards against the exact race this section is prone to otherwise:
  // mounting (it only ever does, under app/(tabs)/chat/_layout.tsx, once
  // the (tabs) route group's own auth gate has already resolved — see
  // app/(tabs)/_layout.tsx — but that gate checks `status` alone; this
  // also requires a non-null accessToken in the same render, so a token
  // that's momentarily null during a background refresh/logout-login
  // cycle can't still slip a request out with no Authorization header.
  // Re-fires (not just fires once) whenever authReady flips true, so a
  // request that couldn't have carried a token yet is always retried
  // once one becomes available, rather than failing once and never
  // trying again.
  const authReady = authStatus === 'authenticated' && accessToken != null;

  useEffect(() => {
    if (!authReady) return;
    projects.refresh();
    loadExpandedProjectIds().then((ids) => {
      hasRestoredExpansionRef.current = true;
      setExpandedIds(ids);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authReady]);

  function toggleExpand(projectId: string): void {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) {
        next.delete(projectId);
      } else {
        next.add(projectId);
      }
      saveExpandedProjectIds(next);
      return next;
    });
  }

  async function handleCreate(): Promise<void> {
    const trimmed = newProjectName.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    setCreateError(null);
    try {
      const project = await projects.createProject({ name: trimmed });
      setNewProjectName('');
      setCreating(false);
      // Auto-expand a freshly created project — the user just made it and
      // almost certainly wants to see (and start adding to) it right away.
      setExpandedIds((prev) => {
        const next = new Set(prev);
        next.add(project.id);
        saveExpandedProjectIds(next);
        return next;
      });
    } catch (error) {
      setCreateError(
        error instanceof EducationAssistantError
          ? describeApiError('POST', baseUrl, '/projects', error)
          : error instanceof Error
            ? error.message
            : String(error)
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <View style={styles.container}>
      <View style={styles.headingRow}>
        <Text style={styles.heading}>Projects</Text>
      </View>

      {!creating ? (
        <Pressable
          style={styles.newProjectButton}
          onPress={() => setCreating(true)}
          accessibilityRole="button"
          accessibilityLabel="Create new project"
        >
          <Text style={styles.newProjectButtonText}>+ New project</Text>
        </Pressable>
      ) : (
        <View style={styles.newProjectForm}>
          <TextInput
            style={styles.newProjectInput}
            value={newProjectName}
            onChangeText={setNewProjectName}
            placeholder="Project name"
            placeholderTextColor={dark.faint}
            maxLength={MAX_PROJECT_NAME_LENGTH}
            autoFocus
            editable={!submitting}
            onSubmitEditing={handleCreate}
            returnKeyType="done"
            accessibilityLabel="New project name"
          />
          {createError && <Text style={styles.errorText}>{createError}</Text>}
          <View style={styles.newProjectActions}>
            <Pressable
              onPress={() => {
                setCreating(false);
                setNewProjectName('');
                setCreateError(null);
              }}
              disabled={submitting}
              accessibilityRole="button"
            >
              <Text style={styles.cancelText}>Cancel</Text>
            </Pressable>
            <Pressable
              onPress={handleCreate}
              disabled={submitting || !newProjectName.trim()}
              accessibilityRole="button"
              accessibilityLabel="Create project"
            >
              {submitting ? (
                <ActivityIndicator size="small" color={dark.accent} />
              ) : (
                <Text style={styles.createText}>Create</Text>
              )}
            </Pressable>
          </View>
        </View>
      )}

      {projects.listState.status === 'loading' && (
        <ActivityIndicator size="small" style={styles.spinner} color={dark.accent} />
      )}
      {projects.listState.status === 'error' && (
        <Text style={styles.errorText}>
          {describeApiError('GET', baseUrl, '/projects', projects.listState.error)}
        </Text>
      )}
      {projects.listState.status === 'success' &&
        projects.listState.projects.map((project) => (
          <ProjectRow
            key={project.id}
            project={project}
            expanded={expandedIds.has(project.id)}
            onToggleExpand={() => toggleExpand(project.id)}
            projects={projects}
            activeConversationId={activeConversationId}
            onSelectConversation={onSelectConversation}
            onAddToProject={onAddToProject}
            onRenameConversation={onRenameConversation}
            onDeleteConversation={onDeleteConversation}
            deletingConversationIds={deletingConversationIds}
          />
        ))}
    </View>
  );
}

function buildStyles(theme: Theme) {
  return StyleSheet.create({
    container: { paddingBottom: 4 },
    headingRow: { paddingHorizontal: 12, paddingTop: 12, paddingBottom: 4 },
    heading: {
      color: dark.faint,
      fontSize: 11,
      textTransform: 'uppercase',
      fontFamily: theme.fonts.bodyBold,
    },
    newProjectButton: {
      marginHorizontal: 8,
      paddingVertical: 8,
      paddingHorizontal: 8,
      minHeight: 36,
    },
    newProjectButtonText: {
      color: dark.accent,
      fontSize: 13,
      fontFamily: theme.fonts.bodySemibold,
    },
    newProjectForm: { marginHorizontal: 8, gap: 6, marginBottom: 4 },
    newProjectInput: {
      color: dark.text,
      fontSize: 13,
      paddingVertical: 8,
      paddingHorizontal: 10,
      backgroundColor: dark.cardPressed,
      borderRadius: theme.radius.sm,
      minHeight: 36,
      fontFamily: theme.fonts.body,
    },
    newProjectActions: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
      gap: 16,
      alignItems: 'center',
    },
    cancelText: {
      color: dark.faint,
      fontSize: 13,
      paddingVertical: 8,
      minHeight: 36,
      fontFamily: theme.fonts.body,
    },
    createText: {
      color: dark.accent,
      fontSize: 13,
      paddingVertical: 8,
      minHeight: 36,
      fontFamily: theme.fonts.bodySemibold,
    },
    errorText: {
      color: dark.danger,
      fontSize: 11,
      marginHorizontal: 4,
      fontFamily: theme.fonts.body,
    },
    spinner: { marginVertical: 8 },
  });
}
