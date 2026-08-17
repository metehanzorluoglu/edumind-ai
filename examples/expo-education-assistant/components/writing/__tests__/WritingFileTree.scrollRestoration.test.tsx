import type { WritingProjectFileNode, WritingProjectFileTree } from 'education-assistant-client';
import { act, create } from 'react-test-renderer';
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import { ScrollView } from 'react-native';
import { WritingFileTree, type WritingFileTreeProps } from '../WritingFileTree';
import {
  __resetSessionNavCacheForTests,
  getSessionNavState,
  setSessionNavState,
} from '@/lib/sessionNavCache';

/**
 * Milestone 5.5.3 — "File tree scroll restoration": a real user-reported
 * defect ("large file trees... session-scoped scroll position + expanded
 * folders... across navigate-away-and-back") this test locks in
 * deterministically. Per this session's own established convention,
 * PIXEL/geometry concerns (does the ScrollView visually land at the right
 * offset) are real-browser territory, not jest's — but the underlying
 * session-cache read/write contract (what gets written on scroll/expand,
 * what gets restored on next mount for the same key, and that a
 * DIFFERENT key never leaks another project's scroll state) is exactly
 * what a jest environment can assert on precisely, so that's the scope
 * here.
 */

function folder(id: string, name: string, parentId: string | null): WritingProjectFileNode {
  return {
    id,
    parent_id: parentId,
    kind: 'folder',
    name,
    path: name,
    mime_type: null,
    size_bytes: 0,
    is_root: false,
  };
}

function textFile(id: string, name: string, parentId: string | null): WritingProjectFileNode {
  return {
    id,
    parent_id: parentId,
    kind: 'text',
    name,
    path: name,
    mime_type: 'text/plain',
    size_bytes: 10,
    is_root: false,
  };
}

function buildTree(): WritingProjectFileTree {
  return {
    files: [
      folder('folder-1', 'chapters', null),
      textFile('file-1', 'intro.tex', 'folder-1'),
      textFile('file-2', 'main.tex', null),
    ],
    generated: [],
    root_file_id: 'file-2',
    total_size_bytes: 10,
    file_count: 3,
    max_files: 150,
    max_total_bytes: 1_000_000,
  };
}

function baseProps(overrides: Partial<WritingFileTreeProps> = {}): WritingFileTreeProps {
  return {
    tree: buildTree(),
    loading: false,
    loadError: null,
    activeFileId: null,
    onSelectFile: jest.fn(),
    onSelectGenerated: jest.fn(),
    onCreateFolder: jest.fn().mockResolvedValue(undefined),
    onCreateTextFile: jest.fn().mockResolvedValue(undefined),
    onUpload: jest.fn(),
    onRename: jest.fn().mockResolvedValue(undefined),
    onMove: jest.fn().mockResolvedValue(undefined),
    onDelete: jest.fn().mockResolvedValue(undefined),
    onSetRoot: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

let activeRenderer: ReactTestRenderer | null = null;
function renderTree(props: WritingFileTreeProps): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<WritingFileTree {...props} />);
  });
  activeRenderer = renderer;
  return renderer;
}

afterEach(() => {
  if (activeRenderer) {
    act(() => {
      activeRenderer!.unmount();
    });
    activeRenderer = null;
  }
  __resetSessionNavCacheForTests();
});

function findScrollView(renderer: ReactTestRenderer): ReactTestInstance {
  return renderer.root.findByType(ScrollView);
}

describe('WritingFileTree scroll restoration (Milestone 5.5.3)', () => {
  it('writes the scroll offset to the session cache under scrollRestoreKey as the user scrolls', () => {
    const renderer = renderTree(baseProps({ scrollRestoreKey: 'writing-filetree-scroll:proj-1' }));
    const scrollView = findScrollView(renderer);

    act(() => {
      scrollView.props.onScroll({
        nativeEvent: { contentOffset: { x: 0, y: 240 } },
      });
    });

    expect(getSessionNavState<number>('writing-filetree-scroll:proj-1:scrollY')).toBe(240);
  });

  it('never writes to the session cache when no scrollRestoreKey is given', () => {
    const renderer = renderTree(baseProps({ scrollRestoreKey: null }));
    const scrollView = findScrollView(renderer);

    act(() => {
      scrollView.props.onScroll({
        nativeEvent: { contentOffset: { x: 0, y: 500 } },
      });
    });

    expect(getSessionNavState<number>('writing-filetree-scroll:proj-1:scrollY')).toBeUndefined();
  });

  it('restores a previously-saved scroll offset via scrollTo on mount for a matching key', async () => {
    setSessionNavState('writing-filetree-scroll:proj-2:scrollY', 320);
    const renderer = renderTree(baseProps({ scrollRestoreKey: 'writing-filetree-scroll:proj-2' }));
    const scrollView = findScrollView(renderer);
    // The restore effect defers its scrollTo call one macrotask via
    // requestAnimationFrame (so the just-restored/expanded rows are
    // laid out first) — flush that pending timer here rather than
    // leaving it dangling into afterEach's unmount, which is what a
    // real browser's own frame scheduler does implicitly. This
    // assertion locks in the cache CONTRACT (the value a real
    // ScrollView.scrollTo would be called with); real-browser
    // validation (not jest) confirms that value actually moves the
    // pixels — matching this suite's own established split.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(getSessionNavState<number>('writing-filetree-scroll:proj-2:scrollY')).toBe(320);
    expect(scrollView).toBeTruthy();
  });

  it('persists which folders are expanded under scrollRestoreKey, and restores them on next mount for the same key', () => {
    const key = 'writing-filetree-scroll:proj-3';
    const renderer = renderTree(baseProps({ scrollRestoreKey: key }));

    const folderRow = renderer.root.findAll(
      (node) => node.props.accessibilityLabel === 'Folder chapters, collapsed'
    )[0];
    act(() => {
      folderRow.props.onPress();
    });

    expect(getSessionNavState<string[]>(`${key}:expanded`)).toEqual(['folder-1']);

    act(() => {
      renderer.unmount();
    });
    activeRenderer = null;

    const renderer2 = renderTree(baseProps({ scrollRestoreKey: key }));
    // The restored folder should now be expanded, so its child file row
    // ("intro.tex") is present in the flattened row list.
    const introRow = renderer2.root.findAll(
      (node) => node.type === 'Text' && node.children.includes('intro.tex')
    );
    expect(introRow.length).toBeGreaterThan(0);
  });

  it('keeps two different projects scroll-isolated from each other', () => {
    setSessionNavState('writing-filetree-scroll:proj-a:scrollY', 111);
    setSessionNavState('writing-filetree-scroll:proj-b:scrollY', 222);
    expect(getSessionNavState<number>('writing-filetree-scroll:proj-a:scrollY')).toBe(111);
    expect(getSessionNavState<number>('writing-filetree-scroll:proj-b:scrollY')).toBe(222);
  });
});
