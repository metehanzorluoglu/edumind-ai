import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import * as SplashScreen from 'expo-splash-screen';
import { EduM8Symbol } from '@/components/EduM8Logo';
import { AuthProvider } from '@/lib/AuthProvider';
import { ClientProvider } from '@/lib/ClientProvider';
import { FeatureFlagsProvider } from '@/lib/FeatureFlags';
import { FontsProvider, useFontsReady } from '@/lib/fonts';
import { PreferencesProvider, useTheme } from '@/lib/Preferences';
import { Stack } from 'expo-router';
import Head from 'expo-router/head';

// Standard expo-splash-screen pattern: called once at import time, before
// any component mounts, so the native splash (app.json's expo-splash-
// screen plugin) stays up until AppShell explicitly hides it below. A
// no-op on web, where there's no persistent native splash to hold.
SplashScreen.preventAutoHideAsync().catch(() => {});

export default function RootLayout() {
  return (
    <FontsProvider>
      <PreferencesProvider>
        <AppShell />
      </PreferencesProvider>
    </FontsProvider>
  );
}

/**
 * Gates the whole app on brand fonts being ready before anything renders
 * — a screen mounting with the system font stack and then reflowing to
 * Source Serif/Hanken Grotesk a moment later would read as a layout bug,
 * not a loading state. The wait is brief (bundled font files, not a
 * network fetch of meaningful size) and shows the same at-rest symbol
 * used everywhere else loading happens (see (tabs)/_layout.tsx) rather
 * than a blank screen.
 */
function AppShell() {
  const fontsReady = useFontsReady();
  const theme = useTheme();

  useEffect(() => {
    if (fontsReady) {
      SplashScreen.hideAsync().catch(() => {});
    }
  }, [fontsReady]);

  if (!fontsReady) {
    return (
      <View style={[styles.loading, { backgroundColor: theme.background }]}>
        <EduM8Symbol size={40} />
      </View>
    );
  }

  return (
    <AuthProvider>
      <ClientProvider>
        <FeatureFlagsProvider>
          {/* Web only (no-ops on native). app/+html.tsx already renders this
              same title/description statically for the very first paint —
              but expo-router mounts a react-helmet-async provider on web
              that reconciles <head> on every route change, and with no
              screen ever rendering a <Head> of its own it was reconciling
              to an *empty* <title>, blanking out the static one from
              +html.tsx after hydration. This is the default every screen
              falls back to; a screen can still override it with its own
              <Head> if a route ever needs a distinct tab title. */}
          <Head>
            <title>EduM8 — Education Research Assistant</title>
          </Head>
          <Stack screenOptions={{ headerShown: false }}>
            <Stack.Screen name="(tabs)" />
            <Stack.Screen name="login" />
            <Stack.Screen name="auth-callback" />
            <Stack.Screen name="check-email" />
            <Stack.Screen name="verify-email" />
            <Stack.Screen name="developer-settings" />
          </Stack>
        </FeatureFlagsProvider>
      </ClientProvider>
    </AuthProvider>
  );
}

const styles = StyleSheet.create({
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
