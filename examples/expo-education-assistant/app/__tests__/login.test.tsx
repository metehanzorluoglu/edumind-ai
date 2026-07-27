import { act, create, type ReactTestInstance } from 'react-test-renderer';
import LoginScreen, { computeLoginBranch } from '../login';

const mockUseAuth = jest.fn();
jest.mock('@/lib/AuthProvider', () => ({
  useAuth: () => mockUseAuth(),
}));

function baseAuth(overrides: Partial<ReturnType<typeof mockUseAuth>> = {}) {
  return {
    status: 'unauthenticated',
    providers: [],
    devLoginEnabled: false,
    providersLoading: false,
    error: null,
    startOAuth: jest.fn(),
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

describe('LoginScreen', () => {
  afterEach(() => {
    mockUseAuth.mockReset();
  });

  it('shows the "no providers configured" message and a Retry button when providers is empty and dev login is disabled', () => {
    mockUseAuth.mockReturnValue(baseAuth({ providers: [], devLoginEnabled: false }));

    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(<LoginScreen />);
    });

    expect(
      findByText(renderer.root, 'No sign-in providers are configured on this backend yet.')
    ).toBeTruthy();
    expect(findPressableByLabel(renderer.root, 'Retry loading sign-in providers')).toBeTruthy();
    expect(findPressableByLabel(renderer.root, 'Dev sign in')).toBeNull();
  });

  it('does NOT show the "no providers configured" message when providers is empty but dev login is enabled', () => {
    mockUseAuth.mockReturnValue(baseAuth({ providers: [], devLoginEnabled: true }));

    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(<LoginScreen />);
    });

    expect(
      findByText(renderer.root, 'No sign-in providers are configured on this backend yet.')
    ).toBeNull();
    // The dev-login form is shown instead — this is the actual bug fix:
    // dev_login_enabled: true must not be masked by the OAuth empty state.
    expect(findPressableByLabel(renderer.root, 'Dev sign in')).toBeTruthy();
  });

  it('shows OAuth provider buttons (and no dev section) when providers are configured and dev login is disabled', () => {
    mockUseAuth.mockReturnValue(
      baseAuth({
        providers: [
          { provider: 'google', display_name: 'Google' },
          { provider: 'facebook', display_name: 'Facebook' },
        ],
        devLoginEnabled: false,
      })
    );

    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(<LoginScreen />);
    });

    expect(findPressableByLabel(renderer.root, 'Continue with Google')).toBeTruthy();
    expect(findPressableByLabel(renderer.root, 'Continue with Facebook')).toBeTruthy();
    expect(
      findByText(renderer.root, 'No sign-in providers are configured on this backend yet.')
    ).toBeNull();
    expect(findPressableByLabel(renderer.root, 'Dev sign in')).toBeNull();
  });

  it('shows both OAuth provider buttons and the dev-login form when both are available', () => {
    mockUseAuth.mockReturnValue(
      baseAuth({
        providers: [{ provider: 'google', display_name: 'Google' }],
        devLoginEnabled: true,
      })
    );

    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(<LoginScreen />);
    });

    expect(findPressableByLabel(renderer.root, 'Continue with Google')).toBeTruthy();
    expect(findPressableByLabel(renderer.root, 'Dev sign in')).toBeTruthy();
  });

  it('shows a loading spinner while providers are still loading, never the empty-state message', () => {
    mockUseAuth.mockReturnValue(
      baseAuth({ providers: [], devLoginEnabled: false, providersLoading: true })
    );

    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(<LoginScreen />);
    });

    expect(renderer.root.findAllByType('ActivityIndicator' as never).length).toBeGreaterThan(0);
    expect(
      findByText(renderer.root, 'No sign-in providers are configured on this backend yet.')
    ).toBeNull();
  });

  it('Retry calls refreshProviders when the empty-state (dev login disabled) is shown', () => {
    const refreshProviders = jest.fn();
    mockUseAuth.mockReturnValue(
      baseAuth({ providers: [], devLoginEnabled: false, refreshProviders })
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
    mockUseAuth.mockReturnValue(
      baseAuth({ error: 'Sign-in failed. Please try again.', clearError })
    );

    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(<LoginScreen />);
    });

    expect(findByText(renderer.root, 'Sign-in failed. Please try again.')).toBeTruthy();

    act(() => {
      findPressableByLabel(renderer.root, 'Dismiss error')!.props.onPress();
    });

    expect(clearError).toHaveBeenCalled();
  });
});

describe('computeLoginBranch', () => {
  // The exact response from the bug report: providers: [], dev_login_enabled: true.
  it('is "empty-with-dev-login", never "empty-no-dev-login", for the exact bug-report values', () => {
    expect(
      computeLoginBranch({ providersLoading: false, providersCount: 0, devLoginEnabled: true })
    ).toBe('empty-with-dev-login');
  });

  it('is "empty-no-dev-login" only when there truly are no providers and dev login is off', () => {
    expect(
      computeLoginBranch({ providersLoading: false, providersCount: 0, devLoginEnabled: false })
    ).toBe('empty-no-dev-login');
  });

  it('is "loading" while the initial fetch is in flight, regardless of devLoginEnabled', () => {
    expect(
      computeLoginBranch({ providersLoading: true, providersCount: 0, devLoginEnabled: true })
    ).toBe('loading');
    expect(
      computeLoginBranch({ providersLoading: true, providersCount: 0, devLoginEnabled: false })
    ).toBe('loading');
  });

  it('is "provider-buttons" whenever at least one OAuth provider exists, regardless of devLoginEnabled', () => {
    expect(
      computeLoginBranch({ providersLoading: false, providersCount: 1, devLoginEnabled: false })
    ).toBe('provider-buttons');
    expect(
      computeLoginBranch({ providersLoading: false, providersCount: 1, devLoginEnabled: true })
    ).toBe('provider-buttons');
  });

  it('prioritizes showing existing providers over the loading spinner once providers have arrived', () => {
    // providersLoading can still be true briefly after providers land
    // (setProvidersLoading(false) is a separate, later state update) —
    // once there's at least one provider, that must win immediately.
    expect(
      computeLoginBranch({ providersLoading: true, providersCount: 1, devLoginEnabled: false })
    ).toBe('provider-buttons');
  });
});
