import { Platform } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { SelectionToolbar } from '../SelectionToolbar';

const RECT = { top: 100, left: 100, width: 80, height: 20 };

async function render(props: Partial<Parameters<typeof SelectionToolbar>[0]> = {}) {
  let renderer!: ReactTestRenderer;
  const defaults: Parameters<typeof SelectionToolbar>[0] = {
    anchorRect: RECT,
    onHighlight: jest.fn(),
    onAddNote: jest.fn(),
    onAskEduM8: jest.fn(),
  };
  await act(async () => {
    renderer = create(<SelectionToolbar {...defaults} {...props} />);
  });
  return renderer;
}

function findPressableByText(root: ReactTestInstance, text: string): ReactTestInstance {
  return root.find(
    (node) =>
      typeof node.props.onPress === 'function' &&
      node.findAll((n) => String(n.type) === 'Text' && n.children.includes(text)).length > 0
  );
}

describe('SelectionToolbar', () => {
  const originalOS = Platform.OS;
  afterEach(() => {
    Platform.OS = originalOS;
  });

  it('renders nothing on non-web platforms', async () => {
    Platform.OS = 'ios';
    const renderer = await render();
    expect(renderer.toJSON()).toBeNull();
  });

  it('renders Highlight / Add note / Ask EduM8 on web', async () => {
    Platform.OS = 'web';
    const renderer = await render();
    expect(findPressableByText(renderer.root, 'Highlight')).toBeTruthy();
    expect(findPressableByText(renderer.root, 'Add note')).toBeTruthy();
    expect(findPressableByText(renderer.root, 'Ask EduM8')).toBeTruthy();
  });

  it('calls the right handler for each button', async () => {
    Platform.OS = 'web';
    const onHighlight = jest.fn();
    const onAddNote = jest.fn();
    const onAskEduM8 = jest.fn();
    const renderer = await render({ onHighlight, onAddNote, onAskEduM8 });

    act(() => {
      findPressableByText(renderer.root, 'Highlight').props.onPress();
    });
    expect(onHighlight).toHaveBeenCalledTimes(1);

    act(() => {
      findPressableByText(renderer.root, 'Add note').props.onPress();
    });
    expect(onAddNote).toHaveBeenCalledTimes(1);

    act(() => {
      findPressableByText(renderer.root, 'Ask EduM8').props.onPress();
    });
    expect(onAskEduM8).toHaveBeenCalledTimes(1);
  });

  it('disables all actions while busy', async () => {
    Platform.OS = 'web';
    const renderer = await render({ busy: true });
    expect(findPressableByText(renderer.root, 'Highlight').props.disabled).toBe(true);
    expect(findPressableByText(renderer.root, 'Add note').props.disabled).toBe(true);
    expect(findPressableByText(renderer.root, 'Ask EduM8').props.disabled).toBe(true);
  });

  it('is labeled as a toolbar for accessibility', async () => {
    Platform.OS = 'web';
    const renderer = await render();
    expect(
      renderer.root.findAll((n) => n.props.accessibilityRole === 'toolbar').length
    ).toBeGreaterThanOrEqual(1);
  });
});
