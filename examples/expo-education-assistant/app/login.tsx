import { Redirect, useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { EduM8Logo } from '@/components/EduM8Logo';
import { EyeIcon, EyeOffIcon } from '@/components/icons';
import { LoginHero } from '@/components/LoginHero';
import { providerIcon } from '@/components/ProviderIcon';
import { Button } from '@/components/ui/Button';
import { InfoDialog } from '@/components/ui/InfoDialog';
import { TextField } from '@/components/ui/TextField';
import { useAuth } from '@/lib/AuthProvider';
import { PRIVACY_POLICY, TERMS_OF_SERVICE } from '@/lib/legalContent';
import { evaluatePasswordChecklist } from '@/lib/passwordChecklist';
import { useTheme } from '@/lib/Preferences';

/** Below this width the marketing hero is dropped and the auth card
 * becomes a plain single-column page — matching the app's other
 * wide/narrow breakpoints (chat/_layout.tsx, (tabs)/_layout.tsx use the
 * same 900-980px range for the same reason: a split layout needs real
 * width to read as two columns rather than two cramped ones. */
const WIDE_HERO_BREAKPOINT_PX = 980;

export type AuthMode = 'signin' | 'signup';

export interface LoginScreenSections {
  showLoadingSpinner: boolean;
  showOAuthButtons: boolean;
  showEmailForm: boolean;
  showDivider: boolean;
  showDevLogin: boolean;
  showUnavailableMessage: boolean;
}

/**
 * Which sections of the login card to render. Deliberately NOT a single
 * mutually-exclusive branch (unlike the old computeLoginBranch this
 * replaces) — the whole point of this redesign is that these sections are
 * independent and can appear together (e.g. a Google button, a divider,
 * and the email form, all at once), not an either/or choice.
 *
 * The bug this fixes: the old model treated `providers.length === 0` as
 * "no authentication available" even when local email/password sign-in —
 * which has nothing to do with OAuth provider configuration — was fully
 * usable. `showEmailForm` here depends only on `localAuthEnabled`, never
 * on `providersCount`.
 */
export function computeLoginSections(state: {
  providersLoading: boolean;
  providersCount: number;
  devLoginEnabled: boolean;
  localAuthEnabled: boolean;
}): LoginScreenSections {
  const showLoadingSpinner = state.providersLoading && state.providersCount === 0;
  const showOAuthButtons = !showLoadingSpinner && state.providersCount > 0;
  const showEmailForm = !showLoadingSpinner && state.localAuthEnabled;
  const showDevLogin = !showLoadingSpinner && state.devLoginEnabled;
  return {
    showLoadingSpinner,
    showOAuthButtons,
    showEmailForm,
    showDivider: showOAuthButtons && showEmailForm,
    showDevLogin,
    showUnavailableMessage:
      !showLoadingSpinner && !showOAuthButtons && !showEmailForm && !showDevLogin,
  };
}

const EMAIL_FORMAT_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const MIN_PASSWORD_LENGTH = 12;

export function validateEmailField(email: string): string | null {
  if (!email.trim()) return 'Email is required.';
  if (!EMAIL_FORMAT_RE.test(email.trim())) return 'Enter a valid email address.';
  return null;
}

export function validatePasswordField(password: string): string | null {
  if (!password) return 'Password is required.';
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  return null;
}

interface FieldErrors {
  email?: string;
  password?: string;
  confirmPassword?: string;
}

export default function LoginScreen() {
  const {
    status,
    providers,
    devLoginEnabled,
    localAuthEnabled,
    providersLoading,
    error,
    unverifiedEmail,
    startOAuth,
    login,
    register,
    resendVerification,
    devLogin,
    clearError,
    refreshProviders,
  } = useAuth();
  const router = useRouter();
  const theme = useTheme();
  const { width } = useWindowDimensions();
  const isWide = Platform.OS === 'web' && width >= WIDE_HERO_BREAKPOINT_PX;

  const [mode, setMode] = useState<AuthMode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const [busyProvider, setBusyProvider] = useState<string | null>(null);
  const [devEmail, setDevEmail] = useState('');
  const [showForgotPasswordNotice, setShowForgotPasswordNotice] = useState(false);
  const [resending, setResending] = useState(false);
  const [resendSent, setResendSent] = useState(false);
  // Hover-only visual state for the two plain-text links below (web —
  // native ignores onHoverIn/onHoverOut entirely) — same lightweight
  // pattern Button.tsx and NavRail's RailButton already use, just inlined
  // here since these two links aren't reusable components.
  const [forgotLinkHovered, setForgotLinkHovered] = useState(false);
  const [modeSwitchHovered, setModeSwitchHovered] = useState(false);
  // Which legal document dialog (if any) is open — shared InfoDialog +
  // shared copy with Settings' own Privacy/Terms rows (lib/legalContent.ts).
  const [legalDialog, setLegalDialog] = useState<'privacy' | 'terms' | null>(null);
  // Synchronous double-submit guard, same reasoning as chat/new.tsx's
  // isSubmittingRef: `submitting` state alone doesn't block a second onPress
  // fired before React re-renders the disabled button (a fast double-click,
  // or Strict Mode invoking a handler twice), since both calls read the same
  // pre-update `submitting`. The ref is mutated synchronously, so the second
  // call always sees the first's claim.
  const isSubmittingRef = useRef(false);

  // A session restored (or just completed) elsewhere must never leave the
  // user stuck looking at the login form — bounce straight into the app.
  if (status === 'authenticated') {
    return <Redirect href="/chat" />;
  }

  const isBusy = submitting || busyProvider !== null;
  const sections = computeLoginSections({
    providersLoading,
    providersCount: providers.length,
    devLoginEnabled,
    localAuthEnabled,
  });
  const passwordChecklist =
    mode === 'signup' ? evaluatePasswordChecklist(password, email, displayName) : [];

  function switchMode(nextMode: AuthMode): void {
    setMode(nextMode);
    setFieldErrors({});
    // Confirm-password is signup-only and easy to forget about after
    // switching away and back — clear it so a stale value can never
    // silently pass a fresh confirm-password check. Email/password/name
    // themselves are deliberately preserved across the switch.
    setConfirmPassword('');
    setShowForgotPasswordNotice(false);
    clearError();
  }

  async function handleOAuthContinue(provider: string): Promise<void> {
    clearError();
    setBusyProvider(provider);
    try {
      await startOAuth(provider);
    } finally {
      setBusyProvider(null);
    }
  }

  async function handleSubmit(): Promise<void> {
    if (isSubmittingRef.current) return;
    clearError();
    const nextFieldErrors: FieldErrors = {};
    const emailError = validateEmailField(email);
    if (emailError) nextFieldErrors.email = emailError;
    const passwordError = validatePasswordField(password);
    if (passwordError) nextFieldErrors.password = passwordError;
    if (mode === 'signup' && !passwordError && password !== confirmPassword) {
      nextFieldErrors.confirmPassword = 'Passwords do not match.';
    }
    setFieldErrors(nextFieldErrors);
    if (Object.keys(nextFieldErrors).length > 0) return;

    isSubmittingRef.current = true;
    setSubmitting(true);
    try {
      if (mode === 'signin') {
        await login(email.trim(), password);
      } else {
        const trimmedEmail = email.trim();
        const result = await register(trimmedEmail, password, displayName.trim() || undefined);
        if (result.emailVerificationRequired) {
          router.push({ pathname: '/check-email', params: { email: trimmedEmail } });
        }
      }
    } finally {
      isSubmittingRef.current = false;
      setSubmitting(false);
    }
  }

  async function handleResendForUnverified(): Promise<void> {
    if (!unverifiedEmail || resending) return;
    setResending(true);
    setResendSent(false);
    try {
      await resendVerification(unverifiedEmail);
    } finally {
      setResending(false);
      setResendSent(true);
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

  return (
    <View style={[styles.page, { backgroundColor: theme.background }]}>
      {isWide && (
        <View style={[styles.heroPane, { borderRightColor: theme.border }]}>
          <LoginHero />
        </View>
      )}

      <View style={styles.authPane}>
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.container}
          keyboardShouldPersistTaps="handled"
          accessibilityLabel="Sign in to EduM8"
        >
          <View
            style={[
              styles.card,
              {
                backgroundColor: theme.card,
                borderColor: theme.border,
                // A larger, softer radius on the wide split layout (matching
                // the reference's premium feel); mobile keeps the app's
                // standard card radius for consistency with every other
                // screen's cards there.
                borderRadius: isWide ? 20 : theme.radius.lg,
              },
              // A distinct card on narrow (no hero to frame it against) needs
              // its own border to read as a surface; on the wide split layout
              // the auth pane's own flat background already does that job, so
              // a second border here would just double up.
              isWide && styles.cardOnWide,
            ]}
          >
            {/* The hero already carries the brand mark on wide layouts (see
                LoginHero) — repeating it here would be redundant. Narrow
                layouts have no hero, so the card is the only place it can
                live (matches the reference demo's .mobile-logo pattern). */}
            {!isWide && <EduM8Logo size={32} style={styles.brandLogo} />}
            {/* Bold sans, matching the hero headline's family — not the
                app's editorial serif (see LoginHero.tsx's identical note). */}
            <Text
              style={[
                styles.supportingTitle,
                { color: theme.text, fontFamily: theme.fonts.bodyBold, fontSize: theme.scale(28) },
              ]}
            >
              {mode === 'signin' ? 'Welcome back' : 'Create your account'}
            </Text>
            <Text
              style={[
                styles.subtitle,
                { color: theme.subtext, fontFamily: theme.fonts.body, fontSize: theme.scale(14) },
              ]}
            >
              {mode === 'signin'
                ? 'Sign in to continue to your workspace.'
                : 'Start building your evidence-informed workspace.'}
            </Text>

            {error && (
              <View
                style={[
                  styles.errorBox,
                  { backgroundColor: theme.dangerSoft, borderRadius: theme.radius.md },
                ]}
                accessibilityRole="alert"
              >
                <Text
                  style={[styles.errorText, { color: theme.danger, fontFamily: theme.fonts.body }]}
                >
                  {error}
                </Text>
                <Pressable
                  onPress={clearError}
                  accessibilityRole="button"
                  accessibilityLabel="Dismiss error"
                  hitSlop={8}
                >
                  <Text
                    style={[
                      styles.errorDismiss,
                      { color: theme.danger, fontFamily: theme.fonts.bodySemibold },
                    ]}
                  >
                    Dismiss
                  </Text>
                </Pressable>
              </View>
            )}

            {unverifiedEmail && (
              <View
                style={[
                  styles.noticeBox,
                  { backgroundColor: theme.cardPressed, borderRadius: theme.radius.md },
                ]}
                accessibilityRole="alert"
              >
                <Text
                  style={[
                    styles.noticeTitle,
                    {
                      color: theme.text,
                      fontFamily: theme.fonts.bodySemibold,
                      fontSize: theme.scale(13),
                    },
                  ]}
                >
                  Please verify your email address before signing in.
                </Text>
                {resendSent ? (
                  <Text
                    style={[
                      styles.noticeText,
                      { color: theme.subtext, fontFamily: theme.fonts.body },
                    ]}
                  >
                    Verification email sent.
                  </Text>
                ) : (
                  <Pressable
                    onPress={handleResendForUnverified}
                    disabled={resending}
                    accessibilityRole="button"
                    accessibilityLabel="Resend verification email"
                    hitSlop={8}
                  >
                    <Text
                      style={[
                        styles.noticeLink,
                        {
                          color: theme.accent,
                          fontFamily: theme.fonts.bodySemibold,
                          fontSize: theme.scale(13),
                        },
                      ]}
                    >
                      {resending ? 'Sending…' : 'Resend verification email'}
                    </Text>
                  </Pressable>
                )}
              </View>
            )}

            {sections.showLoadingSpinner && (
              <View style={styles.centered}>
                <ActivityIndicator color={theme.accent} />
              </View>
            )}

            {sections.showOAuthButtons && (
              <View style={styles.oauthGroup}>
                {providers.map((provider) => (
                  <Button
                    key={provider.provider}
                    variant="secondary"
                    fullWidth
                    icon={providerIcon(provider.provider)}
                    label={`Continue with ${provider.display_name}`}
                    onPress={() => handleOAuthContinue(provider.provider)}
                    disabled={isBusy}
                    loading={busyProvider === provider.provider}
                  />
                ))}
              </View>
            )}

            {sections.showDivider && (
              <View style={styles.dividerRow}>
                <View style={[styles.dividerLine, { backgroundColor: theme.border }]} />
                <Text
                  style={[styles.dividerText, { color: theme.faint, fontFamily: theme.fonts.body }]}
                >
                  {mode === 'signin' ? 'or sign in with email' : 'or sign up with email'}
                </Text>
                <View style={[styles.dividerLine, { backgroundColor: theme.border }]} />
              </View>
            )}

            {sections.showEmailForm && (
              <View style={styles.form}>
                {mode === 'signup' && (
                  <TextField
                    label="Name (optional)"
                    accessibilityLabel="Name"
                    value={displayName}
                    onChangeText={setDisplayName}
                    placeholder="Ada Lovelace"
                    autoCapitalize="words"
                    editable={!isBusy}
                    returnKeyType="next"
                  />
                )}

                <TextField
                  label="Email"
                  value={email}
                  onChangeText={(value) => {
                    setEmail(value);
                    if (fieldErrors.email)
                      setFieldErrors((prev) => ({ ...prev, email: undefined }));
                  }}
                  placeholder="name@institution.edu"
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="email-address"
                  editable={!isBusy}
                  returnKeyType="next"
                  error={fieldErrors.email}
                />

                <TextField
                  label="Password"
                  value={password}
                  onChangeText={(value) => {
                    setPassword(value);
                    if (fieldErrors.password) {
                      setFieldErrors((prev) => ({ ...prev, password: undefined }));
                    }
                  }}
                  placeholder={mode === 'signup' ? 'At least 12 characters' : 'Your password'}
                  secureTextEntry={!showPassword}
                  autoCapitalize="none"
                  autoCorrect={false}
                  editable={!isBusy}
                  returnKeyType={mode === 'signup' ? 'next' : 'done'}
                  onSubmitEditing={mode === 'signin' ? handleSubmit : undefined}
                  error={fieldErrors.password}
                  labelAccessory={
                    mode === 'signin' ? (
                      <Pressable
                        onPress={() => setShowForgotPasswordNotice((prev) => !prev)}
                        onHoverIn={() => setForgotLinkHovered(true)}
                        onHoverOut={() => setForgotLinkHovered(false)}
                        accessibilityRole="button"
                        accessibilityLabel="Forgot password?"
                        hitSlop={8}
                      >
                        <Text
                          style={[
                            styles.forgotLink,
                            {
                              color: theme.accent,
                              fontFamily: theme.fonts.bodySemibold,
                              textDecorationLine: forgotLinkHovered ? 'underline' : 'none',
                            },
                          ]}
                        >
                          Forgot password?
                        </Text>
                      </Pressable>
                    ) : undefined
                  }
                  trailingAccessory={
                    <Pressable
                      onPress={() => setShowPassword((prev) => !prev)}
                      accessibilityRole="button"
                      accessibilityLabel={showPassword ? 'Hide password' : 'Show password'}
                      style={styles.showHideButton}
                      hitSlop={8}
                    >
                      {showPassword ? (
                        <EyeOffIcon size={16} color={theme.accent} />
                      ) : (
                        <EyeIcon size={16} color={theme.accent} />
                      )}
                      <Text
                        style={[
                          styles.showHideText,
                          { color: theme.accent, fontFamily: theme.fonts.bodySemibold },
                        ]}
                      >
                        {showPassword ? 'Hide' : 'Show'}
                      </Text>
                    </Pressable>
                  }
                />

                {showForgotPasswordNotice && (
                  <View
                    style={[
                      styles.noticeBox,
                      { backgroundColor: theme.cardPressed, borderRadius: theme.radius.md },
                    ]}
                    accessibilityRole="alert"
                  >
                    <Text
                      style={[
                        styles.noticeText,
                        { color: theme.subtext, fontFamily: theme.fonts.body },
                      ]}
                    >
                      Password recovery isn&apos;t available yet. Please contact your administrator,
                      or sign in with Google if you&apos;ve linked it to this account.
                    </Text>
                  </View>
                )}

                {mode === 'signup' && (
                  <View
                    style={[
                      styles.checklistBox,
                      {
                        backgroundColor: theme.background,
                        borderColor: theme.border,
                        borderRadius: theme.radius.md,
                      },
                    ]}
                  >
                    <Text
                      style={[
                        styles.checklistTitle,
                        { color: theme.subtext, fontFamily: theme.fonts.bodySemibold },
                      ]}
                    >
                      Password must contain:
                    </Text>
                    {passwordChecklist.map((item) => (
                      <Text
                        key={item.id}
                        style={[
                          styles.checklistItem,
                          {
                            color: item.met ? theme.ok : theme.faint,
                            fontFamily: theme.fonts.body,
                          },
                        ]}
                      >
                        {`${item.met ? '✓' : '•'} ${item.label}`}
                      </Text>
                    ))}
                  </View>
                )}

                {mode === 'signup' && (
                  <TextField
                    label="Confirm password"
                    value={confirmPassword}
                    onChangeText={(value) => {
                      setConfirmPassword(value);
                      if (fieldErrors.confirmPassword) {
                        setFieldErrors((prev) => ({ ...prev, confirmPassword: undefined }));
                      }
                    }}
                    placeholder="Re-enter your password"
                    secureTextEntry={!showPassword}
                    autoCapitalize="none"
                    autoCorrect={false}
                    editable={!isBusy}
                    returnKeyType="done"
                    onSubmitEditing={handleSubmit}
                    error={fieldErrors.confirmPassword}
                  />
                )}

                <Button
                  label={mode === 'signin' ? 'Sign in' : 'Create account'}
                  onPress={handleSubmit}
                  disabled={isBusy}
                  loading={submitting}
                  fullWidth
                  style={[styles.submitButton, styles.submitButtonIndigo]}
                />

                <Pressable
                  onPress={() => switchMode(mode === 'signin' ? 'signup' : 'signin')}
                  onHoverIn={() => setModeSwitchHovered(true)}
                  onHoverOut={() => setModeSwitchHovered(false)}
                  accessibilityRole="button"
                  accessibilityLabel={mode === 'signin' ? 'Create account' : 'Back to sign in'}
                  style={styles.modeSwitchButton}
                  hitSlop={8}
                >
                  <Text
                    style={[
                      styles.modeSwitchText,
                      { color: theme.subtext, fontFamily: theme.fonts.body },
                    ]}
                  >
                    {mode === 'signin' ? 'New to EduM8? ' : 'Already have an account? '}
                    <Text
                      style={[
                        styles.modeSwitchLink,
                        {
                          color: theme.accent,
                          fontFamily: theme.fonts.bodySemibold,
                          textDecorationLine: modeSwitchHovered ? 'underline' : 'none',
                        },
                      ]}
                    >
                      {mode === 'signin' ? 'Create account' : 'Sign in'}
                    </Text>
                  </Text>
                </Pressable>
              </View>
            )}

            {sections.showUnavailableMessage && (
              <View style={styles.centered}>
                <Text
                  style={[
                    styles.noProvidersText,
                    { color: theme.subtext, fontFamily: theme.fonts.body },
                  ]}
                >
                  No sign-in method is configured on this backend yet. An administrator needs to
                  enable local sign-in or configure an OAuth provider.
                </Text>
                <Button
                  label="Retry"
                  accessibilityLabel="Retry loading sign-in providers"
                  onPress={refreshProviders}
                  variant="ghost"
                  size="sm"
                />
              </View>
            )}

            {sections.showDevLogin && (
              <View style={[styles.devSection, { borderTopColor: theme.border }]}>
                <Text
                  style={[
                    styles.devLabel,
                    { color: theme.warning, fontFamily: theme.fonts.bodyBold },
                  ]}
                >
                  Dev login (not real authentication)
                </Text>
                <TextField
                  label="Dev login email"
                  accessibilityLabel="Dev login email"
                  placeholder="you@example.com"
                  value={devEmail}
                  onChangeText={setDevEmail}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="email-address"
                  editable={!isBusy}
                />
                <Button
                  label="Dev sign in"
                  onPress={handleDevLogin}
                  disabled={isBusy || !devEmail.trim()}
                  loading={busyProvider === 'dev'}
                  variant="secondary"
                  fullWidth
                  style={styles.devButton}
                />
              </View>
            )}

            <Text style={[styles.legalText, { color: theme.faint, fontFamily: theme.fonts.body }]}>
              By continuing, you agree to our{' '}
              <Text
                onPress={() => setLegalDialog('terms')}
                accessibilityRole="link"
                style={[styles.legalLink, { color: theme.subtext, fontFamily: theme.fonts.body }]}
              >
                Terms of Service
              </Text>{' '}
              and{' '}
              <Text
                onPress={() => setLegalDialog('privacy')}
                accessibilityRole="link"
                style={[styles.legalLink, { color: theme.subtext, fontFamily: theme.fonts.body }]}
              >
                Privacy Policy
              </Text>
              .
            </Text>
          </View>
        </ScrollView>
      </View>

      <InfoDialog
        visible={legalDialog === 'terms'}
        title={TERMS_OF_SERVICE.title}
        body={TERMS_OF_SERVICE.body}
        onClose={() => setLegalDialog(null)}
      />
      <InfoDialog
        visible={legalDialog === 'privacy'}
        title={PRIVACY_POLICY.title}
        body={PRIVACY_POLICY.body}
        onClose={() => setLegalDialog(null)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, flexDirection: 'row' },
  // Ratio, not percentage: RN resolves sibling flex values as a share of
  // the row's width, so 58/42 reads exactly as the brief's split — no
  // percentage-width math to keep in sync between the two panes.
  heroPane: { flex: 58, borderRightWidth: StyleSheet.hairlineWidth },
  authPane: { flex: 42, minWidth: 0 },
  scroll: { flex: 1 },
  container: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    // Asymmetric on purpose: a touch more headroom above than below sits
    // the card slightly lower than dead-center, which is what actually
    // *reads* as vertically centered once the eye accounts for the
    // hairline "auth" panel border along the top of the viewport and the
    // page's own chrome — true 50/50 centering looks a hair high.
    paddingTop: 64,
    paddingBottom: 48,
  },
  card: {
    width: '100%',
    maxWidth: 420,
    gap: 4,
    padding: 32,
    borderWidth: StyleSheet.hairlineWidth,
  },
  // On the wide split layout the card sits on the auth pane's own flat
  // background, with no hero framing it — a soft, wide-spread shadow
  // (rather than a heavier border) is what keeps it reading as a raised
  // surface, per the brief's "subtle shadows" over "heavy shadows".
  cardOnWide: {
    shadowColor: '#14161F',
    shadowOffset: { width: 0, height: 20 },
    shadowOpacity: 0.08,
    shadowRadius: 44,
    elevation: 4,
  },
  brandLogo: {
    alignSelf: 'flex-start',
    marginBottom: 8,
  },
  supportingTitle: {
    fontWeight: '700',
    marginTop: 4,
  },
  subtitle: {
    marginBottom: 24,
    marginTop: 4,
    lineHeight: 20,
  },
  centered: { alignItems: 'center', gap: 12, paddingVertical: 8 },
  noProvidersText: { fontSize: 13, textAlign: 'center', lineHeight: 19 },
  oauthGroup: { gap: 10, marginBottom: 4 },
  dividerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginVertical: 16,
  },
  dividerLine: { flex: 1, height: StyleSheet.hairlineWidth },
  dividerText: {
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  form: { gap: 16 },
  forgotLink: { fontSize: 12 },
  showHideButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 4,
    paddingVertical: 4,
    minHeight: 32,
    justifyContent: 'center',
  },
  showHideText: { fontSize: 13 },
  noticeBox: {
    padding: 12,
    gap: 4,
  },
  noticeTitle: { fontWeight: '600' },
  noticeText: { fontSize: 12, lineHeight: 18 },
  noticeLink: { fontWeight: '600' },
  checklistBox: {
    borderWidth: StyleSheet.hairlineWidth,
    padding: 12,
    gap: 4,
  },
  checklistTitle: { fontSize: 12, fontWeight: '700', marginBottom: 2 },
  checklistItem: { fontSize: 12 },
  submitButton: { marginTop: 4 },
  // The primary CTA specifically uses the brand mark's own indigo
  // (#4F46E5, matching assets/brand/e8-icon.svg's gradient start) rather
  // than the app's general UI accent token (theme.accent, used for links/
  // focus rings/every other button everywhere else) — scoped to just this
  // one button on this one page, not a global token change. Reasoning:
  // the login page is the one place the brand mark and the primary CTA
  // sit right next to each other, so this is the one place their colors
  // being slightly different (however close) would actually be visible.
  submitButtonIndigo: { backgroundColor: '#4F46E5', shadowColor: '#4F46E5' },
  modeSwitchButton: { alignItems: 'center', paddingVertical: 8 },
  modeSwitchText: { fontSize: 13 },
  modeSwitchLink: { fontWeight: '600' },
  errorBox: {
    padding: 12,
    gap: 4,
    marginBottom: 16,
  },
  errorText: { fontSize: 13 },
  errorDismiss: { fontSize: 12 },
  devSection: {
    marginTop: 20,
    paddingTop: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: 10,
  },
  devLabel: { fontSize: 12, textAlign: 'center' },
  devButton: { marginTop: 2 },
  legalText: { fontSize: 12, lineHeight: 18, textAlign: 'center', marginTop: 28 },
  legalLink: { fontSize: 12, textDecorationLine: 'underline' },
});
