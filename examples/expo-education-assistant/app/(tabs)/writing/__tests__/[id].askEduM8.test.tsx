/**
 * Milestone 5.2 (Research-Aware Writing Assistant) — Part 19 frontend
 * coverage for "Ask EduM8" inside the Writing workspace: opening the
 * panel, the default Project References scope + its research-context
 * indicator (Part 12), sending a question through the real
 * create-conversation -> PUT documents -> PATCH zoom_in_mode -> POST
 * message sequence, evidence-first answer rendering (Part 5), empty/
 * unsupported evidence (Part 13), Add reference / Insert citation (Parts
 * 7/8), Open source navigation (Part 6), the manuscript-selection
 * transient-context checkbox (Part 3), and the AI/manuscript safety
 * boundary — the manuscript is NEVER touched except by the explicit
 * Insert citation action (Part 14).
 *
 * Same harness convention as [id].test.tsx/[id].compile.test.tsx: a raw
 * `global.fetch` mock routed by method+URL, real ClientProvider/
 * AuthProvider/FeatureFlagsProvider, the real screen component. Kept in
 * its own file (not appended to [id].test.tsx) for the same reason
 * [id].compile.test.tsx is separate — a distinct, sizeable feature
 * surface with its own route fixtures.
 */
import { Platform } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { LatexCodeEditor } from '@/components/writing/LatexCodeEditor';
import { AuthProvider } from '@/lib/AuthProvider';
import { ClientProvider } from '@/lib/ClientProvider';
import { FeatureFlagsProvider } from '@/lib/FeatureFlags';
import { __resetSessionNavCacheForTests } from '@/lib/sessionNavCache';
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

function queryByTextIncluding(
  root: ReactTestInstance,
  substring: string
): ReactTestInstance | null {
  const matches = root.findAll(
    (node) => String(node.type) === 'Text' && textOf(node).includes(substring)
  );
  return matches[0] ?? null;
}

function findPressableByLabel(root: ReactTestInstance, label: string): ReactTestInstance {
  return root.find(
    (node) => typeof node.props.onPress === 'function' && node.props.accessibilityLabel === label
  );
}

function findPressableWithText(root: ReactTestInstance, text: string): ReactTestInstance {
  return root.find(
    (node) =>
      typeof node.props.onPress === 'function' &&
      node.findAll((n) => String(n.type) === 'Text' && textOf(n).includes(text)).length > 0
  );
}

interface FetchRoute {
  method: string;
  matches: (url: string) => boolean;
  // `init` is optional and unused by almost every route — only the
  // streaming-cancellation tests (Part 2) need the real request's signal,
  // to wire a synthetic stream's abort behavior the way a real browser
  // fetch would (aborting cancels the in-flight body read).
  respond: (init?: RequestInit) => Response;
}

function installFetchMock(routes: FetchRoute[]) {
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = (init?.method ?? 'GET').toUpperCase();
    const route = routes.find((r) => r.method === method && r.matches(url));
    if (!route) throw new Error(`Unhandled ${method} ${url} in this test`);
    return route.respond(init);
  }) as unknown as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function sseEvent(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function sseResponse(events: unknown[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(sseEvent(event)));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

async function flushAsync(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
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

const CHUNK = {
  score: 0.92,
  text: 'Teachers reported increased autonomy after the 12-week program.',
  document_id: 'd-1',
  chunk_id: 'c-1',
  document_type: 'journal_article',
  title: 'A Study of Laser Cutting',
  authors: ['Jane Doe'],
  publication_year: 2020,
  source_venue: 'Journal of Examples',
  source_filename: 'paper.pdf',
  chunk_index: 0,
  page_number: 4,
  scope: 'chat',
};

const CITATION = {
  source_id: 'S1',
  source_kind: 'document',
  document_id: 'd-1',
  chunk_id: 'c-1',
  title: 'A Study of Laser Cutting',
  authors: ['Jane Doe'],
  publication_year: 2020,
  source_venue: 'Journal of Examples',
  document_type: 'journal_article',
  journal_quartile: null,
  page_start: 4,
  page_end: 4,
  doi: null,
  source_url: null,
  score: 0.92,
};

function getProjectRoute(): FetchRoute {
  return {
    method: 'GET',
    matches: (u) => u.endsWith('/writing-projects/w-1'),
    respond: () => jsonResponse(PROJECT),
  };
}

function patchProjectRoute(): FetchRoute {
  return {
    method: 'PATCH',
    matches: (u) => u.endsWith('/writing-projects/w-1'),
    respond: () => jsonResponse(PROJECT),
  };
}

function referencesRoute(references: unknown[] = [REFERENCE]): FetchRoute {
  return {
    method: 'GET',
    matches: (u) => u.endsWith('/writing-projects/w-1/references'),
    respond: () =>
      jsonResponse({ references, total: references.length, missing_citation_keys: [] }),
  };
}

function createConversationRoute(id = 'conv-1'): FetchRoute {
  return {
    method: 'POST',
    matches: (u) => u.endsWith('/conversations'),
    respond: () =>
      jsonResponse(
        {
          id,
          title: 'New conversation',
          title_is_custom: false,
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
          messages: [],
        },
        201
      ),
  };
}

function putDocumentsRoute(conversationId = 'conv-1'): FetchRoute {
  return {
    method: 'PUT',
    matches: (u) => u.endsWith(`/conversations/${conversationId}/documents`),
    respond: () => jsonResponse({ documents: [], total: 1 }),
  };
}

function patchScopeRoute(conversationId = 'conv-1'): FetchRoute {
  return {
    method: 'PATCH',
    matches: (u) => u.endsWith(`/conversations/${conversationId}/scope`),
    respond: () =>
      jsonResponse({
        chat_enabled: true,
        project_enabled: true,
        general_enabled: true,
        include_other_project_summaries: false,
        zoom_in_mode: true,
      }),
  };
}

function messagesRoute(
  conversationId = 'conv-1',
  options: {
    answer?: string;
    insufficientEvidence?: boolean;
    writingContextSummary?: Record<string, unknown> | null;
  } = {}
): FetchRoute {
  const answer = options.answer ?? 'Teachers reported increased autonomy [S1].';
  const insufficientEvidence = options.insufficientEvidence ?? false;
  const writingContextSummary = options.writingContextSummary ?? null;
  return {
    method: 'POST',
    matches: (u) => u.endsWith(`/conversations/${conversationId}/messages`),
    respond: () =>
      sseResponse(
        insufficientEvidence
          ? [{ type: 'done', citations: [], citation_warnings: [], insufficient_evidence: true }]
          : [
              { type: 'token', content: answer },
              { type: 'sources', sources: [CHUNK] },
              {
                type: 'done',
                citations: [CITATION],
                citation_warnings: [],
                insufficient_evidence: false,
                writing_context_summary: writingContextSummary,
              },
            ]
      ),
  };
}

function addReferenceRoute(): FetchRoute {
  return {
    method: 'POST',
    matches: (u) => u.endsWith('/writing-projects/w-1/references'),
    respond: () => jsonResponse({ added: 1 }),
  };
}

function bibtexRoute(documentId = 'd-1', citationKey = 'Doe2020Laser'): FetchRoute {
  return {
    method: 'GET',
    matches: (u) => u.endsWith(`/documents/${documentId}/bibtex`),
    respond: () => jsonResponse({ citation_key: citationKey, bibtex: `@article{${citationKey},}` }),
  };
}

// --- "Add to notebook" routes (Part 9/10) --------------------------------

function createHighlightRoute(documentId = 'd-1'): FetchRoute {
  return {
    method: 'POST',
    matches: (u) => u.endsWith(`/documents/${documentId}/highlights`),
    respond: () =>
      jsonResponse(
        {
          id: 'h-1',
          document_id: documentId,
          chunk_id: 'c-1',
          chunk_index: 0,
          page_number: 4,
          selected_text: 'Teachers reported increased autonomy after the 12-week program.',
          note_text: null,
          visual_anchor: null,
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
        },
        201
      ),
  };
}

function notebooksListRoute(): FetchRoute {
  return {
    method: 'GET',
    matches: (u) => u.endsWith('/notebooks') || u.includes('/notebooks?'),
    respond: () =>
      jsonResponse({
        notebooks: [
          {
            id: 'nb-1',
            name: 'Chapter 2 sources',
            entry_count: 0,
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
          },
        ],
        total: 1,
      }),
  };
}

function highlightMembershipRoute(documentId = 'd-1', highlightId = 'h-1'): FetchRoute {
  return {
    method: 'GET',
    matches: (u) => u.endsWith(`/documents/${documentId}/highlights/${highlightId}/notebooks`),
    respond: () => jsonResponse({ notebooks: [] }),
  };
}

// Milestone 5.3 — useWritingProjectFiles fetches the file tree + the
// root file's content on mount, exactly like the pre-M5.3 editor's own
// useWritingProject fetched main_tex_content directly. Every test here
// gets this one-file default unless it lists its own override earlier.
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

/** Milestone 5.3 — the NEW per-file autosave endpoint (see
 * [id].test.tsx's identical helper for why the legacy
 * patchProjectRoute() above is no longer what editing itself PATCHes,
 * though it's kept here since renameProject/other legacy-endpoint
 * flows still use it). */
function patchFileRoute(): FetchRoute {
  return {
    method: 'PATCH',
    matches: (u) => u.endsWith(`/writing-projects/w-1/files/${ROOT_FILE_ID}`),
    respond: () => jsonResponse({ file: rootFileNode() }),
  };
}

let activeRenderers: ReactTestRenderer[] = [];

async function renderScreen(routes: FetchRoute[]): Promise<ReactTestRenderer> {
  installFetchMock([...routes, filesTreeRoute(), fileContentRoute(), patchFileRoute()]);
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <AuthProvider>
        <ClientProvider>
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

function openAskPanel(renderer: ReactTestRenderer): void {
  act(() => {
    // Milestone 6.2 Part 10 — targeted by accessibilityRole="tab", not a
    // generic "Ask EduM8" text search: the selection-aware quick-action
    // bar's own bare "Ask EduM8" action (role="button", opens the panel
    // without asking anything — see SelectionQuickActions.tsx) visibly
    // says the same words when a manuscript selection is active, so a
    // plain findPressableWithText(root, 'Ask EduM8') is now genuinely
    // ambiguous between "the tab that opens this panel" and "a quick
    // action that also opens this panel." Both really do open the same
    // panel, but only the tab is what this helper means to click.
    renderer.root
      .find(
        (node) =>
          typeof node.props.onPress === 'function' &&
          node.props.accessibilityRole === 'tab' &&
          node.findAll((n) => String(n.type) === 'Text' && textOf(n).includes('Ask EduM8')).length >
            0
      )
      .props.onPress();
  });
}

async function askQuestion(renderer: ReactTestRenderer, question: string): Promise<void> {
  const input = renderer.root.find(
    (n) => String(n.type) === 'TextInput' && n.props.accessibilityLabel === 'Ask a question'
  );
  act(() => {
    input.props.onChangeText(question);
  });
  await act(async () => {
    findPressableByLabel(renderer.root, 'Ask').props.onPress();
    await flushAsync();
  });
}

function bodyOf(call: [string, RequestInit] | undefined): Record<string, unknown> {
  if (!call?.[1]?.body) return {};
  return JSON.parse(call[1].body as string);
}

function findCall(method: string, urlSuffix: string): [string, RequestInit] | undefined {
  return (global.fetch as jest.Mock).mock.calls.find(
    ([url, init]: [string, RequestInit]) =>
      (init?.method ?? 'GET') === method && String(url).endsWith(urlSuffix)
  );
}

describe('Writing workspace — Ask EduM8 (Milestone 5.2)', () => {
  beforeEach(() => {
    mockPush.mockClear();
    activeRenderers = [];
    // Milestone 6.2 Part 10 — without this, a real selection set by one
    // test (onSelectionChange) leaks into every later test via the
    // module-level session-nav cache ([id].tsx seeds cursorMemoryRef's
    // initial value from getSessionNavState, keyed by this same fixture
    // project id in every test here), since a fresh renderer's initial
    // mount still reads back a PRIOR test's remembered cursor for the
    // same file id. Harmless before the selection-aware quick-action bar
    // existed (nothing rendered differently based on stray leftover
    // selection state); now that something does, this reset — the same
    // one [id].continuity.test.tsx already applies for the same reason —
    // is required for true per-test isolation.
    __resetSessionNavCacheForTests();
  });

  afterEach(async () => {
    for (const renderer of activeRenderers) {
      await act(async () => {
        renderer.unmount();
        await flushAsync();
      });
    }
  });

  it('the header button opens the panel showing "Research context" and the default Project references scope', async () => {
    const renderer = await renderScreen([getProjectRoute(), referencesRoute([REFERENCE])]);
    openAskPanel(renderer);

    expect(findByTextIncluding(renderer.root, 'Research context')).toBeTruthy();
    expect(findByTextIncluding(renderer.root, 'Project references · 1 source')).toBeTruthy();
  });

  it('zero project references no longer disables Ask EduM8 — the current document is always usable (Writing UX Refinement milestone, Blocker 2)', async () => {
    // Real-browser validation found a genuine defect here: this used to
    // assert the OPPOSITE — that an empty Project References scope
    // disabled the Ask button outright and sent no request. That was
    // wrong: the backend has always treated the current document as
    // valid Writing context on its own (writing_context is sent on
    // every ask() call regardless of scope — see useWritingAsk.ts), so
    // gating the composer on the RAG scope's document count was a pure
    // frontend bug, not a backend requirement. See this test's replaced
    // sibling below for the corrected behavior.
    const renderer = await renderScreen([
      getProjectRoute(),
      referencesRoute([]),
      createConversationRoute(),
      messagesRoute(),
    ]);
    openAskPanel(renderer);

    // Current document is always represented as usable context...
    expect(findByTextIncluding(renderer.root, 'Current document')).toBeTruthy();
    // ...and an empty scope is now purely informational, not a warning.
    expect(findByTextIncluding(renderer.root, 'No project references attached')).toBeTruthy();

    const input = renderer.root.find(
      (n) => String(n.type) === 'TextInput' && n.props.accessibilityLabel === 'Ask a question'
    );
    act(() => {
      input.props.onChangeText('Summarize my current document');
    });
    const askButton = findPressableByLabel(renderer.root, 'Ask');
    expect(askButton.props.disabled).toBe(false);

    await act(async () => {
      askButton.props.onPress();
      await flushAsync();
    });

    // The question was actually sent and answered using zero
    // references — the current document (writing_context) alone.
    const messageBody = bodyOf(findCall('POST', '/conversations/conv-1/messages'));
    expect(String(messageBody.query)).toBe('Summarize my current document');
    const writingContext = messageBody.writing_context as Record<string, unknown>;
    expect(writingContext).toBeTruthy();
    expect(writingContext.project_id).toBe(PROJECT.id);
    expect(typeof writingContext.active_file_unsaved_content).toBe('string');
    expect((writingContext.active_file_unsaved_content as string).length).toBeGreaterThan(0);
    // Zero references means the scope-sync PUT/PATCH calls (which only
    // fire when there's something to actually search) never had to run
    // for this turn — never a call with an empty document_ids array.
    expect(findCall('PUT', '/conversations/conv-1/documents')).toBeUndefined();
    expect(findByTextIncluding(renderer.root, 'Teachers reported increased autonomy')).toBeTruthy();
  });

  it('adding a project reference enriches Ask EduM8 with real RAG evidence rather than being what enables it (Writing UX Refinement milestone, Blocker 2)', async () => {
    // Same question, same current document, but now WITH a project
    // reference — proves references remain a genuine evidence-search
    // enrichment (real citations/Evidence card) on top of the always-
    // usable current document, not a gate that had to be satisfied
    // first.
    const renderer = await renderScreen([
      getProjectRoute(),
      referencesRoute([REFERENCE]),
      createConversationRoute(),
      putDocumentsRoute(),
      patchScopeRoute(),
      messagesRoute(),
    ]);
    openAskPanel(renderer);
    expect(queryByTextIncluding(renderer.root, 'No project references attached')).toBeNull();

    await askQuestion(renderer, 'Summarize my current document');

    expect(bodyOf(findCall('PUT', '/conversations/conv-1/documents'))).toEqual({
      document_ids: ['d-1'],
    });
    expect(findByTextIncluding(renderer.root, 'Teachers reported increased autonomy')).toBeTruthy();
    expect(findByTextIncluding(renderer.root, 'Doe')).toBeTruthy();
  });

  it('sending a question runs create -> PUT documents -> PATCH zoom_in_mode -> POST message, in that order, scoped to the project references', async () => {
    const renderer = await renderScreen([
      getProjectRoute(),
      referencesRoute([REFERENCE]),
      createConversationRoute(),
      putDocumentsRoute(),
      patchScopeRoute(),
      messagesRoute(),
    ]);
    openAskPanel(renderer);
    await askQuestion(renderer, 'What evidence supports this claim?');

    const createIdx = (global.fetch as jest.Mock).mock.calls.findIndex(
      ([url, init]: [string, RequestInit]) =>
        String(url).endsWith('/conversations') && (init?.method ?? 'GET') === 'POST'
    );
    const putIdx = (global.fetch as jest.Mock).mock.calls.findIndex(
      ([url, init]: [string, RequestInit]) =>
        String(url).endsWith('/conversations/conv-1/documents') && init?.method === 'PUT'
    );
    const patchIdx = (global.fetch as jest.Mock).mock.calls.findIndex(
      ([url, init]: [string, RequestInit]) =>
        String(url).endsWith('/conversations/conv-1/scope') && init?.method === 'PATCH'
    );
    const msgIdx = (global.fetch as jest.Mock).mock.calls.findIndex(
      ([url, init]: [string, RequestInit]) =>
        String(url).endsWith('/conversations/conv-1/messages') && init?.method === 'POST'
    );
    expect(createIdx).toBeGreaterThanOrEqual(0);
    expect(putIdx).toBeGreaterThan(createIdx);
    expect(patchIdx).toBeGreaterThan(putIdx);
    expect(msgIdx).toBeGreaterThan(patchIdx);

    expect(bodyOf(findCall('PUT', '/conversations/conv-1/documents'))).toEqual({
      document_ids: ['d-1'],
    });
    expect(bodyOf(findCall('PATCH', '/conversations/conv-1/scope'))).toEqual({
      zoom_in_mode: true,
    });

    // Evidence-first rendering (Part 5): answer + an Evidence card with
    // author/year/page/excerpt, never a fabricated page.
    expect(findByTextIncluding(renderer.root, 'Teachers reported increased autonomy')).toBeTruthy();
    expect(findByTextIncluding(renderer.root, 'Doe')).toBeTruthy();
    expect(findByTextIncluding(renderer.root, '2020')).toBeTruthy();
  });

  it('insufficient evidence is reported honestly, with no fabricated Evidence card (Part 13)', async () => {
    const renderer = await renderScreen([
      getProjectRoute(),
      referencesRoute([REFERENCE]),
      createConversationRoute(),
      putDocumentsRoute(),
      patchScopeRoute(),
      messagesRoute('conv-1', { insufficientEvidence: true }),
    ]);
    openAskPanel(renderer);
    await askQuestion(renderer, 'Is there support for cold fusion in these sources?');

    expect(findByTextIncluding(renderer.root, "couldn't find strong support")).toBeTruthy();
    // No "Evidence" section (heading or card) rendered at all — an
    // insufficient-evidence turn has zero cited sources, so the whole
    // block is absent, never a fabricated empty one.
    expect(queryByTextIncluding(renderer.root, 'Evidence')).toBeNull();
    expect(queryByTextIncluding(renderer.root, 'Teachers reported')).toBeNull();
  });

  it('the AI response never mutates the manuscript on its own (Part 14)', async () => {
    const renderer = await renderScreen([
      getProjectRoute(),
      referencesRoute([REFERENCE]),
      createConversationRoute(),
      putDocumentsRoute(),
      patchScopeRoute(),
      messagesRoute(),
    ]);
    const editorBefore = renderer.root.find((n) => n.type === LatexCodeEditor);
    const contentBefore = editorBefore.props.value;

    openAskPanel(renderer);
    await askQuestion(renderer, 'What evidence supports this claim?');
    // The evidence card actually rendered — proving this is a real
    // "answer landed, nothing was inserted" check, not a vacuous one.
    expect(findByTextIncluding(renderer.root, 'Teachers reported')).toBeTruthy();

    // Back to the Editor tab (mobile: Ask EduM8 occupies the same slot —
    // see [id].tsx's mobileTab union) to read the manuscript's real
    // current value; content itself lives in the parent screen's own
    // state and is unaffected by which tab is showing.
    act(() => {
      findPressableByLabel(renderer.root, 'Editor').props.onPress();
    });
    const editorAfter = renderer.root.find((n) => n.type === LatexCodeEditor);
    expect(editorAfter.props.value).toBe(contentBefore);
  });

  it('"Insert citation" resolves the real citation key and inserts it at the cursor (Part 8/19)', async () => {
    const renderer = await renderScreen([
      getProjectRoute(),
      referencesRoute([REFERENCE]),
      createConversationRoute(),
      putDocumentsRoute(),
      patchScopeRoute(),
      messagesRoute(),
      bibtexRoute(),
      // Insert citation leaves the buffer dirty — this test's own
      // afterEach unmount triggers a flush() save (Part 7: "no lost
      // content during navigation"), so a PATCH route is needed even
      // though this test itself never explicitly waits for autosave
      // (matches [id].test.tsx's identical "lists current references…"
      // test for the exact same reason).
      patchProjectRoute(),
    ]);
    const editorBefore = renderer.root.find((n) => n.type === LatexCodeEditor);
    const contentBefore = editorBefore.props.value;

    openAskPanel(renderer);
    await askQuestion(renderer, 'What evidence supports this claim?');

    await act(async () => {
      findPressableWithText(renderer.root, 'Insert citation').props.onPress();
      await flushAsync();
    });

    act(() => {
      findPressableByLabel(renderer.root, 'Editor').props.onPress();
    });
    const editorAfter = renderer.root.find((n) => n.type === LatexCodeEditor);
    expect(editorAfter.props.value).toContain('\\cite{Doe2020Laser}');
    expect(editorAfter.props.value).not.toBe(contentBefore);
  });

  it('Insert citation preserves an active manuscript selection instead of overwriting it (Part 5 regression)', async () => {
    const renderer = await renderScreen([
      getProjectRoute(),
      referencesRoute([REFERENCE]),
      createConversationRoute(),
      putDocumentsRoute(),
      patchScopeRoute(),
      messagesRoute(),
      bibtexRoute(),
      patchProjectRoute(),
    ]);
    const editor = renderer.root.find((n) => n.type === LatexCodeEditor);
    const contentBefore: string = editor.props.value;
    const selectedText = contentBefore.slice(0, 15);
    expect(selectedText.length).toBe(15);

    // A genuine (non-collapsed) manuscript selection, exactly like a
    // researcher highlighting a passage to ask EduM8 about it.
    act(() => {
      editor.props.onSelectionChange({ start: 0, end: 15 });
    });

    openAskPanel(renderer);
    await askQuestion(renderer, 'What evidence supports this claim?');

    // Coexistence (Part 5's literal wording): every evidence action still
    // renders and is clickable while the manuscript selection is active —
    // never hidden or disabled by it.
    expect(findPressableWithText(renderer.root, 'Open source')).toBeTruthy();
    expect(findPressableWithText(renderer.root, 'Add to notebook')).toBeTruthy();
    expect(findPressableWithText(renderer.root, 'Insert citation')).toBeTruthy();

    await act(async () => {
      findPressableWithText(renderer.root, 'Insert citation').props.onPress();
      await flushAsync();
    });

    act(() => {
      findPressableByLabel(renderer.root, 'Editor').props.onPress();
    });
    const editorAfter = renderer.root.find((n) => n.type === LatexCodeEditor);
    // Root cause: insertAtCursor used to slice out [selection.start,
    // selection.end) and replace it — silently deleting the very passage
    // selected as AI context. The selection must survive verbatim, and
    // the citation must land after it, never spliced into the middle.
    expect(editorAfter.props.value).toContain(selectedText);
    expect(editorAfter.props.value).toContain('\\cite{Doe2020Laser}');
    expect(editorAfter.props.value.indexOf('\\cite{Doe2020Laser}')).toBeGreaterThanOrEqual(
      editorAfter.props.value.indexOf(selectedText) + selectedText.length
    );
  });

  it('"Add reference" is offered (not "Insert citation") for evidence not yet a project reference, and never auto-adds it', async () => {
    const renderer = await renderScreen([
      getProjectRoute(),
      referencesRoute([]), // nothing referenced yet — but scope must be non-empty to ask,
      createConversationRoute(),
      putDocumentsRoute(),
      patchScopeRoute(),
      messagesRoute(),
      addReferenceRoute(),
      // ReferencePickerModal's own document-search, present from the
      // start (its "load on open" effect fires as soon as the picker's
      // `visible` flips true — installing this route later would race
      // it against the stale mock still active at that moment).
      {
        method: 'GET',
        matches: (u) => u.endsWith('/documents') || u.includes('/documents?'),
        respond: () =>
          jsonResponse({
            documents: [
              {
                document_id: 'd-1',
                title: 'A Study of Laser Cutting',
                authors: ['Jane Doe'],
                publication_year: 2020,
                source_filename: 'paper.pdf',
              },
            ],
            total: 1,
          }),
      },
    ]);
    openAskPanel(renderer);
    // Switch to Selected Sources — Project References is empty here.
    await act(async () => {
      findPressableWithText(renderer.root, 'Selected sources').props.onPress();
      await flushAsync();
    });
    act(() => {
      findPressableByLabel(renderer.root, 'Select Doe (2020)').props.onPress();
    });
    await act(async () => {
      findPressableWithText(renderer.root, 'Use this source').props.onPress();
      await flushAsync();
    });

    await askQuestion(renderer, 'What evidence supports this claim?');

    expect(findPressableWithText(renderer.root, 'Add reference')).toBeTruthy();
    expect(() => findPressableWithText(renderer.root, 'Insert citation')).toThrow();

    const addReferenceCallsBefore = (global.fetch as jest.Mock).mock.calls.filter(
      ([url, init]: [string, RequestInit]) =>
        String(url).endsWith('/writing-projects/w-1/references') && init?.method === 'POST'
    ).length;
    expect(addReferenceCallsBefore).toBe(0); // never auto-added

    await act(async () => {
      findPressableWithText(renderer.root, 'Add reference').props.onPress();
      await flushAsync();
    });
    const addReferenceCallsAfter = (global.fetch as jest.Mock).mock.calls.filter(
      ([url, init]: [string, RequestInit]) =>
        String(url).endsWith('/writing-projects/w-1/references') && init?.method === 'POST'
    ).length;
    expect(addReferenceCallsAfter).toBe(1);
  });

  it('"Add to notebook" creates a real highlight anchored to the retrieved chunk, then opens the existing notebook picker (Part 9/10)', async () => {
    const renderer = await renderScreen([
      getProjectRoute(),
      referencesRoute([REFERENCE]),
      createConversationRoute(),
      putDocumentsRoute(),
      patchScopeRoute(),
      messagesRoute(),
      createHighlightRoute(),
      notebooksListRoute(),
      highlightMembershipRoute(),
    ]);
    openAskPanel(renderer);
    await askQuestion(renderer, 'What evidence supports this claim?');

    await act(async () => {
      findPressableWithText(renderer.root, 'Add to notebook').props.onPress();
      await flushAsync();
    });

    // The highlight was created against the EXACT retrieved chunk — never
    // an LLM-reconstructed excerpt (Part 9: "insert ACTUAL retrieved
    // source text").
    const highlightCall = (global.fetch as jest.Mock).mock.calls.find(
      ([url, init]: [string, RequestInit]) =>
        String(url).endsWith('/documents/d-1/highlights') && init?.method === 'POST'
    );
    expect(highlightCall).toBeTruthy();
    expect(bodyOf(highlightCall)).toMatchObject({
      chunk_id: 'c-1',
      chunk_index: 0,
      page_number: 4,
      selected_text: 'Teachers reported increased autonomy after the 12-week program.',
    });

    // The EXISTING Research Notes picker opened — reused, not rebuilt
    // (Part 10).
    expect(findByTextIncluding(renderer.root, 'Chapter 2 sources')).toBeTruthy();
  });

  it('"Open source" navigates to the Reader with the correct document/page/chunk (Part 6)', async () => {
    const renderer = await renderScreen([
      getProjectRoute(),
      referencesRoute([REFERENCE]),
      createConversationRoute(),
      putDocumentsRoute(),
      patchScopeRoute(),
      messagesRoute(),
    ]);
    openAskPanel(renderer);
    await askQuestion(renderer, 'What evidence supports this claim?');

    act(() => {
      findPressableWithText(renderer.root, 'Open source').props.onPress();
    });

    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/documents/[id]',
      params: { id: 'd-1', page: '4', chunkId: 'c-1' },
    });
  });

  it('a selected manuscript passage is sent as structured writing_context, not a query-text prefix (Milestone 6.2 Part 2)', async () => {
    // Replaces the old M5.2 assertion (a client-side "Regarding this
    // passage from my manuscript" text prefix) now that manuscript
    // context is sent structured to the M6.1 Writing Context Engine
    // instead — see lib/useWritingAsk.ts's own module docstring.
    const renderer = await renderScreen([
      getProjectRoute(),
      referencesRoute([REFERENCE]),
      createConversationRoute(),
      putDocumentsRoute(),
      patchScopeRoute(),
      messagesRoute(),
    ]);

    const editor = renderer.root.find((n) => n.type === LatexCodeEditor);
    act(() => {
      editor.props.onSelectionChange({ start: 0, end: 15 });
    });

    openAskPanel(renderer);
    expect(findByTextIncluding(renderer.root, 'Include selected manuscript passage')).toBeTruthy();

    await askQuestion(renderer, 'Does my draft claim hold up?');

    const messageBody = bodyOf(findCall('POST', '/conversations/conv-1/messages'));
    expect(String(messageBody.query)).toBe('Does my draft claim hold up?');
    expect(String(messageBody.query)).not.toContain('Regarding this passage from my manuscript');
    const writingContext = messageBody.writing_context as Record<string, unknown>;
    expect(writingContext).toBeTruthy();
    expect(writingContext.project_id).toBe(PROJECT.id);
    expect(typeof writingContext.selected_text).toBe('string');
    expect((writingContext.selected_text as string).length).toBeGreaterThan(0);
    expect(writingContext.selection_start).toBe(0);
    expect(writingContext.selection_end).toBe(15);
  });

  it('the selection-aware quick-action bar is hidden when nothing is selected (Milestone 6.2 Part 10)', async () => {
    const renderer = await renderScreen([
      getProjectRoute(),
      referencesRoute([REFERENCE]),
      createConversationRoute(),
      putDocumentsRoute(),
      patchScopeRoute(),
      messagesRoute(),
    ]);

    const toolbar = renderer.root.findAll((n) => n.props.testID === 'selection-quick-actions');
    expect(toolbar).toHaveLength(0);
  });

  it('Grammar quick action sends its controlled prompt with the current selection, landing in the same turn history (Milestone 6.2 Part 10)', async () => {
    const renderer = await renderScreen([
      getProjectRoute(),
      referencesRoute([REFERENCE]),
      createConversationRoute(),
      putDocumentsRoute(),
      patchScopeRoute(),
      messagesRoute(),
    ]);

    const editor = renderer.root.find((n) => n.type === LatexCodeEditor);
    act(() => {
      editor.props.onSelectionChange({ start: 0, end: 15 });
    });

    // Real (non-collapsed) selection now present — the bar appears (a
    // single `.find()` throws unless exactly one match exists, so this
    // doubles as the uniqueness check `renderer.root.findAll(...).length`
    // alone can't safely make — see findPressableWithText's own note on
    // findAll's default `deep: true` also matching react-native-web's
    // composite View wrapper AND its underlying host node separately).
    expect(() =>
      renderer.root.find((n) => n.props.testID === 'selection-quick-actions')
    ).not.toThrow();

    // ...and pressing Grammar sends a controlled, non-editable prompt —
    // never a free-text field the researcher has to fill in themselves,
    // and never an automatic manuscript edit (Part 10/34: a rewrite is
    // something to read and copy, not something applied for them).
    await act(async () => {
      findPressableByLabel(
        renderer.root,
        'Grammar — ask EduM8 about the selection'
      ).props.onPress();
      await flushAsync();
    });

    const messageBody = bodyOf(findCall('POST', '/conversations/conv-1/messages'));
    expect(String(messageBody.query)).toContain('Check the grammar and spelling');
    const writingContext = messageBody.writing_context as Record<string, unknown>;
    expect(writingContext.selection_start).toBe(0);
    expect(writingContext.selection_end).toBe(15);

    // The quick action's own answer shows up in the SAME Ask EduM8 turn
    // history a manually-typed question would — not a second, separate
    // AI surface (Part 10's own "reuse, never duplicate" requirement).
    expect(findByTextIncluding(renderer.root, 'Teachers reported increased autonomy')).toBeTruthy();
  });

  it('a quick action still works on a project with zero references (Milestone 6.2 real-model validation regression)', async () => {
    // Real bug found via real-model/real-browser validation: the quick-
    // action bar was wired to ask.canAsk (whether the Ask EduM8 PANEL's
    // current RAG scope is non-empty), which disabled every quick
    // action — including Grammar — on any brand-new project with no
    // references yet, even though a local_edit request like Grammar
    // never uses RAG at all (M6.1's own POLICY_LAYERS guarantees this
    // regardless of scope). Fixed in [id].tsx by no longer gating the
    // quick-action bar on canAsk.
    const renderer = await renderScreen([
      getProjectRoute(),
      referencesRoute([]),
      createConversationRoute(),
      putDocumentsRoute(),
      patchScopeRoute(),
      messagesRoute(),
    ]);

    const editor = renderer.root.find((n) => n.type === LatexCodeEditor);
    act(() => {
      editor.props.onSelectionChange({ start: 0, end: 15 });
    });

    const grammarButton = findPressableByLabel(
      renderer.root,
      'Grammar — ask EduM8 about the selection'
    );
    expect(grammarButton.props.disabled).toBeFalsy();

    await act(async () => {
      grammarButton.props.onPress();
      await flushAsync();
    });

    const messageBody = bodyOf(findCall('POST', '/conversations/conv-1/messages'));
    expect(String(messageBody.query)).toContain('Check the grammar and spelling');
  });

  it('the bare "Ask EduM8" quick action only opens the panel — it never sends a request by itself (Milestone 6.2 Part 34)', async () => {
    const renderer = await renderScreen([
      getProjectRoute(),
      referencesRoute([REFERENCE]),
      createConversationRoute(),
      putDocumentsRoute(),
      patchScopeRoute(),
      messagesRoute(),
    ]);

    const editor = renderer.root.find((n) => n.type === LatexCodeEditor);
    act(() => {
      editor.props.onSelectionChange({ start: 0, end: 15 });
    });

    const toolbar = renderer.root.find((n) => n.props.testID === 'selection-quick-actions');
    act(() => {
      toolbar
        .find(
          (n) => typeof n.props.onPress === 'function' && n.props.accessibilityLabel === 'Ask EduM8'
        )
        .props.onPress();
    });
    await act(async () => {
      await flushAsync();
    });

    expect(findCall('POST', '/conversations/conv-1/messages')).toBeUndefined();
    expect(findByTextIncluding(renderer.root, 'Research context')).toBeTruthy();
  });

  it('renders the compact, honest context indicator from writing_context_summary (Milestone 6.2 Parts 11/12)', async () => {
    const renderer = await renderScreen([
      getProjectRoute(),
      referencesRoute([REFERENCE]),
      createConversationRoute(),
      putDocumentsRoute(),
      patchScopeRoute(),
      messagesRoute('conv-1', {
        writingContextSummary: {
          policy: 'reference_question',
          selection_included: false,
          section_included: true,
          notes_included: 2,
          highlights_included: 0,
          reference_metadata_included: 1,
        },
      }),
    ]);

    openAskPanel(renderer);
    await askQuestion(renderer, 'What does the literature say about this?');

    // Real evidence (from the `sources` SSE event, via CHUNK/CITATION) AND
    // reference metadata both surface — worded distinctly, per Part 12's
    // "never say Evidence from a paper for metadata alone" rule: the
    // metadata label here is its own separate "Reference metadata" phrase,
    // never merged into the "Evidence from N sources" phrase.
    expect(findByTextIncluding(renderer.root, 'Current section')).toBeTruthy();
    expect(findByTextIncluding(renderer.root, '2 research notes')).toBeTruthy();
    expect(findByTextIncluding(renderer.root, 'Reference metadata')).toBeTruthy();
    expect(findByTextIncluding(renderer.root, 'Evidence from 1 source')).toBeTruthy();
  });

  it('omits selection/section/metadata from the indicator when writing_context_summary is absent, but still honestly reports real evidence', async () => {
    const renderer = await renderScreen([
      getProjectRoute(),
      referencesRoute([REFERENCE]),
      createConversationRoute(),
      putDocumentsRoute(),
      patchScopeRoute(),
      // No writing_context_summary at all (e.g. a reconnect/replay that
      // couldn't reconstruct it — see _final_reply_events' own
      // docstring) — the turn's real evidence (from the `sources` SSE
      // event, tracked independently) must still show honestly.
      messagesRoute('conv-1', { writingContextSummary: null }),
    ]);

    openAskPanel(renderer);
    await askQuestion(renderer, 'What does the literature say about this?');

    expect(queryByTextIncluding(renderer.root, 'Current selection')).toBeNull();
    expect(queryByTextIncluding(renderer.root, 'Current section')).toBeNull();
    expect(queryByTextIncluding(renderer.root, 'Reference metadata')).toBeNull();
    expect(findByTextIncluding(renderer.root, 'Evidence from 1 source')).toBeTruthy();
  });

  // --- Milestone 5.5 Part 2/3/4: streaming ---------------------------

  /** Unlike messagesRoute() above (whose stream closes synchronously, so
   * flushAsync() always lands past 'done'), this leaves the stream open
   * so a test can assert genuinely mid-flight UI state (Stop control,
   * partial answer text, no evidence yet) before choosing when to send
   * the rest of the events. */
  function controllableMessagesRoute(conversationId = 'conv-1'): {
    route: FetchRoute;
    push: (event: unknown) => void;
    close: () => void;
  } {
    const encoder = new TextEncoder();
    let controllerRef!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controllerRef = controller;
      },
    });
    return {
      route: {
        method: 'POST',
        matches: (u) => u.endsWith(`/conversations/${conversationId}/messages`),
        respond: (init) => {
          // A real browser aborts the in-flight body read when its fetch's
          // AbortSignal fires — this synthetic stream has no such wiring
          // on its own (it isn't a real network response), so this
          // reproduces that one platform behavior explicitly, the same
          // way it would really happen in production. A plain Error (not
          // DOMException) deliberately: real browsers'/Node's AbortError
          // DOMException extends Error (confirmed against both), but the
          // jest-expo test environment's own DOMException polyfill does
          // not — an Error with name 'AbortError' is what stream.ts's
          // isAbortError() actually checks for (`instanceof Error &&
          // name === 'AbortError'`) and is the realistic shape in every
          // runtime this app actually ships to.
          init?.signal?.addEventListener('abort', () => {
            try {
              controllerRef.error(
                Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })
              );
            } catch {
              // already closed/errored — fine, nothing left to cancel
            }
          });
          return new Response(stream, {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
          });
        },
      },
      push: (event) => controllerRef.enqueue(encoder.encode(sseEvent(event))),
      close: () => controllerRef.close(),
    };
  }

  function cancelMessageRoute(conversationId = 'conv-1'): FetchRoute {
    return {
      method: 'POST',
      matches: (u) =>
        u.includes(`/conversations/${conversationId}/messages/`) && u.endsWith('/cancel'),
      respond: () => new Response(null, { status: 204 }),
    };
  }

  it('streams the answer progressively, showing Stop while live and no evidence until sources arrive (Part 2/3/4)', async () => {
    const stream = controllableMessagesRoute();
    const renderer = await renderScreen([
      getProjectRoute(),
      referencesRoute([REFERENCE]),
      createConversationRoute(),
      putDocumentsRoute(),
      patchScopeRoute(),
      stream.route,
    ]);
    openAskPanel(renderer);

    const input = renderer.root.find(
      (n) => String(n.type) === 'TextInput' && n.props.accessibilityLabel === 'Ask a question'
    );
    act(() => {
      input.props.onChangeText('What evidence supports this claim?');
    });
    act(() => {
      findPressableByLabel(renderer.root, 'Ask').props.onPress();
    });
    await act(async () => {
      await flushAsync();
    });

    // Request in flight, nothing back yet: Stop is already available
    // (Part 2: cancellation), no answer/evidence text rendered.
    expect(findPressableWithText(renderer.root, 'Stop')).toBeTruthy();
    expect(queryByTextIncluding(renderer.root, 'Evidence')).toBeNull();

    await act(async () => {
      stream.push({ type: 'token', content: 'Teachers reported increased autonomy [S1].' });
      await flushAsync();
    });

    // Partial answer text is visible (Part 2: "partial answer rendering")
    // while Stop remains available and evidence is still absent — sources
    // haven't arrived yet, so nothing evidence-shaped may render (Part 3).
    expect(findByTextIncluding(renderer.root, 'Teachers reported increased autonomy')).toBeTruthy();
    expect(findPressableWithText(renderer.root, 'Stop')).toBeTruthy();
    expect(queryByTextIncluding(renderer.root, 'Evidence')).toBeNull();

    await act(async () => {
      stream.push({ type: 'sources', sources: [CHUNK] });
      stream.push({
        type: 'done',
        citations: [CITATION],
        citation_warnings: [],
        insufficient_evidence: false,
      });
      stream.close();
      await flushAsync();
    });

    // Finalized: Stop is gone, evidence now renders from the authoritative
    // sources/citations that just arrived (Part 3), and a latency caption
    // records real client timings (Part 4) — never a fabricated percentage.
    expect(queryByTextIncluding(renderer.root, 'Stop')).toBeNull();
    expect(findByTextIncluding(renderer.root, 'Evidence')).toBeTruthy();
    expect(findByTextIncluding(renderer.root, 'Answered in')).toBeTruthy();
  });

  it('Stop cancels the in-flight stream locally, without a doomed server-side /cancel call (Part 2, Milestone 6.2 real-model validation)', async () => {
    const stream = controllableMessagesRoute();
    const renderer = await renderScreen([
      getProjectRoute(),
      referencesRoute([REFERENCE]),
      createConversationRoute(),
      putDocumentsRoute(),
      patchScopeRoute(),
      stream.route,
      cancelMessageRoute(),
    ]);
    openAskPanel(renderer);

    const input = renderer.root.find(
      (n) => String(n.type) === 'TextInput' && n.props.accessibilityLabel === 'Ask a question'
    );
    act(() => {
      input.props.onChangeText('What evidence supports this claim?');
    });
    act(() => {
      findPressableByLabel(renderer.root, 'Ask').props.onPress();
    });
    await act(async () => {
      await flushAsync();
    });

    await act(async () => {
      stream.push({ type: 'token', content: 'Teachers reported' });
      await flushAsync();
    });

    await act(async () => {
      findPressableWithText(renderer.root, 'Stop').props.onPress();
      await flushAsync();
    });

    // The turn reads as explicitly stopped, not as a fabricated failure —
    // WritingAskTurnStatus keeps 'cancelled' distinct from 'error' for
    // exactly this. The Stop *button* itself disappears (no longer live)
    // — checked as a Pressable, not a text substring, since "Stopped."
    // itself starts with "Stop".
    expect(findByTextIncluding(renderer.root, 'Stopped.')).toBeTruthy();
    expect(() => findPressableWithText(renderer.root, 'Stop')).toThrow();

    // Milestone 6.2 real-model validation — a real bug found and fixed:
    // this used to assert a server-side /cancel call was made, on the
    // (wrong) belief that the turn id doubled as the real backend
    // message id. It never does (client_message_id is a purely
    // client-side idempotency key, unrelated to the assistant Message
    // row's own server-assigned UUID — confirmed against real backend
    // logs, which showed every such call 422ing and the backend worker
    // quietly finishing the generation nobody could see anymore). Stop
    // is now a LOCAL abort only — exactly matching Chat's own
    // cancelSend() for a live, still-connected turn (see
    // useConversationMessages.ts) — so no /cancel request is made at all.
    const cancelCall = (global.fetch as jest.Mock).mock.calls.find(
      ([url, init]: [string, RequestInit]) =>
        String(url).includes('/conversations/conv-1/messages/') &&
        String(url).endsWith('/cancel') &&
        init?.method === 'POST'
    );
    expect(cancelCall).toBeUndefined();

    // The composer is usable again immediately — cancelling never leaves
    // the panel stuck in a permanent "Asking…"/busy state.
    expect(findPressableByLabel(renderer.root, 'Ask').props.accessibilityState.busy).toBe(false);

    // The abort above already errored the stream (see
    // controllableMessagesRoute) — nothing left to close.
  });
});
