import type { ReactNode } from 'react';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import VerifyEmailScreen from '../verify-email';

let mockParams: { status?: string } = {};
jest.mock('expo-router', () => ({
  Link: ({ children }: { children: ReactNode }) => children,
  useLocalSearchParams: () => mockParams,
}));

function findByText(root: ReactTestInstance, text: string): ReactTestInstance | null {
  const matches = root.findAll(
    (node) => String(node.type) === 'Text' && node.children.includes(text)
  );
  return matches[0] ?? null;
}

function render(): ReactTestInstance {
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(<VerifyEmailScreen />);
  });
  return renderer.root;
}

describe('VerifyEmailScreen', () => {
  it('shows a success message for status=success', () => {
    mockParams = { status: 'success' };
    expect(findByText(render(), 'Email verified')).toBeTruthy();
  });

  it('shows an expired message for status=expired', () => {
    mockParams = { status: 'expired' };
    expect(findByText(render(), 'Link expired')).toBeTruthy();
  });

  it('shows an already-used message for status=already_used', () => {
    mockParams = { status: 'already_used' };
    expect(findByText(render(), 'Link already used')).toBeTruthy();
  });

  it('shows an invalid message for status=invalid', () => {
    mockParams = { status: 'invalid' };
    expect(findByText(render(), 'Invalid link')).toBeTruthy();
  });

  it('falls back to the invalid message for a missing/unknown status', () => {
    mockParams = {};
    expect(findByText(render(), 'Invalid link')).toBeTruthy();
  });

  it('always offers a way back to sign in', () => {
    mockParams = { status: 'success' };
    expect(findByText(render(), 'Continue to sign in')).toBeTruthy();
  });
});
