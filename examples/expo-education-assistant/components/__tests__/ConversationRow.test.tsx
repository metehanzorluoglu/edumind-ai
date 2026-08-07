/**
 * @jest-environment jsdom
 *
 * jsdom for the same reason as SidebarContextMenuContext.test.tsx: the
 * Escape-cancels-rename test needs a real `document` to dispatch a real
 * KeyboardEvent against — ConversationRow's Escape handler carries the
 * same web-only, real-DOM guard as the menu's. Every other test here
 * works identically under either environment.
 *
 * Regression tests for the "Rename menu item does nothing" bug: the
 * three-dot menu's Rename action must swap the row for an inline input
 * that commits via onRename (Enter or blur/outside-click), cancels on
 * Escape, rejects empty titles without an API call, and — when the API
 * rejects — shows the error inline and stays editable instead of failing
 * silently.
 */
import { Platform } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { ConversationRow, type ConversationRowProps } from '../ConversationRow';
import { SidebarContextMenuProvider } from '@/lib/SidebarContextMenuContext';

// Same mock as ConversationSidebar.test.tsx — react-test-renderer's
// measureInWindow stub never invokes its callback, so without this every
// three-dot press would silently do nothing.
jest.mock('@/lib/measureWindowRect', () => ({
  measureWindowRect: (
    _ref: unknown,
    callback: (rect: { x: number; y: number; width: number; height: number }) => void
  ) => callback({ x: 100, y: 40, width: 24, height: 24 }),
}));

jest.mock('@/lib/focusElement', () => ({
  focusRef: jest.fn(),
}));

function findByText(root: ReactTestInstance, text: string): ReactTestInstance {
  return root.find((node) => String(node.type) === 'Text' && node.children.includes(text));
}

function queryByText(root: ReactTestInstance, text: string): ReactTestInstance | null {
  const matches = root.findAll(
    (node) => String(node.type) === 'Text' && node.children.includes(text)
  );
  return matches[0] ?? null;
}

function findPressableByText(root: ReactTestInstance, text: string): ReactTestInstance {
  return root.find(
    (node) =>
      typeof node.props.onPress === 'function' &&
      node.findAll((n) => String(n.type) === 'Text' && n.children.includes(text)).length > 0
  );
}

function findRenameInput(root: ReactTestInstance): ReactTestInstance {
  return root.find(
    (node) =>
      String(node.type) === 'TextInput' && node.props.accessibilityLabel === 'Conversation title'
  );
}

function queryRenameInput(root: ReactTestInstance): ReactTestInstance | null {
  const matches = root.findAll(
    (node) =>
      String(node.type) === 'TextInput' && node.props.accessibilityLabel === 'Conversation title'
  );
  return matches[0] ?? null;
}

async function renderRow(
  overrides: Partial<ConversationRowProps> = {}
): Promise<ReactTestRenderer> {
  const props: ConversationRowProps = {
    item: {
      id: 'c1',
      title: 'Guided reading question',
      lastMessagePreview: 'Here is the answer',
    },
    active: false,
    onSelect: jest.fn(),
    onRename: jest.fn().mockResolvedValue(undefined),
    onDelete: jest.fn(),
    deleting: false,
    onAddToProject: jest.fn(),
    ...overrides,
  };
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <SidebarContextMenuProvider>
        <ConversationRow {...props} />
      </SidebarContextMenuProvider>
    );
  });
  return renderer;
}

/** Opens the row's three-dot menu and presses "Rename" — rename mode
 * opens one macrotask after the press (deferred so react-native-web's
 * menu-Modal focus-trap teardown can't race the input's autoFocus), so
 * this flushes that timer before returning. */
async function openRename(renderer: ReactTestRenderer): Promise<void> {
  act(() => {
    // The trigger is an icon-only button — select it by its stable
    // accessibility label, not its (no longer textual) glyph.
    renderer.root
      .find(
        (node) =>
          typeof node.props.onPress === 'function' &&
          String(node.props.accessibilityLabel ?? '').startsWith('Options for')
      )
      .props.onPress();
  });
  await act(async () => {
    findPressableByText(renderer.root, 'Rename').props.onPress();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('ConversationRow rename', () => {
  it('the Rename menu item swaps the row for an inline input prefilled with the current title', async () => {
    const renderer = await renderRow();

    await openRename(renderer);

    expect(findRenameInput(renderer.root).props.value).toBe('Guided reading question');
    // The static title text is gone while editing — the input replaced it.
    expect(queryByText(renderer.root, 'Guided reading question')).toBeNull();
  });

  it('Enter commits the trimmed new title via onRename and closes the input', async () => {
    const onRename = jest.fn().mockResolvedValue(undefined);
    const renderer = await renderRow({ onRename });

    await openRename(renderer);
    act(() => {
      findRenameInput(renderer.root).props.onChangeText('  Renamed conversation  ');
    });
    await act(async () => {
      findRenameInput(renderer.root).props.onSubmitEditing();
      await Promise.resolve();
    });

    expect(onRename).toHaveBeenCalledWith('c1', 'Renamed conversation');
    expect(queryRenameInput(renderer.root)).toBeNull();
  });

  it('an outside click (input blur) commits the rename too', async () => {
    const onRename = jest.fn().mockResolvedValue(undefined);
    const renderer = await renderRow({ onRename });

    await openRename(renderer);
    act(() => {
      findRenameInput(renderer.root).props.onChangeText('Renamed on blur');
    });
    await act(async () => {
      findRenameInput(renderer.root).props.onBlur();
      await Promise.resolve();
    });

    expect(onRename).toHaveBeenCalledWith('c1', 'Renamed on blur');
    expect(queryRenameInput(renderer.root)).toBeNull();
  });

  it('Escape cancels the rename — no API call, and the saved title is restored', async () => {
    const originalOS = Platform.OS;
    Platform.OS = 'web';
    try {
      const onRename = jest.fn().mockResolvedValue(undefined);
      const renderer = await renderRow({ onRename });

      await openRename(renderer);
      act(() => {
        findRenameInput(renderer.root).props.onChangeText('Aborted title');
      });
      act(() => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      });

      expect(onRename).not.toHaveBeenCalled();
      expect(queryRenameInput(renderer.root)).toBeNull();
      expect(findByText(renderer.root, 'Guided reading question')).toBeTruthy();
    } finally {
      Platform.OS = originalOS;
    }
  });

  it('a non-Escape key does not cancel the rename', async () => {
    const originalOS = Platform.OS;
    Platform.OS = 'web';
    try {
      const onRename = jest.fn().mockResolvedValue(undefined);
      const renderer = await renderRow({ onRename });

      await openRename(renderer);
      act(() => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      });

      // Still editing — only Escape cancels.
      expect(queryRenameInput(renderer.root)).not.toBeNull();
      expect(onRename).not.toHaveBeenCalled();
    } finally {
      Platform.OS = originalOS;
    }
  });

  it('an empty/whitespace-only title is rejected without an API call and keeps the old title', async () => {
    const onRename = jest.fn().mockResolvedValue(undefined);
    const renderer = await renderRow({ onRename });

    await openRename(renderer);
    act(() => {
      findRenameInput(renderer.root).props.onChangeText('   ');
    });
    await act(async () => {
      findRenameInput(renderer.root).props.onSubmitEditing();
      await Promise.resolve();
    });

    expect(onRename).not.toHaveBeenCalled();
    expect(queryRenameInput(renderer.root)).toBeNull();
    expect(findByText(renderer.root, 'Guided reading question')).toBeTruthy();
  });

  it('submitting the unchanged title does not call the API', async () => {
    const onRename = jest.fn().mockResolvedValue(undefined);
    const renderer = await renderRow({ onRename });

    await openRename(renderer);
    await act(async () => {
      findRenameInput(renderer.root).props.onSubmitEditing();
      await Promise.resolve();
    });

    expect(onRename).not.toHaveBeenCalled();
    expect(queryRenameInput(renderer.root)).toBeNull();
  });

  it('a failed rename shows the error inline, keeps the input open, and a retry can succeed', async () => {
    const onRename = jest
      .fn()
      .mockRejectedValueOnce(new Error('You do not have permission to rename this conversation.'))
      .mockResolvedValueOnce(undefined);
    const renderer = await renderRow({ onRename });

    await openRename(renderer);
    act(() => {
      findRenameInput(renderer.root).props.onChangeText('First attempt');
    });
    await act(async () => {
      findRenameInput(renderer.root).props.onSubmitEditing();
      await Promise.resolve();
    });

    expect(onRename).toHaveBeenCalledWith('c1', 'First attempt');
    // The error is visible and the input stays open for a retry — the
    // failure is never silent.
    expect(
      findByText(renderer.root, 'You do not have permission to rename this conversation.')
    ).toBeTruthy();
    expect(queryRenameInput(renderer.root)).not.toBeNull();

    // Typing clears the error, and the retry commits.
    act(() => {
      findRenameInput(renderer.root).props.onChangeText('Second attempt');
    });
    expect(
      queryByText(renderer.root, 'You do not have permission to rename this conversation.')
    ).toBeNull();
    await act(async () => {
      findRenameInput(renderer.root).props.onSubmitEditing();
      await Promise.resolve();
    });

    expect(onRename).toHaveBeenCalledWith('c1', 'Second attempt');
    expect(queryRenameInput(renderer.root)).toBeNull();
  });

  it('Enter followed by the blur it triggers commits exactly once (no duplicate PATCH)', async () => {
    const onRename = jest.fn().mockResolvedValue(undefined);
    const renderer = await renderRow({ onRename });

    await openRename(renderer);
    act(() => {
      findRenameInput(renderer.root).props.onChangeText('Renamed once');
    });
    await act(async () => {
      const input = findRenameInput(renderer.root);
      input.props.onSubmitEditing(); // Enter…
      input.props.onBlur(); // …which on web fires a blur right afterwards
      await Promise.resolve();
    });

    expect(onRename).toHaveBeenCalledTimes(1);
    expect(onRename).toHaveBeenCalledWith('c1', 'Renamed once');
  });

  it('renaming never calls onSelect — the current conversation stays selected', async () => {
    const onSelect = jest.fn();
    const onRename = jest.fn().mockResolvedValue(undefined);
    const renderer = await renderRow({ active: true, onSelect, onRename });

    await openRename(renderer);
    act(() => {
      findRenameInput(renderer.root).props.onChangeText('Renamed conversation');
    });
    await act(async () => {
      findRenameInput(renderer.root).props.onSubmitEditing();
      await Promise.resolve();
    });

    expect(onRename).toHaveBeenCalledWith('c1', 'Renamed conversation');
    expect(onSelect).not.toHaveBeenCalled();
  });
});
