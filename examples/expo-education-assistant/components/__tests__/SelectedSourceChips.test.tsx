import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { SelectedSourceChips } from '../SelectedSourceChips';
import type { PendingSourceDoc } from '../ChatSourcesPicker';

function textContent(node: ReactTestInstance): string {
  return node.children.filter((child): child is string => typeof child === 'string').join('');
}

function findByText(root: ReactTestInstance, text: string): ReactTestInstance | null {
  const matches = root.findAll(
    (node) => String(node.type) === 'Text' && textContent(node) === text
  );
  return matches[0] ?? null;
}

function render(element: React.ReactElement): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(element);
  });
  return renderer;
}

const DOC_A: PendingSourceDoc = { documentId: 'a', displayName: 'paper-a.pdf' };
const DOC_B: PendingSourceDoc = { documentId: 'b', displayName: 'paper-b.pdf' };
const DOC_C: PendingSourceDoc = { documentId: 'c', displayName: 'notes.txt' };

describe('SelectedSourceChips', () => {
  it('renders nothing when there are no sources', () => {
    const renderer = render(<SelectedSourceChips sources={[]} onRemove={jest.fn()} />);
    expect(renderer.toJSON()).toBeNull();
  });

  it('shows at most 2 chips plus a "+N" overflow badge, never a wall of chips', () => {
    const renderer = render(
      <SelectedSourceChips sources={[DOC_A, DOC_B, DOC_C]} onRemove={jest.fn()} />
    );
    expect(findByText(renderer.root, 'paper-a.pdf')).toBeTruthy();
    expect(findByText(renderer.root, 'paper-b.pdf')).toBeTruthy();
    expect(findByText(renderer.root, 'notes.txt')).toBeNull(); // collapsed into the overflow badge
    expect(findByText(renderer.root, '+1')).toBeTruthy();
  });

  it("calls onRemove with the right document id when a chip's × is pressed", () => {
    const onRemove = jest.fn();
    const renderer = render(<SelectedSourceChips sources={[DOC_A]} onRemove={onRemove} />);
    const removeButton = renderer.root.find(
      (node) => node.props.accessibilityLabel === 'Remove paper-a.pdf from selected sources'
    );
    act(() => {
      removeButton.props.onPress();
    });
    expect(onRemove).toHaveBeenCalledWith('a');
  });

  // Frontend/Platform Milestone 3.2.2 Part D — the old "can't remove the
  // sole remaining source in Zoom-In" guard was removed from this
  // component entirely. Removing the last source is now always allowed
  // here; the caller (chat/new.tsx's pendingSources updater,
  // chat/[id].tsx's onRemove) is responsible for falling back
  // Zoom-In -> Prioritize when the selection becomes empty. This test
  // guards against the disabled/blocked affordance ever regressing back
  // into this shared component.
  it("never disables removal of the sole remaining source (auto-fallback is the caller's job, not this component's)", () => {
    const onRemove = jest.fn();
    const renderer = render(<SelectedSourceChips sources={[DOC_A]} onRemove={onRemove} />);
    const removeButton = renderer.root.find(
      (node) => node.props.accessibilityLabel === 'Remove paper-a.pdf from selected sources'
    );
    expect(removeButton.props.disabled).toBeFalsy();
    act(() => {
      removeButton.props.onPress();
    });
    expect(onRemove).toHaveBeenCalledWith('a');
  });
});
