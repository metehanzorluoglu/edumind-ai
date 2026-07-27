/**
 * @jest-environment jsdom
 *
 * jsdom (rather than this repo's usual node/react-test-renderer default)
 * only because the Escape-closes-on-web test needs a real `document` to
 * dispatch a real KeyboardEvent against — see SidebarContextMenuContext's
 * own guard against Platform.OS === 'web' with no DOM behind it. Every
 * other test here works identically under either environment.
 *
 * This suite exercises the shared controller directly, with bare `Trigger`
 * stand-ins for both a conversation row's and a project row's real
 * three-dot buttons — proving the "only one menu, of either kind, at a
 * time" guarantee doesn't depend on which real component calls it.
 */
import { Modal, Platform, Pressable, Text, View } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import {
  SidebarContextMenuProvider,
  useSidebarContextMenu,
  type SidebarContextMenuAction,
} from '../SidebarContextMenuContext';

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

function findMenuContainer(root: ReactTestInstance): ReactTestInstance {
  return root.find((node) => node.props.role === 'menu');
}

function findByAccessibilityLabel(root: ReactTestInstance, label: string): ReactTestInstance {
  return root.find((node) => node.props.accessibilityLabel === label);
}

function renderWithAct(element: React.ReactElement): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(element);
  });
  return renderer;
}

/** A stand-in for either ConversationRow's or ProjectRow's own trigger:
 * opens `menuId`'s menu with the given actions at a fixed anchor rect when
 * pressed. `kind` only affects the rendered trigger text, purely so tests
 * can tell a conversation-style and a project-style trigger apart. */
function Trigger({
  kind,
  menuId,
  actions,
  anchor = { x: 0, y: 0, width: 24, height: 24 },
}: {
  kind: 'conversation' | 'project';
  menuId: string;
  actions: SidebarContextMenuAction[];
  anchor?: { x: number; y: number; width: number; height: number };
}) {
  const { openMenu } = useSidebarContextMenu();
  return (
    <Pressable onPress={() => openMenu({ menuId, anchor, actions })}>
      <Text>{`trigger-${kind}-${menuId}`}</Text>
    </Pressable>
  );
}

function actionsFor(label: string, onPress: () => void): SidebarContextMenuAction[] {
  return [
    { key: 'rename', label: 'Rename', onPress: jest.fn() },
    { key: 'delete', label, destructive: true, onPress },
  ];
}

describe('SidebarContextMenuProvider', () => {
  it('only one menu is open at a time, for two rows of the same kind', () => {
    const renderer = renderWithAct(
      <SidebarContextMenuProvider>
        <Trigger kind="conversation" menuId="c1" actions={actionsFor('Delete C1', jest.fn())} />
        <Trigger kind="conversation" menuId="c2" actions={actionsFor('Delete C2', jest.fn())} />
      </SidebarContextMenuProvider>
    );

    act(() => {
      findPressableByText(renderer.root, 'trigger-conversation-c1').props.onPress();
    });
    expect(findByText(renderer.root, 'Delete C1')).toBeTruthy();

    act(() => {
      findPressableByText(renderer.root, 'trigger-conversation-c2').props.onPress();
    });
    expect(queryByText(renderer.root, 'Delete C1')).toBeNull();
    expect(findByText(renderer.root, 'Delete C2')).toBeTruthy();
  });

  it('opening a project menu closes an open conversation menu', () => {
    const renderer = renderWithAct(
      <SidebarContextMenuProvider>
        <Trigger kind="conversation" menuId="c1" actions={actionsFor('Delete', jest.fn())} />
        <Trigger kind="project" menuId="p1" actions={actionsFor('Delete project', jest.fn())} />
      </SidebarContextMenuProvider>
    );

    act(() => {
      findPressableByText(renderer.root, 'trigger-conversation-c1').props.onPress();
    });
    expect(findByText(renderer.root, 'Delete')).toBeTruthy();

    act(() => {
      findPressableByText(renderer.root, 'trigger-project-p1').props.onPress();
    });
    expect(queryByText(renderer.root, 'Delete')).toBeNull();
    expect(findByText(renderer.root, 'Delete project')).toBeTruthy();
  });

  it('opening a conversation menu closes an open project menu', () => {
    const renderer = renderWithAct(
      <SidebarContextMenuProvider>
        <Trigger kind="project" menuId="p1" actions={actionsFor('Delete project', jest.fn())} />
        <Trigger kind="conversation" menuId="c1" actions={actionsFor('Delete', jest.fn())} />
      </SidebarContextMenuProvider>
    );

    act(() => {
      findPressableByText(renderer.root, 'trigger-project-p1').props.onPress();
    });
    expect(findByText(renderer.root, 'Delete project')).toBeTruthy();

    act(() => {
      findPressableByText(renderer.root, 'trigger-conversation-c1').props.onPress();
    });
    expect(queryByText(renderer.root, 'Delete project')).toBeNull();
    expect(findByText(renderer.root, 'Delete')).toBeTruthy();
  });

  it('fires the action belonging to the currently open menu, not a stale one', () => {
    const deleteConversation = jest.fn();
    const deleteProject = jest.fn();
    const renderer = renderWithAct(
      <SidebarContextMenuProvider>
        <Trigger
          kind="conversation"
          menuId="c1"
          actions={actionsFor('Delete', deleteConversation)}
        />
        <Trigger kind="project" menuId="p1" actions={actionsFor('Delete', deleteProject)} />
      </SidebarContextMenuProvider>
    );

    act(() => {
      findPressableByText(renderer.root, 'trigger-conversation-c1').props.onPress();
    });
    act(() => {
      findPressableByText(renderer.root, 'trigger-project-p1').props.onPress();
    });
    act(() => {
      findPressableByText(renderer.root, 'Delete').props.onPress();
    });

    expect(deleteProject).toHaveBeenCalledTimes(1);
    expect(deleteConversation).not.toHaveBeenCalled();
  });

  it('clicking outside (the backdrop) closes the menu', () => {
    const renderer = renderWithAct(
      <SidebarContextMenuProvider>
        <Trigger kind="project" menuId="p1" actions={actionsFor('Delete project', jest.fn())} />
      </SidebarContextMenuProvider>
    );

    act(() => {
      findPressableByText(renderer.root, 'trigger-project-p1').props.onPress();
    });
    expect(findByText(renderer.root, 'Delete project')).toBeTruthy();

    act(() => {
      findByAccessibilityLabel(renderer.root, 'Close menu').props.onPress();
    });
    expect(queryByText(renderer.root, 'Delete project')).toBeNull();
  });

  it('pressing Escape closes the menu on web', () => {
    const originalOS = Platform.OS;
    Platform.OS = 'web';
    try {
      const renderer = renderWithAct(
        <SidebarContextMenuProvider>
          <Trigger kind="project" menuId="p1" actions={actionsFor('Delete project', jest.fn())} />
        </SidebarContextMenuProvider>
      );

      act(() => {
        findPressableByText(renderer.root, 'trigger-project-p1').props.onPress();
      });
      expect(findByText(renderer.root, 'Delete project')).toBeTruthy();

      act(() => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      });
      expect(queryByText(renderer.root, 'Delete project')).toBeNull();
    } finally {
      Platform.OS = originalOS;
    }
  });

  it("Android back (Modal's onRequestClose) closes a project menu", () => {
    const renderer = renderWithAct(
      <SidebarContextMenuProvider>
        <Trigger kind="project" menuId="p1" actions={actionsFor('Delete project', jest.fn())} />
      </SidebarContextMenuProvider>
    );

    act(() => {
      findPressableByText(renderer.root, 'trigger-project-p1').props.onPress();
    });
    expect(findByText(renderer.root, 'Delete project')).toBeTruthy();

    act(() => {
      renderer.root.findByType(Modal).props.onRequestClose();
    });
    expect(queryByText(renderer.root, 'Delete project')).toBeNull();
  });

  it('closes the menu when the window/viewport is resized', () => {
    const { Dimensions } = jest.requireActual('react-native');
    const renderer = renderWithAct(
      <SidebarContextMenuProvider>
        <Trigger kind="project" menuId="p1" actions={actionsFor('Delete project', jest.fn())} />
      </SidebarContextMenuProvider>
    );

    act(() => {
      findPressableByText(renderer.root, 'trigger-project-p1').props.onPress();
    });
    expect(findByText(renderer.root, 'Delete project')).toBeTruthy();

    act(() => {
      Dimensions.set({ window: { width: 500, height: 800, scale: 1, fontScale: 1 } });
    });
    expect(queryByText(renderer.root, 'Delete project')).toBeNull();
  });

  it('renders a project menu outside a clipped/scrollable ancestor, not behind it', () => {
    // Mirrors the real bug: a container that would clip an absolutely
    // positioned child (overflow: hidden) wraps the trigger, exactly like
    // a FlatList/ScrollView wraps a project row in the real sidebar.
    const renderer = renderWithAct(
      <SidebarContextMenuProvider>
        <View testID="clipped-list" style={{ overflow: 'hidden', height: 40 }}>
          <Trigger kind="project" menuId="p1" actions={actionsFor('Delete project', jest.fn())} />
        </View>
      </SidebarContextMenuProvider>
    );

    act(() => {
      findPressableByText(renderer.root, 'trigger-project-p1').props.onPress();
    });

    const clippedContainer = renderer.root.find((node) => node.props.testID === 'clipped-list');
    expect(queryByText(clippedContainer, 'Delete project')).toBeNull();
    // ...yet it's still findable from the true root — i.e. it rendered
    // as a sibling of the clipped container, not simply nowhere.
    expect(findByText(renderer.root, 'Delete project')).toBeTruthy();
  });

  it('renders an opaque, bordered, rounded popup (no see-through rows bleeding in)', () => {
    const renderer = renderWithAct(
      <SidebarContextMenuProvider>
        <Trigger kind="project" menuId="p1" actions={actionsFor('Delete project', jest.fn())} />
      </SidebarContextMenuProvider>
    );

    act(() => {
      findPressableByText(renderer.root, 'trigger-project-p1').props.onPress();
    });

    const popup = findMenuContainer(renderer.root);
    const flatStyle = ([] as object[]).concat(popup.props.style).reduce((a, b) => ({ ...a, ...b }));
    expect(flatStyle).toMatchObject({
      backgroundColor: '#1E293B',
      borderWidth: 1,
      borderRadius: 8,
    });
  });
});
