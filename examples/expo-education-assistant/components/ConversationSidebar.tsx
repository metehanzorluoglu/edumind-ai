import type {
  ConversationSummary,
  UseConversationsResult,
  UseProjectsResult,
} from 'education-assistant-client';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { AddToProjectPicker } from '@/components/AddToProjectPicker';
import { EduM8Symbol } from '@/components/EduM8Logo';
import { ConversationRow, type ConversationRowItem } from '@/components/ConversationRow';
import { ProjectsSection } from '@/components/ProjectsSection';
import { useAuth } from '@/lib/AuthProvider';
import { useClient } from '@/lib/ClientProvider';
import { DARK_PALETTE, useTheme } from '@/lib/Preferences';
import { SidebarContextMenuProvider } from '@/lib/SidebarContextMenuContext';
import { describeApiError } from '@/lib/errorDisplay';
import { safeText } from '@/lib/format';

// This rail is deliberately always-dark (ChatGPT-style persistent
// sidebar), independent of the user's light/dark theme preference — so
// it draws colors from DARK_PALETTE directly rather than useTheme(),
// which would follow the ambient mode. Fonts have no light/dark variant,
// so those still come from useTheme().fonts.
const dark = DARK_PALETTE;

const DAY_MS = 24 * 60 * 60 * 1000;

type DateGroup = 'Today' | 'Yesterday' | 'Previous 7 days' | 'Older';

function dateGroupFor(isoDate: string, now: Date): DateGroup {
  const date = new Date(isoDate);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const diffDays = Math.floor((startOfToday - date.getTime()) / DAY_MS);
  if (diffDays <= 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays <= 7) return 'Previous 7 days';
  return 'Older';
}

const GROUP_ORDER: DateGroup[] = ['Today', 'Yesterday', 'Previous 7 days', 'Older'];

interface SidebarListItem {
  type: 'header' | 'conversation';
  key: string;
  group?: DateGroup;
  conversation?: ConversationSummary;
}

function groupConversations(conversations: ConversationSummary[]): SidebarListItem[] {
  const now = new Date();
  const byGroup = new Map<DateGroup, ConversationSummary[]>();
  for (const conversation of conversations) {
    const group = dateGroupFor(conversation.updated_at, now);
    const list = byGroup.get(group) ?? [];
    list.push(conversation);
    byGroup.set(group, list);
  }

  const items: SidebarListItem[] = [];
  for (const group of GROUP_ORDER) {
    const list = byGroup.get(group);
    if (!list || list.length === 0) continue;
    items.push({ type: 'header', key: `header-${group}`, group });
    for (const conversation of list) {
      items.push({ type: 'conversation', key: conversation.id, conversation });
    }
  }
  return items;
}

function toRowItem(conversation: ConversationSummary): ConversationRowItem {
  return {
    id: conversation.id,
    title: conversation.title,
    lastMessagePreview: conversation.last_message_preview,
  };
}

export interface ConversationSidebarProps {
  conversations: UseConversationsResult;
  projects: UseProjectsResult;
  activeConversationId: string | null;
  onSelect: (id: string) => void;
  onNewChat: () => void;
  /** Present only in drawer/overlay mode — lets a row selection also close the drawer. */
  onRequestClose?: () => void;
}

/**
 * ChatGPT-inspired (not a copy of its branding/visuals) conversation list:
 * new-chat button, a Projects section, date-grouped conversations, inline
 * rename, delete with confirmation, and a user profile/logout footer.
 * Rendered by app/(tabs)/chat/_layout.tsx either as a persistent panel
 * (wide web) or inside a drawer overlay (native, narrow web) — this
 * component itself doesn't know which; it just fills whatever container
 * it's given.
 *
 * Everything above the footer lives inside one FlatList (New Chat button,
 * Projects section, and the date-grouped history all render via
 * ListHeaderComponent/data) so the whole sidebar scrolls as a single unit
 * once projects+conversations exceed the available height, rather than
 * nesting a second scrollable list inside another (an anti-pattern for
 * VirtualizedLists). The footer stays a sibling below the FlatList, so it
 * stays pinned regardless of scroll position.
 */
export function ConversationSidebar({
  conversations,
  projects,
  activeConversationId,
  onSelect,
  onNewChat,
  onRequestClose,
}: ConversationSidebarProps) {
  const { listState, refresh, renameConversation, deleteConversation, deleteStates } =
    conversations;
  const { user, logout, status: authStatus, accessToken } = useAuth();
  const { baseUrl } = useClient();
  const theme = useTheme();
  const [addToProjectTarget, setAddToProjectTarget] = useState<{
    id: string;
    title: string;
    restoreFocus: () => void;
  } | null>(null);

  // Same auth-readiness guard as ProjectsSection (see its own docs) — this
  // mount-time refresh is likewise not reachable before auth restoration
  // completes today (app/(tabs)/_layout.tsx already gates the whole route
  // group on `status`), but requiring a non-null accessToken too, and
  // re-firing whenever that flips ready, is a correctness guarantee this
  // component shouldn't have to depend on a *different* file to uphold.
  const authReady = authStatus === 'authenticated' && accessToken != null;

  useEffect(() => {
    if (!authReady) return;
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authReady]);

  function handleSelect(id: string): void {
    onSelect(id);
    onRequestClose?.();
  }

  function handleNewChat(): void {
    onNewChat();
    onRequestClose?.();
  }

  function handleAddToProject(
    conversationId: string,
    title: string,
    restoreFocus: () => void
  ): void {
    setAddToProjectTarget({ id: conversationId, title, restoreFocus });
  }

  function handleCloseAddToProject(): void {
    // Deferred to a macrotask so it runs strictly after this unmount's own
    // effect cleanups — including react-native-web's Modal's built-in
    // focus-trap teardown (see node_modules/react-native-web/dist/exports/
    // Modal/ModalFocusTrap.js), which would otherwise sometimes win the
    // race and move focus to whatever it captured instead (often
    // document.body) right after this callback returns. This guarantees
    // the three-dot button that opened the dialog is the *final* focus
    // target, not whichever ran last by accident.
    const restoreFocus = addToProjectTarget?.restoreFocus;
    setAddToProjectTarget(null);
    if (restoreFocus) setTimeout(restoreFocus, 0);
  }

  const deletingConversationIds = useMemo(
    () =>
      new Set(
        Object.entries(deleteStates)
          .filter(([, state]) => state.status === 'deleting')
          .map(([id]) => id)
      ),
    [deleteStates]
  );

  const items = listState.status === 'success' ? groupConversations(listState.conversations) : [];

  return (
    <View style={[styles.container, { backgroundColor: dark.background }]}>
      <View style={styles.brandHeader}>
        <EduM8Symbol size={20} />
        <Text
          style={[styles.brandHeaderText, { color: dark.text, fontFamily: theme.fonts.display }]}
        >
          EduM8
        </Text>
      </View>

      {/* SidebarContextMenuProvider wraps the FlatList (and everything it
          renders, including ProjectRow's own three-dot menu and its own
          nested ConversationRows) but renders its actual popup as its own
          sibling, not a descendant of the FlatList — see that file's docs
          for why that's what keeps a menu from ever being clipped by/
          painted behind rows, and how it keeps both menu kinds mutually
          exclusive. */}
      <SidebarContextMenuProvider>
        {({ closeMenu }) => (
          <>
            <FlatList
              style={styles.list}
              data={items}
              keyExtractor={(item) => item.key}
              onScroll={closeMenu}
              scrollEventThrottle={16}
              renderItem={({ item }) =>
                item.type === 'header' ? (
                  <Text
                    style={[
                      styles.groupHeader,
                      { color: dark.faint, fontFamily: theme.fonts.bodyBold },
                    ]}
                  >
                    {item.group}
                  </Text>
                ) : (
                  <ConversationRow
                    item={toRowItem(item.conversation!)}
                    active={item.conversation!.id === activeConversationId}
                    onSelect={handleSelect}
                    onRename={renameConversation}
                    onDelete={deleteConversation}
                    deleting={deletingConversationIds.has(item.conversation!.id)}
                    onAddToProject={handleAddToProject}
                  />
                )
              }
              ListHeaderComponent={
                <>
                  <NewChatButton onPress={handleNewChat} />

                  <ProjectsSection
                    projects={projects}
                    activeConversationId={activeConversationId}
                    onSelectConversation={handleSelect}
                    onAddToProject={handleAddToProject}
                    onRenameConversation={renameConversation}
                    onDeleteConversation={deleteConversation}
                    deletingConversationIds={deletingConversationIds}
                  />

                  {listState.status === 'loading' && (
                    <View style={styles.centered}>
                      <ActivityIndicator color={dark.faint} />
                    </View>
                  )}

                  {listState.status === 'error' && (
                    <View style={styles.centered}>
                      <Text
                        style={[
                          styles.errorText,
                          { color: dark.danger, fontFamily: theme.fonts.body },
                        ]}
                      >
                        {describeApiError('GET', baseUrl, '/conversations', listState.error)}
                      </Text>
                      <Pressable
                        style={styles.retryButton}
                        onPress={() => refresh()}
                        accessibilityRole="button"
                        accessibilityLabel="Retry loading conversations"
                      >
                        <Text
                          style={[
                            styles.retryButtonText,
                            { color: dark.accent, fontFamily: theme.fonts.bodySemibold },
                          ]}
                        >
                          Retry
                        </Text>
                      </Pressable>
                    </View>
                  )}

                  {listState.status === 'success' && items.length === 0 && (
                    <Text
                      style={[
                        styles.emptyText,
                        { color: dark.faint, fontFamily: theme.fonts.body },
                      ]}
                    >
                      No conversations yet — start one above.
                    </Text>
                  )}
                </>
              }
            />

            {addToProjectTarget && (
              <AddToProjectPicker
                conversationId={addToProjectTarget.id}
                conversationTitle={addToProjectTarget.title}
                projects={projects}
                onClose={handleCloseAddToProject}
              />
            )}
          </>
        )}
      </SidebarContextMenuProvider>

      <View style={[styles.footer, { borderTopColor: dark.divider }]}>
        <Text
          numberOfLines={1}
          style={[styles.footerName, { color: dark.subtext, fontFamily: theme.fonts.body }]}
        >
          {safeText(user?.display_name ?? user?.email ?? null, 'Signed in')}
        </Text>
        <Pressable
          style={styles.logoutButton}
          onPress={() => logout()}
          accessibilityRole="button"
          accessibilityLabel="Log out"
        >
          <Text
            style={[
              styles.logoutButtonText,
              { color: dark.accent, fontFamily: theme.fonts.bodySemibold },
            ]}
          >
            Log out
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

/** Local, not the shared Button component — this rail is deliberately
 * always-dark (see `dark` above), independent of the ambient theme
 * Button.tsx reads via useTheme(). Same hover/focus pattern as Button. */
function NewChatButton({ onPress }: { onPress: () => void }) {
  const theme = useTheme();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  return (
    <Pressable
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      accessibilityRole="button"
      accessibilityLabel="New chat"
      style={[
        styles.newChatButton,
        {
          borderColor: focused ? dark.focusRing : dark.borderStrong,
          borderWidth: focused ? 2 : StyleSheet.hairlineWidth * 2,
          backgroundColor: hovered ? dark.cardPressed : 'transparent',
          borderRadius: theme.radius.md,
        },
      ]}
    >
      <Text
        style={[
          styles.newChatButtonText,
          { color: dark.text, fontFamily: theme.fonts.bodySemibold },
        ]}
      >
        + New chat
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  brandHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 4,
  },
  brandHeaderText: { fontWeight: '600', fontSize: 15, letterSpacing: -0.2 },
  newChatButton: {
    margin: 12,
    paddingVertical: 10,
    alignItems: 'center',
  },
  newChatButtonText: { fontWeight: '600' },
  list: { flex: 1 },
  centered: { alignItems: 'center', gap: 8, padding: 16 },
  errorText: { fontSize: 12, textAlign: 'center' },
  retryButton: { paddingVertical: 6, paddingHorizontal: 12 },
  retryButtonText: { fontSize: 12, fontWeight: '600' },
  emptyText: { fontSize: 12, textAlign: 'center', padding: 16 },
  groupHeader: {
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: 0.3,
    paddingHorizontal: 12,
    paddingTop: 12,
    paddingBottom: 4,
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderTopWidth: StyleSheet.hairlineWidth,
    padding: 12,
  },
  footerName: { fontSize: 12, flex: 1, marginRight: 8 },
  logoutButton: { paddingVertical: 6, paddingHorizontal: 10 },
  logoutButtonText: { fontSize: 12, fontWeight: '600' },
});
