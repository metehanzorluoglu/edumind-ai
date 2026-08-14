import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { SelectionContextChip, type PendingSelectionContext } from '../SelectionContextChip';

function textOf(node: ReactTestInstance): string {
  return node.children
    .map((c) => (typeof c === 'string' || typeof c === 'number' ? String(c) : ''))
    .join('');
}

function findByTextIncluding(root: ReactTestInstance, substring: string): ReactTestInstance {
  const matches = root.findAll(
    (node) => String(node.type) === 'Text' && textOf(node).includes(substring)
  );
  if (matches.length === 0) throw new Error(`No Text node found containing "${substring}"`);
  return matches[0]!;
}

async function render(context: PendingSelectionContext, onRemove = jest.fn()) {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<SelectionContextChip context={context} onRemove={onRemove} />);
  });
  return { renderer, onRemove };
}

const CONTEXT: PendingSelectionContext = {
  documentId: 'd1',
  documentName: 'paper-a.pdf',
  pageNumber: 3,
  selectedText: 'Students completed a 12-week program.',
};

describe('SelectionContextChip', () => {
  it('shows the document name, page number, and the exact selected passage', async () => {
    const { renderer } = await render(CONTEXT);
    expect(findByTextIncluding(renderer.root, 'paper-a.pdf')).toBeTruthy();
    expect(findByTextIncluding(renderer.root, 'page 3')).toBeTruthy();
    expect(
      findByTextIncluding(renderer.root, 'Students completed a 12-week program.')
    ).toBeTruthy();
  });

  it('calls onRemove when the remove button is pressed', async () => {
    const { renderer, onRemove } = await render(CONTEXT);
    act(() => {
      renderer.root
        .find((n) => n.props.accessibilityLabel === 'Remove selected passage from this question')
        .props.onPress();
    });
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it('omits the page number when it is falsy (e.g. 0)', async () => {
    const { renderer } = await render({ ...CONTEXT, pageNumber: 0 });
    expect(findByTextIncluding(renderer.root, 'paper-a.pdf')).toBeTruthy();
    expect(() => findByTextIncluding(renderer.root, 'page 0')).toThrow();
  });
});
