import { Redirect } from 'expo-router';
import { useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useAuth } from '@/lib/AuthProvider';

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
const MIN_PASSWORD_LENGTH = 8;

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
    startOAuth,
    login,
    register,
    devLogin,
    clearError,
    refreshProviders,
  } = useAuth();

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

    setSubmitting(true);
    try {
      if (mode === 'signin') {
        await login(email.trim(), password);
      } else {
        await register(email.trim(), password, displayName.trim() || undefined);
      }
    } finally {
      setSubmitting(false);
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
    <ScrollView
      contentContainerStyle={styles.container}
      keyboardShouldPersistTaps="handled"
      accessibilityLabel="Sign in to EduM8"
    >
      <View style={styles.card}>
        <Text style={styles.brand}>EduM8</Text>
        <Text style={styles.supportingTitle}>Education Research Assistant</Text>
        <Text style={styles.subtitle}>Your private AI workspace for learning and research.</Text>

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

        {sections.showLoadingSpinner && (
          <View style={styles.centered}>
            <ActivityIndicator />
          </View>
        )}

        {sections.showOAuthButtons &&
          providers.map((provider) => (
            <Pressable
              key={provider.provider}
              style={[styles.oauthButton, isBusy && styles.buttonDisabled]}
              onPress={() => handleOAuthContinue(provider.provider)}
              disabled={isBusy}
              accessibilityRole="button"
              accessibilityLabel={`Continue with ${provider.display_name}`}
            >
              {busyProvider === provider.provider ? (
                <ActivityIndicator color="#1F2937" />
              ) : (
                <Text style={styles.oauthButtonText}>Continue with {provider.display_name}</Text>
              )}
            </Pressable>
          ))}

        {sections.showDivider && (
          <View style={styles.dividerRow}>
            <View style={styles.dividerLine} />
            <Text style={styles.dividerText}>or continue with email</Text>
            <View style={styles.dividerLine} />
          </View>
        )}

        {sections.showEmailForm && (
          <View style={styles.form}>
            {mode === 'signup' && (
              <View style={styles.field}>
                <Text style={styles.label}>Name (optional)</Text>
                <TextInput
                  style={styles.input}
                  value={displayName}
                  onChangeText={setDisplayName}
                  placeholder="Ada Lovelace"
                  placeholderTextColor="#94A3B8"
                  autoCapitalize="words"
                  editable={!isBusy}
                  returnKeyType="next"
                  accessibilityLabel="Name"
                />
              </View>
            )}

            <View style={styles.field}>
              <Text style={styles.label}>Email</Text>
              <TextInput
                style={[styles.input, fieldErrors.email && styles.inputError]}
                value={email}
                onChangeText={(value) => {
                  setEmail(value);
                  if (fieldErrors.email) setFieldErrors((prev) => ({ ...prev, email: undefined }));
                }}
                placeholder="you@example.com"
                placeholderTextColor="#94A3B8"
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="email-address"
                editable={!isBusy}
                returnKeyType="next"
                accessibilityLabel="Email"
              />
              {fieldErrors.email && <Text style={styles.fieldErrorText}>{fieldErrors.email}</Text>}
            </View>

            <View style={styles.field}>
              <View style={styles.labelRow}>
                <Text style={styles.label}>Password</Text>
                {mode === 'signin' && (
                  <Pressable
                    onPress={() => setShowForgotPasswordNotice((prev) => !prev)}
                    accessibilityRole="button"
                    accessibilityLabel="Forgot password?"
                  >
                    <Text style={styles.forgotLink}>Forgot password?</Text>
                  </Pressable>
                )}
              </View>
              <View style={styles.passwordRow}>
                <TextInput
                  style={[
                    styles.input,
                    styles.passwordInput,
                    fieldErrors.password && styles.inputError,
                  ]}
                  value={password}
                  onChangeText={(value) => {
                    setPassword(value);
                    if (fieldErrors.password) {
                      setFieldErrors((prev) => ({ ...prev, password: undefined }));
                    }
                  }}
                  placeholder={mode === 'signup' ? 'At least 8 characters' : 'Your password'}
                  placeholderTextColor="#94A3B8"
                  secureTextEntry={!showPassword}
                  autoCapitalize="none"
                  autoCorrect={false}
                  editable={!isBusy}
                  returnKeyType={mode === 'signup' ? 'next' : 'done'}
                  onSubmitEditing={mode === 'signin' ? handleSubmit : undefined}
                  accessibilityLabel="Password"
                />
                <Pressable
                  onPress={() => setShowPassword((prev) => !prev)}
                  accessibilityRole="button"
                  accessibilityLabel={showPassword ? 'Hide password' : 'Show password'}
                  style={styles.showHideButton}
                >
                  <Text style={styles.showHideText}>{showPassword ? 'Hide' : 'Show'}</Text>
                </Pressable>
              </View>
              {fieldErrors.password && (
                <Text style={styles.fieldErrorText}>{fieldErrors.password}</Text>
              )}
              {mode === 'signup' && !fieldErrors.password && (
                <Text style={styles.helperText}>At least 8 characters.</Text>
              )}
            </View>

            {showForgotPasswordNotice && (
              <View style={styles.noticeBox} accessibilityRole="alert">
                <Text style={styles.noticeText}>
                  Password recovery isn&apos;t available yet. Please contact your administrator, or
                  sign in with Google if you&apos;ve linked it to this account.
                </Text>
              </View>
            )}

            {mode === 'signup' && (
              <View style={styles.field}>
                <Text style={styles.label}>Confirm password</Text>
                <TextInput
                  style={[styles.input, fieldErrors.confirmPassword && styles.inputError]}
                  value={confirmPassword}
                  onChangeText={(value) => {
                    setConfirmPassword(value);
                    if (fieldErrors.confirmPassword) {
                      setFieldErrors((prev) => ({ ...prev, confirmPassword: undefined }));
                    }
                  }}
                  placeholder="Re-enter your password"
                  placeholderTextColor="#94A3B8"
                  secureTextEntry={!showPassword}
                  autoCapitalize="none"
                  autoCorrect={false}
                  editable={!isBusy}
                  returnKeyType="done"
                  onSubmitEditing={handleSubmit}
                  accessibilityLabel="Confirm password"
                />
                {fieldErrors.confirmPassword && (
                  <Text style={styles.fieldErrorText}>{fieldErrors.confirmPassword}</Text>
                )}
              </View>
            )}

            <Pressable
              style={[styles.submitButton, isBusy && styles.buttonDisabled]}
              onPress={handleSubmit}
              disabled={isBusy}
              accessibilityRole="button"
              accessibilityLabel={mode === 'signin' ? 'Sign in' : 'Create account'}
            >
              {submitting ? (
                <ActivityIndicator color="#FFFFFF" />
              ) : (
                <Text style={styles.submitButtonText}>
                  {mode === 'signin' ? 'Sign in' : 'Create account'}
                </Text>
              )}
            </Pressable>

            <Pressable
              onPress={() => switchMode(mode === 'signin' ? 'signup' : 'signin')}
              accessibilityRole="button"
              accessibilityLabel={mode === 'signin' ? 'Create account' : 'Back to sign in'}
              style={styles.modeSwitchButton}
            >
              <Text style={styles.modeSwitchText}>
                {mode === 'signin' ? "Don't have an account? " : 'Already have an account? '}
                <Text style={styles.modeSwitchLink}>
                  {mode === 'signin' ? 'Create account' : 'Sign in'}
                </Text>
              </Text>
            </Pressable>
          </View>
        )}

        {sections.showUnavailableMessage && (
          <View style={styles.centered}>
            <Text style={styles.noProvidersText}>
              No sign-in method is configured on this backend yet. An administrator needs to enable
              local sign-in or configure an OAuth provider.
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
        )}

        {sections.showDevLogin && (
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
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flexGrow: 1,
    backgroundColor: '#F8FAFC',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    paddingVertical: 48,
  },
  card: {
    width: '100%',
    maxWidth: 420,
    gap: 4,
  },
  brand: {
    fontSize: 30,
    fontWeight: '800',
    color: '#0F172A',
    textAlign: 'center',
    letterSpacing: -0.5,
  },
  supportingTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: '#334155',
    textAlign: 'center',
    marginTop: 4,
  },
  subtitle: {
    fontSize: 13,
    color: '#64748B',
    textAlign: 'center',
    marginBottom: 20,
    marginTop: 2,
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
  buttonText: { color: '#FFFFFF', fontWeight: '600', fontSize: 15 },
  buttonDisabled: { opacity: 0.6 },
  oauthButton: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E2E8F0',
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
    marginBottom: 10,
  },
  oauthButtonText: { color: '#1F2937', fontWeight: '600', fontSize: 15 },
  dividerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginVertical: 14,
  },
  dividerLine: { flex: 1, height: 1, backgroundColor: '#E2E8F0' },
  dividerText: { fontSize: 12, color: '#94A3B8', fontWeight: '500' },
  form: { gap: 14 },
  field: { gap: 6 },
  labelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  label: { fontSize: 13, fontWeight: '600', color: '#334155' },
  forgotLink: { fontSize: 12, color: '#208AEF', fontWeight: '600' },
  input: {
    borderWidth: 1,
    borderColor: '#CBD5E1',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: '#FFFFFF',
    minHeight: 44,
    fontSize: 15,
    color: '#0F172A',
  },
  inputError: { borderColor: '#DC2626' },
  fieldErrorText: { fontSize: 12, color: '#B91C1C' },
  helperText: { fontSize: 12, color: '#94A3B8' },
  passwordRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  passwordInput: { flex: 1 },
  showHideButton: {
    paddingHorizontal: 8,
    paddingVertical: 10,
    minHeight: 44,
    justifyContent: 'center',
  },
  showHideText: { fontSize: 13, color: '#208AEF', fontWeight: '600' },
  noticeBox: {
    backgroundColor: '#F1F5F9',
    borderRadius: 8,
    padding: 12,
  },
  noticeText: { fontSize: 12, color: '#475569', lineHeight: 18 },
  submitButton: {
    backgroundColor: '#208AEF',
    borderRadius: 8,
    paddingVertical: 13,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 46,
    marginTop: 4,
  },
  submitButtonText: { color: '#FFFFFF', fontWeight: '700', fontSize: 15 },
  modeSwitchButton: { alignItems: 'center', paddingVertical: 8 },
  modeSwitchText: { fontSize: 13, color: '#64748B' },
  modeSwitchLink: { color: '#208AEF', fontWeight: '600' },
  errorBox: {
    backgroundColor: '#FEF2F2',
    borderRadius: 8,
    padding: 12,
    gap: 4,
    marginBottom: 16,
  },
  errorText: { color: '#7F1D1D', fontSize: 13 },
  errorDismiss: { color: '#B91C1C', fontWeight: '600', fontSize: 12 },
  devSection: {
    marginTop: 20,
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
