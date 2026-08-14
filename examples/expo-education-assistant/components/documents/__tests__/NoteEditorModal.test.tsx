import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { NoteEditorModal } from '../NoteEditorModal';

function textOf(node: ReactTestInstance): string {
  return node.children
    .map((c) => (typeof c === 'string' || typeof c === 'number' ? String(c) : ''))
    .join('');
}

function findByText(root: ReactTestInstance, text: string): ReactTestInstance {
  const matches = root.findAll((node) => String(node.type) === 'Text' && textOf(node) === text);
  if (matches.length === 0) throw new Error(`No Text node found with content "${text}"`);
  return matches[0]!;
}

function findPressableByText(root: ReactTestInstance, text: string): ReactTestInstance {
  return root.find(
    (node) =>
      typeof node.props.onPress === 'function' &&
      node.findAll((n) => String(n.type) === 'Text' && textOf(n) === text).length > 0
  );
}

async function renderModal(props: Partial<Parameters<typeof NoteEditorModal>[0]> = {}) {
  let renderer!: ReactTestRenderer;
  const defaults: Parameters<typeof NoteEditorModal>[0] = {
    selectedText: 'Students completed a 12-week program.',
    initialNote: '',
    saving: false,
    onCancel: jest.fn(),
    onSave: jest.fn(),
  };
  await act(async () => {
    renderer = create(<NoteEditorModal {...defaults} {...props} />);
  });
  return renderer;
}

describe('NoteEditorModal', () => {
  it('shows the selected passage read-only, for context', async () => {
    const renderer = await renderModal();
    expect(findByText(renderer.root, '“Students completed a 12-week program.”')).toBeTruthy();
  });

  it('prefills the note field with initialNote (edit mode)', async () => {
    const renderer = await renderModal({ initialNote: 'Existing note.' });
    const input = renderer.root.find((n) => String(n.type) === 'TextInput');
    expect(input.props.value).toBe('Existing note.');
  });

  it('calls onSave with the trimmed note text', async () => {
    const onSave = jest.fn();
    const renderer = await renderModal({ onSave });
    const input = renderer.root.find((n) => String(n.type) === 'TextInput');

    act(() => {
      input.props.onChangeText('  Worth revisiting.  ');
    });
    act(() => {
      findPressableByText(renderer.root, 'Save').props.onPress();
    });
    expect(onSave).toHaveBeenCalledWith('Worth revisiting.');
  });

  it('calls onCancel when Cancel is pressed', async () => {
    const onCancel = jest.fn();
    const renderer = await renderModal({ onCancel });

    act(() => {
      findPressableByText(renderer.root, 'Cancel').props.onPress();
    });
    expect(onCancel).toHaveBeenCalled();
  });

  it('calls onCancel when the backdrop is pressed', async () => {
    const onCancel = jest.fn();
    const renderer = await renderModal({ onCancel });

    act(() => {
      renderer.root.find((n) => n.props.accessibilityLabel === 'Close note editor').props.onPress();
    });
    expect(onCancel).toHaveBeenCalled();
  });

  it('disables Cancel while saving', async () => {
    const renderer = await renderModal({ saving: true });
    expect(findPressableByText(renderer.root, 'Cancel').props.disabled).toBe(true);
  });
});
