import { useConversations, useProjects } from 'education-assistant-client';
import { Slot, usePathname, useRouter } from 'expo-router';
import { useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { ConversationSidebar } from '@/components/ConversationSidebar';
import { ChatConversationsProvider } from '@/lib/ChatConversationsContext';
import { useClient } from '@/lib/ClientProvider';

const WIDE_PANEL_BREAKPOINT_PX = 900;

/**
 * Wraps every /chat/* screen with the conversation sidebar: a persistent
 * side panel on wide web (desktop-class viewport), or a hamburger-triggered
 * overlay drawer everywhere else (native at any width, narrow web) — see
 * ConversationSidebar's own docs for why the split lives here and not in
 * the sidebar component itself.
 */
export default function ChatLayout() {
  const { width } = useWindowDimensions();
  const isWidePanel = Platform.OS === 'web' && width >= WIDE_PANEL_BREAKPOINT_PX;
  const [drawerOpen, setDrawerOpen] = useState(false);
  const router = useRouter();
  const pathname = usePathname();
  const { client } = useClient();
  const conversations = useConversations(client);
  const projects = useProjects(client);

  // "/chat/c1" -> "c1"; "/chat/new" and "/chat" both have no active
  // conversation to highlight in the sidebar.
  const segments = pathname.split('/').filter(Boolean);
  const lastSegment = segments[segments.length - 1];
  const activeConversationId =
    lastSegment && lastSegment !== 'chat' && lastSegment !== 'new' ? lastSegment : null;

  function handleSelect(id: string): void {
    router.push(`/chat/${id}`);
  }

  function handleNewChat(): void {
    router.push('/chat/new');
  }

  return (
    <ChatConversationsProvider value={{ refreshConversations: () => conversations.refresh() }}>
      <View style={styles.root}>
        {isWidePanel && (
          <View style={styles.panel}>
            <ConversationSidebar
              conversations={conversations}
              projects={projects}
              activeConversationId={activeConversationId}
              onSelect={handleSelect}
              onNewChat={handleNewChat}
            />
          </View>
        )}

        <View style={styles.content}>
          {!isWidePanel && (
            <View style={styles.topBar}>
              <Pressable
                style={styles.hamburgerButton}
                onPress={() => setDrawerOpen(true)}
                hitSlop={8}
                accessibilityLabel="Open conversation list"
              >
                <Text style={styles.hamburgerIcon}>☰</Text>
              </Pressable>
              <Text style={styles.topBarTitle}>Chat</Text>
              <Pressable
                style={styles.hamburgerButton}
                onPress={handleNewChat}
                hitSlop={8}
                accessibilityLabel="New chat"
              >
                <Text style={styles.newChatIcon}>+</Text>
              </Pressable>
            </View>
          )}
          <Slot />
        </View>

        {!isWidePanel && drawerOpen && (
          <View style={styles.overlay}>
            <Pressable
              style={styles.overlayBackdrop}
              onPress={() => setDrawerOpen(false)}
              accessibilityLabel="Close conversation list"
            />
            <View style={styles.drawerPanel}>
              <ConversationSidebar
                conversations={conversations}
                projects={projects}
                activeConversationId={activeConversationId}
                onSelect={handleSelect}
                onNewChat={handleNewChat}
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
  root: { flex: 1, flexDirection: 'row', backgroundColor: '#F8FAFC' },
  panel: { width: 280, borderRightWidth: 1, borderRightColor: '#1E293B' },
  content: { flex: 1 },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#E2E8F0',
    backgroundColor: '#FFFFFF',
  },
  hamburgerButton: { padding: 4 },
  hamburgerIcon: { fontSize: 20, color: '#0F172A' },
  newChatIcon: { fontSize: 22, color: '#0F172A', fontWeight: '600' },
  topBarTitle: { fontSize: 16, fontWeight: '700', color: '#0F172A' },
  overlay: { ...StyleSheet.absoluteFillObject, flexDirection: 'row', zIndex: 20 },
  overlayBackdrop: { flex: 1, backgroundColor: 'rgba(15, 23, 42, 0.5)' },
  drawerPanel: { width: 280 },
});
