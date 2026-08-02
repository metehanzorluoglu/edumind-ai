import { act, create, type ReactTestInstance } from 'react-test-renderer';
import LoginScreen, {
  computeLoginSections,
  validateEmailField,
  validatePasswordField,
} from '../login';

const mockUseAuth = jest.fn();
jest.mock('@/lib/AuthProvider', () => ({
  useAuth: () => mockUseAuth(),
}));

const mockRouterPush = jest.fn();
jest.mock('expo-router', () => ({
  Redirect: () => null,
  useRouter: () => ({ push: mockRouterPush, replace: jest.fn() }),
}));

function baseAuth(overrides: Partial<ReturnType<typeof mockUseAuth>> = {}) {
  return {
    status: 'unauthenticated',
    providers: [],
    devLoginEnabled: false,
    localAuthEnabled: true,
    providersLoading: false,
    error: null,
    unverifiedEmail: null,
    startOAuth: jest.fn(),
    login: jest.fn(),
    register: jest.fn().mockResolvedValue({ emailVerificationRequired: false }),
    resendVerification: jest.fn(),
    devLogin: jest.fn(),
    clearError: jest.fn(),
    refreshProviders: jest.fn(),
    ...overrides,
  };
}

function findByText(root: ReactTestInstance, text: string): ReactTestInstance | null {
  const matches = root.findAll(
    (node) => String(node.type) === 'Text' && node.children.includes(text)
  );
  return matches[0] ?? null;
}

function findPressableByLabel(root: ReactTestInstance, label: string): ReactTestInstance | null {
  const matches = root.findAll(
    (node) => typeof node.props.onPress === 'function' && node.props.accessibilityLabel === label
  );
  return matches[0] ?? null;
}

function findInputByLabel(root: ReactTestInstance, label: string): ReactTestInstance | null {
  const matches = root.findAll(
    (node) => String(node.type) === 'TextInput' && node.props.accessibilityLabel === label
  );
  return matches[0] ?? null;
}

function containsText(root: ReactTestInstance, substring: string): boolean {
  return (
    root.findAll(
      (node) =>
        String(node.type) === 'Text' &&
        node.children.some((child) => typeof child === 'string' && child.includes(substring))
    ).length > 0
  );
}

describe('LoginScreen', () => {
  afterEach(() => {
    mockUseAuth.mockReset();
    mockRouterPush.mockReset();
  });

  it('shows the email/password form when local auth is enabled and no OAuth providers exist — never the old dead-end message', () => {
    mockUseAuth.mockReturnValue(
      baseAuth({ providers: [], devLoginEnabled: false, localAuthEnabled: true })
    );

    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(<LoginScreen />);
    });

    expect(
      findByText(renderer.root, 'No sign-in providers are configured on this backend yet.')
    ).toBeNull();
    expect(findInputByLabel(renderer.root, 'Email')).toBeTruthy();
    expect(findInputByLabel(renderer.root, 'Password')).toBeTruthy();
    expect(findPressableByLabel(renderer.root, 'Sign in')).toBeTruthy();
  });

  it('shows the administrator-facing unavailable message only when local auth, OAuth, and dev login are all unavailable', () => {
    mockUseAuth.mockReturnValue(
      baseAuth({ providers: [], devLoginEnabled: false, localAuthEnabled: false })
    );

    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(<LoginScreen />);
    });

    expect(
      findByText(
        renderer.root,
        'No sign-in method is configured on this backend yet. An administrator needs to enable local sign-in or configure an OAuth provider.'
      )
    ).toBeTruthy();
    expect(findPressableByLabel(renderer.root, 'Retry loading sign-in providers')).toBeTruthy();
    expect(findInputByLabel(renderer.root, 'Email')).toBeNull();
  });

  it('shows OAuth provider buttons and the email form together, with a divider, when both are available', () => {
    mockUseAuth.mockReturnValue(
      baseAuth({
        providers: [
          { provider: 'google', display_name: 'Google' },
          { provider: 'facebook', display_name: 'Facebook' },
        ],
        devLoginEnabled: false,
        localAuthEnabled: true,
      })
    );

    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(<LoginScreen />);
    });

    expect(findPressableByLabel(renderer.root, 'Continue with Google')).toBeTruthy();
    expect(findPressableByLabel(renderer.root, 'Continue with Facebook')).toBeTruthy();
    expect(findByText(renderer.root, 'or continue with email')).toBeTruthy();
    expect(findInputByLabel(renderer.root, 'Email')).toBeTruthy();
  });

  it('shows only OAuth provider buttons, no email form or divider, when local auth is disabled', () => {
    mockUseAuth.mockReturnValue(
      baseAuth({
        providers: [{ provider: 'google', display_name: 'Google' }],
        devLoginEnabled: false,
        localAuthEnabled: false,
      })
    );

    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(<LoginScreen />);
    });

    expect(findPressableByLabel(renderer.root, 'Continue with Google')).toBeTruthy();
    expect(findByText(renderer.root, 'or continue with email')).toBeNull();
    expect(findInputByLabel(renderer.root, 'Email')).toBeNull();
  });

  it('shows the dev-login form alongside the email form when both are available', () => {
    mockUseAuth.mockReturnValue(
      baseAuth({ providers: [], devLoginEnabled: true, localAuthEnabled: true })
    );

    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(<LoginScreen />);
    });

    expect(findInputByLabel(renderer.root, 'Email')).toBeTruthy();
    expect(findPressableByLabel(renderer.root, 'Dev sign in')).toBeTruthy();
  });

  it('shows a loading spinner while providers are still loading, never the unavailable message', () => {
    mockUseAuth.mockReturnValue(
      baseAuth({
        providers: [],
        devLoginEnabled: false,
        localAuthEnabled: false,
        providersLoading: true,
      })
    );

    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(<LoginScreen />);
    });

    expect(renderer.root.findAllByType('ActivityIndicator' as never).length).toBeGreaterThan(0);
    expect(
      findByText(
        renderer.root,
        'No sign-in method is configured on this backend yet. An administrator needs to enable local sign-in or configure an OAuth provider.'
      )
    ).toBeNull();
  });

  it('Retry calls refreshProviders when the unavailable message is shown', () => {
    const refreshProviders = jest.fn();
    mockUseAuth.mockReturnValue(
      baseAuth({ providers: [], devLoginEnabled: false, localAuthEnabled: false, refreshProviders })
    );

    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(<LoginScreen />);
    });

    act(() => {
      findPressableByLabel(renderer.root, 'Retry loading sign-in providers')!.props.onPress();
    });

    expect(refreshProviders).toHaveBeenCalled();
  });

  it('an existing error is shown and can be dismissed', () => {
    const clearError = jest.fn();
    mockUseAuth.mockReturnValue(baseAuth({ error: 'Invalid email or password', clearError }));

    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(<LoginScreen />);
    });

    expect(findByText(renderer.root, 'Invalid email or password')).toBeTruthy();

    act(() => {
      findPressableByLabel(renderer.root, 'Dismiss error')!.props.onPress();
    });

    expect(clearError).toHaveBeenCalled();
  });

  it('switching to Create account mode reveals confirm-password and name fields, and back again removes them', () => {
    mockUseAuth.mockReturnValue(baseAuth());

    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(<LoginScreen />);
    });

    expect(findInputByLabel(renderer.root, 'Confirm password')).toBeNull();

    act(() => {
      findPressableByLabel(renderer.root, 'Create account')!.props.onPress();
    });
    expect(findInputByLabel(renderer.root, 'Confirm password')).toBeTruthy();
    expect(findInputByLabel(renderer.root, 'Name')).toBeTruthy();
    expect(findPressableByLabel(renderer.root, 'Create account')).toBeTruthy();

    act(() => {
      findPressableByLabel(renderer.root, 'Back to sign in')!.props.onPress();
    });
    expect(findInputByLabel(renderer.root, 'Confirm password')).toBeNull();
  });

  it('submitting sign-in with a blank email/password shows field errors and never calls login()', () => {
    const login = jest.fn();
    mockUseAuth.mockReturnValue(baseAuth({ login }));

    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(<LoginScreen />);
    });

    act(() => {
      findPressableByLabel(renderer.root, 'Sign in')!.props.onPress();
    });

    expect(findByText(renderer.root, 'Email is required.')).toBeTruthy();
    expect(findByText(renderer.root, 'Password is required.')).toBeTruthy();
    expect(login).not.toHaveBeenCalled();
  });

  it('submitting sign-in with valid fields calls login() with the trimmed email', async () => {
    const login = jest.fn().mockResolvedValue(undefined);
    mockUseAuth.mockReturnValue(baseAuth({ login }));

    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(<LoginScreen />);
    });

    act(() => {
      findInputByLabel(renderer.root, 'Email')!.props.onChangeText('  user@example.com  ');
    });
    act(() => {
      findInputByLabel(renderer.root, 'Password')!.props.onChangeText('correct-password-1');
    });
    await act(async () => {
      findPressableByLabel(renderer.root, 'Sign in')!.props.onPress();
    });

    expect(login).toHaveBeenCalledWith('user@example.com', 'correct-password-1');
  });

  it('submitting Create account with mismatched passwords shows a field error and never calls register()', () => {
    const register = jest.fn();
    mockUseAuth.mockReturnValue(baseAuth({ register }));

    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(<LoginScreen />);
    });
    act(() => {
      findPressableByLabel(renderer.root, 'Create account')!.props.onPress();
    });
    act(() => {
      findInputByLabel(renderer.root, 'Email')!.props.onChangeText('user@example.com');
    });
    act(() => {
      findInputByLabel(renderer.root, 'Password')!.props.onChangeText('correct-password-1');
    });
    act(() => {
      findInputByLabel(renderer.root, 'Confirm password')!.props.onChangeText('different');
    });
    act(() => {
      findPressableByLabel(renderer.root, 'Create account')!.props.onPress();
    });

    expect(findByText(renderer.root, 'Passwords do not match.')).toBeTruthy();
    expect(register).not.toHaveBeenCalled();
  });

  it('submitting Create account with matching valid fields calls register()', async () => {
    const register = jest.fn().mockResolvedValue({ emailVerificationRequired: true });
    mockUseAuth.mockReturnValue(baseAuth({ register }));

    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(<LoginScreen />);
    });
    act(() => {
      findPressableByLabel(renderer.root, 'Create account')!.props.onPress();
    });
    act(() => {
      findInputByLabel(renderer.root, 'Email')!.props.onChangeText('user@example.com');
    });
    act(() => {
      findInputByLabel(renderer.root, 'Password')!.props.onChangeText('correct-password-1');
    });
    act(() => {
      findInputByLabel(renderer.root, 'Confirm password')!.props.onChangeText('correct-password-1');
    });
    await act(async () => {
      findPressableByLabel(renderer.root, 'Create account')!.props.onPress();
    });

    expect(register).toHaveBeenCalledWith('user@example.com', 'correct-password-1', undefined);
    expect(mockRouterPush).toHaveBeenCalledWith({
      pathname: '/check-email',
      params: { email: 'user@example.com' },
    });
  });

  it('shows the password checklist in Create account mode, updating live as the password is typed', () => {
    mockUseAuth.mockReturnValue(baseAuth());

    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(<LoginScreen />);
    });

    expect(findByText(renderer.root, 'Password must contain:')).toBeNull();

    act(() => {
      findPressableByLabel(renderer.root, 'Create account')!.props.onPress();
    });
    expect(findByText(renderer.root, 'Password must contain:')).toBeTruthy();
    expect(containsText(renderer.root, 'At least 12 characters')).toBe(true);

    act(() => {
      findInputByLabel(renderer.root, 'Password')!.props.onChangeText('Xq7!vTr9zLmP#4word');
    });
    // A strong password should flip every checklist item to its "met" (✓) form.
    expect(containsText(renderer.root, '✓ At least 12 characters')).toBe(true);
    expect(containsText(renderer.root, '✓ One uppercase letter')).toBe(true);
  });

  it('shows the unverified-account notice and resend action when unverifiedEmail is set', async () => {
    const resendVerification = jest.fn().mockResolvedValue(undefined);
    mockUseAuth.mockReturnValue(
      baseAuth({ unverifiedEmail: 'unverified@example.com', resendVerification })
    );

    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(<LoginScreen />);
    });

    expect(
      findByText(renderer.root, 'Please verify your email address before signing in.')
    ).toBeTruthy();

    await act(async () => {
      findPressableByLabel(renderer.root, 'Resend verification email')!.props.onPress();
    });

    expect(resendVerification).toHaveBeenCalledWith('unverified@example.com');
    expect(findByText(renderer.root, 'Verification email sent.')).toBeTruthy();
  });

  it('the password visibility toggle switches secureTextEntry off and on', () => {
    mockUseAuth.mockReturnValue(baseAuth());

    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(<LoginScreen />);
    });

    expect(findInputByLabel(renderer.root, 'Password')!.props.secureTextEntry).toBe(true);

    act(() => {
      findPressableByLabel(renderer.root, 'Show password')!.props.onPress();
    });
    expect(findInputByLabel(renderer.root, 'Password')!.props.secureTextEntry).toBe(false);
    expect(findPressableByLabel(renderer.root, 'Hide password')).toBeTruthy();
  });

  it('Enter-key submission (onSubmitEditing) on the password field triggers sign-in', async () => {
    const login = jest.fn().mockResolvedValue(undefined);
    mockUseAuth.mockReturnValue(baseAuth({ login }));

    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(<LoginScreen />);
    });
    act(() => {
      findInputByLabel(renderer.root, 'Email')!.props.onChangeText('user@example.com');
    });
    act(() => {
      findInputByLabel(renderer.root, 'Password')!.props.onChangeText('correct-password-1');
    });
    await act(async () => {
      findInputByLabel(renderer.root, 'Password')!.props.onSubmitEditing();
    });

    expect(login).toHaveBeenCalledWith('user@example.com', 'correct-password-1');
  });

  it('clicking "Forgot password?" shows a clear not-yet-available notice, no navigation', () => {
    mockUseAuth.mockReturnValue(baseAuth());

    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(<LoginScreen />);
    });

    expect(containsText(renderer.root, "isn't available yet")).toBe(false);
    act(() => {
      findPressableByLabel(renderer.root, 'Forgot password?')!.props.onPress();
    });
    expect(containsText(renderer.root, "isn't available yet")).toBe(true);
  });
});

describe('computeLoginSections', () => {
  it('shows only the loading spinner while the initial fetch is in flight', () => {
    expect(
      computeLoginSections({
        providersLoading: true,
        providersCount: 0,
        devLoginEnabled: true,
        localAuthEnabled: true,
      })
    ).toEqual({
      showLoadingSpinner: true,
      showOAuthButtons: false,
      showEmailForm: false,
      showDivider: false,
      showDevLogin: false,
      showUnavailableMessage: false,
    });
  });

  it('shows the email form whenever local auth is enabled, regardless of OAuth provider count', () => {
    const sections = computeLoginSections({
      providersLoading: false,
      providersCount: 0,
      devLoginEnabled: false,
      localAuthEnabled: true,
    });
    expect(sections.showEmailForm).toBe(true);
    expect(sections.showUnavailableMessage).toBe(false);
  });

  it('shows the unavailable message only when every auth method is unavailable', () => {
    expect(
      computeLoginSections({
        providersLoading: false,
        providersCount: 0,
        devLoginEnabled: false,
        localAuthEnabled: false,
      }).showUnavailableMessage
    ).toBe(true);
  });

  it('shows the divider only when both OAuth buttons and the email form are shown', () => {
    expect(
      computeLoginSections({
        providersLoading: false,
        providersCount: 1,
        devLoginEnabled: false,
        localAuthEnabled: true,
      }).showDivider
    ).toBe(true);
    expect(
      computeLoginSections({
        providersLoading: false,
        providersCount: 0,
        devLoginEnabled: false,
        localAuthEnabled: true,
      }).showDivider
    ).toBe(false);
    expect(
      computeLoginSections({
        providersLoading: false,
        providersCount: 1,
        devLoginEnabled: false,
        localAuthEnabled: false,
      }).showDivider
    ).toBe(false);
  });

  it('shows dev login independently of every other section', () => {
    expect(
      computeLoginSections({
        providersLoading: false,
        providersCount: 0,
        devLoginEnabled: true,
        localAuthEnabled: false,
      }).showDevLogin
    ).toBe(true);
  });
});

describe('validateEmailField', () => {
  it('requires a non-empty value', () => {
    expect(validateEmailField('')).toBe('Email is required.');
    expect(validateEmailField('   ')).toBe('Email is required.');
  });

  it('rejects an obviously malformed address', () => {
    expect(validateEmailField('not-an-email')).toBe('Enter a valid email address.');
  });

  it('accepts a well-formed address', () => {
    expect(validateEmailField('user@example.com')).toBeNull();
  });
});

describe('validatePasswordField', () => {
  it('requires a non-empty value', () => {
    expect(validatePasswordField('')).toBe('Password is required.');
  });

  it('rejects a password shorter than 12 characters', () => {
    expect(validatePasswordField('short')).toBe('Password must be at least 12 characters.');
  });

  it('accepts a 12+ character password', () => {
    expect(validatePasswordField('correct-password-1')).toBeNull();
  });
});
