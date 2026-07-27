import { Redirect, Tabs } from 'expo-router';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { useAuth } from '@/lib/AuthProvider';

/**
 * Auth guard for every screen under (tabs) — Chat, Search, Documents,
 * Settings. Lives here (not the root layout) so /login and /auth-callback
 * stay reachable as ordinary sibling routes regardless of auth status,
 * while every route that resolves into this group is gated the same way
 * no matter how it was reached (tab press, deep link, typed URL, browser
 * back/forward on web).
 */
export default function TabsLayout() {
  const { status } = useAuth();

  if (status === 'loading') {
    return (
      <View style={styles.splash}>
        <ActivityIndicator />
      </View>
    );
  }

  if (status === 'unauthenticated') {
    return <Redirect href="/login" />;
  }

  return (
    <Tabs screenOptions={{ headerShown: false, headerTitleAlign: 'center' }}>
      {/* Redirects "/" to "/chat" — hidden from the tab bar (href: null),
          but the route itself stays reachable so a browser opened straight
          to the site root has something to render. See index.tsx. */}
      <Tabs.Screen name="index" options={{ href: null }} />
      <Tabs.Screen name="chat" options={{ title: 'Chat' }} />
      <Tabs.Screen name="search" options={{ headerShown: true, title: 'Search' }} />
      <Tabs.Screen name="documents" options={{ headerShown: true, title: 'Documents' }} />
      {/* User-facing profile/app-info screen — visible in every build.
          Its "Developer Options" section (backend base URL override) is
          separately collapsed by default, not gated behind __DEV__. */}
      <Tabs.Screen name="settings" options={{ headerShown: true, title: 'Settings' }} />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  splash: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#F8FAFC' },
});
