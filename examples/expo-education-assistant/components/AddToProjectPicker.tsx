import type { UseProjectsResult } from 'education-assistant-client';
import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import { useClient } from '@/lib/ClientProvider';
import { describeApiError } from '@/lib/errorDisplay';
import { safeText } from '@/lib/format';
import { DARK_PALETTE, useTheme, type Theme } from '@/lib/Preferences';

// Always-dark, matching the sidebar this dialog is always triggered from
// (see ConversationSidebar's docs on why that rail ignores the app's own
// light/dark theme preference — this picker follows the same convention).
const dark = DARK_PALETTE;

const MAX_PROJECT_NAME_LENGTH = 80;

// Below this window width, the dialog presents as a full-width bottom
// sheet instead of a centered modal — matches chat/_layout.tsx's own
// wide/narrow split in spirit, but independently: this dialog's own
// content (a ~400px-wide list+form) needs a smaller breakpoint than the
// three-panel chat layout does.
const NARROW_BREAKPOINT_PX = 480;
const DESKTOP_PANEL_WIDTH_PX = 440;

export interface AddToProjectPickerProps {
  conversationId: string;
  conversationTitle: string;
  projects: UseProjectsResult;
  onClose: () => void;
}

/**
 * Overlay picker for POST /conversations/{id}'s three-dot menu's "Add to
 * project" action — lets the user toggle this one conversation's
 * membership in any number of their projects, and create a brand new
 * project inline without leaving the picker. Membership ("already in
 * this project?") is determined by lazily loading each project's
 * conversation list the same way expanding it in the sidebar does (see
 * useProjects().loadProjectConversations) — shares that same cache
 * rather than requiring a separate "which projects have conversation X"
 * endpoint.
 *
 * Rendered through React Native's `Modal` — on web, react-native-web
 * portals it via `ReactDOM.createPortal` straight to `document.body` (see
 * node_modules/react-native-web/dist/exports/Modal/ModalPortal.js), and on
 * iOS/Android it's a true native modal layer — so this dialog is never
 * subject to the sidebar panel's/drawer's own width or overflow, however
 * narrow that container is (see this file's git history for the bug this
 * fixes: a previous version rendered a plain absolutely-positioned `View`
 * as a normal descendant of the sidebar, which only ever covered that
 * ~280px column, clipping the dialog on narrow screens). Matches the exact
 * pattern already used by ImageGenerationModal.tsx, SaveImageToProjectPicker.tsx,
 * AttachmentLightbox.tsx, and SidebarContextMenuContext.tsx's own popup.
 *
 * Escape-to-close (web) and the Android hardware back button both come
 * from `onRequestClose` alone — react-native-web's Modal already listens
 * for Escape itself (see ModalContent.js), and RN's Modal wires
 * `onRequestClose` to the Android back button natively; neither needs
 * bespoke code here.
 */
export function AddToProjectPicker({
  conversationId,
  conversationTitle,
  projects,
  onClose,
}: AddToProjectPickerProps) {
  const theme = useTheme();
  const styles = useMemo(() => buildStyles(theme), [theme]);
  const { listState, projectConversationsStates, loadProjectConversations } = projects;
  const { baseUrl } = useClient();
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const isNarrow = windowWidth < NARROW_BREAKPOINT_PX;
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const [showNewProjectForm, setShowNewProjectForm] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  useEffect(() => {
    if (listState.status !== 'success') return;
    for (const project of listState.projects) {
      if (!projectConversationsStates[project.id]) {
        loadProjectConversations(project.id);
      }
    }
    // Deliberately only re-runs when the project list itself changes (a
    // project created/deleted) — not on every projectConversationsStates
    // update, which would otherwise re-trigger a load for every project on
    // every single one's own load completion.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listState, loadProjectConversations]);

  // Locks background scrolling while this dialog is open (web only — RN's
  // own Modal already prevents interaction with anything behind it on
  // iOS/Android without needing this). Mounts/unmounts with the dialog
  // itself (see ConversationSidebar.tsx's conditional render), so this
  // reliably pairs one lock with one restore per open/close cycle.
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  async function handleToggle(projectId: string, projectName: string, isMember: boolean) {
    setToggleError(null);
    try {
      if (isMember) {
        await projects.removeConversationFromProject(projectId, conversationId);
        setConfirmation(null);
      } else {
        await projects.addConversationToProject(projectId, conversationId);
        setConfirmation(`Added to ${projectName}`);
      }
    } catch (error) {
      setToggleError(error instanceof Error ? error.message : String(error));
    }
  }

  async function handleCreateAndAdd() {
    const trimmed = newProjectName.trim();
    if (!trimmed || creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      const project = await projects.createProject({ name: trimmed });
      await projects.addConversationToProject(project.id, conversationId);
      setConfirmation(`Added to ${project.name}`);
      setShowNewProjectForm(false);
      setNewProjectName('');
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : String(error));
    } finally {
      setCreating(false);
    }
  }

  // Desktop: centered, clamped to a fixed ~400-450px band regardless of a
  // much wider viewport. Narrow: a full-width bottom sheet, capped well
  // below the full window height so short/landscape screens never get a
  // panel taller than the viewport itself.
  const panelWidth = isNarrow ? windowWidth : Math.min(DESKTOP_PANEL_WIDTH_PX, windowWidth - 32);
  const panelMaxHeight = isNarrow ? windowHeight * 0.85 : Math.min(560, windowHeight - 64);
  // The project list is the one part expected to grow arbitrarily (many
  // projects) — bounded to its own scrollable band so it never pushes the
  // title/create-project form/Done button off the bottom of the panel.
  const projectListMaxHeight = Math.max(140, Math.min(280, windowHeight * 0.35));

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={[styles.overlay, isNarrow && styles.overlayBottom]}>
        <Pressable
          style={styles.backdrop}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close add to project dialog"
        />
        <View
          style={[
            styles.panel,
            isNarrow ? styles.panelSheet : styles.panelCentered,
            { width: panelWidth, maxHeight: panelMaxHeight },
          ]}
        >
          <Text style={styles.title}>Add to project</Text>
          <Text style={styles.subtitle} numberOfLines={2} ellipsizeMode="tail">
            {`"${safeText(conversationTitle, 'this conversation')}"`}
          </Text>

          {listState.status === 'loading' && (
            <ActivityIndicator style={styles.spinner} color={dark.accent} />
          )}
          {listState.status === 'error' && (
            <Text style={styles.errorText}>
              {describeApiError('GET', baseUrl, '/projects', listState.error)}
            </Text>
          )}
          {listState.status === 'success' && listState.projects.length === 0 && (
            <Text style={styles.emptyText}>No projects yet — create one below.</Text>
          )}

          {listState.status === 'success' && listState.projects.length > 0 && (
            <ScrollView style={[styles.projectList, { maxHeight: projectListMaxHeight }]}>
              {listState.projects.map((project) => {
                const conversationsState = projectConversationsStates[project.id];
                const isMember =
                  conversationsState?.status === 'success' &&
                  conversationsState.conversations.some(
                    (c) => c.conversation_id === conversationId
                  );
                const pending =
                  projects.addRemoveStates[`${project.id}:${conversationId}`]?.status === 'pending';
                const membershipKnown = conversationsState?.status === 'success';

                return (
                  <Pressable
                    key={project.id}
                    style={styles.projectRow}
                    onPress={() => handleToggle(project.id, project.name, Boolean(isMember))}
                    disabled={pending || !membershipKnown}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: Boolean(isMember) }}
                    accessibilityLabel={`${isMember ? 'Remove from' : 'Add to'} ${project.name}`}
                  >
                    <Text style={styles.checkbox}>{isMember ? '☑' : '☐'}</Text>
                    <Text style={styles.projectRowText} numberOfLines={2} ellipsizeMode="tail">
                      {project.name}
                    </Text>
                    {(pending || !membershipKnown) && (
                      <ActivityIndicator size="small" color={dark.accent} />
                    )}
                  </Pressable>
                );
              })}
            </ScrollView>
          )}

          {toggleError && <Text style={styles.errorText}>{toggleError}</Text>}
          {confirmation && <Text style={styles.confirmationText}>{confirmation}</Text>}

          <View style={styles.divider} />

          {!showNewProjectForm ? (
            <Pressable
              style={styles.newProjectButton}
              onPress={() => setShowNewProjectForm(true)}
              accessibilityRole="button"
              accessibilityLabel="Create a new project"
            >
              <Text style={styles.newProjectButtonText}>+ Create new project</Text>
            </Pressable>
          ) : (
            <View style={styles.newProjectForm}>
              <TextInput
                style={styles.newProjectInput}
                value={newProjectName}
                onChangeText={setNewProjectName}
                placeholder="Project name"
                maxLength={MAX_PROJECT_NAME_LENGTH}
                autoFocus
                editable={!creating}
                accessibilityLabel="New project name"
              />
              {createError && <Text style={styles.errorText}>{createError}</Text>}
              <View style={styles.newProjectActions}>
                <Pressable
                  onPress={() => {
                    setShowNewProjectForm(false);
                    setNewProjectName('');
                    setCreateError(null);
                  }}
                  disabled={creating}
                >
                  <Text style={styles.cancelText}>Cancel</Text>
                </Pressable>
                <Pressable
                  onPress={handleCreateAndAdd}
                  disabled={creating || !newProjectName.trim()}
                  accessibilityRole="button"
                  accessibilityLabel="Create project and add conversation"
                >
                  {creating ? (
                    <ActivityIndicator size="small" color={dark.accent} />
                  ) : (
                    <Text style={styles.createText}>Create &amp; add</Text>
                  )}
                </Pressable>
              </View>
            </View>
          )}

          <Pressable
            style={styles.doneButton}
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Done adding to projects"
          >
            <Text style={styles.doneButtonText}>Done</Text>
          </Pressable>
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
      zIndex: 30,
      elevation: 30,
    },
    // Narrow/mobile: anchor the sheet to the bottom edge instead of centering
    // it, and let it span the full width (panelWidth === windowWidth) — the
    // "full-width bottom sheet" requirement.
    overlayBottom: { alignItems: 'stretch', justifyContent: 'flex-end' },
    backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(20, 22, 31, 0.6)' },
    panel: { backgroundColor: dark.card, padding: 16, gap: 8 },
    panelCentered: { borderRadius: theme.radius.lg },
    panelSheet: { borderTopLeftRadius: theme.radius.lg, borderTopRightRadius: theme.radius.lg },
    title: { color: dark.text, fontSize: 14, fontFamily: theme.fonts.display },
    subtitle: { color: dark.subtext, fontSize: 13, marginBottom: 4, fontFamily: theme.fonts.body },
    spinner: { marginVertical: 12 },
    errorText: { color: dark.danger, fontSize: 12, fontFamily: theme.fonts.body },
    emptyText: { color: dark.faint, fontSize: 12, fontFamily: theme.fonts.body },
    confirmationText: { color: dark.ok, fontSize: 12, fontFamily: theme.fonts.body },
    projectList: {},
    projectRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingVertical: 8,
      minHeight: 36,
    },
    checkbox: { color: dark.accent, fontSize: 16 },
    projectRowText: { color: dark.text, fontSize: 13, flex: 1, fontFamily: theme.fonts.body },
    divider: { height: StyleSheet.hairlineWidth, backgroundColor: dark.divider, marginVertical: 4 },
    newProjectButton: { paddingVertical: 8, minHeight: 36, justifyContent: 'center' },
    newProjectButtonText: {
      color: dark.accent,
      fontSize: 13,
      fontFamily: theme.fonts.bodySemibold,
    },
    newProjectForm: { gap: 6 },
    newProjectInput: {
      color: dark.text,
      fontSize: 13,
      paddingVertical: 8,
      paddingHorizontal: 10,
      backgroundColor: dark.background,
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
      fontFamily: theme.fonts.body,
    },
    createText: {
      color: dark.accent,
      fontSize: 13,
      paddingVertical: 8,
      fontFamily: theme.fonts.bodySemibold,
    },
    doneButton: {
      marginTop: 8,
      alignSelf: 'flex-end',
      paddingVertical: 8,
      paddingHorizontal: 12,
      minHeight: 36,
      justifyContent: 'center',
    },
    doneButtonText: { color: dark.text, fontSize: 13, fontFamily: theme.fonts.bodySemibold },
  });
}
