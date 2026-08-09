import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { AuthProvider } from '@/lib/AuthProvider';
import { ClientProvider } from '@/lib/ClientProvider';
import { ChatSourcesPicker, type PendingSourceDoc, type SourceMode } from '../ChatSourcesPicker';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

function textContent(node: ReactTestInstance): string {
  return node.children.filter((child): child is string => typeof child === 'string').join('');
}

function findByText(root: ReactTestInstance, text: string): ReactTestInstance {
  const matches = root.findAll(
    (node) => String(node.type) === 'Text' && textContent(node) === text
  );
  if (matches.length === 0)
    throw new Error(`No Text node found with content ${JSON.stringify(text)}`);
  return matches[0]!;
}

function queryByText(root: ReactTestInstance, text: string): ReactTestInstance | null {
  const matches = root.findAll(
    (node) => String(node.type) === 'Text' && textContent(node) === text
  );
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

    expect(findByText(renderer.root, 'Add sources')).toBeTruthy();
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

    expect(findByText(renderer.root, 'Selected (0)')).toBeTruthy();

    await act(async () => {
      findPressableByAccessibilityLabel(renderer.root, 'Add AI Education').props.onPress();
    });

    expect(findByText(renderer.root, 'Selected (1)')).toBeTruthy();
  });

  it('unselecting a document via its checkbox removes it', async () => {
    const renderer = await renderPicker({
      target: { kind: 'pending' },
      initialSelection: [{ documentId: 'doc-a', displayName: 'AI Education' }],
      routes: [rootContentsRoute([], [DOC_A])],
    });

    expect(findByText(renderer.root, 'Selected (1)')).toBeTruthy();

    await act(async () => {
      findPressableByAccessibilityLabel(renderer.root, 'Remove AI Education').props.onPress();
    });

    expect(findByText(renderer.root, 'Selected (0)')).toBeTruthy();
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

    expect(findByText(renderer.root, 'Selected (0)')).toBeTruthy();
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
    expect(findByText(renderer.root, 'Selected (1)')).toBeTruthy();

    await act(async () => {
      findPressableByText(renderer.root, 'Research').props.onPress();
      await flushAsync();
    });

    // Still selected after navigating away from the folder it lives in.
    expect(findByText(renderer.root, 'Selected (1)')).toBeTruthy();
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
    expect(findByText(renderer.root, 'Selected (1)')).toBeTruthy();
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

    expect(findByText(renderer.root, 'Selected (1)')).toBeTruthy();
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
    expect(findByText(renderer.root, 'Selected (1)')).toBeTruthy();
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
});
