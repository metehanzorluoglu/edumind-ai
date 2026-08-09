import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { ChatSourcesButton } from '../ChatSourcesButton';

function findByText(root: ReactTestInstance, text: string): ReactTestInstance {
  return root.find((node) => String(node.type) === 'Text' && node.children.includes(text));
}

function renderButton(props: Parameters<typeof ChatSourcesButton>[0]): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<ChatSourcesButton {...props} />);
  });
  return renderer;
}

describe('ChatSourcesButton', () => {
  it('shows "Add sources" when count is 0', () => {
    const renderer = renderButton({ count: 0, onPress: jest.fn() });
    expect(findByText(renderer.root, 'Add sources')).toBeTruthy();
  });

  it('shows "Add sources" when count is null (not yet loaded)', () => {
    const renderer = renderButton({ count: null, onPress: jest.fn() });
    expect(findByText(renderer.root, 'Add sources')).toBeTruthy();
  });

  it('shows a singular label for exactly one source', () => {
    const renderer = renderButton({ count: 1, onPress: jest.fn() });
    expect(findByText(renderer.root, '1 source')).toBeTruthy();
  });

  it('shows a plural count label for multiple sources', () => {
    const renderer = renderButton({ count: 3, onPress: jest.fn() });
    expect(findByText(renderer.root, '3 sources')).toBeTruthy();
  });

  it('calls onPress when pressed', () => {
    const onPress = jest.fn();
    const renderer = renderButton({ count: 2, onPress });
    const pressable = renderer.root.find((node) => typeof node.props.onPress === 'function');
    act(() => {
      pressable.props.onPress();
    });
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('is disabled when disabled=true', () => {
    const renderer = renderButton({ count: 0, onPress: jest.fn(), disabled: true });
    const pressable = renderer.root.find((node) => typeof node.props.onPress === 'function');
    expect(pressable.props.disabled).toBe(true);
  });

  // Milestone 4: Zoom-In / strict selected-source mode.
  describe('zoom-in mode', () => {
    it('shows a distinct "Zoom-In · N" label, never confusable with the Prioritize count label', () => {
      const renderer = renderButton({ count: 2, mode: 'zoom-in', onPress: jest.fn() });
      expect(findByText(renderer.root, 'Zoom-In · 2')).toBeTruthy();
      expect(() => findByText(renderer.root, '2 sources')).toThrow();
    });

    it('shows "Zoom-In" (no count) while still loading', () => {
      const renderer = renderButton({ count: null, mode: 'zoom-in', onPress: jest.fn() });
      expect(findByText(renderer.root, 'Zoom-In')).toBeTruthy();
    });

    it('defaults to prioritize mode when `mode` is omitted', () => {
      const renderer = renderButton({ count: 1, onPress: jest.fn() });
      expect(findByText(renderer.root, '1 source')).toBeTruthy();
    });
  });

  // Milestone 4 §15 (Milestone 3 bug fix): the initial-load-failure state.
  describe('error/retry state', () => {
    it('shows a distinct error label instead of any count-based label', () => {
      const renderer = renderButton({
        count: 3,
        mode: 'zoom-in',
        hasError: true,
        onPress: jest.fn(),
      });
      expect(findByText(renderer.root, 'Sources unavailable')).toBeTruthy();
      expect(() => findByText(renderer.root, 'Zoom-In · 3')).toThrow();
    });

    it('is never disabled purely by hasError — the retry affordance stays pressable', () => {
      const renderer = renderButton({ count: null, hasError: true, onPress: jest.fn() });
      const pressable = renderer.root.find((node) => typeof node.props.onPress === 'function');
      expect(pressable.props.disabled).toBeFalsy();
    });

    it('still calls onPress when pressed in the error state (caller decides retry vs. open)', () => {
      const onPress = jest.fn();
      const renderer = renderButton({ count: null, hasError: true, onPress });
      const pressable = renderer.root.find((node) => typeof node.props.onPress === 'function');
      act(() => {
        pressable.props.onPress();
      });
      expect(onPress).toHaveBeenCalledTimes(1);
    });
  });
});
