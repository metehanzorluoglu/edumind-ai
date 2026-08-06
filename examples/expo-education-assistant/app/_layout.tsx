import { AuthProvider } from '@/lib/AuthProvider';
import { ClientProvider } from '@/lib/ClientProvider';
import { FeatureFlagsProvider } from '@/lib/FeatureFlags';
import { PreferencesProvider } from '@/lib/Preferences';
import { Stack } from 'expo-router';
import Head from 'expo-router/head';

export default function RootLayout() {
  return (
    <AuthProvider>
      <ClientProvider>
        <FeatureFlagsProvider>
          <PreferencesProvider>
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
          </PreferencesProvider>
        </FeatureFlagsProvider>
      </ClientProvider>
    </AuthProvider>
  );
}
