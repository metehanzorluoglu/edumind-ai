import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import {
  Dimensions,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
} from 'react-native';

export interface SidebarContextMenuAction {
  key: string;
  label: string;
  /** Renders this item's label in the destructive (red) color — reserved for Delete. */
  destructive?: boolean;
  onPress: () => void;
}

/** A trigger button's on-screen box, from `measureInWindow` (RN) / `getBoundingClientRect` (web) — see ConversationRow/ProjectRow's usage. */
export interface SidebarContextMenuAnchor {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface OpenMenuArgs {
  /** Whatever this menu belongs to — a conversation id or a project id;
   * this module has no opinion on which, which is exactly what lets both
   * kinds of sidebar row share one controller and one "only one open at a
   * time" guarantee (see SidebarContextMenuProvider's own docs). */
  menuId: string;
  anchor: SidebarContextMenuAnchor;
  actions: SidebarContextMenuAction[];
}

interface SidebarContextMenuContextValue {
  /** The conversation-or-project id whose menu is currently open, or null — only ever one at a time, regardless of kind (see SidebarContextMenuProvider). */
  openMenuId: string | null;
  openMenu: (args: OpenMenuArgs) => void;
  closeMenu: () => void;
}

const SidebarContextMenuContext = createContext<SidebarContextMenuContextValue | null>(null);

/**
 * Falls back to inert no-ops outside a provider (same convention as
 * useRefreshConversations in ChatConversationsContext.tsx) — a row
 * rendered directly in a unit test without <SidebarContextMenuProvider>
 * simply never opens a menu, rather than throwing.
 */
export function useSidebarContextMenu(): SidebarContextMenuContextValue {
  const ctx = useContext(SidebarContextMenuContext);
  return (
    ctx ?? {
      openMenuId: null,
      openMenu: () => {},
      closeMenu: () => {},
    }
  );
}

const MENU_WIDTH = 190;
const MENU_ITEM_HEIGHT = 40;
const MENU_VERTICAL_PADDING = 8;
const EDGE_MARGIN = 8;
const TRIGGER_GAP = 4;

interface Placement {
  top: number;
  left: number;
}

/**
 * Screen-coordinate placement for the popup, from the trigger button's own
 * on-screen box (never the row's position in the list — the list can
 * scroll or reorder freely without this math changing). Right-aligns to
 * the trigger by default (matching where the three-dot button sits) and
 * flips left/up whenever the default placement would extend past the
 * viewport edge, so the popup stays fully on-screen without covering the
 * trigger any more than the default below-and-right placement already
 * would.
 */
function computePlacement(anchor: SidebarContextMenuAnchor, itemCount: number): Placement {
  const { width: windowWidth, height: windowHeight } = Dimensions.get('window');
  const menuHeight = itemCount * MENU_ITEM_HEIGHT + MENU_VERTICAL_PADDING * 2;

  let left = anchor.x + anchor.width - MENU_WIDTH;
  if (left < EDGE_MARGIN) left = anchor.x;
  if (left + MENU_WIDTH > windowWidth - EDGE_MARGIN) left = windowWidth - MENU_WIDTH - EDGE_MARGIN;
  left = Math.max(EDGE_MARGIN, left);

  let top = anchor.y + anchor.height + TRIGGER_GAP;
  if (top + menuHeight > windowHeight - EDGE_MARGIN) {
    top = anchor.y - menuHeight - TRIGGER_GAP;
  }
  top = Math.max(EDGE_MARGIN, top);

  return { top, left };
}

// React Native's ViewStyle type has no 'fixed' literal (native has no such
// concept) — react-native-web does support and needs it here, so the
// popup stays pinned to the viewport instead of scrolling away with the
// sidebar's FlatList. Isolated to this one cast rather than widening the
// whole style's type.
const WEB_FIXED_POSITION = 'fixed' as ViewStyle['position'];

/**
 * Renders whichever sidebar row's context menu is currently open — a
 * conversation row's (Rename / Add to project / Remove from project /
 * Delete) or a project row's (Rename / Edit description / Delete project)
 * — through React Native's `Modal`. On web, react-native-web's Modal
 * portals via `ReactDOM.createPortal` straight to `document.body` (see
 * node_modules/react-native-web/dist/exports/Modal/ModalPortal.js), and on
 * iOS/Android it's a true native modal layer — so the popup is never
 * subject to a row's or the sidebar FlatList's overflow/stacking context,
 * however many conversations or projects are rendered above or below it.
 *
 * Exactly one menu can be open at a time, *across both kinds*: `open` is a
 * single piece of state here, not per-row state, and it's keyed by
 * `menuId` (a conversation id or a project id, this module doesn't care
 * which) — never by list position — so scrolling, a sidebar refresh,
 * expanding/collapsing a project, or a rename can never leave a menu
 * pointing at the wrong row, and opening a project's menu always closes
 * an open conversation menu (and vice versa), since they share this one
 * controller. (A row that unmounts while it owns the open menu — e.g.
 * because its conversation was deleted, or its project was collapsed —
 * closes the menu itself; see ConversationRow's/ProjectRow's own cleanup
 * effects.)
 *
 * Mount this once, wrapping the sidebar's content but OUTSIDE its
 * FlatList/ScrollView (see ConversationSidebar.tsx) — the Modal it renders
 * is a sibling of `children`, never a descendant of anything scrollable.
 *
 * `children` may also be a function receiving this same context value —
 * lets the FlatList itself (a child of this provider, not a caller of
 * useSidebarContextMenu() the way ConversationRow/ProjectRow are) wire
 * `closeMenu` into its own onScroll without needing a separate component
 * just to call the hook.
 */
export function SidebarContextMenuProvider({
  children,
}: {
  children: ReactNode | ((value: SidebarContextMenuContextValue) => ReactNode);
}) {
  const [open, setOpen] = useState<OpenMenuArgs | null>(null);

  const closeMenu = useCallback(() => setOpen(null), []);
  const openMenu = useCallback((args: OpenMenuArgs) => setOpen(args), []);

  useEffect(() => {
    if (!open) return undefined;

    // Resizing the window (or, on native, rotating the device) can move or
    // invalidate the trigger's captured coordinates — closing is simpler
    // and just as correct as re-measuring a button that may no longer be
    // where it was.
    const dimensionsSubscription = Dimensions.addEventListener('change', closeMenu);

    // `typeof document !== 'undefined'` guards against Platform.OS being
    // 'web' with no real DOM behind it — not just an oddity of this
    // codebase's own tests (which force Platform.OS to 'web' to exercise
    // web-only business logic like window.confirm without a full jsdom
    // environment), but also true of react-test-renderer generally.
    let handleKeyDown: ((event: KeyboardEvent) => void) | null = null;
    if (Platform.OS === 'web' && typeof document !== 'undefined') {
      handleKeyDown = (event: KeyboardEvent) => {
        if (event.key === 'Escape') closeMenu();
      };
      document.addEventListener('keydown', handleKeyDown);
    }

    return () => {
      dimensionsSubscription.remove();
      if (handleKeyDown) document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, closeMenu]);

  const placement = open ? computePlacement(open.anchor, open.actions.length) : null;
  const contextValue: SidebarContextMenuContextValue = {
    openMenuId: open?.menuId ?? null,
    openMenu,
    closeMenu,
  };

  return (
    <SidebarContextMenuContext.Provider value={contextValue}>
      {typeof children === 'function' ? children(contextValue) : children}
      <Modal visible={!!open} transparent animationType="none" onRequestClose={closeMenu}>
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={closeMenu}
          accessibilityRole="button"
          accessibilityLabel="Close menu"
        />
        {open && placement && (
          <View
            style={[
              styles.menu,
              { top: placement.top, left: placement.left },
              Platform.OS === 'web' && { position: WEB_FIXED_POSITION },
            ]}
            role="menu"
          >
            {open.actions.map((action) => (
              <Pressable
                key={action.key}
                style={styles.menuItem}
                onPress={() => {
                  closeMenu();
                  action.onPress();
                }}
                role="menuitem"
                accessibilityLabel={action.label}
              >
                <Text
                  style={[styles.menuItemText, action.destructive && styles.menuItemDestructive]}
                >
                  {action.label}
                </Text>
              </Pressable>
            ))}
          </View>
        )}
      </Modal>
    </SidebarContextMenuContext.Provider>
  );
}

const styles = StyleSheet.create({
  menu: {
    position: 'absolute',
    width: MENU_WIDTH,
    backgroundColor: '#1E293B',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#334155',
    paddingVertical: MENU_VERTICAL_PADDING / 2,
    zIndex: 1000,
    elevation: 24,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.35,
    shadowRadius: 12,
  },
  menuItem: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    minHeight: MENU_ITEM_HEIGHT,
    justifyContent: 'center',
  },
  menuItemText: { color: '#E2E8F0', fontSize: 13 },
  menuItemDestructive: { color: '#FCA5A5' },
});
