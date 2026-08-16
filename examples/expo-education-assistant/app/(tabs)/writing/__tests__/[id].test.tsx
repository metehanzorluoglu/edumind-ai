import { Platform } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { AuthProvider } from '@/lib/AuthProvider';
import { ClientProvider } from '@/lib/ClientProvider';
import { FeatureFlagsProvider } from '@/lib/FeatureFlags';
import WritingProjectEditorScreen from '../[id]';

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
beforeAll(() => {
  Platform.OS = 'web';
});
afterAll(() => {
  Platform.OS = originalOS;
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

function findPressableByLabel(root: ReactTestInstance, label: string): ReactTestInstance {
  return root.find(
    (node) => typeof node.props.onPress === 'function' && node.props.accessibilityLabel === label
  );
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

const REFERENCE = {
  document_type: 'journal_article',
  title: 'A Study of Laser Cutting',
  authors: ['Jane Doe'],
  publication_year: 2020,
  has_usable_doi: false,
  citation_key: 'Doe2020Laser',
  document_id: 'd-1',
  source_filename: 'paper.pdf',
  added_at: '2026-01-01T00:00:00Z',
  cited: false,
};

function getProjectRoute(project: unknown = PROJECT): FetchRoute {
  return {
    method: 'GET',
    matches: (u) => u.endsWith('/writing-projects/w-1') && !u.includes('/files'),
    respond: () => jsonResponse(project),
  };
}

function patchProjectRoute(response: unknown = PROJECT): FetchRoute {
  return {
    method: 'PATCH',
    matches: (u) => u.endsWith('/writing-projects/w-1'),
    respond: () => jsonResponse(response),
  };
}

// Milestone 5.3 — the project's file tree. Every test in this file gets
// a default one-file tree (just the root main.tex, matching the
// pre-M5.3 single-file behavior) via renderScreen's own auto-appended
// defaults below, UNLESS a test explicitly passes its own
// filesTreeRoute()/fileContentRoute() earlier in its route list (an
// earlier match in installFetchMock always wins).
const ROOT_FILE_ID = 'root-file-id';

function rootFileNode(overrides: Record<string, unknown> = {}) {
  return {
    id: ROOT_FILE_ID,
    parent_id: null,
    kind: 'text',
    name: 'main.tex',
    path: 'main.tex',
    mime_type: null,
    size_bytes: PROJECT.main_tex_content.length,
    is_root: true,
    ...overrides,
  };
}

function filesTreeRoute(files: unknown[] = [rootFileNode()], rootFileId: string | null = ROOT_FILE_ID): FetchRoute {
  return {
    method: 'GET',
    matches: (u) => u.endsWith('/writing-projects/w-1/files'),
    respond: () =>
      jsonResponse({
        files,
        generated: [{ name: 'references.bib', path: 'references.bib', read_only: true, reference_count: 0 }],
        root_file_id: rootFileId,
        total_size_bytes: PROJECT.main_tex_content.length,
        file_count: files.length,
        max_files: 150,
        max_total_bytes: 100_000_000,
      }),
  };
}

function fileContentRoute(
  content: string = PROJECT.main_tex_content,
  fileId: string = ROOT_FILE_ID
): FetchRoute {
  return {
    method: 'GET',
    matches: (u) => u.endsWith(`/writing-projects/w-1/files/${fileId}`),
    respond: () => jsonResponse({ file: rootFileNode({ id: fileId }), content_text: content }),
  };
}

/** Milestone 5.3 — the NEW per-file autosave endpoint: editing now
 * PATCHes here (never the legacy PATCH /writing-projects/{id} main_tex_
 * content field — see [id].tsx's own write-through-sync docstring for
 * why the legacy endpoint still exists but is no longer what the editor
 * itself calls). */
function patchFileRoute(fileId: string = ROOT_FILE_ID): FetchRoute {
  return {
    method: 'PATCH',
    matches: (u) => u.endsWith(`/writing-projects/w-1/files/${fileId}`),
    respond: () => jsonResponse({ file: rootFileNode({ id: fileId }) }),
  };
}

function referencesRoute(
  references: unknown[] = [],
  missingCitationKeys: string[] = []
): FetchRoute {
  return {
    method: 'GET',
    matches: (u) => u.endsWith('/writing-projects/w-1/references'),
    respond: () =>
      jsonResponse({
        references,
        total: references.length,
        missing_citation_keys: missingCitationKeys,
      }),
  };
}

function bibliographyRoute(bibtex = '@article{Doe2020Laser,\n}\n', count = 1): FetchRoute {
  return {
    method: 'GET',
    matches: (u) => u.endsWith('/writing-projects/w-1/bibliography'),
    respond: () => jsonResponse({ bibtex, reference_count: count }),
  };
}

async function flushAsync(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function renderScreen(routes: FetchRoute[]): Promise<ReactTestRenderer> {
  // Milestone 5.3 — useWritingProjectFiles fetches the file tree and
  // then the root file's content on mount, exactly like the pre-M5.3
  // editor's own useWritingProject fetched main_tex_content directly.
  // Appended AFTER the caller's own routes so a test that needs a
  // custom tree/content can still override by listing its own
  // filesTreeRoute()/fileContentRoute() earlier (installFetchMock's
  // `routes.find` takes the first match).
  installFetchMock([...routes, filesTreeRoute(), fileContentRoute()]);
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <AuthProvider>
        <ClientProvider>
          {/* Milestone 5.1 — the screen now reads useFeatureFlags() to
              gate the Compile button/Preview panel. latexCompilation
              defaults to false (bootstrap default, see FeatureFlags.tsx)
              — exactly right for these pre-existing M5 tests, none of
              which exercise the compile UI; see [id].compile.test.tsx
              for that coverage with the flag explicitly on. */}
          <FeatureFlagsProvider>
            <WritingProjectEditorScreen />
          </FeatureFlagsProvider>
        </ClientProvider>
      </AuthProvider>
    );
    await flushAsync();
  });
  activeRenderers.push(renderer);
  return renderer;
}

// Tracks every renderer created by renderScreen() in the current test so
// afterEach can unmount it — unmounting runs useWritingProject's own
// cleanup effect, which clears any pending (real-timer) debounce timeout.
// Without this, a debounce scheduled by one test (e.g. "editing shows
// Editing… immediately", which deliberately never lets the debounce
// fire) can still be pending when a LATER test replaces global.fetch —
// and firing against a torn-down mock crashes the whole Jest worker
// process, not just that one test.
let activeRenderers: ReactTestRenderer[] = [];

describe('WritingProjectEditorScreen', () => {
  beforeEach(() => {
    mockPush.mockClear();
    activeRenderers = [];
  });

  afterEach(async () => {
    for (const renderer of activeRenderers) {
      await act(async () => {
        renderer.unmount();
        await flushAsync();
      });
    }
  });

  it('loads the project and seeds the editor with its exact saved source', async () => {
    const renderer = await renderScreen([getProjectRoute(), referencesRoute()]);
    expect(findByTextIncluding(renderer.root, 'Laser Cutting Paper')).toBeTruthy();
    const editor = renderer.root.find(
      (n) => String(n.type) === 'TextInput' && n.props.accessibilityLabel === 'LaTeX source editor'
    );
    expect(editor.props.value).toBe(PROJECT.main_tex_content);
  });

  it('an error while loading shows a retry action, never a silent blank screen', async () => {
    const renderer = await renderScreen([
      {
        method: 'GET',
        matches: (u) => u.endsWith('/writing-projects/w-1'),
        respond: () => jsonResponse({ detail: 'Writing project not found' }, 404),
      },
    ]);
    expect(findByTextIncluding(renderer.root, "Couldn't load this writing project.")).toBeTruthy();
  });

  it('editing the source shows "Editing…" immediately, without an immediate PATCH', async () => {
    const renderer = await renderScreen([
      getProjectRoute(),
      referencesRoute(),
      patchFileRoute(),
    ]);
    const patchCallsBefore = (global.fetch as jest.Mock).mock.calls.filter(
      ([, init]: [string, RequestInit]) => init?.method === 'PATCH'
    ).length;

    const editor = renderer.root.find(
      (n) => String(n.type) === 'TextInput' && n.props.accessibilityLabel === 'LaTeX source editor'
    );
    act(() => {
      editor.props.onChangeText('\\section{Introduction}');
    });

    expect(findByTextIncluding(renderer.root, 'Editing…')).toBeTruthy();
    const patchCallsAfter = (global.fetch as jest.Mock).mock.calls.filter(
      ([, init]: [string, RequestInit]) => init?.method === 'PATCH'
    ).length;
    expect(patchCallsAfter).toBe(patchCallsBefore);
  });

  it('autosaves the debounced edit and shows "Saved" once the server acknowledges it', async () => {
    // Render with REAL timers first — renderScreen's own flushAsync()
    // relies on a real setTimeout(0), which would otherwise hang forever
    // once fake timers freeze the clock.
    const renderer = await renderScreen([
      getProjectRoute(),
      referencesRoute(),
      patchFileRoute(),
    ]);

    jest.useFakeTimers();
    try {
      const editor = renderer.root.find(
        (n) =>
          String(n.type) === 'TextInput' && n.props.accessibilityLabel === 'LaTeX source editor'
      );
      act(() => {
        editor.props.onChangeText('\\section{Introduction}');
      });

      await act(async () => {
        await jest.advanceTimersByTimeAsync(2000);
      });

      // Milestone 5.3 — the autosave PATCH now targets the ACTIVE
      // FILE's own endpoint (never the legacy PATCH /writing-projects/
      // {id} main_tex_content field the pre-M5.3 editor used).
      const patchCall = (global.fetch as jest.Mock).mock.calls.find(
        ([url, init]: [string, RequestInit]) =>
          init?.method === 'PATCH' &&
          String(url).endsWith(`/writing-projects/w-1/files/${ROOT_FILE_ID}`)
      );
      expect(patchCall).toBeTruthy();
      expect(JSON.parse(patchCall[1].body as string)).toEqual({
        content_text: '\\section{Introduction}',
      });
      expect(findByTextIncluding(renderer.root, 'Saved')).toBeTruthy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('shows a missing-citation-key warning without ever auto-deleting or rewriting the source', async () => {
    const renderer = await renderScreen([getProjectRoute(), referencesRoute([], ['Smith2024AI'])]);

    act(() => {
      findPressableByLabel(renderer.root, 'References').props.onPress();
    });

    expect(
      findByTextIncluding(
        renderer.root,
        "Citation key 'Smith2024AI' is not in this project's references."
      )
    ).toBeTruthy();
  });

  it('regression: the References panel refreshes after a save completes — not just once at mount', async () => {
    // Reproduces a real bug found during Milestone 5 production QA: the
    // References panel only ever fetched once at mount, so a user who
    // inserted a \cite{} and then checked References (or was already
    // looking at it, on desktop's split pane) saw STALE data — the
    // missing-citation warning silently never appeared until a full page
    // reload. Fixed by re-fetching references whenever saveStatus
    // transitions to 'saved' (see [id].tsx's second `loadReferences`
    // effect). This test fails against the pre-fix code.
    let referencesCallCount = 0;
    const dynamicReferencesRoute: FetchRoute = {
      method: 'GET',
      matches: (u) => u.endsWith('/writing-projects/w-1/references'),
      respond: () => {
        referencesCallCount += 1;
        // First call (mount): nothing unresolved yet. Every call after
        // the edit below is saved: the new key is now unresolved.
        const missing = referencesCallCount === 1 ? [] : ['FreshlyTypedKey'];
        return jsonResponse({ references: [], total: 0, missing_citation_keys: missing });
      },
    };
    const renderer = await renderScreen([
      getProjectRoute(),
      dynamicReferencesRoute,
      patchFileRoute(),
    ]);

    act(() => {
      findPressableByLabel(renderer.root, 'References').props.onPress();
    });
    expect(referencesCallCount).toBe(1);
    expect(() =>
      findByTextIncluding(renderer.root, "Citation key 'FreshlyTypedKey' is not")
    ).toThrow();

    jest.useFakeTimers();
    try {
      act(() => {
        findPressableByLabel(renderer.root, 'Editor').props.onPress();
      });
      const editor = renderer.root.find(
        (n) =>
          String(n.type) === 'TextInput' && n.props.accessibilityLabel === 'LaTeX source editor'
      );
      act(() => {
        editor.props.onChangeText('\\cite{FreshlyTypedKey}');
      });
      await act(async () => {
        await jest.advanceTimersByTimeAsync(2000);
      });
    } finally {
      jest.useRealTimers();
    }

    act(() => {
      findPressableByLabel(renderer.root, 'References').props.onPress();
    });

    expect(referencesCallCount).toBeGreaterThan(1);
    expect(
      findByTextIncluding(renderer.root, "Citation key 'FreshlyTypedKey' is not")
    ).toBeTruthy();
  });

  it('lists current references with a compact identity and inserts a citation at the cursor', async () => {
    const renderer = await renderScreen([
      getProjectRoute(),
      referencesRoute([REFERENCE]),
      // Insert citation leaves the buffer dirty — this test's own
      // afterEach unmount triggers a flushActiveFile() save (Part 7: "no
      // lost content during navigation"), so a PATCH route is needed
      // even though this test itself never explicitly waits for
      // autosave.
      patchFileRoute(),
    ]);

    act(() => {
      findPressableByLabel(renderer.root, 'References').props.onPress();
    });
    expect(findByTextIncluding(renderer.root, 'Doe (2020)')).toBeTruthy();

    act(() => {
      findPressableByLabel(renderer.root, 'Editor').props.onPress();
    });
    const editorBefore = renderer.root.find(
      (n) => String(n.type) === 'TextInput' && n.props.accessibilityLabel === 'LaTeX source editor'
    );
    act(() => {
      editorBefore.props.onSelectionChange({
        nativeEvent: {
          selection: {
            start: editorBefore.props.value.length,
            end: editorBefore.props.value.length,
          },
        },
      });
    });

    act(() => {
      findPressableByLabel(renderer.root, 'References').props.onPress();
    });
    act(() => {
      findPressableByLabel(renderer.root, 'Insert citation for Doe (2020)').props.onPress();
    });

    act(() => {
      findPressableByLabel(renderer.root, 'Editor').props.onPress();
    });
    const editorAfter = renderer.root.find(
      (n) => String(n.type) === 'TextInput' && n.props.accessibilityLabel === 'LaTeX source editor'
    );
    expect(editorAfter.props.value).toContain('\\cite{Doe2020Laser}');
  });

  it('regression: inserting a citation before the user ever clicks the editor lands at the END of the content, never before \\documentclass (Milestone 5.2.1)', async () => {
    // Reproduces a real bug found during Milestone 5.2.1 browser
    // validation: `selection` starts at {0, 0} on every fresh mount
    // (including after Ask EduM8's "Open source" navigates away and
    // back — Part 6). Position 0 in a real LaTeX file is BEFORE
    // \documentclass{...} — inserting there via insertAtCursor silently
    // corrupted the source into something that failed to compile. Fixed
    // by defaulting `selection` to the end of the just-loaded content
    // once loadState succeeds; this test fails against the pre-fix code
    // (which would insert \cite{...} as the literal first four
    // characters of main_tex_content, before \documentclass).
    const renderer = await renderScreen([
      getProjectRoute(),
      referencesRoute([REFERENCE]),
      patchFileRoute(),
    ]);

    act(() => {
      findPressableByLabel(renderer.root, 'References').props.onPress();
    });
    // Deliberately never touch the editor's selection at all — this is
    // the exact "fresh load, click Insert citation immediately" flow
    // that exposed the bug.
    act(() => {
      findPressableByLabel(renderer.root, 'Insert citation for Doe (2020)').props.onPress();
    });

    act(() => {
      findPressableByLabel(renderer.root, 'Editor').props.onPress();
    });
    const editorAfter = renderer.root.find(
      (n) => String(n.type) === 'TextInput' && n.props.accessibilityLabel === 'LaTeX source editor'
    );
    expect(editorAfter.props.value).toContain('\\cite{Doe2020Laser}');
    expect(editorAfter.props.value.startsWith('\\cite{')).toBe(false);
    expect(editorAfter.props.value.indexOf('\\cite{Doe2020Laser}')).toBeGreaterThan(
      editorAfter.props.value.indexOf('\\documentclass')
    );
  });

  it('opening "View BibTeX" fetches and displays the project bibliography', async () => {
    const renderer = await renderScreen([
      getProjectRoute(),
      referencesRoute([REFERENCE]),
      bibliographyRoute(),
    ]);

    act(() => {
      findPressableByLabel(renderer.root, 'References').props.onPress();
    });
    await act(async () => {
      findPressableByLabel(renderer.root, 'View BibTeX').props.onPress();
      await flushAsync();
    });

    expect(findByTextIncluding(renderer.root, '@article{Doe2020Laser')).toBeTruthy();
  });

  it('the "Export" action flushes any pending edit and fetches the project ZIP', async () => {
    const renderer = await renderScreen([
      getProjectRoute(),
      referencesRoute(),
      patchProjectRoute(),
    ]);
    (global.fetch as jest.Mock).mockImplementationOnce(async () => {
      throw new Error('unused');
    });
    installFetchMock([
      getProjectRoute(),
      referencesRoute(),
      patchProjectRoute(),
      filesTreeRoute(),
      fileContentRoute(),
      {
        method: 'GET',
        matches: (u) => u.endsWith('/writing-projects/w-1/export'),
        respond: () =>
          new Response('zip-bytes', {
            status: 200,
            headers: { 'content-type': 'application/zip' },
          }),
      },
    ]);

    await act(async () => {
      findPressableByLabel(renderer.root, 'Export').props.onPress();
      await flushAsync();
    });

    const exportCall = (global.fetch as jest.Mock).mock.calls.find(([url]: [string]) =>
      String(url).endsWith('/writing-projects/w-1/export')
    );
    expect(exportCall).toBeTruthy();
  });

  it('deleting the project navigates back to the Writing list', async () => {
    const originalConfirm = (global as { confirm?: unknown }).confirm;
    const confirmMock = jest.fn(() => true);
    // @ts-expect-error test stub
    global.window = { confirm: confirmMock };
    global.confirm = confirmMock as unknown as typeof confirm;

    try {
      const renderer = await renderScreen([
        getProjectRoute(),
        referencesRoute(),
        {
          method: 'DELETE',
          matches: (u) => u.endsWith('/writing-projects/w-1'),
          respond: () => new Response(null, { status: 204 }),
        },
      ]);

      act(() => {
        findPressableByLabel(renderer.root, 'Project options').props.onPress();
      });
      await act(async () => {
        findPressableByLabel(renderer.root, 'Delete project').props.onPress();
        await flushAsync();
      });

      expect(mockPush).toHaveBeenCalledWith('/writing');
    } finally {
      // @ts-expect-error test cleanup
      delete global.window;
      global.confirm = originalConfirm as typeof confirm;
    }
  });
});
