import type {
  ConversationSummary,
  ProjectSummary,
  UseConversationsResult,
  UseProjectsResult,
} from 'education-assistant-client';
import { useState } from 'react';
import { FlatList, Modal, Platform, StyleSheet } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { ConversationSidebar } from '../ConversationSidebar';

const mockUseAuth = jest.fn();
jest.mock('@/lib/AuthProvider', () => ({
  useAuth: () => mockUseAuth(),
}));

function setAuthMock(overrides: { status?: string; accessToken?: string | null } = {}): void {
  mockUseAuth.mockReturnValue({
    user: { id: 'u1', email: 'dev@example.com', display_name: 'Dev User', avatar_url: null },
    logout: jest.fn(),
    status: 'authenticated',
    accessToken: 'test-access-token',
    ...overrides,
  });
}

jest.mock('@/lib/ClientProvider', () => ({
  useClient: () => ({ baseUrl: 'http://127.0.0.1:8000' }),
}));

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn().mockResolvedValue(null),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

// react-test-renderer's host-component stub for measureInWindow never
// actually invokes its callback (there's no real layout engine under it),
// so every three-dot menu press below would silently do nothing without
// this — see lib/measureWindowRect.ts's own docs.
jest.mock('@/lib/measureWindowRect', () => ({
  measureWindowRect: (
    _ref: unknown,
    callback: (rect: { x: number; y: number; width: number; height: number }) => void
  ) => callback({ x: 100, y: 40, width: 24, height: 24 }),
}));

const mockFocusRef = jest.fn();
jest.mock('@/lib/focusElement', () => ({
  focusRef: (ref: unknown) => mockFocusRef(ref),
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

function queryAllByText(root: ReactTestInstance, text: string): ReactTestInstance[] {
  return root.findAll((node) => String(node.type) === 'Text' && node.children.includes(text));
}

function findPressableByText(root: ReactTestInstance, text: string): ReactTestInstance {
  return root.find(
    (node) =>
      typeof node.props.onPress === 'function' &&
      node.findAll((n) => String(n.type) === 'Text' && n.children.includes(text)).length > 0
  );
}

function findAllPressablesByText(root: ReactTestInstance, text: string): ReactTestInstance[] {
  return root.findAll(
    (node) =>
      typeof node.props.onPress === 'function' &&
      node.findAll((n) => String(n.type) === 'Text' && n.children.includes(text)).length > 0
  );
}

function makeSummary(overrides: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    id: 'c1',
    title: 'Guided reading question',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    message_count: 2,
    last_message_preview: 'Here is the answer',
    ...overrides,
  };
}

function makeConversationsResult(
  overrides: Partial<UseConversationsResult> = {}
): UseConversationsResult {
  return {
    listState: { status: 'success', conversations: [makeSummary()], total: 1 },
    refresh: jest.fn(),
    cancelList: jest.fn(),
    createConversation: jest.fn(),
    renameConversation: jest.fn().mockResolvedValue(makeSummary()),
    deleteStates: {},
    deleteConversation: jest.fn(),
    resetDeleteState: jest.fn(),
    ...overrides,
  };
}

function makeProject(overrides: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    id: 'p1',
    name: 'AI Literacy Research',
    description: null,
    conversation_count: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeProjectsResult(overrides: Partial<UseProjectsResult> = {}): UseProjectsResult {
  return {
    listState: { status: 'success', projects: [], total: 0 },
    refresh: jest.fn(),
    cancelList: jest.fn(),
    createProject: jest.fn().mockResolvedValue(makeProject()),
    updateProject: jest.fn().mockResolvedValue(makeProject()),
    deleteStates: {},
    deleteProject: jest.fn(),
    resetDeleteState: jest.fn(),
    projectConversationsStates: {},
    loadProjectConversations: jest.fn(),
    addRemoveStates: {},
    addConversationToProject: jest.fn().mockResolvedValue(undefined),
    removeConversationFromProject: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

async function renderSidebar(
  props: Partial<{
    conversations: UseConversationsResult;
    projects: UseProjectsResult;
    activeConversationId: string | null;
    onSelect: (id: string) => void;
    onNewChat: () => void;
  }> = {}
): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <ConversationSidebar
        conversations={props.conversations ?? makeConversationsResult()}
        projects={props.projects ?? makeProjectsResult()}
        activeConversationId={props.activeConversationId ?? null}
        onSelect={props.onSelect ?? jest.fn()}
        onNewChat={props.onNewChat ?? jest.fn()}
      />
    );
    await Promise.resolve();
  });
  return renderer;
}

describe('ConversationSidebar', () => {
  beforeEach(() => {
    setAuthMock();
  });

  it('renders the conversation title and preview', async () => {
    const renderer = await renderSidebar();

    expect(findByText(renderer.root, 'Guided reading question')).toBeTruthy();
    expect(findByText(renderer.root, 'Here is the answer')).toBeTruthy();
  });

  it('calls onNewChat when "+ New chat" is pressed', async () => {
    const onNewChat = jest.fn();
    const renderer = await renderSidebar({ onNewChat });

    act(() => {
      findPressableByText(renderer.root, '+ New chat').props.onPress();
    });

    expect(onNewChat).toHaveBeenCalledTimes(1);
  });

  it('calls onSelect with the conversation id when a row is pressed', async () => {
    const onSelect = jest.fn();
    const renderer = await renderSidebar({ onSelect });

    act(() => {
      findPressableByText(renderer.root, 'Guided reading question').props.onPress();
    });

    expect(onSelect).toHaveBeenCalledWith('c1');
  });

  it('shows an empty state when there are no conversations', async () => {
    const renderer = await renderSidebar({
      conversations: makeConversationsResult({
        listState: { status: 'success', conversations: [], total: 0 },
      }),
    });

    expect(findByText(renderer.root, 'No conversations yet — start one above.')).toBeTruthy();
  });

  it('renames a conversation via the inline text input', async () => {
    const renameConversation = jest.fn().mockResolvedValue(makeSummary({ title: 'New title' }));
    const renderer = await renderSidebar({
      conversations: makeConversationsResult({ renameConversation }),
    });

    act(() => {
      findPressableByText(renderer.root, '⋮').props.onPress();
    });
    await act(async () => {
      findPressableByText(renderer.root, 'Rename').props.onPress();
      // Rename mode opens one macrotask after the menu action (deferred so
      // react-native-web's menu-Modal focus-trap teardown can't race the
      // rename input's autoFocus) — flush it.
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    act(() => {
      const input = renderer.root.find(
        (node) =>
          String(node.type) === 'TextInput' && node.props.value === 'Guided reading question'
      );
      input.props.onChangeText('Renamed conversation');
    });
    await act(async () => {
      const input = renderer.root.find(
        (node) => String(node.type) === 'TextInput' && node.props.value === 'Renamed conversation'
      );
      input.props.onSubmitEditing();
      await Promise.resolve();
    });

    expect(renameConversation).toHaveBeenCalledWith('c1', 'Renamed conversation');
  });

  it('a successful rename immediately refreshes the sidebar title and keeps the conversation selected', async () => {
    // Stateful harness that mimics the real useConversations hook: a
    // successful rename patches the shared list state, which is exactly
    // what makes the sidebar show the new title with no manual refresh.
    const renameSpy = jest.fn();
    function RenameHarness() {
      const [conversations, setConversations] = useState<ConversationSummary[]>([
        makeSummary({ id: 'c1', title: 'Guided reading question' }),
        makeSummary({ id: 'c2', title: 'Second conversation' }),
      ]);
      renameSpy.mockImplementation(async (id: string, title: string) => {
        setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, title } : c)));
        return makeSummary({ id, title });
      });
      return (
        <ConversationSidebar
          conversations={makeConversationsResult({
            listState: { status: 'success', conversations, total: conversations.length },
            renameConversation: renameSpy,
          })}
          projects={makeProjectsResult()}
          activeConversationId="c1"
          onSelect={jest.fn()}
          onNewChat={jest.fn()}
        />
      );
    }

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<RenameHarness />);
      await Promise.resolve();
    });

    act(() => {
      renderer.root
        .find((node) => node.props.accessibilityLabel === 'Options for Guided reading question')
        .props.onPress();
    });
    await act(async () => {
      findPressableByText(renderer.root, 'Rename').props.onPress();
      // Rename mode opens one macrotask after the menu action (deferred so
      // react-native-web's menu-Modal focus-trap teardown can't race the
      // rename input's autoFocus) — flush it.
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    act(() => {
      renderer.root
        .find(
          (node) =>
            String(node.type) === 'TextInput' && node.props.value === 'Guided reading question'
        )
        .props.onChangeText('Renamed conversation');
    });
    await act(async () => {
      renderer.root
        .find(
          (node) => String(node.type) === 'TextInput' && node.props.value === 'Renamed conversation'
        )
        .props.onSubmitEditing();
      await Promise.resolve();
    });

    expect(renameSpy).toHaveBeenCalledWith('c1', 'Renamed conversation');
    // The new title is on screen immediately — no refresh button, no
    // remount — and the old one is gone.
    expect(findByText(renderer.root, 'Renamed conversation')).toBeTruthy();
    expect(queryByText(renderer.root, 'Guided reading question')).toBeNull();
    expect(findByText(renderer.root, 'Second conversation')).toBeTruthy();
    // …and the renamed conversation is still the active (selected) row —
    // selection is keyed by id, which the rename never changes (the active
    // row's title carries the bold rowTitleActive style).
    const titleStyle = StyleSheet.flatten(
      findByText(renderer.root, 'Renamed conversation').props.style
    );
    expect(titleStyle).toMatchObject({ fontWeight: '600' });
  });

  it('deletes a conversation after confirmation (web)', async () => {
    const originalOS = Platform.OS;
    const originalConfirm = (global as { confirm?: unknown }).confirm;
    Platform.OS = 'web';
    const confirmMock = jest.fn(() => true);
    // @ts-expect-error test stub
    global.window = { confirm: confirmMock };
    global.confirm = confirmMock as unknown as typeof confirm;

    try {
      const deleteConversation = jest.fn();
      const renderer = await renderSidebar({
        conversations: makeConversationsResult({ deleteConversation }),
      });

      act(() => {
        findPressableByText(renderer.root, '⋮').props.onPress();
      });
      act(() => {
        findPressableByText(renderer.root, 'Delete').props.onPress();
      });

      expect(deleteConversation).toHaveBeenCalledWith('c1');
    } finally {
      Platform.OS = originalOS;
      // @ts-expect-error test cleanup
      delete global.window;
      global.confirm = originalConfirm as typeof confirm;
    }
  });

  it('renders the open menu outside the FlatList, so it can never be clipped behind other rows', async () => {
    const renderer = await renderSidebar({
      conversations: makeConversationsResult({
        listState: {
          status: 'success',
          conversations: [
            makeSummary({ id: 'c1', title: 'First conversation' }),
            makeSummary({ id: 'c2', title: 'Second conversation' }),
          ],
          total: 2,
        },
      }),
    });

    act(() => {
      findAllPressablesByText(renderer.root, '⋮')[0]!.props.onPress();
    });

    const flatList = renderer.root.findByType(FlatList);
    // The popup must never be a descendant of the FlatList that renders
    // every conversation row — that's exactly what let it be painted
    // behind a later row before this fix.
    expect(queryByText(flatList, 'Rename')).toBeNull();
    expect(findByText(renderer.root, 'Rename')).toBeTruthy();
  });

  it('scrolling the sidebar closes an open conversation menu', async () => {
    const renderer = await renderSidebar();

    act(() => {
      findPressableByText(renderer.root, '⋮').props.onPress();
    });
    expect(findByText(renderer.root, 'Rename')).toBeTruthy();

    const flatList = renderer.root.findByType(FlatList);
    act(() => {
      flatList.props.onScroll({ nativeEvent: { contentOffset: { y: 80 } } });
    });

    // Closed, rather than left pointing at coordinates that no longer
    // match where the trigger scrolled to.
    expect(queryByText(renderer.root, 'Rename')).toBeNull();
  });

  it('shows a spinner instead of the menu button while a conversation is deleting', async () => {
    const renderer = await renderSidebar({
      conversations: makeConversationsResult({
        deleteStates: { c1: { status: 'deleting' } },
      }),
    });

    expect(queryByText(renderer.root, '⋮')).toBeNull();
  });

  it('does not call refresh() while auth restoration has not completed', async () => {
    setAuthMock({ status: 'loading', accessToken: null });
    const refresh = jest.fn();
    await renderSidebar({ conversations: makeConversationsResult({ refresh }) });

    expect(refresh).not.toHaveBeenCalled();
  });

  it('does not call refresh() when status is authenticated but the access token has not landed yet', async () => {
    setAuthMock({ status: 'authenticated', accessToken: null });
    const refresh = jest.fn();
    await renderSidebar({ conversations: makeConversationsResult({ refresh }) });

    expect(refresh).not.toHaveBeenCalled();
  });

  it('calls refresh() once auth becomes ready, without needing a remount', async () => {
    setAuthMock({ status: 'loading', accessToken: null });
    const refresh = jest.fn();
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <ConversationSidebar
          conversations={makeConversationsResult({ refresh })}
          projects={makeProjectsResult()}
          activeConversationId={null}
          onSelect={jest.fn()}
          onNewChat={jest.fn()}
        />
      );
      await Promise.resolve();
    });
    expect(refresh).not.toHaveBeenCalled();

    setAuthMock({ status: 'authenticated', accessToken: 'now-available' });
    await act(async () => {
      renderer.update(
        <ConversationSidebar
          conversations={makeConversationsResult({ refresh })}
          projects={makeProjectsResult()}
          activeConversationId={null}
          onSelect={jest.fn()}
          onNewChat={jest.fn()}
        />
      );
      await Promise.resolve();
    });

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('shows the real HTTP status and backend detail for a conversation-list error, never a generic network-failure label', async () => {
    const renderer = await renderSidebar({
      conversations: makeConversationsResult({
        listState: {
          status: 'error',
          error: Object.assign(new Error('Invalid or expired access token'), {
            statusCode: 401,
            requestId: null,
            name: 'AuthenticationError',
          }),
        },
      }),
    });

    expect(
      findByText(
        renderer.root,
        'GET http://127.0.0.1:8000/conversations\nHTTP 401\nInvalid or expired access token'
      )
    ).toBeTruthy();
    expect(queryByText(renderer.root, 'Network request to /conversations failed')).toBeNull();
  });

  it('labels a genuine fetch-level failure as a network error, not an HTTP status', async () => {
    const renderer = await renderSidebar({
      conversations: makeConversationsResult({
        listState: {
          status: 'error',
          error: Object.assign(new Error('Network request to /conversations failed'), {
            statusCode: null,
            requestId: null,
            name: 'NetworkError',
          }),
        },
      }),
    });

    expect(
      findByText(
        renderer.root,
        'GET http://127.0.0.1:8000/conversations\nNetwork error: Network request to /conversations failed'
      )
    ).toBeTruthy();
    expect(queryByText(renderer.root, 'HTTP 401')).toBeNull();
  });
});

describe('ConversationSidebar Projects section', () => {
  beforeEach(() => {
    setAuthMock();
  });

  it("renders a Projects heading and lists the user's projects", async () => {
    const renderer = await renderSidebar({
      projects: makeProjectsResult({
        listState: {
          status: 'success',
          projects: [makeProject({ name: 'AI Literacy Research' })],
          total: 1,
        },
      }),
    });

    expect(findByText(renderer.root, 'Projects')).toBeTruthy();
    expect(findByText(renderer.root, 'AI Literacy Research')).toBeTruthy();
  });

  it('"+ New project" opens an inline form, and submitting creates the project', async () => {
    const createProject = jest
      .fn()
      .mockResolvedValue(makeProject({ id: 'new-id', name: 'New One' }));
    const renderer = await renderSidebar({
      projects: makeProjectsResult({ createProject }),
    });

    act(() => {
      findPressableByText(renderer.root, '+ New project').props.onPress();
    });

    const input = renderer.root.find(
      (node) => String(node.type) === 'TextInput' && node.props.placeholder === 'Project name'
    );
    act(() => {
      input.props.onChangeText('New One');
    });
    await act(async () => {
      const updatedInput = renderer.root.find(
        (node) => String(node.type) === 'TextInput' && node.props.value === 'New One'
      );
      updatedInput.props.onSubmitEditing();
      await Promise.resolve();
    });

    expect(createProject).toHaveBeenCalledWith({ name: 'New One' });
  });

  it('expanding a project with no conversations loaded yet triggers a load', async () => {
    const loadProjectConversations = jest.fn();
    const renderer = await renderSidebar({
      projects: makeProjectsResult({
        listState: { status: 'success', projects: [makeProject({ id: 'p1' })], total: 1 },
        loadProjectConversations,
      }),
    });

    act(() => {
      findPressableByText(renderer.root, 'AI Literacy Research').props.onPress();
    });

    expect(loadProjectConversations).toHaveBeenCalledWith('p1');
  });

  it('expanding a project shows its already-loaded conversations', async () => {
    const renderer = await renderSidebar({
      projects: makeProjectsResult({
        listState: { status: 'success', projects: [makeProject({ id: 'p1' })], total: 1 },
        projectConversationsStates: {
          p1: {
            status: 'success',
            conversations: [
              {
                conversation_id: 'proj-c1',
                title: 'Teacher motivation',
                added_at: new Date().toISOString(),
                sort_order: null,
                updated_at: new Date().toISOString(),
              },
            ],
            total: 1,
          },
        },
      }),
    });

    expect(queryByText(renderer.root, 'Teacher motivation')).toBeNull();

    act(() => {
      findPressableByText(renderer.root, 'AI Literacy Research').props.onPress();
    });

    expect(findByText(renderer.root, 'Teacher motivation')).toBeTruthy();
  });

  it('collapsing a project hides its conversations again', async () => {
    const renderer = await renderSidebar({
      projects: makeProjectsResult({
        listState: { status: 'success', projects: [makeProject({ id: 'p1' })], total: 1 },
        projectConversationsStates: {
          p1: {
            status: 'success',
            conversations: [
              {
                conversation_id: 'proj-c1',
                title: 'Teacher motivation',
                added_at: new Date().toISOString(),
                sort_order: null,
                updated_at: new Date().toISOString(),
              },
            ],
            total: 1,
          },
        },
      }),
    });

    act(() => {
      findPressableByText(renderer.root, 'AI Literacy Research').props.onPress();
    });
    expect(findByText(renderer.root, 'Teacher motivation')).toBeTruthy();

    act(() => {
      findPressableByText(renderer.root, 'AI Literacy Research').props.onPress();
    });
    expect(queryByText(renderer.root, 'Teacher motivation')).toBeNull();
  });

  it('opening a conversation from an expanded project calls onSelect', async () => {
    const onSelect = jest.fn();
    const renderer = await renderSidebar({
      onSelect,
      projects: makeProjectsResult({
        listState: { status: 'success', projects: [makeProject({ id: 'p1' })], total: 1 },
        projectConversationsStates: {
          p1: {
            status: 'success',
            conversations: [
              {
                conversation_id: 'proj-c1',
                title: 'Teacher motivation',
                added_at: new Date().toISOString(),
                sort_order: null,
                updated_at: new Date().toISOString(),
              },
            ],
            total: 1,
          },
        },
      }),
    });

    act(() => {
      findPressableByText(renderer.root, 'AI Literacy Research').props.onPress();
    });
    act(() => {
      findPressableByText(renderer.root, 'Teacher motivation').props.onPress();
    });

    expect(onSelect).toHaveBeenCalledWith('proj-c1');
  });

  it('a conversation shown under an expanded project can still be highlighted as active', async () => {
    const renderer = await renderSidebar({
      activeConversationId: 'proj-c1',
      projects: makeProjectsResult({
        listState: { status: 'success', projects: [makeProject({ id: 'p1' })], total: 1 },
        projectConversationsStates: {
          p1: {
            status: 'success',
            conversations: [
              {
                conversation_id: 'proj-c1',
                title: 'Teacher motivation',
                added_at: new Date().toISOString(),
                sort_order: null,
                updated_at: new Date().toISOString(),
              },
            ],
            total: 1,
          },
        },
      }),
    });

    act(() => {
      findPressableByText(renderer.root, 'AI Literacy Research').props.onPress();
    });

    // No duplicate-active-styling error: exactly one row for this id renders.
    expect(queryAllByText(renderer.root, 'Teacher motivation')).toHaveLength(1);
  });

  it('removing a conversation from a project keeps it in normal history', async () => {
    const removeConversationFromProject = jest.fn().mockResolvedValue(undefined);
    const renderer = await renderSidebar({
      conversations: makeConversationsResult({
        listState: {
          status: 'success',
          conversations: [makeSummary({ id: 'c1', title: 'Guided reading question' })],
          total: 1,
        },
      }),
      projects: makeProjectsResult({
        listState: { status: 'success', projects: [makeProject({ id: 'p1' })], total: 1 },
        removeConversationFromProject,
        projectConversationsStates: {
          p1: {
            status: 'success',
            conversations: [
              {
                conversation_id: 'c1',
                title: 'Guided reading question',
                added_at: new Date().toISOString(),
                sort_order: null,
                updated_at: new Date().toISOString(),
              },
            ],
            total: 1,
          },
        },
      }),
    });

    act(() => {
      findPressableByText(renderer.root, 'AI Literacy Research').props.onPress();
    });

    // Three "⋮" buttons now exist: the project's own menu, the nested
    // project-conversation row's menu, and the normal-history row's menu
    // (same conversation, different context) — open the nested one (the
    // only one offering "Remove from project") and remove it there.
    const menuButtons = findAllPressablesByText(renderer.root, '⋮');
    expect(menuButtons).toHaveLength(3);
    act(() => {
      menuButtons[1]!.props.onPress();
    });
    act(() => {
      findPressableByText(renderer.root, 'Remove from project').props.onPress();
    });

    expect(removeConversationFromProject).toHaveBeenCalledWith('p1', 'c1');
    // Still present in normal history afterward — this fake harness
    // doesn't itself remove the nested row on call (that's useProjects'
    // own job, covered by its unit tests), so this just confirms the
    // history row was never touched by the removal at all.
    expect(queryAllByText(renderer.root, 'Guided reading question').length).toBeGreaterThanOrEqual(
      1
    );
  });

  it('renaming a project via its menu calls updateProject', async () => {
    const updateProject = jest
      .fn()
      .mockResolvedValue(makeProject({ name: 'Teacher Agency Study' }));
    const renderer = await renderSidebar({
      projects: makeProjectsResult({
        listState: { status: 'success', projects: [makeProject({ id: 'p1' })], total: 1 },
        updateProject,
      }),
    });

    const menuButtons = findAllPressablesByText(renderer.root, '⋮');
    act(() => {
      menuButtons[0]!.props.onPress();
    });
    await act(async () => {
      findPressableByText(renderer.root, 'Rename').props.onPress();
      // Rename mode opens one macrotask after the menu action (deferred so
      // react-native-web's menu-Modal focus-trap teardown can't race the
      // rename input's autoFocus) — flush it.
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const input = renderer.root.find(
      (node) => String(node.type) === 'TextInput' && node.props.value === 'AI Literacy Research'
    );
    act(() => {
      input.props.onChangeText('Teacher Agency Study');
    });
    await act(async () => {
      const updatedInput = renderer.root.find(
        (node) => String(node.type) === 'TextInput' && node.props.value === 'Teacher Agency Study'
      );
      updatedInput.props.onSubmitEditing();
      await Promise.resolve();
    });

    expect(updateProject).toHaveBeenCalledWith('p1', { name: 'Teacher Agency Study' });
  });

  it('deleting a project after confirmation calls deleteProject but never touches conversations (web)', async () => {
    const originalOS = Platform.OS;
    const originalConfirm = (global as { confirm?: unknown }).confirm;
    Platform.OS = 'web';
    const confirmMock = jest.fn(() => true);
    // @ts-expect-error test stub
    global.window = { confirm: confirmMock };
    global.confirm = confirmMock as unknown as typeof confirm;

    try {
      const deleteProject = jest.fn();
      const renderer = await renderSidebar({
        projects: makeProjectsResult({
          listState: { status: 'success', projects: [makeProject({ id: 'p1' })], total: 1 },
          deleteProject,
        }),
      });

      const menuButtons = findAllPressablesByText(renderer.root, '⋮');
      act(() => {
        menuButtons[0]!.props.onPress();
      });
      act(() => {
        findPressableByText(renderer.root, 'Delete project').props.onPress();
      });

      expect(deleteProject).toHaveBeenCalledWith('p1');
      expect(confirmMock).toHaveBeenCalledWith(
        expect.stringContaining('chats will remain in your history')
      );
    } finally {
      Platform.OS = originalOS;
      // @ts-expect-error test cleanup
      delete global.window;
      global.confirm = originalConfirm as typeof confirm;
    }
  });

  it('renders the open project menu outside the FlatList, so it can never be clipped behind other rows', async () => {
    const renderer = await renderSidebar({
      conversations: makeConversationsResult({
        listState: {
          status: 'success',
          conversations: [makeSummary({ id: 'c1', title: 'Guided reading question' })],
          total: 1,
        },
      }),
      projects: makeProjectsResult({
        listState: { status: 'success', projects: [makeProject({ id: 'p1' })], total: 1 },
      }),
    });

    act(() => {
      findAllPressablesByText(renderer.root, '⋮')[0]!.props.onPress();
    });
    expect(findByText(renderer.root, 'Delete project')).toBeTruthy();

    const flatList = renderer.root.findByType(FlatList);
    // The popup must never be a descendant of the FlatList that renders
    // every project/conversation row — that's exactly what let it be
    // painted behind (or partially through) other rows before this fix.
    expect(queryByText(flatList, 'Delete project')).toBeNull();
  });

  it('scrolling the sidebar closes an open project menu', async () => {
    const renderer = await renderSidebar({
      projects: makeProjectsResult({
        listState: { status: 'success', projects: [makeProject({ id: 'p1' })], total: 1 },
      }),
    });

    act(() => {
      findAllPressablesByText(renderer.root, '⋮')[0]!.props.onPress();
    });
    expect(findByText(renderer.root, 'Delete project')).toBeTruthy();

    const flatList = renderer.root.findByType(FlatList);
    act(() => {
      flatList.props.onScroll({ nativeEvent: { contentOffset: { y: 80 } } });
    });

    expect(queryByText(renderer.root, 'Delete project')).toBeNull();
  });

  it("Android back closes an open project menu (Modal's onRequestClose)", async () => {
    const renderer = await renderSidebar({
      projects: makeProjectsResult({
        listState: { status: 'success', projects: [makeProject({ id: 'p1' })], total: 1 },
      }),
    });

    act(() => {
      findAllPressablesByText(renderer.root, '⋮')[0]!.props.onPress();
    });
    expect(findByText(renderer.root, 'Delete project')).toBeTruthy();

    act(() => {
      renderer.root.findByType(Modal).props.onRequestClose();
    });
    expect(queryByText(renderer.root, 'Delete project')).toBeNull();
  });

  it("opening a project's menu closes an already-open conversation menu", async () => {
    const renderer = await renderSidebar({
      conversations: makeConversationsResult({
        listState: {
          status: 'success',
          conversations: [makeSummary({ id: 'c1', title: 'Guided reading question' })],
          total: 1,
        },
      }),
      projects: makeProjectsResult({
        listState: { status: 'success', projects: [makeProject({ id: 'p1' })], total: 1 },
      }),
    });

    const menuButtons = findAllPressablesByText(renderer.root, '⋮');
    expect(menuButtons).toHaveLength(2); // the project's own menu, then the history row's

    act(() => {
      menuButtons[1]!.props.onPress(); // the conversation row's menu
    });
    expect(findByText(renderer.root, 'Add to project')).toBeTruthy();

    act(() => {
      menuButtons[0]!.props.onPress(); // the project's own menu
    });
    expect(queryByText(renderer.root, 'Add to project')).toBeNull();
    expect(findByText(renderer.root, 'Delete project')).toBeTruthy();
  });

  it("opens the Add to project picker from a history conversation's menu", async () => {
    const renderer = await renderSidebar({
      projects: makeProjectsResult({
        listState: {
          status: 'success',
          projects: [makeProject({ name: 'AI Literacy Research' })],
          total: 1,
        },
      }),
    });

    // Two "⋮" buttons exist: the project's own menu, and the (single,
    // default) history conversation row's menu — the second is the one
    // under test here.
    const menuButtons = findAllPressablesByText(renderer.root, '⋮');
    expect(menuButtons).toHaveLength(2);
    act(() => {
      menuButtons[1]!.props.onPress();
    });
    act(() => {
      findPressableByText(renderer.root, 'Add to project').props.onPress();
    });

    // The picker itself lists the project (in addition to the sidebar's
    // own project row already showing that same name).
    expect(queryAllByText(renderer.root, 'AI Literacy Research').length).toBeGreaterThanOrEqual(2);
    expect(queryByText(renderer.root, 'Done')).toBeTruthy();
  });

  it("restores focus to the conversation row's own three-dot button once the Add to project picker closes", async () => {
    jest.useFakeTimers();
    try {
      const renderer = await renderSidebar({
        projects: makeProjectsResult({
          listState: {
            status: 'success',
            projects: [makeProject({ name: 'AI Literacy Research' })],
            total: 1,
          },
        }),
      });

      const menuButtons = findAllPressablesByText(renderer.root, '⋮');
      act(() => {
        menuButtons[1]!.props.onPress();
      });
      act(() => {
        findPressableByText(renderer.root, 'Add to project').props.onPress();
      });
      expect(queryByText(renderer.root, 'Done')).toBeTruthy();
      expect(mockFocusRef).not.toHaveBeenCalled();

      act(() => {
        findPressableByText(renderer.root, 'Done').props.onPress();
      });
      // The picker is gone immediately...
      expect(queryByText(renderer.root, 'Done')).toBeNull();
      // ...but the actual refocus is deliberately deferred to a macrotask
      // (see ConversationSidebar.tsx's handleCloseAddToProject) so it runs
      // after react-native-web's own Modal focus-trap teardown, not before.
      expect(mockFocusRef).not.toHaveBeenCalled();

      act(() => {
        jest.runAllTimers();
      });
      expect(mockFocusRef).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('assigning a conversation to a project via the picker calls addConversationToProject', async () => {
    const addConversationToProject = jest.fn().mockResolvedValue(undefined);
    const renderer = await renderSidebar({
      projects: makeProjectsResult({
        listState: {
          status: 'success',
          projects: [makeProject({ id: 'p1', name: 'AI Literacy Research' })],
          total: 1,
        },
        addConversationToProject,
        projectConversationsStates: {
          p1: { status: 'success', conversations: [], total: 0 },
        },
      }),
    });

    const menuButtons = findAllPressablesByText(renderer.root, '⋮');
    act(() => {
      menuButtons[1]!.props.onPress();
    });
    act(() => {
      findPressableByText(renderer.root, 'Add to project').props.onPress();
    });
    await act(async () => {
      // Targets the picker's own checkbox row specifically (by its
      // accessibilityLabel) rather than by text, since the sidebar's own
      // project row shows the identical "AI Literacy Research" text too.
      const checkboxRow = renderer.root.find(
        (node) => node.props.accessibilityLabel === 'Add to AI Literacy Research'
      );
      checkboxRow.props.onPress();
      await Promise.resolve();
    });

    expect(addConversationToProject).toHaveBeenCalledWith('p1', 'c1');
  });

  it('does not call projects.refresh() while auth restoration has not completed', async () => {
    setAuthMock({ status: 'loading', accessToken: null });
    const refresh = jest.fn();
    await renderSidebar({ projects: makeProjectsResult({ refresh }) });

    expect(refresh).not.toHaveBeenCalled();
  });

  it('calls projects.refresh() once auth becomes ready, without needing a remount', async () => {
    setAuthMock({ status: 'loading', accessToken: null });
    const refresh = jest.fn();
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <ConversationSidebar
          conversations={makeConversationsResult()}
          projects={makeProjectsResult({ refresh })}
          activeConversationId={null}
          onSelect={jest.fn()}
          onNewChat={jest.fn()}
        />
      );
      await Promise.resolve();
    });
    expect(refresh).not.toHaveBeenCalled();

    setAuthMock({ status: 'authenticated', accessToken: 'now-available' });
    await act(async () => {
      renderer.update(
        <ConversationSidebar
          conversations={makeConversationsResult()}
          projects={makeProjectsResult({ refresh })}
          activeConversationId={null}
          onSelect={jest.fn()}
          onNewChat={jest.fn()}
        />
      );
      await Promise.resolve();
    });

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('shows the real HTTP status and backend detail for a projects-list error, never a generic network-failure label', async () => {
    const renderer = await renderSidebar({
      projects: makeProjectsResult({
        listState: {
          status: 'error',
          error: Object.assign(new Error('Invalid or expired access token'), {
            statusCode: 401,
            requestId: null,
            name: 'AuthenticationError',
          }),
        },
      }),
    });

    expect(
      findByText(
        renderer.root,
        'GET http://127.0.0.1:8000/projects\nHTTP 401\nInvalid or expired access token'
      )
    ).toBeTruthy();
    expect(queryByText(renderer.root, 'Network request to /projects failed')).toBeNull();
  });
});
