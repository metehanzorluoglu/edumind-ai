import { forwardRef, useEffect, useRef, useState } from 'react';
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
import { MoreIcon } from '@/components/icons';
import { focusRef } from '@/lib/focusElement';
import { safeText } from '@/lib/format';
import { measureWindowRect } from '@/lib/measureWindowRect';
import { DARK_PALETTE, useTheme } from '@/lib/Preferences';
import {
  useSidebarContextMenu,
  type SidebarContextMenuAction,
} from '@/lib/SidebarContextMenuContext';
import { WEB_MENU_TRIGGER_ARIA_PROPS } from '@/lib/webMenuTriggerAria';

// This row only ever renders inside the always-dark sidebar rail, so it
// draws from the dark palette directly (same convention as
// ConversationSidebar/NavRail) instead of the ambient theme.
const dark = DARK_PALETTE;

/** Minimal shape both a normal-history ConversationSummary and a
 * project-scoped ProjectConversation can be adapted into — this row
 * doesn't need anything else from either. */
export interface ConversationRowItem {
  id: string;
  title: string;
  lastMessagePreview?: string | null;
}

export interface ConversationRowProps {
  item: ConversationRowItem;
  active: boolean;
  onSelect: (id: string) => void;
  onRename: (id: string, title: string) => void | Promise<unknown>;
  onDelete: (id: string) => void;
  deleting: boolean;
  /** `restoreFocus` returns focus to this row's own three-dot button — call it once the Add-to-project dialog it opened has closed (see AddToProjectPicker.tsx). */
  onAddToProject: (id: string, title: string, restoreFocus: () => void) => void;
  /** Present only when this row is rendered inside an expanded project's
   * own conversation list — adds "Remove from project" to the menu,
   * which removes only the association (see onRemoveFromProject), never
   * the conversation itself. */
  onRemoveFromProject?: (id: string) => void;
  removingFromProject?: boolean;
}

/**
 * One conversation row, shared by the sidebar's normal date-grouped
 * history AND a project's expanded conversation list (see
 * ConversationSidebar.tsx / ProjectRow.tsx) — the exact same row
 * component either way keeps their menus, rename/delete behavior, and
 * active-conversation highlighting from ever drifting apart between the
 * two contexts.
 *
 * Rename contract: the menu's "Rename" swaps the row for an inline input;
 * Enter or blur (an outside click) commits via onRename, Escape cancels
 * back to the saved title, empty/whitespace titles are rejected without
 * an API call, and a rejected rename call shows its error inline under
 * the input (which stays open for a retry) — never a silent no-op. The
 * sidebar reflects a successful rename immediately because onRename
 * patches the shared conversation list state (see useConversations), and
 * the active conversation stays selected — selection is keyed by
 * conversation id, which a rename never changes.
 *
 * The three-dot menu itself is NOT rendered here: this row only measures
 * its trigger button's on-screen position and hands that, plus its action
 * list, to SidebarContextMenuProvider (mounted once above the sidebar's
 * FlatList — see ConversationSidebar.tsx; the same provider also serves
 * ProjectRow's own three-dot menu), which renders the actual popup
 * through a Modal/Portal. Keeping the popup out of this row entirely is
 * what stops it from being clipped or painted behind neighboring rows.
 */
export function ConversationRow({
  item,
  active,
  onSelect,
  onRename,
  onDelete,
  deleting,
  onAddToProject,
  onRemoveFromProject,
  removingFromProject = false,
}: ConversationRowProps) {
  const theme = useTheme();
  const [renaming, setRenaming] = useState(false);
  const [titleInput, setTitleInput] = useState(item.title);
  /** Set when the rename API call rejects — shown inline under the input,
   * which stays open so the user can retry or press Escape to back out
   * (rather than failing silently and pretending the rename happened). */
  const [renameError, setRenameError] = useState<string | null>(null);
  const triggerRef = useRef<View>(null);
  // Separate from triggerRef above: that one wraps the whole hit area for
  // measureWindowRect's positioning math; this one is on the actual
  // interactive Pressable, since restoring focus to a plain wrapping View
  // would do nothing (a non-interactive div isn't focusable) — see
  // lib/focusElement.ts.
  const menuButtonRef = useRef<View>(null);
  const { openMenuId, openMenu, closeMenu } = useSidebarContextMenu();
  const isMenuOpen = openMenuId === item.id;

  // Read inside the unmount cleanup below, which otherwise closes over the
  // `isMenuOpen` value from whichever render first mounted this effect.
  const isMenuOpenRef = useRef(isMenuOpen);
  isMenuOpenRef.current = isMenuOpen;

  useEffect(() => {
    if (!renaming) setTitleInput(item.title);
  }, [item.title, renaming]);

  // The active menu must never outlive the row it belongs to: if this
  // conversation's menu is open when this row unmounts (deleted, its
  // project just collapsed, a sidebar refresh dropped it, etc.), close it
  // rather than leaving a popup with no row behind it.
  useEffect(() => {
    return () => {
      if (isMenuOpenRef.current) closeMenu();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Submit (Enter) on web fires a blur right afterwards — and blur commits
  // too — so without this guard every Enter would PATCH the rename twice.
  const isCommittingRef = useRef(false);

  /** Commits the edit (Enter / blur — "outside click" blurs the input).
   * Empty or whitespace-only titles are rejected client-side: the input
   * simply closes and the conversation keeps its existing title (the
   * backend would 422 an empty title anyway). A rejected API call shows
   * the error inline and keeps the input open for a retry — it must never
   * look like the rename succeeded when it didn't. */
  async function commitRename(): Promise<void> {
    if (isCommittingRef.current) return;
    const trimmed = titleInput.trim();
    if (!trimmed || trimmed === item.title) {
      setRenaming(false);
      setRenameError(null);
      return;
    }
    isCommittingRef.current = true;
    setRenameError(null);
    try {
      await onRename(item.id, trimmed);
      setRenaming(false);
    } catch (err) {
      setRenameError(
        err instanceof Error && err.message ? err.message : 'Could not rename this conversation.'
      );
    } finally {
      isCommittingRef.current = false;
    }
  }

  /** Escape abandons the edit without touching the API — restores the
   * input to the saved title so re-entering rename mode starts clean. */
  function cancelRename(): void {
    setRenaming(false);
    setRenameError(null);
    setTitleInput(item.title);
  }

  // Escape-to-cancel for the rename input — same web-only, real-DOM guard
  // as SidebarContextMenuProvider's Escape-closes-menu handler (native
  // software keyboards have no Escape key to deliver here).
  useEffect(() => {
    if (!renaming) return undefined;
    if (Platform.OS !== 'web' || typeof document === 'undefined') return undefined;
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      cancelRename();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renaming, item.title]);

  function handleDeletePress(): void {
    const label = safeText(item.title, 'this conversation');
    const message = `Delete "${label}"? This removes its messages permanently. This cannot be undone.`;
    if (Platform.OS === 'web') {
      if (window.confirm(message)) onDelete(item.id);
      return;
    }
    Alert.alert('Delete conversation', message, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => onDelete(item.id) },
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
          onPress: () => {
            // Deferred one macrotask — same reasoning as
            // ConversationSidebar's handleCloseAddToProject: pressing this
            // item unmounts the menu Modal, and react-native-web's Modal
            // focus-trap teardown then restores focus to the element it
            // captured (this row's ⋮ button). If the rename input mounts
            // (autoFocus) before that teardown runs, the teardown steals
            // focus straight back, firing the input's onBlur → an immediate
            // commit-with-the-unchanged-title → "Rename" visibly does
            // nothing and nothing is ever PATCHed. Deferring lets the
            // teardown finish before the input mounts and takes focus.
            setTimeout(() => setRenaming(true), 0);
          },
        },
        {
          key: 'add-to-project',
          label: 'Add to project',
          onPress: () => onAddToProject(item.id, item.title, () => focusRef(menuButtonRef)),
        },
        ...(onRemoveFromProject
          ? [
              {
                key: 'remove-from-project',
                label: 'Remove from project',
                onPress: () => onRemoveFromProject(item.id),
              },
            ]
          : []),
        { key: 'delete', label: 'Delete', destructive: true, onPress: handleDeletePress },
      ];
      openMenu({ menuId: item.id, anchor: { x, y, width, height }, actions });
    });
  }

  if (renaming) {
    return (
      <View
        style={[
          styles.row,
          {
            backgroundColor: active ? dark.elevated : 'transparent',
            borderRadius: theme.radius.sm,
          },
        ]}
      >
        <View style={styles.renameWrap}>
          <TextInput
            style={[
              styles.renameInput,
              {
                fontFamily: theme.fonts.body,
                color: dark.text,
                backgroundColor: dark.elevated,
                borderRadius: theme.radius.sm,
              },
            ]}
            value={titleInput}
            onChangeText={(text) => {
              setTitleInput(text);
              setRenameError(null);
            }}
            autoFocus
            onSubmitEditing={commitRename}
            onBlur={commitRename}
            returnKeyType="done"
            accessibilityLabel="Conversation title"
          />
          {renameError && (
            <Text
              style={[styles.renameErrorText, { fontFamily: theme.fonts.body, color: dark.danger }]}
              accessibilityRole="alert"
            >
              {renameError}
            </Text>
          )}
        </View>
      </View>
    );
  }

  const busy = deleting || removingFromProject;

  return (
    <RowSurface active={active}>
      <Pressable
        style={styles.rowMain}
        onPress={() => onSelect(item.id)}
        accessibilityRole="button"
        accessibilityLabel={safeText(item.title, 'New conversation')}
      >
        <Text
          numberOfLines={1}
          style={[
            styles.rowTitle,
            { fontFamily: theme.fonts.body, color: active ? dark.text : dark.subtext },
            // fontWeight stays explicit: the sidebar's own test suite
            // asserts the active row reads bolder, and screen-reader-
            // adjacent tooling keys off weight, not family.
            active && { fontFamily: theme.fonts.bodySemibold, fontWeight: '600' },
          ]}
        >
          {safeText(item.title, 'New conversation')}
        </Text>
        {item.lastMessagePreview && (
          <Text
            numberOfLines={1}
            style={[
              styles.rowPreview,
              { fontFamily: theme.fonts.body, color: active ? dark.subtext : dark.faint },
            ]}
          >
            {item.lastMessagePreview}
          </Text>
        )}
      </Pressable>
      {busy ? (
        <ActivityIndicator size="small" color={dark.faint} style={styles.rowMenuButton} />
      ) : (
        <View ref={triggerRef} style={styles.rowMenuButton}>
          <MenuTrigger
            ref={menuButtonRef}
            onPress={handleMenuTriggerPress}
            isMenuOpen={isMenuOpen}
            label={`Options for ${safeText(item.title, 'this conversation')}`}
          />
        </View>
      )}
    </RowSurface>
  );
}

/** The row's hover/active surface — hover tint + keyboard focus ring, so
 * the sidebar list responds to the pointer and the keyboard the same way
 * NavRail's buttons do. */
function RowSurface({ active, children }: { active: boolean; children: React.ReactNode }) {
  const theme = useTheme();
  const [hovered, setHovered] = useState(false);
  return (
    <View
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      style={[
        styles.row,
        {
          borderRadius: theme.radius.sm,
          backgroundColor: active ? dark.elevated : hovered ? dark.cardPressed : 'transparent',
        },
      ]}
    >
      {children}
    </View>
  );
}

/** The three-dot trigger with its own hover/focus feedback — the glyph is
 * the shared MoreIcon, not a text glyph, so it renders identically on
 * every platform and takes palette colors. */
const MenuTrigger = forwardRef<View, { onPress: () => void; isMenuOpen: boolean; label: string }>(
  function MenuTrigger({ onPress, isMenuOpen, label }, ref) {
    const theme = useTheme();
    const [hovered, setHovered] = useState(false);
    const [focused, setFocused] = useState(false);
    return (
      <Pressable
        ref={ref}
        style={[
          styles.rowMenuButtonPressable,
          {
            borderRadius: theme.radius.sm,
            backgroundColor: hovered || isMenuOpen ? dark.border : 'transparent',
          },
          focused && { borderColor: dark.focusRing, borderWidth: 2 },
        ]}
        onPress={onPress}
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => setHovered(false)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ expanded: isMenuOpen }}
        aria-expanded={isMenuOpen}
        {...WEB_MENU_TRIGGER_ARIA_PROPS}
      >
        <MoreIcon size={16} color={hovered || isMenuOpen ? dark.text : dark.faint} />
      </Pressable>
    );
  }
);

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 8,
    position: 'relative',
  },
  rowMain: {
    flex: 1,
    paddingVertical: 8,
    paddingHorizontal: 10,
    minHeight: 40,
    justifyContent: 'center',
  },
  rowTitle: { fontSize: 13 },
  rowPreview: { fontSize: 11, marginTop: 2 },
  rowMenuButton: {
    paddingHorizontal: 6,
    paddingVertical: 8,
    minWidth: 36,
    minHeight: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowMenuButtonPressable: {
    padding: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  renameWrap: { flex: 1 },
  renameInput: {
    fontSize: 13,
    paddingVertical: 6,
    paddingHorizontal: 8,
    minHeight: 36,
  },
  renameErrorText: { fontSize: 11, paddingHorizontal: 8, paddingTop: 2 },
});
