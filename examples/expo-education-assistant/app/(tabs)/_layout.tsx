import { useConversations, useProjects } from 'education-assistant-client';
import { Redirect, Slot, usePathname, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
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
import { MenuIcon, PlusIcon } from '@/components/icons';
import { NavRail, type NavSection } from '@/components/NavRail';
import { IconButton } from '@/components/ui/IconButton';
import { useAuth } from '@/lib/AuthProvider';
import { ChatConversationsProvider } from '@/lib/ChatConversationsContext';
import { useClient } from '@/lib/ClientProvider';
import { flushBeforeNavigate } from '@/lib/navigationFlushGuard';
import { DARK_PALETTE, usePreferences, useTheme } from '@/lib/Preferences';
import {
  getLastSectionLocation,
  recordSectionLocation,
  type LastLocationSection,
} from '@/lib/sectionLastLocation';

const WIDE_PANEL_BREAKPOINT_PX = 900;

const ROUTE_BY_SECTION: Record<NavSection, string> = {
  chat: '/chat',
  search: '/search',
  documents: '/documents',
  notes: '/notes',
  writing: '/writing',
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
    segments[0] === 'notes' ||
    segments[0] === 'writing' ||
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

  // Milestone 5.5.2 Part 26 — records every pathname visited inside
  // Writing/Documents/Notes so this section's own nav icon can return
  // to it later (see handleNavigate below) — manual testing found the
  // nav icon always going to the bare section dashboard, regardless of
  // where the user actually was, read as "continuity is broken" even
  // though no STATE was actually lost (that's sessionNavCache's job,
  // a different concern — this fixes the nav icon's OWN destination).
  useEffect(() => {
    if (activeSection === 'writing' || activeSection === 'documents' || activeSection === 'notes') {
      recordSectionLocation(activeSection, pathname);
    }
  }, [activeSection, pathname]);

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

  // Milestone 5.5.1 Part 25 — every in-app navigation in this app funnels
  // through one of the three functions below (this layout is the single
  // <Slot/> choke point every route change passes through — see the
  // module docstring). Awaiting flushBeforeNavigate() first means a
  // screen with debounced unsaved work (currently only the Writing
  // editor — see [id].tsx's registerNavigationFlush call) always gets a
  // real chance to actually save before its own unmount tears its state
  // down, closing the race the unmount-cleanup effect alone couldn't:
  // "type -> immediately click Documents -> return Writing" must never
  // lose the edit. A no-op, effectively instant await for every other
  // screen (nothing registered).
  async function handleSelect(id: string): Promise<void> {
    await flushBeforeNavigate();
    router.push(`/chat/${id}`);
    setDrawerOpen(false);
  }

  async function handleNewChat(): Promise<void> {
    await flushBeforeNavigate();
    router.push('/chat/new');
    setDrawerOpen(false);
  }

  async function handleNavigate(section: NavSection): Promise<void> {
    // Frontend/Platform Milestone 3.2.2 Part A — desktop-only: the Chat
    // nav icon becomes the Chat drawer's toggle once already inside Chat,
    // reusing `preferences.sidebarCollapsed` (the SAME state the lower
    // NavRail collapse control already drives — see NavRail.tsx and this
    // milestone's report on why that control was removed rather than
    // leaving two buttons that do the same thing). Never touches route/
    // conversation state: toggling the drawer must not navigate, reset
    // the composer, or change which conversation is active. `isWide`
    // gates this entirely off on mobile/narrow web, which keeps
    // BottomNav's own "Chat" press exactly as it was before this
    // milestone (mobile has no persistent drawer to toggle).
    await flushBeforeNavigate();
    if (isWide && section === 'chat') {
      if (activeSection === 'chat') {
        update('sidebarCollapsed', !preferences.sidebarCollapsed);
        return;
      }
      // Coming from a non-Chat route: land on New Chat AND make sure the
      // drawer is visible (never toggle it closed if it already is open).
      router.push('/chat/new');
      if (preferences.sidebarCollapsed) update('sidebarCollapsed', false);
      return;
    }
    // Milestone 5.5.2 Part 26 — manual testing on the real production
    // stack found M5.5.1's continuity fixes insufficient: the nav icon
    // itself always pushed the section's bare dashboard route
    // (/writing, /documents, /notes), discarding wherever the user
    // actually was — sessionNavCache/navigationFlushGuard only ever
    // protected state WITHIN an already-open project/document/
    // notebook, never the nav icon's own destination. Prefer the last
    // pathname visited in that section this session (recorded by the
    // effect above) — reached from ANYWHERE (another section, or
    // already inside this one), the nav icon now means "take me back
    // to my work here," not "reset to the list." The section's own
    // list/dashboard is still one click away via its in-screen
    // breadcrumb (e.g. [id].tsx's own "Writing" back-chevron) — see
    // this milestone's report for why that satisfies "section home
    // must still be reachable" without a second, competing meaning for
    // the nav icon itself.
    const lastLocationSection: LastLocationSection | null =
      section === 'writing' || section === 'documents' || section === 'notes' ? section : null;
    const target =
      (lastLocationSection && getLastSectionLocation(lastLocationSection)) ||
      ROUTE_BY_SECTION[section];
    // Milestone 5.5.1 Part 25 — real-browser validation (checking
    // window.history.length before/after repeated same-icon clicks)
    // caught a genuine duplicate-history bug: pushing a route that's
    // already the current pathname adds a useless, identical history
    // entry every time, so the browser's Back button appears to do
    // nothing (landing on the same URL again). Still correct under the
    // last-location logic above: `target` and `pathname` naturally
    // agree whenever the remembered location IS where the user already
    // is.
    if (pathname !== target) {
      router.push(target as never);
    }
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
            onLogoPress={handleNewChat}
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
              <IconButton
                label="Open conversation list"
                onPress={() => setDrawerOpen(true)}
                icon={<MenuIcon size={20} color={theme.text} />}
              />
              <Pressable
                onPress={handleNewChat}
                accessibilityRole="button"
                accessibilityLabel="EduM8 — New chat"
                style={styles.topBarBrand}
                hitSlop={6}
              >
                <EduM8Symbol size={18} />
                <Text
                  style={[
                    styles.topBarTitle,
                    { color: theme.text, fontFamily: theme.fonts.display },
                  ]}
                >
                  EduM8
                </Text>
              </Pressable>
              {activeSection === 'chat' ? (
                <IconButton
                  label="New chat"
                  onPress={handleNewChat}
                  icon={<PlusIcon size={20} color={theme.accent} />}
                />
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
  topBarBrand: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  topBarTitle: { fontSize: 16, fontWeight: '600' },
  overlay: { ...StyleSheet.absoluteFillObject, flexDirection: 'row', zIndex: 20 },
  overlayBackdrop: { flex: 1 },
  drawerPanel: { width: 280 },
});
