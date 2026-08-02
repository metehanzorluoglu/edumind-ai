import { Link, Redirect, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { describeAuthError, useAuth } from '@/lib/AuthProvider';

/**
 * Web landing route for GET /auth/{provider}/callback's final redirect
 * (`${webOrigin}/auth-callback?auth_code=...` or `?auth_error=...`) — see
 * AuthProvider.startOAuth's web branch. Native never really lands here in
 * the primary flow: expo-web-browser's openAuthSessionAsync intercepts the
 * matching redirect at the OS level and hands the URL back as a promise
 * result instead of dispatching a normal deep link, so this route is web's
 * counterpart to that in-process handling — kept as a real route mainly for
 * robustness / manual testing.
 */
export default function AuthCallbackScreen() {
  const { exchangeCode, status, error } = useAuth();
  const params = useLocalSearchParams<{ auth_code?: string; auth_error?: string }>();
  const [localError, setLocalError] = useState<string | null>(null);
  const handled = useRef(false);

  useEffect(() => {
    if (handled.current) return;
    handled.current = true;

    if (params.auth_error) {
      setLocalError(describeAuthError(String(params.auth_error)));
      return;
    }
    if (params.auth_code) {
      exchangeCode(String(params.auth_code));
    } else {
      setLocalError('Sign-in failed: no authorization code was returned.');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // exchangeCode() has no return value this screen can await directly
  // (see AuthProvider.exchangeCode) — a failed exchange (an invalid,
  // expired, or already-used auth_code; a network error; a backend
  // error) surfaces only through the shared `error` context value, with
  // `status` flipping to 'unauthenticated'. Without also reading it here,
  // this screen had no way to detect that failure at all and was stuck
  // showing "Completing sign-in…" forever — the same user-visible
  // symptom as the silentRefresh/exchangeCode race this file's tests
  // cover, but from an entirely different, independent cause.
  const exchangeFailed = status === 'unauthenticated' && Boolean(error);
  const displayError = localError ?? (exchangeFailed ? error : null);

  if (displayError) {
    return (
      <View style={styles.container}>
        <Text style={styles.errorTitle}>Sign-in failed</Text>
        <Text style={styles.errorText}>{displayError}</Text>
        <Link href="/login" style={styles.link}>
          <Text style={styles.linkText}>Back to sign in</Text>
        </Link>
      </View>
    );
  }

  if (status === 'authenticated') {
    return <Redirect href="/chat" />;
  }

  return (
    <View style={styles.container}>
      <ActivityIndicator />
      <Text style={styles.hint}>Completing sign-in…</Text>
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
    gap: 12,
  },
  hint: { color: '#64748B' },
  errorTitle: { fontWeight: '700', fontSize: 16, color: '#B91C1C' },
  errorText: { color: '#7F1D1D', textAlign: 'center', fontSize: 14 },
  link: { marginTop: 8, paddingVertical: 8, paddingHorizontal: 12 },
  linkText: { color: '#208AEF', fontWeight: '600' },
});
