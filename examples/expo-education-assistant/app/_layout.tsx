import { AuthProvider } from '@/lib/AuthProvider';
import { ClientProvider } from '@/lib/ClientProvider';
import { FeatureFlagsProvider } from '@/lib/FeatureFlags';
import { Stack } from 'expo-router';

export default function RootLayout() {
  return (
    <AuthProvider>
      <ClientProvider>
        <FeatureFlagsProvider>
          <Stack screenOptions={{ headerShown: false }}>
            <Stack.Screen name="(tabs)" />
            <Stack.Screen name="login" />
            <Stack.Screen name="auth-callback" />
          </Stack>
        </FeatureFlagsProvider>
      </ClientProvider>
    </AuthProvider>
  );
}
