import {
  AuthorizationError,
  EducationAssistantClient,
  type AuthProviderInfo,
  type AuthTokenResponse,
  type AuthUser,
} from 'education-assistant-client';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Platform } from 'react-native';
import { DEFAULT_BASE_URL } from './ClientProvider';
import { getStoredBaseUrl } from './authStore';
import { getStoredRefreshToken, setStoredRefreshToken } from './authTokenStore';

export type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated';

/** The web/native landing path GET /auth/{provider}/authorize redirects back to once login completes. */
export const AUTH_CALLBACK_PATH = 'auth-callback';

interface AuthContextValue {
  status: AuthStatus;
  user: AuthUser | null;
  accessToken: string | null;
  error: string | null;
  /**
   * Set to the email a login attempt just failed for, only when that
   * failure was specifically "correct credentials, unverified account"
   * (backend 403 "email_verification_required" — see `login` below).
   * login.tsx uses this to show a "verify your email" message with a
   * resend action addressed to this exact email, instead of the generic
   * error banner. Cleared by clearError() and by any other auth action.
   */
  unverifiedEmail: string | null;
  providers: AuthProviderInfo[];
  devLoginEnabled: boolean;
  /**
   * Whether POST /auth/login and POST /auth/register are available at
   * all — separate from `providers` (which only ever lists OAuth
   * providers). An empty `providers` array must never be read as "no
   * authentication available" when this is true; see login.tsx.
   */
  localAuthEnabled: boolean;
  providersLoading: boolean;
  refreshProviders: () => void;
  /** Starts one provider's OAuth flow — opens a system browser session on native, a top-level redirect on web. */
  startOAuth: (provider: string) => Promise<void>;
  /**
   * Redeems the single-use auth_code the web callback route
   * (app/auth-callback.tsx) receives as a query param. Native never calls
   * this directly — startOAuth's own openAuthSessionAsync round trip
   * handles the exchange internally.
   */
  exchangeCode: (authCode: string) => Promise<void>;
  /** Local email/password sign-in — see POST /auth/login. Throws on
   * failure (wrong credentials, disabled, rate-limited); callers should
   * catch and surface `error` from context, same pattern as devLogin. */
  login: (email: string, password: string) => Promise<void>;
  /**
   * Local email/password account creation — see POST /auth/register.
   * Resolves with `emailVerificationRequired: true` (the default) when
   * the account was created but needs email confirmation before any
   * session exists yet — the caller (login.tsx) should route to
   * /check-email in that case. `emailVerificationRequired: false` means
   * verification is disabled and the caller is already signed in, same
   * as login.
   */
  register: (
    email: string,
    password: string,
    displayName?: string
  ) => Promise<{ emailVerificationRequired: boolean }>;
  /** POST /auth/resend-verification — see EducationAssistantClient.resendVerification.
   * Always resolves (never throws for "no such account"); the generic
   * response text is available for display but this app already shows
   * its own fixed copy instead (see login.tsx). */
  resendVerification: (email: string) => Promise<void>;
  devLogin: (email: string, displayName?: string) => Promise<void>;
  logout: () => Promise<void>;
  clearError: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function stripTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, '');
}

/** Maps the `auth_error` query param GET /auth/{provider}/callback appends to its redirect into copy a user can act on — see rag-backend's app/api/routes_auth.py for the full set of values. */
export function describeAuthError(code: string): string {
  switch (code) {
    case 'email_required':
      return "This sign-in provider didn't share an email address, which is required to create an account here. Please try a different sign-in method, or check that provider's permissions.";
    case 'email_conflict':
      // See rag-backend's UnverifiedEmailConflictError — an unverified
      // provider email matched an address a different account already
      // owns. Deliberately doesn't say "this address is already
      // registered" (that would confirm the account's existence to
      // whoever is attempting this sign-in) — same account-enumeration
      // caution as the login form's generic error copy.
      return "This sign-in provider didn't confirm its email address, so we can't verify who it belongs to. Try signing in with email and password instead, or a provider that confirms your email.";
    case 'provider_error':
      return 'Sign-in failed while contacting the identity provider. Please try again.';
    default:
      return 'Sign-in failed. Please try again.';
  }
}

/**
 * App-level authentication state — mounted above <ClientProvider> in
 * app/_layout.tsx, since ClientProvider's own request client needs to read
 * the access token this provider holds. Deliberately hydrates its own copy
 * of the stored base URL (see lib/authStore.ts) rather than reading it from
 * ClientProvider: this provider sits above ClientProvider in the tree, so
 * it cannot consume useClient(). A base URL changed later in the dev-only
 * Settings screen takes effect here after the next app reload, not live —
 * an acceptable limitation for a dev convenience knob.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [baseUrl, setBaseUrl] = useState(DEFAULT_BASE_URL);
  const [baseUrlHydrated, setBaseUrlHydrated] = useState(false);
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<AuthUser | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unverifiedEmail, setUnverifiedEmail] = useState<string | null>(null);
  const [providers, setProviders] = useState<AuthProviderInfo[]>([]);
  const [devLoginEnabled, setDevLoginEnabled] = useState(false);
  const [localAuthEnabled, setLocalAuthEnabled] = useState(false);
  const [providersLoading, setProvidersLoading] = useState(false);

  // Guards against silentRefresh() — fired once on mount to restore an
  // existing session — resolving *after* a later, explicit auth action
  // (devLogin/exchangeCode/logout) has already settled the real outcome.
  // Every action that establishes or clears a session bumps this before
  // doing any async work; a callback whose captured generation no longer
  // matches when it resolves has been superseded and must not apply its
  // result. Same shape as the SDK's internal useAsyncGuard, reimplemented
  // locally here since that hook isn't exported for app code to reuse.
  const authGenerationRef = useRef(0);
  const beginAuthAction = useCallback((): number => {
    authGenerationRef.current += 1;
    return authGenerationRef.current;
  }, []);

  // Its own, separate counter from authGenerationRef — see
  // refreshProviders' own comment for why sharing one would be wrong.
  const providersGenerationRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const stored = await getStoredBaseUrl();
      if (cancelled) return;
      if (stored) setBaseUrl(stripTrailingSlashes(stored));
      setBaseUrlHydrated(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // None of this provider's own calls (providers/session-exchange/refresh/
  // logout/dev-login) carry a bearer token — the credential in each is
  // either a one-time auth_code, a refresh token, or nothing — so this
  // client's getAccessToken is permanently null. It is NOT the client the
  // rest of the app uses for chat/search/documents (see ClientProvider).
  const authClient = useMemo(
    () =>
      new EducationAssistantClient({
        baseUrl,
        getAccessToken: async () => null,
        timeoutMs: 30_000,
      }),
    [baseUrl]
  );

  const applySession = useCallback(async (tokens: AuthTokenResponse) => {
    setAccessToken(tokens.access_token);
    setUser(tokens.user);
    setStatus('authenticated');
    setError(null);
    if (Platform.OS !== 'web') {
      await setStoredRefreshToken(tokens.refresh_token);
    }
  }, []);

  const silentRefresh = useCallback(async () => {
    const generation = beginAuthAction();
    const stored = Platform.OS === 'web' ? null : await getStoredRefreshToken();
    try {
      const response = await authClient.refreshSession(stored ?? undefined);
      if (authGenerationRef.current !== generation) return;
      await applySession(response);
    } catch {
      if (authGenerationRef.current !== generation) return;
      // No valid session to restore — this is the ordinary "not logged in
      // yet" outcome on first launch, not a surfaced error.
      setAccessToken(null);
      setUser(null);
      setStatus('unauthenticated');
      if (Platform.OS !== 'web') await setStoredRefreshToken(null);
    }
  }, [authClient, applySession, beginAuthAction]);

  useEffect(() => {
    if (!baseUrlHydrated) return;
    silentRefresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseUrlHydrated]);

  const refreshProviders = useCallback(() => {
    // A generation guard of its own — deliberately NOT sharing
    // authGenerationRef with the session-establishing actions below
    // (devLogin/exchangeCode/silentRefresh/logout): those bump that
    // counter to invalidate a *stale session-restore* racing a newer
    // login/logout, which is a different concern from "is this the latest
    // providers fetch". Without some guard here, refreshProviders had no
    // protection at all against overlapping calls (e.g. a Fast Refresh
    // remount re-firing the mount effect, or a user pressing Retry while
    // the initial fetch was still in flight): whichever call's promise
    // settled *last* won, so a slower, failed call could silently
    // overwrite a faster, successful call's correct
    // providers/devLoginEnabled — "fetch success replaced by fallback
    // state" — even though the UI had briefly shown the right thing.
    const generation = ++providersGenerationRef.current;
    setProvidersLoading(true);
    authClient
      .getAuthProviders()
      // getAuthProviders() already normalizes the raw snake_case wire
      // response into { providers, devLoginEnabled } once, at the SDK's
      // API boundary (see EducationAssistantClient.getAuthProviders) — this
      // callback only ever sees that normalized shape, never a raw
      // dev_login_enabled field it would have to re-derive itself.
      .then((response) => {
        if (__DEV__) {
          console.log('[AuthProvider] getAuthProviders() parsed response:', response);
          console.log('[AuthProvider] response.providers:', response.providers);
          console.log('[AuthProvider] response.devLoginEnabled:', response.devLoginEnabled);
          if (providersGenerationRef.current !== generation) {
            console.log(
              '[AuthProvider] discarding this response — a newer refreshProviders() call is already in flight (generation',
              generation,
              'vs current',
              providersGenerationRef.current,
              ')'
            );
          }
        }
        if (providersGenerationRef.current !== generation) return;
        setProviders(response.providers);
        setDevLoginEnabled(response.devLoginEnabled);
        setLocalAuthEnabled(response.localAuthEnabled);
      })
      .catch((err) => {
        if (__DEV__) {
          console.log('[AuthProvider] getAuthProviders() failed:', err);
        }
        if (providersGenerationRef.current !== generation) return;
        setProviders([]);
        setDevLoginEnabled(false);
        setLocalAuthEnabled(false);
        // Previously silent: a failed request looked identical to "the
        // backend genuinely has no providers/dev login configured" — same
        // providers: [], devLoginEnabled: false — with nothing to tell
        // them apart. Surfacing it here reuses the login screen's existing
        // error banner (no new UI, no changed render logic there).
        setError(
          err instanceof Error
            ? `Could not load sign-in options: ${err.message}`
            : 'Could not load sign-in options.'
        );
      })
      .finally(() => {
        if (providersGenerationRef.current !== generation) return;
        setProvidersLoading(false);
      });
  }, [authClient]);

  useEffect(() => {
    if (!baseUrlHydrated) return;
    refreshProviders();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseUrlHydrated]);

  const exchangeCode = useCallback(
    async (authCode: string) => {
      const generation = beginAuthAction();
      try {
        const response = await authClient.exchangeAuthCode(authCode);
        if (authGenerationRef.current !== generation) return;
        await applySession(response);
      } catch (err) {
        if (authGenerationRef.current !== generation) return;
        setError(err instanceof Error ? err.message : 'Sign-in failed.');
        setStatus('unauthenticated');
      }
    },
    [authClient, applySession, beginAuthAction]
  );

  const startOAuth = useCallback(
    async (provider: string) => {
      setError(null);

      if (Platform.OS === 'web') {
        // Top-level navigation, not a popup: Google/Facebook/LinkedIn's own
        // iframe/popup restrictions and third-party-cookie blocking make
        // popups unreliable for this. Execution ends here — the rest of
        // the flow resumes on the next page load, at app/auth-callback.tsx.
        const redirectUri = `${window.location.origin}/${AUTH_CALLBACK_PATH}`;
        window.location.assign(authClient.buildOAuthAuthorizeUrl(provider, redirectUri));
        return;
      }

      const redirectUri = Linking.createURL(AUTH_CALLBACK_PATH);
      const authorizeUrl = authClient.buildOAuthAuthorizeUrl(provider, redirectUri);
      const result = await WebBrowser.openAuthSessionAsync(authorizeUrl, redirectUri);
      if (result.type !== 'success') {
        // 'cancel' / 'dismiss': the user backed out — not an error worth surfacing.
        return;
      }

      const parsed = Linking.parse(result.url);
      const authErrorParam = parsed.queryParams?.auth_error;
      if (typeof authErrorParam === 'string') {
        setError(describeAuthError(authErrorParam));
        return;
      }
      const authCode = parsed.queryParams?.auth_code;
      if (typeof authCode !== 'string') {
        setError('Sign-in failed: no authorization code was returned.');
        return;
      }
      await exchangeCode(authCode);
    },
    [authClient, exchangeCode]
  );

  const login = useCallback(
    async (email: string, password: string) => {
      const generation = beginAuthAction();
      setError(null);
      setUnverifiedEmail(null);
      try {
        const response = await authClient.login({ email, password });
        if (authGenerationRef.current !== generation) return;
        await applySession(response);
      } catch (err) {
        if (authGenerationRef.current !== generation) return;
        if (err instanceof AuthorizationError && err.message === 'email_verification_required') {
          // Correct credentials, but the account hasn't confirmed its
          // email yet — a distinct case from every other login failure
          // (see rag-backend's POST /auth/login docstring), surfaced via
          // `unverifiedEmail` rather than the generic `error` banner so
          // login.tsx can offer a "Resend verification email" action
          // addressed to this exact address.
          setUnverifiedEmail(email);
          return;
        }
        // The backend already returns a generic "Invalid email or
        // password" for every other failure reason (unknown account,
        // OAuth-only account, wrong password) — see
        // rag-backend's app/core/auth_service.py::authenticate_local_user.
        // This just passes that message through, same as every other
        // BackendError-shaped failure elsewhere in this provider.
        setError(err instanceof Error ? err.message : 'Sign-in failed.');
      }
    },
    [authClient, applySession, beginAuthAction]
  );

  const register = useCallback(
    async (email: string, password: string, displayName?: string) => {
      const generation = beginAuthAction();
      setError(null);
      setUnverifiedEmail(null);
      try {
        const response = await authClient.register({
          email,
          password,
          display_name: displayName ?? null,
        });
        if (authGenerationRef.current !== generation) {
          return { emailVerificationRequired: response.email_verification_required };
        }
        if (response.email_verification_required) {
          // No session yet — see POST /auth/register's docstring. The
          // caller (login.tsx) is responsible for routing to /check-email;
          // this provider only reports the outcome, never navigates.
          return { emailVerificationRequired: true };
        }
        await applySession({
          access_token: response.access_token as string,
          refresh_token: response.refresh_token as string,
          token_type: response.token_type,
          expires_in: response.expires_in as number,
          user: response.user as AuthUser,
        });
        return { emailVerificationRequired: false };
      } catch (err) {
        if (authGenerationRef.current !== generation) return { emailVerificationRequired: false };
        setError(err instanceof Error ? err.message : 'Account creation failed.');
        return { emailVerificationRequired: false };
      }
    },
    [authClient, applySession, beginAuthAction]
  );

  const resendVerification = useCallback(
    async (email: string) => {
      try {
        await authClient.resendVerification(email);
      } catch {
        // Never surfaced: resendVerification() itself already resolves
        // with a generic response for every real-world case (unknown
        // account, already verified, rate-limited-but-still-200) — only a
        // genuine network failure reaches here, and silently allowing a
        // retry is preferable to alarming the user over something they
        // cannot act on.
      }
    },
    [authClient]
  );

  const devLogin = useCallback(
    async (email: string, displayName?: string) => {
      const generation = beginAuthAction();
      setError(null);
      try {
        const response = await authClient.devLogin(email, displayName);
        if (authGenerationRef.current !== generation) return;
        await applySession(response);
      } catch (err) {
        if (authGenerationRef.current !== generation) return;
        setError(err instanceof Error ? err.message : 'Dev login failed.');
      }
    },
    [authClient, applySession, beginAuthAction]
  );

  const logout = useCallback(async () => {
    beginAuthAction();
    const stored = Platform.OS === 'web' ? null : await getStoredRefreshToken();
    try {
      await authClient.logout(stored ?? undefined);
    } catch {
      // Logging out locally must still succeed even if the network call
      // fails — never leave the user stuck "logged in" on this device
      // just because the backend was briefly unreachable. This never
      // touches stored chats or documents — only session/token state.
    }
    setAccessToken(null);
    setUser(null);
    setStatus('unauthenticated');
    setError(null);
    setUnverifiedEmail(null);
    if (Platform.OS !== 'web') await setStoredRefreshToken(null);
  }, [authClient, beginAuthAction]);

  const clearError = useCallback(() => {
    setError(null);
    setUnverifiedEmail(null);
  }, []);

  const value: AuthContextValue = {
    status,
    user,
    accessToken,
    error,
    unverifiedEmail,
    providers,
    devLoginEnabled,
    localAuthEnabled,
    providersLoading,
    refreshProviders,
    startOAuth,
    exchangeCode,
    login,
    register,
    resendVerification,
    devLogin,
    logout,
    clearError,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth() must be used within an <AuthProvider>');
  return ctx;
}
