import { Link, useLocalSearchParams } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import { EduM8Logo } from '@/components/EduM8Logo';
import { useTheme } from '@/lib/Preferences';

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
  const theme = useTheme();
  const { title, body, ok } = describeStatus(
    typeof params.status === 'string' ? params.status : undefined
  );

  return (
    <View style={[styles.container, { backgroundColor: theme.background }]}>
      <View
        style={[
          styles.card,
          { backgroundColor: theme.card, borderColor: theme.border, borderRadius: theme.radius.lg },
        ]}
      >
        <EduM8Logo size={30} style={styles.brandLogo} />
        <Text
          style={[
            styles.title,
            {
              color: ok ? theme.ok : theme.danger,
              fontFamily: theme.fonts.display,
              fontSize: theme.scale(20),
            },
          ]}
        >
          {title}
        </Text>
        <Text
          style={[
            styles.body,
            { color: theme.subtext, fontFamily: theme.fonts.body, fontSize: theme.scale(14) },
          ]}
        >
          {body}
        </Text>
        <Link
          href="/login"
          style={[styles.link, { backgroundColor: theme.accent, borderRadius: theme.radius.md }]}
        >
          <Text
            style={[
              styles.linkText,
              {
                color: theme.accentContrast,
                fontFamily: theme.fonts.bodySemibold,
                fontSize: theme.scale(15),
              },
            ]}
          >
            Continue to sign in
          </Text>
        </Link>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  card: {
    width: '100%',
    maxWidth: 420,
    gap: 8,
    alignItems: 'center',
    padding: 28,
    borderWidth: StyleSheet.hairlineWidth,
  },
  brandLogo: { marginBottom: 8 },
  title: { fontWeight: '600', textAlign: 'center' },
  body: { textAlign: 'center', lineHeight: 20, marginTop: 4 },
  link: {
    marginTop: 20,
    paddingVertical: 12,
    paddingHorizontal: 24,
  },
  linkText: { fontWeight: '600' },
});
