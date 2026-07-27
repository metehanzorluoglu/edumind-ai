/**
 * @jest-environment jsdom
 *
 * jsdom (rather than jest-expo's default node environment) is needed for
 * the background-scroll-lock test below, which reads/writes
 * `document.body.style.overflow` directly.
 */
import type { ProjectSummary, UseProjectsResult } from 'education-assistant-client';
import { Dimensions, Modal, Platform } from 'react-native';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { AddToProjectPicker } from '../AddToProjectPicker';

jest.mock('@/lib/ClientProvider', () => ({
  useClient: () => ({ baseUrl: 'http://127.0.0.1:8000' }),
}));

function makeProject(overrides: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    id: 'p1',
    name: 'AI Literacy Research',
    description: null,
    conversation_count: 0,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeProjectsResult(overrides: Partial<UseProjectsResult> = {}): UseProjectsResult {
  return {
    listState: { status: 'success', projects: [], total: 0 },
    refresh: jest.fn(),
    cancelList: jest.fn(),
    createProject: jest.fn(),
    updateProject: jest.fn(),
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

function findByLabel(root: ReactTestInstance, label: string): ReactTestInstance {
  return root.find(
    (node) => node.props.accessibilityLabel === label && typeof node.props.onPress === 'function'
  );
}

function queryByText(root: ReactTestInstance, text: string): ReactTestInstance | null {
  const matches = root.findAll(
    (node) => String(node.type) === 'Text' && node.children.includes(text)
  );
  return matches[0] ?? null;
}

function setWindowSize(width: number, height: number): void {
  jest.spyOn(Dimensions, 'get').mockReturnValue({ width, height, scale: 1, fontScale: 1 });
}

const DESKTOP_WIDTH = 1280;
const DESKTOP_HEIGHT = 800;
const NARROW_WIDTH = 375;
const NARROW_HEIGHT = 667;

describe('AddToProjectPicker', () => {
  const originalOS = Platform.OS;

  afterEach(() => {
    Platform.OS = originalOS;
    jest.restoreAllMocks();
  });

  it('renders through a top-level Modal, not a plain in-tree overlay', async () => {
    setWindowSize(DESKTOP_WIDTH, DESKTOP_HEIGHT);
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <AddToProjectPicker
          conversationId="c1"
          conversationTitle="Guided reading"
          projects={makeProjectsResult()}
          onClose={jest.fn()}
        />
      );
    });

    const modal = renderer.root.findByType(Modal);
    expect(modal.props.visible).toBe(true);
    expect(modal.props.transparent).toBe(true);
  });

  it('on a desktop-width window, centers the panel and clamps it to ~400-450px', async () => {
    setWindowSize(DESKTOP_WIDTH, DESKTOP_HEIGHT);
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <AddToProjectPicker
          conversationId="c1"
          conversationTitle="Guided reading"
          projects={makeProjectsResult()}
          onClose={jest.fn()}
        />
      );
    });

    // The overlay centers content (no bottom-sheet override) and the panel
    // itself is a flattened style array — read the merged width out of it.
    const overlay = renderer.root.findByProps({ accessibilityLabel: 'Close add to project dialog' })
      .parent!.props.style;
    const overlayStyles = Array.isArray(overlay) ? overlay : [overlay];
    expect(
      overlayStyles.some(
        (s: unknown) => s && (s as { alignItems?: string }).alignItems === 'stretch'
      )
    ).toBe(false);

    const panelNode = renderer.root.find(
      (node) =>
        Array.isArray(node.props.style) &&
        node.props.style.some(
          (s: unknown) =>
            s &&
            (s as { width?: number }).width !== undefined &&
            (s as { maxHeight?: number }).maxHeight !== undefined
        )
    );
    const flattenedWidth = panelNode.props.style.find(
      (s: unknown) => s && (s as { width?: number }).width !== undefined
    ).width;
    expect(flattenedWidth).toBeGreaterThanOrEqual(400);
    expect(flattenedWidth).toBeLessThanOrEqual(450);
  });

  it('on a narrow window, renders a full-width bottom sheet instead of a centered modal', async () => {
    setWindowSize(NARROW_WIDTH, NARROW_HEIGHT);
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <AddToProjectPicker
          conversationId="c1"
          conversationTitle="Guided reading"
          projects={makeProjectsResult()}
          onClose={jest.fn()}
        />
      );
    });

    const panelNode = renderer.root.find(
      (node) =>
        Array.isArray(node.props.style) &&
        node.props.style.some(
          (s: unknown) =>
            s &&
            (s as { width?: number }).width !== undefined &&
            (s as { maxHeight?: number }).maxHeight !== undefined
        )
    );
    const flattenedWidth = panelNode.props.style.find(
      (s: unknown) => s && (s as { width?: number }).width !== undefined
    ).width;
    expect(flattenedWidth).toBe(NARROW_WIDTH);
  });

  it('wraps and safely truncates a very long conversation title instead of overflowing', async () => {
    setWindowSize(DESKTOP_WIDTH, DESKTOP_HEIGHT);
    const longTitle =
      'This is an extremely long conversation title that keeps going and going far past what any dialog panel could ever comfortably display on one or even two lines without truncation';
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <AddToProjectPicker
          conversationId="c1"
          conversationTitle={longTitle}
          projects={makeProjectsResult()}
          onClose={jest.fn()}
        />
      );
    });

    const subtitle = renderer.root.find(
      (node) => String(node.type) === 'Text' && node.children.includes(`"${longTitle}"`)
    );
    expect(subtitle.props.numberOfLines).toBe(2);
    expect(subtitle.props.ellipsizeMode).toBe('tail');
    // The dialog's own static instructional heading is never itself
    // truncated, regardless of how long the conversation title is.
    expect(queryByText(renderer.root, 'Add to project')).toBeTruthy();
  });

  it('renders every project inside the scrollable list when there are many', async () => {
    setWindowSize(DESKTOP_WIDTH, DESKTOP_HEIGHT);
    const manyProjects = Array.from({ length: 25 }, (_, i) =>
      makeProject({ id: `p${i}`, name: `Project ${i}` })
    );
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <AddToProjectPicker
          conversationId="c1"
          conversationTitle="Guided reading"
          projects={makeProjectsResult({
            listState: { status: 'success', projects: manyProjects, total: manyProjects.length },
            projectConversationsStates: Object.fromEntries(
              manyProjects.map((p) => [p.id, { status: 'success', conversations: [], total: 0 }])
            ),
          })}
          onClose={jest.fn()}
        />
      );
    });

    for (const project of manyProjects) {
      expect(queryByText(renderer.root, project.name)).toBeTruthy();
    }
  });

  it('closes when the backdrop is pressed', async () => {
    setWindowSize(DESKTOP_WIDTH, DESKTOP_HEIGHT);
    const onClose = jest.fn();
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <AddToProjectPicker
          conversationId="c1"
          conversationTitle="Guided reading"
          projects={makeProjectsResult()}
          onClose={onClose}
        />
      );
    });

    act(() => {
      findByLabel(renderer.root, 'Close add to project dialog').props.onPress();
    });

    expect(onClose).toHaveBeenCalled();
  });

  it('closes via the Done button', async () => {
    setWindowSize(DESKTOP_WIDTH, DESKTOP_HEIGHT);
    const onClose = jest.fn();
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <AddToProjectPicker
          conversationId="c1"
          conversationTitle="Guided reading"
          projects={makeProjectsResult()}
          onClose={onClose}
        />
      );
    });

    act(() => {
      findByLabel(renderer.root, 'Done adding to projects').props.onPress();
    });

    expect(onClose).toHaveBeenCalled();
  });

  it("wires the Modal's onRequestClose to onClose (Android back / web Escape both funnel through it)", async () => {
    setWindowSize(DESKTOP_WIDTH, DESKTOP_HEIGHT);
    const onClose = jest.fn();
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <AddToProjectPicker
          conversationId="c1"
          conversationTitle="Guided reading"
          projects={makeProjectsResult()}
          onClose={onClose}
        />
      );
    });

    act(() => {
      renderer.root.findByType(Modal).props.onRequestClose();
    });

    expect(onClose).toHaveBeenCalled();
  });

  it('locks background scrolling on web while open, and restores it on close', async () => {
    Platform.OS = 'web';
    setWindowSize(DESKTOP_WIDTH, DESKTOP_HEIGHT);
    document.body.style.overflow = 'auto';
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <AddToProjectPicker
          conversationId="c1"
          conversationTitle="Guided reading"
          projects={makeProjectsResult()}
          onClose={jest.fn()}
        />
      );
    });

    expect(document.body.style.overflow).toBe('hidden');

    act(() => {
      renderer.unmount();
    });

    expect(document.body.style.overflow).toBe('auto');
  });
});
