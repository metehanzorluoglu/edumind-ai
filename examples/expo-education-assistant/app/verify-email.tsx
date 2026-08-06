import { Link, useLocalSearchParams } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import { EduM8Logo } from '@/components/EduM8Logo';

/** The `status` query param GET /auth/verify-email's redirect appends —
 * see rag-backend's app/api/routes_auth.py::get_verify_email and
 * app/core/verification_service.py::VerificationResult. */
type VerifyStatus = 'success' | 'invalid' | 'expired' | 'already_used';

function describeStatus(status: string | undefined): { title: string; body: string; ok: boolean } {
  switch (status as VerifyStatus) {
    case 'success':
      return {
        title: 'Email verified',
        body: 'Your email address has been confirmed. You can now sign in.',
        ok: true,
      };
    case 'expired':
      return {
        title: 'Link expired',
        body: 'This verification link has expired. Sign in with your email and password to request a new one.',
        ok: false,
      };
    case 'already_used':
      return {
        title: 'Link already used',
        body: 'This verification link has already been used. If your account still isn’t verified, sign in to request a new link.',
        ok: false,
      };
    case 'invalid':
    default:
      return {
        title: 'Invalid link',
        body: 'This verification link isn’t valid. Sign in with your email and password to request a new one.',
        ok: false,
      };
  }
}

export default function VerifyEmailScreen() {
  const params = useLocalSearchParams<{ status?: string }>();
  const { title, body, ok } = describeStatus(
    typeof params.status === 'string' ? params.status : undefined
  );

  return (
    <View style={styles.container}>
      <View style={styles.card}>
        <EduM8Logo size={30} style={styles.brandLogo} />
        <Text style={[styles.title, ok ? styles.titleOk : styles.titleFail]}>{title}</Text>
        <Text style={styles.body}>{body}</Text>
        <Link href="/login" style={styles.link}>
          <Text style={styles.linkText}>Continue to sign in</Text>
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
  title: { fontSize: 20, fontWeight: '700', textAlign: 'center' },
  titleOk: { color: '#166534' },
  titleFail: { color: '#B91C1C' },
  body: { fontSize: 14, color: '#64748B', textAlign: 'center', lineHeight: 20, marginTop: 4 },
  link: {
    marginTop: 20,
    backgroundColor: '#2F5FE0',
    borderRadius: 8,
    paddingVertical: 12,
    paddingHorizontal: 24,
  },
  linkText: { color: '#FFFFFF', fontWeight: '600', fontSize: 15 },
});
