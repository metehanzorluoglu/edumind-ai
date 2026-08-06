import { Link, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { EduM8Logo } from '@/components/EduM8Logo';
import { useAuth } from '@/lib/AuthProvider';

/** Fixed client-side cooldown between resend taps — a UX nicety only; the
 * backend enforces its own authoritative cooldown
 * (EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS) and returns the same
 * generic response either way, so this never needs to match it exactly. */
const RESEND_COOLDOWN_SECONDS = 60;

/** Shows enough of the address to confirm "yes, that's the one I typed"
 * without putting the full value on screen unnecessarily — this is the
 * same email the user just entered into the form themselves, not a
 * discovered secret, but masking it here is a small, cheap privacy
 * courtesy (e.g. over someone's shoulder) with no functional cost. */
export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!local || !domain) return email;
  const visible = local.slice(0, 1);
  const masked = '*'.repeat(Math.max(local.length - 1, 1));
  return `${visible}${masked}@${domain}`;
}

export default function CheckEmailScreen() {
  const { resendVerification } = useAuth();
  const params = useLocalSearchParams<{ email?: string }>();
  const email = typeof params.email === 'string' ? params.email : '';
  const [sending, setSending] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [justSent, setJustSent] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  async function handleResend(): Promise<void> {
    if (!email || sending || cooldown > 0) return;
    setSending(true);
    setJustSent(false);
    try {
      await resendVerification(email);
    } finally {
      setSending(false);
      setJustSent(true);
      setCooldown(RESEND_COOLDOWN_SECONDS);
      intervalRef.current = setInterval(() => {
        setCooldown((prev) => {
          if (prev <= 1) {
            if (intervalRef.current) clearInterval(intervalRef.current);
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    }
  }

  return (
    <View style={styles.container}>
      <View style={styles.card}>
        <EduM8Logo size={30} style={styles.brandLogo} />
        <Text style={styles.title}>Check your email</Text>
        <Text style={styles.body}>
          We sent a verification link{email ? ` to ${maskEmail(email)}` : ''}. Click the link to
          confirm your address, then come back and sign in.
        </Text>

        {justSent && !sending && (
          <View style={styles.noticeBox} accessibilityRole="alert">
            <Text style={styles.noticeText}>Verification email sent.</Text>
          </View>
        )}

        <Pressable
          style={[styles.button, (sending || cooldown > 0 || !email) && styles.buttonDisabled]}
          onPress={handleResend}
          disabled={sending || cooldown > 0 || !email}
          accessibilityRole="button"
          accessibilityLabel="Resend verification email"
        >
          {sending ? (
            <ActivityIndicator color="#FFFFFF" />
          ) : (
            <Text style={styles.buttonText}>
              {cooldown > 0 ? `Resend available in ${cooldown}s` : 'Resend verification email'}
            </Text>
          )}
        </Pressable>

        <Link href="/login" style={styles.link}>
          <Text style={styles.linkText}>Back to sign in</Text>
        </Link>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F6F7FA',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  card: { width: '100%', maxWidth: 420, gap: 8, alignItems: 'center' },
  brandLogo: { marginBottom: 8 },
  title: { fontSize: 20, fontWeight: '700', color: '#14161F', textAlign: 'center' },
  body: { fontSize: 14, color: '#64748B', textAlign: 'center', lineHeight: 20, marginBottom: 16 },
  noticeBox: { backgroundColor: '#F0FDF4', borderRadius: 8, padding: 10, marginBottom: 8 },
  noticeText: { fontSize: 13, color: '#166534', textAlign: 'center' },
  button: {
    backgroundColor: '#2F5FE0',
    borderRadius: 8,
    paddingVertical: 12,
    paddingHorizontal: 20,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
    width: '100%',
  },
  buttonDisabled: { opacity: 0.6 },
  buttonText: { color: '#FFFFFF', fontWeight: '600', fontSize: 15 },
  link: { marginTop: 16, paddingVertical: 8 },
  linkText: { color: '#2F5FE0', fontWeight: '600' },
});
