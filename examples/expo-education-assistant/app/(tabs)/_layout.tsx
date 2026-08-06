import { useConversations, useProjects } from 'education-assistant-client';
import { Redirect, Slot, usePathname, useRouter } from 'expo-router';
import { useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { AppDrawer } from '@/components/AppDrawer';
import { BottomNav } from '@/components/BottomNav';
import { EduM8Symbol } from '@/components/EduM8Logo';
import { NavRail, type NavSection } from '@/components/NavRail';
import { useAuth } from '@/lib/AuthProvider';
import { ChatConversationsProvider } from '@/lib/ChatConversationsContext';
import { useClient } from '@/lib/ClientProvider';
import { DARK_PALETTE, usePreferences, useTheme } from '@/lib/Preferences';

const WIDE_PANEL_BREAKPOINT_PX = 900;

const ROUTE_BY_SECTION: Record<NavSection, string> = {
  chat: '/chat',
  search: '/search',
  documents: '/documents',
  settings: '/settings',
};

/**
 * Auth guard + whole-app chrome for every screen under (tabs) — Chat,
 * Search, Documents, Settings. Lives here (not the root layout) so
 * /login and /auth-callback stay reachable as ordinary sibling routes
 * regardless of auth status, while every route that resolves into this
 * group is gated the same way no matter how it was reached (tab press,
 * deep link, typed URL, browser back/forward on web).
 *
 * Replaces React Navigation's <Tabs> (a bottom bar on every viewport,
 * including desktop web) with a responsive Slot-based shell — the same
 * pattern chat/_layout.tsx already used just for chat routes, now
 * lifted up a level so the nav rail + conversation drawer are available
 * from Search/Documents/Settings too, not only Chat. Wide web gets a
 * persistent icon-only rail plus a resizable/collapsible drawer; narrow
 * web and native fall back to a top bar + slim bottom nav, with the
 * drawer as a hamburger-triggered overlay — see NavRail/AppDrawer/
 * BottomNav for the pieces themselves.
 */
export default function TabsLayout() {
  const { status } = useAuth();
  const theme = useTheme();
  const { preferences, update } = usePreferences();
  const { width } = useWindowDimensions();
  const router = useRouter();
  const pathname = usePathname();
  const { client } = useClient();
  const conversations = useConversations(client);
  const projects = useProjects(client);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const isWide = Platform.OS === 'web' && width >= WIDE_PANEL_BREAKPOINT_PX;

  const segments = pathname.split('/').filter(Boolean);
  const activeSection: NavSection | null =
    segments[0] === 'chat' ||
    segments[0] === 'search' ||
    segments[0] === 'documents' ||
    segments[0] === 'settings'
      ? (segments[0] as NavSection)
      : null;
  // "/chat/c1" -> "c1"; "/chat/new" and "/chat" both have no active
  // conversation to highlight in the drawer.
  const lastSegment = segments[segments.length - 1];
  const activeConversationId =
    activeSection === 'chat' && lastSegment && lastSegment !== 'chat' && lastSegment !== 'new'
      ? lastSegment
      : null;

  if (status === 'loading') {
    return (
      <View style={[styles.splash, { backgroundColor: theme.background }]}>
        {/* The mark itself never spins — see EduM8Logo's docs. The
            ActivityIndicator below it is the "thinking" signal. */}
        <EduM8Symbol size={40} style={styles.splashMark} />
        <ActivityIndicator color={theme.accent} />
      </View>
    );
  }

  if (status === 'unauthenticated') {
    return <Redirect href="/login" />;
  }

  function handleSelect(id: string): void {
    router.push(`/chat/${id}`);
    setDrawerOpen(false);
  }

  function handleNewChat(): void {
    router.push('/chat/new');
    setDrawerOpen(false);
  }

  function handleNavigate(section: NavSection): void {
    router.push(ROUTE_BY_SECTION[section] as never);
    setDrawerOpen(false);
  }

  const drawerProps = {
    conversations,
    projects,
    activeConversationId,
    onSelect: handleSelect,
    onNewChat: handleNewChat,
  };

  return (
    <ChatConversationsProvider value={{ refreshConversations: () => conversations.refresh() }}>
      <View style={[styles.root, { backgroundColor: theme.background }]}>
        {isWide && (
          <NavRail
            active={activeSection}
            onNavigate={handleNavigate}
            drawerCollapsed={preferences.sidebarCollapsed}
            onToggleDrawer={() => update('sidebarCollapsed', !preferences.sidebarCollapsed)}
          />
        )}

        {isWide && !preferences.sidebarCollapsed && (
          <AppDrawer
            width={preferences.sidebarWidth}
            onResizeEnd={(w) => update('sidebarWidth', w)}
            {...drawerProps}
          />
        )}

        <View style={styles.content}>
          {!isWide && (
            <View
              style={[
                styles.topBar,
                { backgroundColor: theme.card, borderBottomColor: theme.border },
              ]}
            >
              <Pressable
                style={styles.hamburgerButton}
                onPress={() => setDrawerOpen(true)}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="Open conversation list"
              >
                <Text style={[styles.hamburgerIcon, { color: theme.text }]}>☰</Text>
              </Pressable>
              <View style={styles.topBarBrand}>
                <EduM8Symbol size={18} />
                <Text
                  style={[
                    styles.topBarTitle,
                    { color: theme.text, fontFamily: theme.fonts.display },
                  ]}
                >
                  EduM8
                </Text>
              </View>
              {activeSection === 'chat' ? (
                <Pressable
                  style={styles.hamburgerButton}
                  onPress={handleNewChat}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel="New chat"
                >
                  <Text style={[styles.newChatIcon, { color: theme.accent }]}>+</Text>
                </Pressable>
              ) : (
                <View style={styles.hamburgerButton} />
              )}
            </View>
          )}

          <View style={styles.slot}>
            <Slot />
          </View>

          {!isWide && <BottomNav active={activeSection} onNavigate={handleNavigate} />}
        </View>

        {!isWide && drawerOpen && (
          <View style={styles.overlay}>
            <Pressable
              style={[styles.overlayBackdrop, { backgroundColor: theme.overlay }]}
              onPress={() => setDrawerOpen(false)}
              accessibilityRole="button"
              accessibilityLabel="Close conversation list"
            />
            <View style={[styles.drawerPanel, { backgroundColor: DARK_PALETTE.background }]}>
              <AppDrawer
                width={280}
                onResizeEnd={() => {}}
                {...drawerProps}
                onRequestClose={() => setDrawerOpen(false)}
              />
            </View>
          </View>
        )}
      </View>
    </ChatConversationsProvider>
  );
}

const styles = StyleSheet.create({
  splash: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  splashMark: { marginBottom: 16 },
  root: { flex: 1, flexDirection: 'row' },
  content: { flex: 1 },
  slot: { flex: 1 },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  hamburgerButton: {
    padding: 8,
    minWidth: 36,
    minHeight: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  hamburgerIcon: { fontSize: 20 },
  newChatIcon: { fontSize: 22, fontWeight: '600' },
  topBarBrand: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  topBarTitle: { fontSize: 16, fontWeight: '600' },
  overlay: { ...StyleSheet.absoluteFillObject, flexDirection: 'row', zIndex: 20 },
  overlayBackdrop: { flex: 1 },
  drawerPanel: { width: 280 },
});
