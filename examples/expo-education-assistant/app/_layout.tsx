import { AuthProvider } from '@/lib/AuthProvider';
import { ClientProvider } from '@/lib/ClientProvider';
import { FeatureFlagsProvider } from '@/lib/FeatureFlags';
import { PreferencesProvider } from '@/lib/Preferences';
import { Stack } from 'expo-router';

export default function RootLayout() {
  return (
    <AuthProvider>
      <ClientProvider>
        <FeatureFlagsProvider>
          <PreferencesProvider>
            <Stack screenOptions={{ headerShown: false }}>
              <Stack.Screen name="(tabs)" />
              <Stack.Screen name="login" />
              <Stack.Screen name="auth-callback" />
              <Stack.Screen name="developer-settings" />
            </Stack>
          </PreferencesProvider>
        </FeatureFlagsProvider>
      </ClientProvider>
    </AuthProvider>
  );
}
