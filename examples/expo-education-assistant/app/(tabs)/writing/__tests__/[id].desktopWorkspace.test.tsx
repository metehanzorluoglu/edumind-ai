/**
 * Milestone 5.5 Part 6/7/9/12 — the desktop-only unified "Research" panel
 * (Files/References/Notes/Ask EduM8 as one tab strip, not a separate
 * drawer), its Preferences-backed tab persistence, and the screen's
 * keyboard shortcuts (Cmd/Ctrl+S save, Cmd/Ctrl+Enter compile, Cmd/Ctrl+K
 * jump to Ask EduM8). Kept in its own file (same convention as
 * [id].compile.test.tsx/[id].askEduM8.test.tsx) since it needs a WIDE
 * window (Dimensions.set) and a real PreferencesProvider that none of
 * the other Writing test files need — every other file in this
 * directory runs under the narrow/no-provider default, which is why
 * they've never exercised this code path.
 */
import { Dimensions, Platform } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { LatexCodeEditor } from '@/components/writing/LatexCodeEditor';
import { AuthProvider } from '@/lib/AuthProvider';
import { ClientProvider } from '@/lib/ClientProvider';
import { FeatureFlagsProvider } from '@/lib/FeatureFlags';
import { PreferencesProvider, type Preferences } from '@/lib/Preferences';
import { useWritingDrawerContent, WritingDrawerSlotProvider } from '@/lib/WritingDrawerSlot';
import WritingProjectEditorScreen from '../[id]';

/**
 * Writing drawer/layout architecture correction — [id].tsx no longer
 * renders its own Files/Outline/References/Notes/Tools panel inline on
 * desktop; it registers that JSX into the shared slot
 * app/(tabs)/_layout.tsx renders beside NavRail instead (see
 * lib/WritingDrawerSlot.tsx). This test file renders [id].tsx in
 * isolation (not the real _layout.tsx shell), so it has to provide that
 * same slot + a render site itself — this tiny component IS that render
 * site, mirroring exactly what _layout.tsx does with
 * `{isWide && isWritingProjectOpen && writingDrawerContent}`.
 */
function WritingDrawerSlotRenderer() {
  return <>{useWritingDrawerContent()}</>;
}

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

const mockPush = jest.fn();
const mockParams: { id: string } = { id: 'w-1' };
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn() }),
  useLocalSearchParams: () => mockParams,
  usePathname: () => '/writing/w-1',
  useGlobalSearchParams: () => ({}),
}));

const originalOS = Platform.OS;
const originalWindow = Dimensions.get('window');
beforeAll(() => {
  Platform.OS = 'web';
  Dimensions.set({
    window: { width: 1200, height: 900, scale: 1, fontScale: 1 },
    screen: { width: 1200, height: 900, scale: 1, fontScale: 1 },
  });
});
afterAll(() => {
  Platform.OS = originalOS;
  Dimensions.set({ window: originalWindow, screen: originalWindow });
});

function textOf(node: ReactTestInstance): string {
  return node.children
    .map((c) => (typeof c === 'string' || typeof c === 'number' ? String(c) : ''))
    .join('');
}

function findByTextIncluding(root: ReactTestInstance, substring: string): ReactTestInstance {
  const matches = root.findAll(
    (node) => String(node.type) === 'Text' && textOf(node).includes(substring)
  );
  if (matches.length === 0)
    throw new Error(`No Text node found containing ${JSON.stringify(substring)}`);
  return matches[0]!;
}

function queryByTextIncluding(
  root: ReactTestInstance,
  substring: string
): ReactTestInstance | null {
  const matches = root.findAll(
    (node) => String(node.type) === 'Text' && textOf(node).includes(substring)
  );
  return matches[0] ?? null;
}

// .findAll(...)[0], not .find() (which throws on >1 match): a raw
// react-native-web <Pressable accessibilityLabel=... onPress=...> shows
// up as several distinct fiber layers (the Pressable function component,
// an intermediate forwardRef wrapper, and the host View) that each carry
// the identical, spread-through props — all equally valid to interact
// with, since they share the same onPress reference.
function findPressableByLabel(root: ReactTestInstance, label: string): ReactTestInstance {
  const matches = root.findAll(
    (node) => typeof node.props.onPress === 'function' && node.props.accessibilityLabel === label
  );
  if (matches.length === 0)
    throw new Error(`No pressable found with accessibilityLabel ${JSON.stringify(label)}`);
  return matches[0]!;
}

interface FetchRoute {
  method: string;
  matches: (url: string) => boolean;
  respond: () => Response;
}

function installFetchMock(routes: FetchRoute[]) {
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = (init?.method ?? 'GET').toUpperCase();
    const route = routes.find((r) => r.method === method && r.matches(url));
    if (!route) throw new Error(`Unhandled ${method} ${url} in this test`);
    return route.respond();
  }) as unknown as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

const PROJECT = {
  id: 'w-1',
  title: 'Laser Cutting Paper',
  description: null,
  main_tex_content: '\\documentclass{article}\n\\begin{document}\n\\end{document}',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

const ROOT_FILE_ID = 'root-file-id';

function rootFileNode() {
  return {
    id: ROOT_FILE_ID,
    parent_id: null,
    kind: 'text',
    name: 'main.tex',
    path: 'main.tex',
    mime_type: null,
    size_bytes: PROJECT.main_tex_content.length,
    is_root: true,
  };
}

function getProjectRoute(): FetchRoute {
  return {
    method: 'GET',
    matches: (u) => u.endsWith('/writing-projects/w-1'),
    respond: () => jsonResponse(PROJECT),
  };
}

function referencesRoute(): FetchRoute {
  return {
    method: 'GET',
    matches: (u) => u.endsWith('/writing-projects/w-1/references'),
    respond: () =>
      jsonResponse({ references: [], total: 0, missing_citation_keys: [], source_hash: 'hash1' }),
  };
}

function filesTreeRoute(): FetchRoute {
  return {
    method: 'GET',
    matches: (u) => u.endsWith('/writing-projects/w-1/files'),
    respond: () =>
      jsonResponse({
        files: [rootFileNode()],
        generated: [
          { name: 'references.bib', path: 'references.bib', read_only: true, reference_count: 0 },
        ],
        root_file_id: ROOT_FILE_ID,
        total_size_bytes: PROJECT.main_tex_content.length,
        file_count: 1,
        max_files: 150,
        max_total_bytes: 100_000_000,
      }),
  };
}

function fileContentRoute(content: string = PROJECT.main_tex_content): FetchRoute {
  return {
    method: 'GET',
    matches: (u) => u.endsWith(`/writing-projects/w-1/files/${ROOT_FILE_ID}`),
    respond: () => jsonResponse({ file: rootFileNode(), content_text: content }),
  };
}

function patchFileRoute(): FetchRoute {
  return {
    method: 'PATCH',
    matches: (u) => u.endsWith(`/writing-projects/w-1/files/${ROOT_FILE_ID}`),
    respond: () => jsonResponse({ file: rootFileNode() }),
  };
}

async function flushAsync(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

const activeRenderers: ReactTestRenderer[] = [];
afterEach(() => {
  while (activeRenderers.length > 0) {
    const renderer = activeRenderers.pop()!;
    act(() => {
      renderer.unmount();
    });
  }
  delete process.env.EXPO_PUBLIC_LATEX_COMPILATION_ENABLED;
});

async function renderScreen(
  routes: FetchRoute[],
  preferencesOverrides?: Partial<Preferences>
): Promise<ReactTestRenderer> {
  installFetchMock([...routes, filesTreeRoute(), fileContentRoute(), patchFileRoute()]);
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <PreferencesProvider initialOverrides={preferencesOverrides}>
        <AuthProvider>
          <ClientProvider>
            <FeatureFlagsProvider>
              <WritingDrawerSlotProvider>
                <WritingProjectEditorScreen />
                <WritingDrawerSlotRenderer />
              </WritingDrawerSlotProvider>
            </FeatureFlagsProvider>
          </ClientProvider>
        </AuthProvider>
      </PreferencesProvider>
    );
    await flushAsync();
  });
  activeRenderers.push(renderer);
  return renderer;
}

describe('WritingProjectEditorScreen — desktop Research panel (Milestone 5.5)', () => {
  it('shows Files/Outline/References/Notes/Tools as one tab strip (writing navigation, not chat history), and switching tabs swaps the panel body in place', async () => {
    const renderer = await renderScreen([getProjectRoute(), referencesRoute()]);

    // Defaults to Files (Part 9's own real-browser validation caught
    // that the original 'references' default landed a user on an empty
    // References panel on first open of any project — Files is the
    // primary content and belongs first).
    expect(findByTextIncluding(renderer.root, 'Research')).toBeTruthy();
    expect(renderer.root.find((n) => n.type === LatexCodeEditor)).toBeTruthy();
    expect(findByTextIncluding(renderer.root, 'main.tex')).toBeTruthy();

    // Writing UX Refinement milestone — the tab strip itself is pure
    // writing navigation now: Files/Outline/References/Notes/Tools.
    // "Ask EduM8" is deliberately NOT one of these pills (see the
    // dedicated header-button test below) — a chat-style turn-history
    // panel living as an equal-weight tab of this strip is exactly what
    // that milestone removed.
    expect(findPressableByLabel(renderer.root, 'Files')).toBeTruthy();
    expect(findPressableByLabel(renderer.root, 'Outline')).toBeTruthy();
    expect(findPressableByLabel(renderer.root, 'References')).toBeTruthy();
    expect(findPressableByLabel(renderer.root, 'Notes')).toBeTruthy();
    expect(findPressableByLabel(renderer.root, 'Tools')).toBeTruthy();
    expect(renderer.root.findAll((n) => n.props.accessibilityLabel === 'Ask EduM8').length).toBe(0);

    act(() => {
      findPressableByLabel(renderer.root, 'References').props.onPress();
    });
    expect(findByTextIncluding(renderer.root, 'References')).toBeTruthy();

    act(() => {
      findPressableByLabel(renderer.root, 'Outline').props.onPress();
    });
    expect(findByTextIncluding(renderer.root, 'Sections')).toBeTruthy();

    act(() => {
      findPressableByLabel(renderer.root, 'Tools').props.onPress();
    });
    expect(findByTextIncluding(renderer.root, 'Word count')).toBeTruthy();
  });

  it('reaches Ask EduM8 only via the header button/shortcut, never as a panel tab pill', async () => {
    const renderer = await renderScreen([getProjectRoute(), referencesRoute()]);

    act(() => {
      findPressableByLabel(renderer.root, 'Show Ask EduM8 panel').props.onPress();
    });
    // The embedded panel — same "Research context" indicator the
    // (previously separate-drawer) AskEduM8Panel has always shown, now
    // living inside the Research panel with no separate mount.
    expect(findByTextIncluding(renderer.root, 'Research context')).toBeTruthy();
    // No duplicate drawer: exactly one "Ask EduM8" panel testID.
    // >0 rather than an exact count: a single logical View shows up as
    // more than one react-test-renderer fiber layer in this RN-web setup
    // (the composite + host layers), so this proves the panel mounted,
    // not a literal fiber count.
    expect(
      renderer.root.findAll((n) => n.props.testID === 'ask-edum8-panel').length
    ).toBeGreaterThan(0);
  });

  describe('Research drawer toggle (Milestone 5.5.1 Part 4/5)', () => {
    it('opens and closes via the dedicated header toggle, defaulting to open', async () => {
      const renderer = await renderScreen([getProjectRoute(), referencesRoute()]);

      // Default (no stored preference) is open — the tab strip is visible.
      expect(findPressableByLabel(renderer.root, 'Files')).toBeTruthy();
      const toggle = findPressableByLabel(renderer.root, 'Hide Research panel');

      act(() => {
        toggle.props.onPress();
      });
      // Closed: the SAME toggle now offers to re-open it (relabeled, not
      // a second control) and the panel itself is hidden.
      expect(findPressableByLabel(renderer.root, 'Show Research panel')).toBeTruthy();
      const panelWrap = renderer.root.findAll(
        (n) =>
          Array.isArray(n.props.style) &&
          n.props.style.some((s: unknown) => !!s && (s as { display?: string }).display === 'none')
      );
      expect(panelWrap.length).toBeGreaterThan(0);

      act(() => {
        findPressableByLabel(renderer.root, 'Show Research panel').props.onPress();
      });
      expect(findPressableByLabel(renderer.root, 'Hide Research panel')).toBeTruthy();
    });

    it('closing and reopening the drawer preserves the active tab and Ask EduM8 conversation', async () => {
      const renderer = await renderScreen([getProjectRoute(), referencesRoute()]);

      act(() => {
        findPressableByLabel(renderer.root, 'Notes').props.onPress();
      });
      act(() => {
        findPressableByLabel(renderer.root, 'Hide Research panel').props.onPress();
      });
      act(() => {
        findPressableByLabel(renderer.root, 'Show Research panel').props.onPress();
      });

      // Still on Notes, not reset back to Files/References.
      const notesTab = findPressableByLabel(renderer.root, 'Notes');
      expect(notesTab.props['aria-selected']).toBe(true);
      // AskEduM8Panel never left the tree across the close/reopen cycle —
      // the actual bug this part exists to fix.
      expect(
        renderer.root.findAll((n) => n.props.testID === 'ask-edum8-panel').length
      ).toBeGreaterThan(0);
    });
  });

  it('the header "Ask EduM8" button is a quick-jump to the same panel tab, not a second drawer', async () => {
    const renderer = await renderScreen([getProjectRoute(), referencesRoute()]);

    act(() => {
      findPressableByLabel(renderer.root, 'Show Ask EduM8 panel').props.onPress();
    });

    expect(findByTextIncluding(renderer.root, 'Research context')).toBeTruthy();
    // >0 rather than an exact count: a single logical View shows up as
    // more than one react-test-renderer fiber layer in this RN-web setup
    // (the composite + host layers), so this proves the panel mounted,
    // not a literal fiber count.
    expect(
      renderer.root.findAll((n) => n.props.testID === 'ask-edum8-panel').length
    ).toBeGreaterThan(0);
  });

  it('restores the last-open Research tab from Preferences (Part 9)', async () => {
    const renderer = await renderScreen([getProjectRoute(), referencesRoute()], {
      writingPanelTab: 'notes',
    });

    expect(findByTextIncluding(renderer.root, 'Research')).toBeTruthy();
    // Milestone 5.5.1 Part 4 — AskEduM8Panel stays MOUNTED even when a
    // different tab is the one showing (its own wrapper is hidden via
    // display:'none' below, not removed from the tree) — this is the
    // exact fix for the conversation-state-loss bug this same part
    // describes. Confirms presence, then confirms it's the WRAPPER
    // that's hidden, not merely coincidentally absent.
    expect(
      renderer.root.findAll((n) => n.props.testID === 'ask-edum8-panel').length
    ).toBeGreaterThan(0);
    const hiddenNodes = renderer.root.findAll(
      (n) =>
        Array.isArray(n.props.style) &&
        n.props.style.some((s: unknown) => !!s && (s as { display?: string }).display === 'none')
    );
    expect(hiddenNodes.length).toBeGreaterThan(0);
  });

  // The document-level Cmd/Ctrl+S/Enter/K listener itself is deliberately
  // NOT covered here: it needs a real `document` to dispatch a genuine
  // KeyboardEvent against (this screen's own guard against
  // Platform.OS === 'web' with no DOM behind it), which needs
  // @jest-environment jsdom — and this file's fetch-mock harness
  // (global.fetch = jest.fn(...), the same convention every other
  // Writing test file uses) does not reliably intercept requests under
  // jsdom in this repo's Jest config. That path is validated against a
  // real browser instead (Milestone 5.5 Part 32/33 real browser
  // validation), where the DOM is genuine rather than approximated.
  //
  // The editor's own onShortcutKeyDown wiring below IS covered here,
  // without jsdom, by calling the prop directly — real-browser
  // validation is what actually found the bug this closes:
  // react-native-web's OLD <TextInput> called e.stopPropagation() on
  // every keydown while focused, so the document-level listener above
  // never saw a Cmd/Ctrl+S/Enter/K pressed while the cursor was in the
  // editor (i.e. almost all the time a user would reach for one of
  // these). Milestone 5.5.1 Part 11 replaced that TextInput with
  // LatexCodeEditor (see its own comment: a raw <textarea> doesn't
  // actually stop propagation the way RNW's TextInput did, but the
  // explicit onShortcutKeyDown wiring is kept anyway, so this coverage
  // stays exactly as meaningful as it always was).
  describe('keyboard shortcuts while focus is inside the editor (Part 12 regression)', () => {
    function findEditor(root: ReactTestInstance): ReactTestInstance {
      return root.find((n) => n.type === LatexCodeEditor);
    }

    it('Ctrl+S saves without also falling through to a plain keystroke', async () => {
      const renderer = await renderScreen([getProjectRoute(), referencesRoute()]);
      const editor = findEditor(renderer.root);
      const preventDefault = jest.fn();

      await act(async () => {
        editor.props.onShortcutKeyDown({ key: 's', ctrlKey: true, metaKey: false, preventDefault });
        await flushAsync();
      });

      expect(preventDefault).toHaveBeenCalled();
    });

    it('a plain "s" keystroke (no modifier) is left alone — never intercepted', async () => {
      const renderer = await renderScreen([getProjectRoute(), referencesRoute()]);
      const editor = findEditor(renderer.root);
      const preventDefault = jest.fn();

      await act(async () => {
        editor.props.onShortcutKeyDown({
          key: 's',
          ctrlKey: false,
          metaKey: false,
          preventDefault,
        });
        await flushAsync();
      });

      expect(preventDefault).not.toHaveBeenCalled();
    });

    it('Ctrl+K jumps to the Ask EduM8 tab from inside the editor', async () => {
      const renderer = await renderScreen([getProjectRoute(), referencesRoute()]);
      const editor = findEditor(renderer.root);
      const preventDefault = jest.fn();

      await act(async () => {
        editor.props.onShortcutKeyDown({ key: 'k', ctrlKey: true, metaKey: false, preventDefault });
        await flushAsync();
      });

      expect(preventDefault).toHaveBeenCalled();
      expect(findByTextIncluding(renderer.root, 'Research context')).toBeTruthy();
    });
  });
});
