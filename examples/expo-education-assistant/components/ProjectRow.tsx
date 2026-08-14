import type { ProjectSummary, UseProjectsResult } from 'education-assistant-client';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { ChevronIcon, MoreIcon } from '@/components/icons';
import { ConversationRow } from '@/components/ConversationRow';
import { safeText } from '@/lib/format';
import { measureWindowRect } from '@/lib/measureWindowRect';
import { WEB_MENU_TRIGGER_ARIA_PROPS } from '@/lib/webMenuTriggerAria';
import { DARK_PALETTE, useTheme, type Theme } from '@/lib/Preferences';
import {
  useSidebarContextMenu,
  type SidebarContextMenuAction,
} from '@/lib/SidebarContextMenuContext';

// Always-dark — ProjectRow only ever renders inside the sidebar (see
// ConversationSidebar's docs).
const dark = DARK_PALETTE;

const MAX_PROJECT_NAME_LENGTH = 80;

export interface ProjectRowProps {
  project: ProjectSummary;
  expanded: boolean;
  onToggleExpand: () => void;
  projects: UseProjectsResult;
  activeConversationId: string | null;
  onSelectConversation: (id: string) => void;
  onAddToProject: (conversationId: string, title: string, restoreFocus: () => void) => void;
  onRenameConversation: (id: string, title: string) => void | Promise<unknown>;
  onDeleteConversation: (id: string) => void;
  deletingConversationIds: ReadonlySet<string>;
}

type EditMode = 'none' | 'name' | 'description';

// `aria-haspopup` lives in lib/webMenuTriggerAria — shared with
// ConversationRow's identical three-dot trigger.

/**
 * One project's sidebar row: expand/collapse control, name, conversation
 * count, a three-dot menu (Rename / Edit description / Delete project),
 * and, when expanded, its assigned conversations rendered with the exact
 * same ConversationRow the normal history list uses (see that component's
 * own docs on why it's shared).
 *
 * The three-dot menu itself is NOT rendered here, for the same reason
 * ConversationRow's isn't: this row only measures its trigger button's
 * on-screen position and hands that, plus its action list, to
 * SidebarContextMenuProvider (mounted once above the sidebar's FlatList —
 * see ConversationSidebar.tsx, the same provider ConversationRow itself
 * uses), which renders the actual popup through a Modal/Portal. Sharing
 * that one controller with ConversationRow is also what guarantees a
 * project's menu and a conversation's menu are mutually exclusive —
 * opening either one always closes the other, since both are just the
 * same single piece of "which id's menu is open" state.
 */
export function ProjectRow({
  project,
  expanded,
  onToggleExpand,
  projects,
  activeConversationId,
  onSelectConversation,
  onAddToProject,
  onRenameConversation,
  onDeleteConversation,
  deletingConversationIds,
}: ProjectRowProps) {
  const theme = useTheme();
  const styles = useMemo(() => buildStyles(theme), [theme]);
  const [editMode, setEditMode] = useState<EditMode>('none');
  const [nameInput, setNameInput] = useState(project.name);
  const [descriptionInput, setDescriptionInput] = useState(project.description ?? '');
  const [saveError, setSaveError] = useState<string | null>(null);
  const triggerRef = useRef<View>(null);
  const { openMenuId, openMenu, closeMenu } = useSidebarContextMenu();
  const isMenuOpen = openMenuId === project.id;

  // Read inside the unmount cleanup below, which otherwise closes over the
  // `isMenuOpen` value from whichever render first mounted this effect.
  const isMenuOpenRef = useRef(isMenuOpen);
  isMenuOpenRef.current = isMenuOpen;

  useEffect(() => {
    if (editMode !== 'name') setNameInput(project.name);
  }, [project.name, editMode]);
  useEffect(() => {
    if (editMode !== 'description') setDescriptionInput(project.description ?? '');
  }, [project.description, editMode]);

  useEffect(() => {
    if (expanded && !projects.projectConversationsStates[project.id]) {
      projects.loadProjectConversations(project.id);
    }
    // Only (re-)loads when this project transitions to expanded, or on
    // first mount already-expanded (restored from local storage) — not on
    // every unrelated projectConversationsStates update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, project.id]);

  // The active menu must never outlive the row it belongs to: if this
  // project's menu is open when this row unmounts (the project list was
  // refreshed and this project dropped out, etc.), close it rather than
  // leaving a popup with no row behind it.
  useEffect(() => {
    return () => {
      if (isMenuOpenRef.current) closeMenu();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function commitRename(): Promise<void> {
    const trimmed = nameInput.trim();
    setEditMode('none');
    if (!trimmed || trimmed === project.name) return;
    try {
      await projects.updateProject(project.id, { name: trimmed });
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    }
  }

  async function commitDescription(): Promise<void> {
    const trimmed = descriptionInput.trim();
    setEditMode('none');
    if (trimmed === (project.description ?? '')) return;
    try {
      await projects.updateProject(project.id, { description: trimmed || null });
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    }
  }

  function handleDeletePress(): void {
    const label = safeText(project.name, 'this project');
    const message = `Delete "${label}"? The project will be removed, but its chats will remain in your history.`;
    if (Platform.OS === 'web') {
      if (window.confirm(message)) projects.deleteProject(project.id);
      return;
    }
    Alert.alert('Delete project', message, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => projects.deleteProject(project.id) },
    ]);
  }

  function handleMenuTriggerPress(): void {
    if (isMenuOpen) {
      closeMenu();
      return;
    }
    measureWindowRect(triggerRef, ({ x, y, width, height }) => {
      const actions: SidebarContextMenuAction[] = [
        {
          key: 'rename',
          label: 'Rename',
          // Frontend/Platform Milestone 3.2.2 Part F — deferred one
          // macrotask, same reasoning as ConversationRow's identical
          // rename action (see that component's own comment): pressing
          // this item unmounts the menu Modal, and react-native-web's
          // Modal focus-trap teardown then restores focus to the element
          // it captured (this row's ⋮ button). If the rename input mounts
          // (autoFocus) before that teardown runs, the teardown steals
          // focus straight back, firing the input's onBlur → commitRename
          // running with the unchanged name → "Rename" visibly does
          // nothing and nothing is ever PATCHed. This was the actual
          // root cause of the PO-reported "Rename is visible but broken"
          // bug — ProjectRow never received the fix ConversationRow
          // already had for the exact same shared-menu interaction.
          // Deferring lets the teardown finish before the input mounts
          // and takes focus.
          onPress: () => setTimeout(() => setEditMode('name'), 0),
        },
        {
          key: 'edit-description',
          label: 'Edit description',
          // Same fix, same reason — Edit description has the identical
          // autoFocus-vs-Modal-teardown race.
          onPress: () => setTimeout(() => setEditMode('description'), 0),
        },
        { key: 'delete', label: 'Delete project', destructive: true, onPress: handleDeletePress },
      ];
      openMenu({ menuId: project.id, anchor: { x, y, width, height }, actions });
    });
  }

  const deleting = projects.deleteStates[project.id]?.status === 'deleting';
  const conversationsState = projects.projectConversationsStates[project.id];

  if (editMode === 'name') {
    return (
      <View style={styles.header}>
        <TextInput
          style={styles.renameInput}
          value={nameInput}
          onChangeText={setNameInput}
          maxLength={MAX_PROJECT_NAME_LENGTH}
          autoFocus
          onSubmitEditing={commitRename}
          onBlur={commitRename}
          returnKeyType="done"
          accessibilityLabel="Project name"
        />
      </View>
    );
  }

  return (
    <View>
      <View style={styles.header}>
        <Pressable
          style={styles.expandButton}
          onPress={onToggleExpand}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={`${expanded ? 'Collapse' : 'Expand'} ${safeText(project.name, 'project')}`}
          accessibilityState={{ expanded }}
        >
          <ChevronIcon
            size={14}
            color={dark.faint}
            style={{ transform: [{ rotate: expanded ? '90deg' : '0deg' }] }}
          />
        </Pressable>
        <Pressable style={styles.headerMain} onPress={onToggleExpand}>
          <Text numberOfLines={1} style={styles.projectName}>
            {safeText(project.name, 'Untitled project')}
          </Text>
          <Text style={styles.conversationCount}>{project.conversation_count}</Text>
        </Pressable>
        {deleting ? (
          <ActivityIndicator size="small" style={styles.menuButton} color={dark.accent} />
        ) : (
          <View ref={triggerRef} style={styles.menuButton}>
            <Pressable
              style={({ pressed, hovered }) => [
                styles.menuButtonPressable,
                {
                  borderRadius: theme.radius.sm,
                  backgroundColor: pressed || hovered || isMenuOpen ? dark.border : 'transparent',
                },
              ]}
              onPress={handleMenuTriggerPress}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={`Options for ${safeText(project.name, 'this project')}`}
              accessibilityState={{ expanded: isMenuOpen }}
              aria-expanded={isMenuOpen}
              {...WEB_MENU_TRIGGER_ARIA_PROPS}
            >
              <MoreIcon size={16} color={isMenuOpen ? dark.text : dark.faint} />
            </Pressable>
          </View>
        )}
      </View>

      {editMode === 'description' && (
        <View style={styles.descriptionEditBox}>
          <TextInput
            style={styles.descriptionInput}
            value={descriptionInput}
            onChangeText={setDescriptionInput}
            placeholder="Description (optional)"
            placeholderTextColor={dark.faint}
            multiline
            autoFocus
            onBlur={commitDescription}
            accessibilityLabel="Project description"
          />
        </View>
      )}

      {saveError && <Text style={styles.errorText}>{saveError}</Text>}

      {expanded && (
        <View style={styles.conversationList}>
          {conversationsState?.status === 'loading' && (
            <ActivityIndicator size="small" style={styles.spinner} color={dark.accent} />
          )}
          {conversationsState?.status === 'error' && (
            <Text style={styles.errorText}>{conversationsState.error.message}</Text>
          )}
          {conversationsState?.status === 'success' &&
            conversationsState.conversations.length === 0 && (
              <Text style={styles.emptyText}>No conversations in this project yet.</Text>
            )}
          {conversationsState?.status === 'success' &&
            conversationsState.conversations.map((conversation) => (
              <ConversationRow
                key={conversation.conversation_id}
                item={{ id: conversation.conversation_id, title: conversation.title }}
                active={conversation.conversation_id === activeConversationId}
                onSelect={onSelectConversation}
                onRename={onRenameConversation}
                onDelete={onDeleteConversation}
                deleting={deletingConversationIds.has(conversation.conversation_id)}
                onAddToProject={onAddToProject}
                onRemoveFromProject={(conversationId) =>
                  projects.removeConversationFromProject(project.id, conversationId).catch(() => {})
                }
                removingFromProject={
                  projects.addRemoveStates[`${project.id}:${conversation.conversation_id}`]
                    ?.status === 'pending'
                }
              />
            ))}
        </View>
      )}
    </View>
  );
}

function buildStyles(theme: Theme) {
  return StyleSheet.create({
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      marginHorizontal: 8,
      borderRadius: theme.radius.sm,
      position: 'relative',
      minHeight: 36,
    },
    expandButton: {
      width: 28,
      minHeight: 36,
      alignItems: 'center',
      justifyContent: 'center',
    },
    expandIcon: { color: dark.faint, fontSize: 12 },
    headerMain: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 8,
      gap: 6,
    },
    projectName: {
      color: dark.text,
      fontSize: 13,
      flexShrink: 1,
      fontFamily: theme.fonts.bodySemibold,
    },
    conversationCount: { color: dark.faint, fontSize: 11, fontFamily: theme.fonts.body },
    menuButton: {
      paddingHorizontal: 8,
      paddingVertical: 8,
      minWidth: 36,
      minHeight: 36,
      alignItems: 'center',
      justifyContent: 'center',
    },
    menuButtonPressable: {
      alignItems: 'center',
      justifyContent: 'center',
    },
    menuButtonText: { color: dark.faint, fontSize: 16 },
    renameInput: {
      flex: 1,
      color: dark.text,
      fontSize: 13,
      paddingVertical: 6,
      paddingHorizontal: 8,
      marginHorizontal: 4,
      backgroundColor: dark.cardPressed,
      borderRadius: theme.radius.sm,
      minHeight: 36,
      fontFamily: theme.fonts.body,
    },
    descriptionEditBox: { marginHorizontal: 8, marginBottom: 4 },
    descriptionInput: {
      color: dark.text,
      fontSize: 12,
      paddingVertical: 6,
      paddingHorizontal: 8,
      backgroundColor: dark.cardPressed,
      borderRadius: theme.radius.sm,
      minHeight: 48,
      textAlignVertical: 'top',
      fontFamily: theme.fonts.body,
    },
    errorText: {
      color: dark.danger,
      fontSize: 11,
      marginHorizontal: 12,
      marginBottom: 4,
      fontFamily: theme.fonts.body,
    },
    emptyText: {
      color: dark.faint,
      fontSize: 11,
      marginHorizontal: 12,
      marginBottom: 4,
      fontFamily: theme.fonts.body,
    },
    spinner: { marginVertical: 8 },
    conversationList: { marginLeft: 20 },
  });
}
