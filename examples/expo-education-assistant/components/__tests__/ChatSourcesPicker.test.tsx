import type { ConversationProjectRef } from 'education-assistant-client';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { AuthProvider } from '@/lib/AuthProvider';
import { ClientProvider } from '@/lib/ClientProvider';
import {
  ChatSourcesPicker,
  describeProjectNames,
  prioritizeModeCopy,
  type PendingSourceDoc,
  type SourceMode,
} from '../ChatSourcesPicker';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn() }),
  usePathname: () => '/chat',
  useGlobalSearchParams: () => ({}),
  useLocalSearchParams: () => ({}),
}));

function textContent(node: ReactTestInstance): string {
  return node.children.filter((child): child is string => typeof child === 'string').join('');
}

function matchesText(node: ReactTestInstance, text: string | RegExp): boolean {
  if (String(node.type) !== 'Text') return false;
  const content = textContent(node);
  return typeof text === 'string' ? content === text : text.test(content);
}

function findByText(root: ReactTestInstance, text: string | RegExp): ReactTestInstance {
  const matches = root.findAll((node) => matchesText(node, text));
  if (matches.length === 0)
    throw new Error(`No Text node found with content ${JSON.stringify(String(text))}`);
  return matches[0]!;
}

function queryByText(root: ReactTestInstance, text: string | RegExp): ReactTestInstance | null {
  const matches = root.findAll((node) => matchesText(node, text));
  return matches[0] ?? null;
}

function findPressableByText(root: ReactTestInstance, text: string): ReactTestInstance {
  const matches = root.findAll(
    (node) => typeof node.props.onPress === 'function' && queryByText(node, text) !== null
  );
  if (matches.length === 0)
    throw new Error(`No pressable found containing text ${JSON.stringify(text)}`);
  return matches[0]!;
}

function findPressableByAccessibilityLabel(
  root: ReactTestInstance,
  label: string
): ReactTestInstance {
  return root.find(
    (node) => typeof node.props.onPress === 'function' && node.props.accessibilityLabel === label
  );
}

async function flushAsync(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

interface FetchRoute {
  method: string;
  matches: (url: string) => boolean;
  respond: (url: string, init?: RequestInit) => Response;
}

function installFetchMock(routes: FetchRoute[]) {
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = (init?.method ?? 'GET').toUpperCase();
    const route = routes.find((r) => r.method === method && r.matches(url));
    if (!route) throw new Error(`Unhandled ${method} ${url} in this test`);
    return route.respond(url, init);
  }) as unknown as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

const ROOT_FOLDER = {
  id: 'f1',
  name: 'Research',
  parent_id: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  folder_count: 0,
  document_count: 1,
};

const DOC_A = {
  document_id: 'doc-a',
  source_filename: 'a.pdf',
  title: 'AI Education',
  folder_id: null,
  document_type: 'report',
  chunk_count: 3,
  ingested_at: '2026-01-01T00:00:00Z',
};

const DOC_B = {
  document_id: 'doc-b',
  source_filename: 'b.pdf',
  title: null,
  folder_id: 'f1',
  document_type: 'report',
  chunk_count: 3,
  ingested_at: '2026-01-01T00:00:00Z',
};

async function renderPicker(props: {
  target: { kind: 'conversation'; conversationId: string } | { kind: 'pending' };
  initialSelection: PendingSourceDoc[];
  initialMode?: SourceMode;
  zoomInEnabled?: boolean;
  projectContext?: ConversationProjectRef[] | null;
  scope?: { chatEnabled?: boolean; projectEnabled?: boolean; generalEnabled?: boolean };
  onClose?: () => void;
  onSaved?: (selection: PendingSourceDoc[], mode: SourceMode) => void;
  routes: FetchRoute[];
}): Promise<ReactTestRenderer> {
  installFetchMock(props.routes);
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <AuthProvider>
        <ClientProvider>
          <ChatSourcesPicker
            target={props.target}
            initialSelection={props.initialSelection}
            initialMode={props.initialMode}
            zoomInEnabled={props.zoomInEnabled}
            projectContext={props.projectContext}
            scope={props.scope}
            onClose={props.onClose ?? jest.fn()}
            onSaved={props.onSaved ?? jest.fn()}
          />
        </ClientProvider>
      </AuthProvider>
    );
    await flushAsync();
  });
  return renderer;
}

/** Milestone 4: PATCH .../scope route — Save (existing-conversation target)
 * always issues this immediately after the documents PUT, regardless of
 * mode, so every "existing conversation" Save test needs it registered. */
const scopeRoute = (conversationId = 'c1'): FetchRoute => ({
  method: 'PATCH',
  matches: (u) => u.includes(`/conversations/${conversationId}/scope`),
  respond: () =>
    jsonResponse({
      chat_enabled: true,
      project_enabled: true,
      general_enabled: true,
      include_other_project_summaries: false,
      zoom_in_mode: false,
    }),
});

const rootContentsRoute = (folders = [ROOT_FOLDER], documents: unknown[] = []): FetchRoute => ({
  method: 'GET',
  matches: (u) => u.includes('/folders/contents') && !u.includes('folder_id'),
  respond: () =>
    jsonResponse({
      folder: null,
      breadcrumbs: [],
      folders,
      documents,
      documents_total: documents.length,
    }),
});

const folderContentsRoute = (folderId: string, documents: unknown[]): FetchRoute => ({
  method: 'GET',
  matches: (u) => u.includes('/folders/contents') && u.includes(`folder_id=${folderId}`),
  respond: () =>
    jsonResponse({
      folder: ROOT_FOLDER,
      breadcrumbs: [{ id: folderId, name: 'Research' }],
      folders: [],
      documents,
      documents_total: documents.length,
    }),
});

describe('ChatSourcesPicker — browsing', () => {
  it('opens and displays root folders and documents', async () => {
    const renderer = await renderPicker({
      target: { kind: 'pending' },
      initialSelection: [],
      routes: [rootContentsRoute([ROOT_FOLDER], [DOC_A])],
    });

    expect(findByText(renderer.root, 'Sources')).toBeTruthy();
    expect(findByText(renderer.root, 'Research')).toBeTruthy();
    expect(findByText(renderer.root, 'AI Education')).toBeTruthy();
  });

  it('navigates into a folder and shows its breadcrumb', async () => {
    const renderer = await renderPicker({
      target: { kind: 'pending' },
      initialSelection: [],
      routes: [rootContentsRoute([ROOT_FOLDER], []), folderContentsRoute('f1', [DOC_B])],
    });

    await act(async () => {
      findPressableByText(renderer.root, 'Research').props.onPress();
      await flushAsync();
    });

    expect(findByText(renderer.root, 'b.pdf')).toBeTruthy(); // no title -> falls back to filename
    expect(findByText(renderer.root, 'My Library')).toBeTruthy(); // breadcrumb root crumb
  });

  it('breadcrumb navigation returns to root', async () => {
    const renderer = await renderPicker({
      target: { kind: 'pending' },
      initialSelection: [],
      routes: [rootContentsRoute([ROOT_FOLDER], []), folderContentsRoute('f1', [DOC_B])],
    });

    await act(async () => {
      findPressableByText(renderer.root, 'Research').props.onPress();
      await flushAsync();
    });
    await act(async () => {
      findPressableByText(renderer.root, 'My Library').props.onPress();
      await flushAsync();
    });

    expect(queryByText(renderer.root, 'b.pdf')).toBeNull();
  });
});

describe('ChatSourcesPicker — selection', () => {
  it('selecting a document adds it to the Selected list', async () => {
    const renderer = await renderPicker({
      target: { kind: 'pending' },
      initialSelection: [],
      routes: [rootContentsRoute([], [DOC_A])],
    });

    expect(findByText(renderer.root, 'Selected sources (0)')).toBeTruthy();

    await act(async () => {
      findPressableByAccessibilityLabel(renderer.root, 'Add AI Education').props.onPress();
    });

    expect(findByText(renderer.root, 'Selected sources (1)')).toBeTruthy();
  });

  it('unselecting a document via its checkbox removes it', async () => {
    const renderer = await renderPicker({
      target: { kind: 'pending' },
      initialSelection: [{ documentId: 'doc-a', displayName: 'AI Education' }],
      routes: [rootContentsRoute([], [DOC_A])],
    });

    expect(findByText(renderer.root, 'Selected sources (1)')).toBeTruthy();

    await act(async () => {
      findPressableByAccessibilityLabel(renderer.root, 'Remove AI Education').props.onPress();
    });

    expect(findByText(renderer.root, 'Selected sources (0)')).toBeTruthy();
  });

  it('removing a document from the Selected summary also unchecks it', async () => {
    const renderer = await renderPicker({
      target: { kind: 'pending' },
      initialSelection: [{ documentId: 'doc-a', displayName: 'AI Education' }],
      routes: [rootContentsRoute([], [DOC_A])],
    });

    await act(async () => {
      findPressableByAccessibilityLabel(
        renderer.root,
        'Remove AI Education from selection'
      ).props.onPress();
    });

    expect(findByText(renderer.root, 'Selected sources (0)')).toBeTruthy();
    expect(findPressableByAccessibilityLabel(renderer.root, 'Add AI Education')).toBeTruthy(); // now unchecked in the browse list too
  });

  it('selection survives folder navigation', async () => {
    const renderer = await renderPicker({
      target: { kind: 'pending' },
      initialSelection: [],
      routes: [rootContentsRoute([ROOT_FOLDER], [DOC_A]), folderContentsRoute('f1', [DOC_B])],
    });

    await act(async () => {
      findPressableByAccessibilityLabel(renderer.root, 'Add AI Education').props.onPress();
    });
    expect(findByText(renderer.root, 'Selected sources (1)')).toBeTruthy();

    await act(async () => {
      findPressableByText(renderer.root, 'Research').props.onPress();
      await flushAsync();
    });

    // Still selected after navigating away from the folder it lives in.
    expect(findByText(renderer.root, 'Selected sources (1)')).toBeTruthy();
    expect(findByText(renderer.root, 'AI Education')).toBeTruthy(); // in the Selected summary
  });
});

describe('ChatSourcesPicker — save/cancel (existing conversation)', () => {
  it('Cancel does not call the network and just closes', async () => {
    const onClose = jest.fn();
    const onSaved = jest.fn();
    const renderer = await renderPicker({
      target: { kind: 'conversation', conversationId: 'c1' },
      initialSelection: [],
      onClose,
      onSaved,
      routes: [rootContentsRoute([], [DOC_A])],
    });

    await act(async () => {
      findPressableByAccessibilityLabel(renderer.root, 'Add AI Education').props.onPress();
    });
    await act(async () => {
      findPressableByText(renderer.root, 'Cancel').props.onPress();
    });

    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Save issues exactly one PUT with the full selection and reports the server result', async () => {
    let putCalls = 0;
    const onSaved = jest.fn();
    const onClose = jest.fn();
    const renderer = await renderPicker({
      target: { kind: 'conversation', conversationId: 'c1' },
      initialSelection: [],
      onClose,
      onSaved,
      routes: [
        rootContentsRoute([], [DOC_A]),
        {
          method: 'PUT',
          matches: (u) => u.includes('/conversations/c1/documents'),
          respond: (_u, init) => {
            putCalls += 1;
            expect(JSON.parse(String(init?.body))).toEqual({ document_ids: ['doc-a'] });
            return jsonResponse({
              documents: [
                {
                  document_id: 'doc-a',
                  source_filename: 'a.pdf',
                  document_type: 'report',
                  added_at: '2026-01-01T00:00:00Z',
                },
              ],
              total: 1,
            });
          },
        },
        scopeRoute(),
      ],
    });

    await act(async () => {
      findPressableByAccessibilityLabel(renderer.root, 'Add AI Education').props.onPress();
    });
    await act(async () => {
      findPressableByText(renderer.root, 'Save').props.onPress();
      await flushAsync();
    });

    expect(putCalls).toBe(1);
    expect(onSaved).toHaveBeenCalledWith(
      [{ documentId: 'doc-a', displayName: 'a.pdf' }],
      'prioritize'
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Save with zero selected documents clears the scope (empty document_ids)', async () => {
    let putBody: unknown;
    const renderer = await renderPicker({
      target: { kind: 'conversation', conversationId: 'c1' },
      initialSelection: [{ documentId: 'doc-a', displayName: 'AI Education' }],
      routes: [
        rootContentsRoute([], [DOC_A]),
        {
          method: 'PUT',
          matches: (u) => u.includes('/conversations/c1/documents'),
          respond: (_u, init) => {
            putBody = JSON.parse(String(init?.body));
            return jsonResponse({ documents: [], total: 0 });
          },
        },
        scopeRoute(),
      ],
    });

    await act(async () => {
      findPressableByAccessibilityLabel(renderer.root, 'Remove AI Education').props.onPress();
    });
    await act(async () => {
      findPressableByText(renderer.root, 'Save').props.onPress();
      await flushAsync();
    });

    expect(putBody).toEqual({ document_ids: [] });
  });

  it('a server error on Save keeps the picker open with the error shown, never calling onSaved/onClose', async () => {
    const onSaved = jest.fn();
    const onClose = jest.fn();
    const renderer = await renderPicker({
      target: { kind: 'conversation', conversationId: 'c1' },
      initialSelection: [{ documentId: 'doc-a', displayName: 'AI Education' }],
      onSaved,
      onClose,
      routes: [
        rootContentsRoute([], [DOC_A]),
        {
          method: 'PUT',
          matches: (u) => u.includes('/conversations/c1/documents'),
          respond: () => jsonResponse({ detail: 'boom' }, 500),
        },
      ],
    });

    await act(async () => {
      findPressableByText(renderer.root, 'Save').props.onPress();
      await flushAsync();
    });

    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    // The picker is still open and the selection is intact — Save can be retried.
    expect(findByText(renderer.root, 'Selected sources (1)')).toBeTruthy();
  });
});

describe('ChatSourcesPicker — pending (new conversation) mode', () => {
  it('Save never touches the network and reports the local selection directly', async () => {
    const onSaved = jest.fn();
    const onClose = jest.fn();
    const renderer = await renderPicker({
      target: { kind: 'pending' },
      initialSelection: [],
      onSaved,
      onClose,
      routes: [rootContentsRoute([], [DOC_A])],
    });

    await act(async () => {
      findPressableByAccessibilityLabel(renderer.root, 'Add AI Education').props.onPress();
    });
    await act(async () => {
      findPressableByText(renderer.root, 'Save').props.onPress();
      await flushAsync();
    });

    expect(onSaved).toHaveBeenCalledWith(
      [{ documentId: 'doc-a', displayName: 'AI Education' }],
      'prioritize'
    );
    expect(onClose).toHaveBeenCalledTimes(1);
    // Save in 'pending' mode never calls the bulk-replace endpoint — no
    // conversation exists yet for it to target (see ChatSourcesPicker's
    // 'pending' target docs). Any other incidental request (e.g.
    // AuthProvider's own background token refresh) is unrelated to this.
    const calls = (global.fetch as jest.Mock).mock.calls as [string, RequestInit?][];
    const documentsCalls = calls.filter(([url]) => url.includes('/documents'));
    expect(documentsCalls.every(([, init]) => (init?.method ?? 'GET') === 'GET')).toBe(true);
  });

  it('preselects from initialSelection without any network call for it', async () => {
    const renderer = await renderPicker({
      target: { kind: 'pending' },
      initialSelection: [{ documentId: 'doc-z', displayName: 'Previously picked.pdf' }],
      routes: [rootContentsRoute([], [])],
    });

    expect(findByText(renderer.root, 'Selected sources (1)')).toBeTruthy();
    expect(findByText(renderer.root, 'Previously picked.pdf')).toBeTruthy();
  });
});

// Milestone 4: Zoom-In / strict selected-source mode.
describe('ChatSourcesPicker — Zoom-In mode', () => {
  it('Save is disabled and a validation message shows when Zoom-In has zero selected sources', async () => {
    const renderer = await renderPicker({
      target: { kind: 'pending' },
      initialSelection: [],
      routes: [rootContentsRoute([], [DOC_A])],
    });

    await act(async () => {
      findPressableByText(renderer.root, 'Zoom-In').props.onPress();
    });

    expect(
      findByText(renderer.root, 'Zoom-In requires at least one selected source.')
    ).toBeTruthy();
    const saveButton = findPressableByText(renderer.root, 'Save');
    expect(saveButton.props.disabled).toBe(true);
  });

  it('selecting a source while in Zoom-In re-enables Save', async () => {
    const renderer = await renderPicker({
      target: { kind: 'pending' },
      initialSelection: [],
      routes: [rootContentsRoute([], [DOC_A])],
    });

    await act(async () => {
      findPressableByText(renderer.root, 'Zoom-In').props.onPress();
    });
    await act(async () => {
      findPressableByAccessibilityLabel(renderer.root, 'Add AI Education').props.onPress();
    });

    const saveButton = findPressableByText(renderer.root, 'Save');
    expect(saveButton.props.disabled).toBeFalsy();
  });

  it('pending target: Save reports the chosen mode with zero network calls', async () => {
    const onSaved = jest.fn();
    const renderer = await renderPicker({
      target: { kind: 'pending' },
      initialSelection: [],
      onSaved,
      routes: [rootContentsRoute([], [DOC_A])],
    });

    await act(async () => {
      findPressableByAccessibilityLabel(renderer.root, 'Add AI Education').props.onPress();
    });
    await act(async () => {
      findPressableByText(renderer.root, 'Zoom-In').props.onPress();
    });
    await act(async () => {
      findPressableByText(renderer.root, 'Save').props.onPress();
      await flushAsync();
    });

    expect(onSaved).toHaveBeenCalledWith(
      [{ documentId: 'doc-a', displayName: 'AI Education' }],
      'zoom-in'
    );
  });

  it('conversation target: Save issues the documents PUT then the scope PATCH, in that order, with zoom_in_mode true', async () => {
    const calls: string[] = [];
    const onSaved = jest.fn();
    const renderer = await renderPicker({
      target: { kind: 'conversation', conversationId: 'c1' },
      initialSelection: [],
      onSaved,
      routes: [
        rootContentsRoute([], [DOC_A]),
        {
          method: 'PUT',
          matches: (u) => u.includes('/conversations/c1/documents'),
          respond: () => {
            calls.push('PUT documents');
            return jsonResponse({
              documents: [
                {
                  document_id: 'doc-a',
                  source_filename: 'a.pdf',
                  document_type: 'report',
                  added_at: '2026-01-01T00:00:00Z',
                },
              ],
              total: 1,
            });
          },
        },
        {
          method: 'PATCH',
          matches: (u) => u.includes('/conversations/c1/scope'),
          respond: (_u, init) => {
            calls.push('PATCH scope');
            expect(JSON.parse(String(init?.body))).toEqual({ zoom_in_mode: true });
            return jsonResponse({
              chat_enabled: true,
              project_enabled: true,
              general_enabled: true,
              include_other_project_summaries: false,
              zoom_in_mode: true,
            });
          },
        },
      ],
    });

    await act(async () => {
      findPressableByAccessibilityLabel(renderer.root, 'Add AI Education').props.onPress();
    });
    await act(async () => {
      findPressableByText(renderer.root, 'Zoom-In').props.onPress();
    });
    await act(async () => {
      findPressableByText(renderer.root, 'Save').props.onPress();
      await flushAsync();
    });

    expect(calls).toEqual(['PUT documents', 'PATCH scope']);
    expect(onSaved).toHaveBeenCalledWith(
      [{ documentId: 'doc-a', displayName: 'a.pdf' }],
      'zoom-in'
    );
  });

  it('a scope PATCH failure after a successful documents PUT keeps the picker open with the error shown, never calling onSaved/onClose', async () => {
    const onSaved = jest.fn();
    const onClose = jest.fn();
    const renderer = await renderPicker({
      target: { kind: 'conversation', conversationId: 'c1' },
      initialSelection: [],
      onSaved,
      onClose,
      routes: [
        rootContentsRoute([], [DOC_A]),
        {
          method: 'PUT',
          matches: (u) => u.includes('/conversations/c1/documents'),
          respond: () =>
            jsonResponse({
              documents: [
                {
                  document_id: 'doc-a',
                  source_filename: 'a.pdf',
                  document_type: 'report',
                  added_at: '2026-01-01T00:00:00Z',
                },
              ],
              total: 1,
            }),
        },
        {
          method: 'PATCH',
          matches: (u) => u.includes('/conversations/c1/scope'),
          respond: () =>
            jsonResponse({ detail: 'Zoom-In requires at least one selected source.' }, 422),
        },
      ],
    });

    await act(async () => {
      findPressableByAccessibilityLabel(renderer.root, 'Add AI Education').props.onPress();
    });
    await act(async () => {
      findPressableByText(renderer.root, 'Zoom-In').props.onPress();
    });
    await act(async () => {
      findPressableByText(renderer.root, 'Save').props.onPress();
      await flushAsync();
    });

    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    // The selection itself already saved server-side (PUT succeeded) — the
    // picker stays open showing the error so Save can simply be retried
    // (idempotent: the PUT would just re-apply the same selection).
    expect(findByText(renderer.root, 'Selected sources (1)')).toBeTruthy();
  });

  it('initialMode="zoom-in" preselects the Zoom-In chip on open', async () => {
    const renderer = await renderPicker({
      target: { kind: 'pending' },
      initialSelection: [{ documentId: 'doc-a', displayName: 'AI Education' }],
      initialMode: 'zoom-in',
      routes: [rootContentsRoute([], [DOC_A])],
    });

    const zoomInChip = findPressableByAccessibilityLabel(
      renderer.root,
      'Zoom-In — chat answers ONLY from the selected sources, nothing else'
    );
    expect(zoomInChip.props.accessibilityState.checked).toBe(true);
  });

  it('hides the mode toggle entirely when zoomInEnabled=false', async () => {
    const renderer = await renderPicker({
      target: { kind: 'pending' },
      initialSelection: [],
      zoomInEnabled: false,
      routes: [rootContentsRoute([], [DOC_A])],
    });

    expect(queryByText(renderer.root, 'Zoom-In')).toBeNull();
    expect(queryByText(renderer.root, 'Prioritize')).toBeNull();
  });

  // Frontend/Platform Milestone 3.2.2 Part D — the old guard that disabled
  // removing the sole remaining Zoom-In source was a trapped-state bug
  // (PO-identified). Removing it must now be always allowed, and doing so
  // auto-switches the mode to Prioritize in the same update rather than
  // leaving Zoom-In selected with zero sources (which the Save button's
  // zoomInNeedsASource guard would otherwise silently block with no
  // explanation of why).
  it('removing the sole remaining source in Zoom-In is allowed and auto-falls-back to Prioritize', async () => {
    const renderer = await renderPicker({
      target: { kind: 'pending' },
      initialSelection: [{ documentId: 'doc-a', displayName: 'AI Education' }],
      initialMode: 'zoom-in',
      routes: [rootContentsRoute([], [DOC_A])],
    });

    const removeButton = findPressableByAccessibilityLabel(
      renderer.root,
      'Remove AI Education from selection'
    );
    expect(removeButton.props.disabled).toBeFalsy();

    await act(async () => {
      removeButton.props.onPress();
    });

    expect(queryByText(renderer.root, 'Selected sources (1)')).toBeNull();
    const zoomInChip = findPressableByAccessibilityLabel(
      renderer.root,
      'Zoom-In — chat answers ONLY from the selected sources, nothing else'
    );
    expect(zoomInChip.props.accessibilityState.checked).toBe(false);
    const prioritizeChip = findPressableByAccessibilityLabel(
      renderer.root,
      'Prioritize — selected sources rank first, other sources still available'
    );
    expect(prioritizeChip.props.accessibilityState.checked).toBe(true);
    // Save is not trapped behind the old guard — nothing selected in
    // Prioritize is a perfectly valid, saveable state.
    expect(findPressableByText(renderer.root, 'Save').props.disabled).toBeFalsy();
  });

  it('removing one of two Zoom-In sources leaves the mode untouched (only the LAST source triggers fallback)', async () => {
    const renderer = await renderPicker({
      target: { kind: 'pending' },
      initialSelection: [
        { documentId: 'doc-a', displayName: 'AI Education' },
        { documentId: 'doc-b', displayName: 'b.pdf' },
      ],
      initialMode: 'zoom-in',
      routes: [rootContentsRoute([], [DOC_A])],
    });

    const removeButton = findPressableByAccessibilityLabel(
      renderer.root,
      'Remove AI Education from selection'
    );

    await act(async () => {
      removeButton.props.onPress();
    });

    expect(findByText(renderer.root, 'Selected sources (1)')).toBeTruthy();
    const zoomInChip = findPressableByAccessibilityLabel(
      renderer.root,
      'Zoom-In — chat answers ONLY from the selected sources, nothing else'
    );
    expect(zoomInChip.props.accessibilityState.checked).toBe(true);
  });
});

const PROJECT_A: ConversationProjectRef = { id: 'p1', name: 'AI Literacy Study' };
const PROJECT_B: ConversationProjectRef = { id: 'p2', name: 'Reading Group' };
const PROJECT_C: ConversationProjectRef = { id: 'p3', name: 'Curriculum Design' };

const withOneSelected = (): PendingSourceDoc[] => [{ documentId: 'doc-a', displayName: 'a.pdf' }];

describe('ChatSourcesPicker — Prioritize copy truthfulness (Frontend Milestone 2.1)', () => {
  it('ordinary chat, sources selected: broadens to library knowledge, never mentions project knowledge', async () => {
    const renderer = await renderPicker({
      target: { kind: 'conversation', conversationId: 'c1' },
      initialSelection: withOneSelected(),
      projectContext: [],
      routes: [rootContentsRoute([], [DOC_A])],
    });
    expect(
      queryByText(
        renderer.root,
        'Use these sources first, then broaden to other available library knowledge when useful.'
      )
    ).toBeTruthy();
    expect(queryByText(renderer.root, /project knowledge/)).toBeNull();
  });

  it('project chat, sources selected: mentions both project and library knowledge', async () => {
    const renderer = await renderPicker({
      target: { kind: 'conversation', conversationId: 'c1' },
      initialSelection: withOneSelected(),
      projectContext: [PROJECT_A],
      routes: [rootContentsRoute([], [DOC_A])],
    });
    expect(
      queryByText(
        renderer.root,
        'Use these sources first, then broaden to project knowledge and other available library knowledge when useful.'
      )
    ).toBeTruthy();
  });

  it('ordinary chat, zero sources selected: never says "use these sources first"', async () => {
    const renderer = await renderPicker({
      target: { kind: 'conversation', conversationId: 'c1' },
      initialSelection: [],
      projectContext: [],
      routes: [rootContentsRoute([], [DOC_A])],
    });
    expect(queryByText(renderer.root, 'Use your available library knowledge.')).toBeTruthy();
    expect(queryByText(renderer.root, /Use these sources first/)).toBeNull();
  });

  it('project chat, zero sources selected: mentions project knowledge, never "use these sources first"', async () => {
    const renderer = await renderPicker({
      target: { kind: 'conversation', conversationId: 'c1' },
      initialSelection: [],
      projectContext: [PROJECT_A],
      routes: [rootContentsRoute([], [DOC_A])],
    });
    expect(
      queryByText(renderer.root, 'Use project knowledge and your available library knowledge.')
    ).toBeTruthy();
    expect(queryByText(renderer.root, /Use these sources first/)).toBeNull();
  });

  it('Zoom-In copy stays "only from the selected sources" regardless of project membership — no automatic project fallback', async () => {
    const renderer = await renderPicker({
      target: { kind: 'conversation', conversationId: 'c1' },
      initialSelection: [],
      projectContext: [PROJECT_A],
      routes: [rootContentsRoute([], [DOC_A])],
    });
    expect(queryByText(renderer.root, 'Answer only from the selected sources.')).toBeTruthy();
  });

  it('a conversation not yet in a project (projectContext=[]) never shows project copy even with project_enabled defaulting true', async () => {
    const renderer = await renderPicker({
      target: { kind: 'conversation', conversationId: 'c1' },
      initialSelection: withOneSelected(),
      projectContext: [],
      // project_enabled omitted — defaults true, same as the backend's own
      // column default for every conversation, project or not. Copy must
      // still stay silent about project knowledge with zero membership.
      routes: [rootContentsRoute([], [DOC_A])],
    });
    expect(queryByText(renderer.root, /project knowledge/)).toBeNull();
  });

  it('projectContext=null (still loading) is treated as no project — never invents membership', async () => {
    const renderer = await renderPicker({
      target: { kind: 'conversation', conversationId: 'c1' },
      initialSelection: withOneSelected(),
      projectContext: null,
      routes: [rootContentsRoute([], [DOC_A])],
    });
    expect(
      queryByText(
        renderer.root,
        'Use these sources first, then broaden to other available library knowledge when useful.'
      )
    ).toBeTruthy();
  });
});

describe('ChatSourcesPicker — non-default scope truthfulness (Frontend Milestone 2.1 §11)', () => {
  it('project_enabled=false: a project-associated conversation never claims project knowledge is available', async () => {
    const renderer = await renderPicker({
      target: { kind: 'conversation', conversationId: 'c1' },
      initialSelection: withOneSelected(),
      projectContext: [PROJECT_A],
      scope: { projectEnabled: false },
      routes: [rootContentsRoute([], [DOC_A])],
    });
    // The project-context indicator legitimately still names the project
    // and explains project knowledge is off (see the §7 tests above) — the
    // thing that must never happen is the Prioritize card itself claiming
    // project knowledge is available to broaden into.
    expect(
      queryByText(
        renderer.root,
        'Use these sources first, then broaden to project knowledge and other available library knowledge when useful.'
      )
    ).toBeNull();
    expect(
      queryByText(
        renderer.root,
        'Use these sources first, then broaden to other available library knowledge when useful.'
      )
    ).toBeTruthy();
  });

  it('general_enabled=false: never claims broader library search is available', async () => {
    const renderer = await renderPicker({
      target: { kind: 'conversation', conversationId: 'c1' },
      initialSelection: withOneSelected(),
      projectContext: [],
      scope: { generalEnabled: false },
      routes: [rootContentsRoute([], [DOC_A])],
    });
    expect(queryByText(renderer.root, /library knowledge/)).toBeNull();
    expect(
      queryByText(
        renderer.root,
        'Use only these selected sources — broader search is currently turned off for this chat.'
      )
    ).toBeTruthy();
  });

  it('project_enabled=false AND general_enabled=false, zero selected: honestly says nothing will be searched', async () => {
    const renderer = await renderPicker({
      target: { kind: 'conversation', conversationId: 'c1' },
      initialSelection: [],
      projectContext: [PROJECT_A],
      scope: { projectEnabled: false, generalEnabled: false },
      routes: [rootContentsRoute([], [DOC_A])],
    });
    expect(
      queryByText(
        renderer.root,
        'No sources selected, and broader search is currently turned off for this chat — add sources to get an answer.'
      )
    ).toBeTruthy();
  });
});

describe('ChatSourcesPicker — project context indicator (Frontend Milestone 2.1 §7)', () => {
  it('shows a Project indicator with the project name for a project-associated conversation', async () => {
    const renderer = await renderPicker({
      target: { kind: 'conversation', conversationId: 'c1' },
      initialSelection: [],
      projectContext: [PROJECT_A],
      routes: [rootContentsRoute([], [DOC_A])],
    });
    expect(findByText(renderer.root, 'Project')).toBeTruthy();
    expect(queryByText(renderer.root, /AI Literacy Study/)).toBeTruthy();
  });

  it('shows nothing for an ordinary (non-project) conversation', async () => {
    const renderer = await renderPicker({
      target: { kind: 'conversation', conversationId: 'c1' },
      initialSelection: [],
      projectContext: [],
      routes: [rootContentsRoute([], [DOC_A])],
    });
    expect(queryByText(renderer.root, 'Project')).toBeNull();
    expect(queryByText(renderer.root, 'Projects')).toBeNull();
  });

  it('shows nothing while project context is still loading (projectContext=null) — no flicker', async () => {
    const renderer = await renderPicker({
      target: { kind: 'conversation', conversationId: 'c1' },
      initialSelection: [],
      projectContext: null,
      routes: [rootContentsRoute([], [DOC_A])],
    });
    expect(queryByText(renderer.root, 'Project')).toBeNull();
  });

  it('a conversation in multiple projects reports every one of them, never an arbitrary "first" project', async () => {
    const renderer = await renderPicker({
      target: { kind: 'conversation', conversationId: 'c1' },
      initialSelection: [],
      projectContext: [PROJECT_A, PROJECT_B],
      routes: [rootContentsRoute([], [DOC_A])],
    });
    expect(findByText(renderer.root, 'Projects')).toBeTruthy();
    expect(queryByText(renderer.root, /AI Literacy Study and Reading Group/)).toBeTruthy();
  });

  it('never displays project documents as selected sources — membership and selection stay visually distinct', async () => {
    const renderer = await renderPicker({
      target: { kind: 'conversation', conversationId: 'c1' },
      initialSelection: [],
      projectContext: [PROJECT_A],
      routes: [rootContentsRoute([], [DOC_A])],
    });
    // The indicator names the project; the Selected sources list still
    // reports zero — project membership never inflates the selection.
    expect(findByText(renderer.root, 'Selected sources (0)')).toBeTruthy();
  });

  it('notes Zoom-In restricts the chat to selected sources even though the conversation is in a project', async () => {
    const renderer = await renderPicker({
      target: { kind: 'conversation', conversationId: 'c1' },
      initialSelection: withOneSelected(),
      initialMode: 'zoom-in',
      projectContext: [PROJECT_A],
      routes: [rootContentsRoute([], [DOC_A])],
    });
    expect(
      queryByText(renderer.root, /Zoom-In restricts this chat to only the selected sources/)
    ).toBeTruthy();
  });
});

describe('describeProjectNames (pure function)', () => {
  it('formats zero, one, two, and three+ names correctly, never truncating silently', () => {
    expect(describeProjectNames([])).toBe('');
    expect(describeProjectNames(['AI Literacy Study'])).toBe('AI Literacy Study');
    expect(describeProjectNames(['AI Literacy Study', 'Reading Group'])).toBe(
      'AI Literacy Study and Reading Group'
    );
    expect(describeProjectNames([PROJECT_A.name, PROJECT_B.name, PROJECT_C.name])).toBe(
      'AI Literacy Study, Reading Group +1 more'
    );
  });
});

describe('prioritizeModeCopy (pure function)', () => {
  it('covers the full effective-scope matrix truthfully', () => {
    expect(
      prioritizeModeCopy({
        selectedCount: 2,
        chatEnabled: true,
        projectAvailable: true,
        generalEnabled: true,
      })
    ).toBe(
      'Use these sources first, then broaden to project knowledge and other available library knowledge when useful.'
    );
    expect(
      prioritizeModeCopy({
        selectedCount: 0,
        chatEnabled: true,
        projectAvailable: false,
        generalEnabled: true,
      })
    ).toBe('Use your available library knowledge.');
    expect(
      prioritizeModeCopy({
        selectedCount: 2,
        chatEnabled: false,
        projectAvailable: false,
        generalEnabled: false,
      })
    ).toBe(
      "Your selected sources aren't currently included in this chat's search, and no other retrieval sources are enabled for this chat."
    );
    expect(
      prioritizeModeCopy({
        selectedCount: 0,
        chatEnabled: true,
        projectAvailable: false,
        generalEnabled: false,
      })
    ).toBe(
      'No sources selected, and broader search is currently turned off for this chat — add sources to get an answer.'
    );
  });
});

describe('ChatSourcesPicker — filter and library actions', () => {
  it('filters the currently-loaded folder by name, client-side, without any network call', async () => {
    const renderer = await renderPicker({
      target: { kind: 'pending' },
      initialSelection: [],
      routes: [rootContentsRoute([ROOT_FOLDER], [DOC_A])],
    });
    const fetchCallsBefore = (global.fetch as jest.Mock).mock.calls.length;

    const filterInput = renderer.root.find(
      (node) => String(node.type) === 'TextInput' && node.props.placeholder === 'Filter by name…'
    );
    await act(async () => {
      filterInput.props.onChangeText('Research');
    });

    expect(findByText(renderer.root, 'Research')).toBeTruthy();
    expect(queryByText(renderer.root, 'AI Education')).toBeNull();
    expect((global.fetch as jest.Mock).mock.calls.length).toBe(fetchCallsBefore);
  });

  it('Milestone 4: a titleless document shows "Author et al. (Year)" instead of a truncated filename', async () => {
    const doc = { ...DOC_B, folder_id: null, authors: ['Jeff Forrester'], publication_year: 2004 };
    const renderer = await renderPicker({
      target: { kind: 'pending' },
      initialSelection: [],
      routes: [rootContentsRoute([], [doc])],
    });
    expect(findByText(renderer.root, 'Forrester (2004)')).toBeTruthy();
    expect(queryByText(renderer.root, 'b.pdf')).toBeNull();
  });

  it('Milestone 4: still falls back to the filename when neither title nor authors are known', async () => {
    const renderer = await renderPicker({
      target: { kind: 'pending' },
      initialSelection: [],
      routes: [rootContentsRoute([], [{ ...DOC_B, folder_id: null }])],
    });
    expect(findByText(renderer.root, 'b.pdf')).toBeTruthy();
  });

  it('Milestone 4: the client-side filter also matches by author name', async () => {
    const doc = { ...DOC_A, authors: ['Ada Lovelace'] };
    const renderer = await renderPicker({
      target: { kind: 'pending' },
      initialSelection: [],
      routes: [rootContentsRoute([], [doc])],
    });
    const filterInput = renderer.root.find(
      (node) => String(node.type) === 'TextInput' && node.props.placeholder === 'Filter by name…'
    );
    await act(async () => {
      filterInput.props.onChangeText('Lovelace');
    });
    expect(findByText(renderer.root, 'AI Education')).toBeTruthy();
  });

  it('shows a truthful "no matches" state rather than an empty list when the filter matches nothing', async () => {
    const renderer = await renderPicker({
      target: { kind: 'pending' },
      initialSelection: [],
      routes: [rootContentsRoute([ROOT_FOLDER], [DOC_A])],
    });
    const filterInput = renderer.root.find(
      (node) => String(node.type) === 'TextInput' && node.props.placeholder === 'Filter by name…'
    );
    await act(async () => {
      filterInput.props.onChangeText('nonexistent-xyz');
    });

    expect(
      findByText(renderer.root, 'No items in this folder match "nonexistent-xyz".')
    ).toBeTruthy();
  });

  it('"Manage library" closes the picker and navigates to Documents', async () => {
    mockPush.mockClear();
    const onClose = jest.fn();
    const renderer = await renderPicker({
      target: { kind: 'pending' },
      initialSelection: [],
      onClose,
      routes: [rootContentsRoute([ROOT_FOLDER], [DOC_A])],
    });

    await act(async () => {
      findPressableByText(renderer.root, 'Manage library').props.onPress();
    });

    expect(onClose).toHaveBeenCalled();
    expect(mockPush).toHaveBeenCalledWith('/documents');
  });

  it('shows the empty-library state with a Go to Documents action when the root has nothing', async () => {
    mockPush.mockClear();
    const onClose = jest.fn();
    const renderer = await renderPicker({
      target: { kind: 'pending' },
      initialSelection: [],
      onClose,
      routes: [rootContentsRoute([], [])],
    });

    expect(findByText(renderer.root, 'No documents yet.')).toBeTruthy();
    await act(async () => {
      findPressableByText(renderer.root, 'Go to Documents').props.onPress();
    });
    expect(onClose).toHaveBeenCalled();
    expect(mockPush).toHaveBeenCalledWith('/documents');
  });
});
