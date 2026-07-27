import { Redirect } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useAuth } from '@/lib/AuthProvider';

export type LoginBranch =
  'loading' | 'empty-no-dev-login' | 'empty-with-dev-login' | 'provider-buttons';

/**
 * The one place that decides which of the four mutually-exclusive states
 * below renders — a pure function, not inline JSX ternaries, specifically
 * so it can never drift from what a diagnostic log reports (a previous
 * version of this screen computed the same condition twice, once for a
 * dev-only log and once in the JSX itself; identical today, but two
 * copies of the same decision is exactly the kind of thing that silently
 * diverges later) and so it's directly unit-testable with no React
 * rendering involved at all.
 */
export function computeLoginBranch(state: {
  providersLoading: boolean;
  providersCount: number;
  devLoginEnabled: boolean;
}): LoginBranch {
  if (state.providersLoading && state.providersCount === 0) return 'loading';
  if (state.providersCount === 0 && !state.devLoginEnabled) return 'empty-no-dev-login';
  if (state.providersCount === 0 && state.devLoginEnabled) return 'empty-with-dev-login';
  return 'provider-buttons';
}

export default function LoginScreen() {
  const {
    status,
    providers,
    devLoginEnabled,
    providersLoading,
    error,
    startOAuth,
    devLogin,
    clearError,
    refreshProviders,
  } = useAuth();
  const [busyProvider, setBusyProvider] = useState<string | null>(null);
  const [devEmail, setDevEmail] = useState('');

  // A session restored (or just completed) elsewhere must never leave the
  // user stuck looking at the login form — bounce straight into the app.
  if (status === 'authenticated') {
    return <Redirect href="/chat" />;
  }

  const isBusy = busyProvider !== null;

  async function handleContinue(provider: string): Promise<void> {
    clearError();
    setBusyProvider(provider);
    try {
      await startOAuth(provider);
    } finally {
      setBusyProvider(null);
    }
  }

  async function handleDevLogin(): Promise<void> {
    const trimmed = devEmail.trim();
    if (!trimmed) return;
    clearError();
    setBusyProvider('dev');
    try {
      await devLogin(trimmed);
    } finally {
      setBusyProvider(null);
    }
  }

  const loginBranch = computeLoginBranch({
    providersLoading,
    providersCount: providers.length,
    devLoginEnabled,
  });

  // TEMPORARY (see EduMind AI's frontend-login-empty-state debugging
  // session) — the exact inputs to, and output of, computeLoginBranch
  // above. Safe to remove once this class of bug is confirmed fixed.
  if (__DEV__) {
    console.log('[LoginScreen] providers (parsed, from useAuth()):', providers);
    console.log('[LoginScreen] devLoginEnabled (parsed, from useAuth()):', devLoginEnabled);
    console.log('[LoginScreen] providersLoading:', providersLoading);
    console.log('[LoginScreen] computed render branch:', loginBranch);
  }

  return (
    <View style={styles.container}>
      <View style={styles.card}>
        <Text style={styles.appName}>Education Research Assistant</Text>
        <Text style={styles.subtitle}>Your private education research assistant</Text>

        {error && (
          <View style={styles.errorBox} accessibilityRole="alert">
            <Text style={styles.errorText}>{error}</Text>
            <Pressable
              onPress={clearError}
              accessibilityRole="button"
              accessibilityLabel="Dismiss error"
            >
              <Text style={styles.errorDismiss}>Dismiss</Text>
            </Pressable>
          </View>
        )}

        {loginBranch === 'loading' ? (
          <View style={styles.centered}>
            <ActivityIndicator />
          </View>
        ) : loginBranch === 'empty-no-dev-login' ? (
          <View style={styles.centered}>
            <Text style={styles.noProvidersText}>
              No sign-in providers are configured on this backend yet.
            </Text>
            <Pressable
              onPress={refreshProviders}
              accessibilityRole="button"
              accessibilityLabel="Retry loading sign-in providers"
              style={styles.retryButton}
            >
              <Text style={styles.retryText}>Retry</Text>
            </Pressable>
          </View>
        ) : loginBranch === 'empty-with-dev-login' ? (
          // No OAuth providers configured, but dev login is available (see
          // the devSection below) — this is a normal dev-environment state,
          // not the "backend has nothing configured at all" error case
          // above, so it gets its own, non-alarming copy rather than the
          // "No sign-in providers" message.
          <View style={styles.centered}>
            <Text style={styles.noProvidersText}>
              No OAuth sign-in providers are configured — use developer sign-in below.
            </Text>
          </View>
        ) : (
          providers.map((provider) => (
            <Pressable
              key={provider.provider}
              style={[styles.button, isBusy && styles.buttonDisabled]}
              onPress={() => handleContinue(provider.provider)}
              disabled={isBusy}
              accessibilityRole="button"
              accessibilityLabel={`Continue with ${provider.display_name}`}
            >
              {busyProvider === provider.provider ? (
                <ActivityIndicator color="#FFFFFF" />
              ) : (
                <Text style={styles.buttonText}>Continue with {provider.display_name}</Text>
              )}
            </Pressable>
          ))
        )}

        {devLoginEnabled && (
          <View style={styles.devSection}>
            <Text style={styles.devLabel}>Dev login (not real authentication)</Text>
            <TextInput
              style={styles.devInput}
              placeholder="you@example.com"
              placeholderTextColor="#94A3B8"
              value={devEmail}
              onChangeText={setDevEmail}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              editable={!isBusy}
              accessibilityLabel="Dev login email"
            />
            <Pressable
              style={[
                styles.button,
                styles.devButton,
                (isBusy || !devEmail.trim()) && styles.buttonDisabled,
              ]}
              onPress={handleDevLogin}
              disabled={isBusy || !devEmail.trim()}
              accessibilityRole="button"
              accessibilityLabel="Dev sign in"
            >
              {busyProvider === 'dev' ? (
                <ActivityIndicator color="#FFFFFF" />
              ) : (
                <Text style={styles.buttonText}>Dev sign in</Text>
              )}
            </Pressable>
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F8FAFC',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  card: {
    width: '100%',
    maxWidth: 380,
    gap: 12,
  },
  appName: {
    fontSize: 24,
    fontWeight: '700',
    color: '#0F172A',
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 14,
    color: '#64748B',
    textAlign: 'center',
    marginBottom: 16,
  },
  centered: { alignItems: 'center', gap: 8, paddingVertical: 8 },
  noProvidersText: { fontSize: 13, color: '#64748B', textAlign: 'center' },
  retryButton: { paddingVertical: 6, paddingHorizontal: 12 },
  retryText: { color: '#208AEF', fontWeight: '600' },
  button: {
    backgroundColor: '#208AEF',
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
  },
  buttonDisabled: { opacity: 0.6 },
  buttonText: { color: '#FFFFFF', fontWeight: '600', fontSize: 15 },
  errorBox: {
    backgroundColor: '#FEF2F2',
    borderRadius: 8,
    padding: 12,
    gap: 4,
  },
  errorText: { color: '#7F1D1D', fontSize: 13 },
  errorDismiss: { color: '#B91C1C', fontWeight: '600', fontSize: 12 },
  devSection: {
    marginTop: 16,
    paddingTop: 16,
    borderTopWidth: 1,
    borderTopColor: '#E2E8F0',
    gap: 8,
  },
  devLabel: { fontSize: 12, fontWeight: '700', color: '#92400E', textAlign: 'center' },
  devInput: {
    borderWidth: 1,
    borderColor: '#CBD5E1',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: '#FFFFFF',
    minHeight: 44,
  },
  devButton: { backgroundColor: '#64748B' },
});
