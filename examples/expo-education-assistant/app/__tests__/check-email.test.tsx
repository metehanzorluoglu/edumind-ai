import type { ReactNode } from 'react';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import CheckEmailScreen, { maskEmail } from '../check-email';

const mockUseAuth = jest.fn();
jest.mock('@/lib/AuthProvider', () => ({
  useAuth: () => mockUseAuth(),
}));

let mockParams: { email?: string } = {};
jest.mock('expo-router', () => ({
  Link: ({ children }: { children: ReactNode }) => children,
  useLocalSearchParams: () => mockParams,
}));

function findPressableByLabel(root: ReactTestInstance, label: string): ReactTestInstance | null {
  const matches = root.findAll(
    (node) => typeof node.props.onPress === 'function' && node.props.accessibilityLabel === label
  );
  return matches[0] ?? null;
}

function findByText(root: ReactTestInstance, matcher: string | RegExp): ReactTestInstance | null {
  const matches = root.findAll(
    (node) =>
      String(node.type) === 'Text' &&
      node.children.some(
        (child) =>
          typeof child === 'string' &&
          (typeof matcher === 'string' ? child.includes(matcher) : matcher.test(child))
      )
  );
  return matches[0] ?? null;
}

describe('maskEmail', () => {
  it('keeps the first character of the local part and the whole domain', () => {
    expect(maskEmail('jdoe@example.com')).toBe('j***@example.com');
  });

  it('returns the input unchanged if it has no @', () => {
    expect(maskEmail('not-an-email')).toBe('not-an-email');
  });
});

describe('CheckEmailScreen', () => {
  beforeEach(() => {
    mockParams = { email: 'jdoe@example.com' };
    mockUseAuth.mockReturnValue({ resendVerification: jest.fn().mockResolvedValue(undefined) });
  });

  afterEach(() => {
    mockUseAuth.mockReset();
  });

  it('shows the masked destination email', () => {
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(<CheckEmailScreen />);
    });
    expect(findByText(renderer.root, 'j***@example.com')).toBeTruthy();
  });

  it('resend button calls resendVerification with the email and shows a confirmation', async () => {
    const resendVerification = jest.fn().mockResolvedValue(undefined);
    mockUseAuth.mockReturnValue({ resendVerification });

    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(<CheckEmailScreen />);
    });

    await act(async () => {
      findPressableByLabel(renderer.root, 'Resend verification email')!.props.onPress();
    });

    expect(resendVerification).toHaveBeenCalledWith('jdoe@example.com');
    expect(findByText(renderer.root, 'Verification email sent.')).toBeTruthy();
    // Unmount to clear the cooldown-countdown interval this screen starts
    // on a successful resend — otherwise it dangles past the end of this
    // test (the real app relies on the component actually unmounting).
    act(() => {
      renderer.unmount();
    });
  });

  it('does not attempt a resend when no email param is present', () => {
    mockParams = {};
    const resendVerification = jest.fn();
    mockUseAuth.mockReturnValue({ resendVerification });

    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(<CheckEmailScreen />);
    });

    const button = findPressableByLabel(renderer.root, 'Resend verification email');
    expect(button!.props.disabled).toBe(true);
  });
});
