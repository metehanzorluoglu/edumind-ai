/**
 * Milestone 1 (Document Library / Folder Management) — the folder-aware
 * Documents UI, gated on featureFlags.folderLibrary (see FeatureFlags.tsx).
 * The pre-existing flat-list UI (folderLibrary=false) is covered by
 * documents.test.tsx, which forces the flag off for its entire file.
 */
import { Platform } from 'react-native';
import { act, create, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer';
import { AuthProvider } from '@/lib/AuthProvider';
import { ClientProvider } from '@/lib/ClientProvider';
import { FeatureFlagsProvider } from '@/lib/FeatureFlags';
import { MoveToFolderDialog } from '@/components/MoveToFolderDialog';
import DocumentsScreen from '../documents';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

jest.mock('expo-document-picker', () => ({
  getDocumentAsync: jest.fn(),
}));

function installWindow() {
  const backing = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => backing.set(key, value),
    removeItem: (key: string) => backing.delete(key),
  };
  // @ts-expect-error minimal window stub sufficient for this test
  global.window = { localStorage, confirm: jest.fn(() => true) };
}

function textContent(node: ReactTestInstance): string {
  return node.children.filter((child): child is string => typeof child === 'string').join('');
}

// `findAll(...)[0]`, not `.find(...)`: react-native-web's <Text
// numberOfLines={n}> (used by FolderRow's folder name) can render more than
// one underlying Text-typed node for the same visible string (a
// measurement/truncation implementation detail) — `.find()` throws unless
// exactly one match exists, which that duplication would otherwise trip.
function findByText(root: ReactTestInstance, text: string): ReactTestInstance {
  const matches = root.findAll(
    (node) => String(node.type) === 'Text' && textContent(node) === text
  );
  if (matches.length === 0)
    throw new Error(`No Text node found with content ${JSON.stringify(text)}`);
  return matches[0]!;
}

/** Substring match across a Text node's joined children — for text built
 * from multiple template/conditional fragments (e.g. the upload hint's
 * "Uploads land in ..." suffix), where an exact-equality match would be
 * fragile against how JSX happens to split those fragments into children. */
function findByTextIncluding(root: ReactTestInstance, substring: string): ReactTestInstance {
  const matches = root.findAll(
    (node) => String(node.type) === 'Text' && textContent(node).includes(substring)
  );
  if (matches.length === 0) {
    throw new Error(`No Text node found containing ${JSON.stringify(substring)}`);
  }
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
  if (matches.length === 0) {
    throw new Error(`No pressable found containing text ${JSON.stringify(text)}`);
  }
  // The outermost matching Pressable (a folder row's own onPress, not some
  // nested pressable inside it) — react-test-renderer's tree walk visits
  // parents before children, so the first match is always the shallowest.
  return matches[0]!;
}

/** Disambiguates two same-labeled buttons (e.g. a folder row's and a
 * document row's own "Move"/"Delete" — both use the same visible Button
 * label) by accessibilityLabel instead, which every actionable row already
 * sets to something row-specific (see FolderRow.tsx/documents.tsx). */
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

const ROOT_FOLDER = {
  id: 'f1',
  name: 'Research',
  parent_id: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  folder_count: 0,
  document_count: 2,
};

const ROOT_DOCUMENT = {
  document_id: 'd1',
  source_filename: 'root-notes.pdf',
  folder_id: null,
  document_type: 'report',
  chunk_count: 4,
  ingested_at: '2026-01-01T00:00:00Z',
};

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
    if (!route) {
      throw new Error(`Unhandled ${method} ${url} in this test`);
    }
    return route.respond(url, init);
  }) as unknown as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

async function renderScreen(routes: FetchRoute[]): Promise<ReactTestRenderer> {
  installFetchMock(routes);
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <AuthProvider>
        <ClientProvider>
          <FeatureFlagsProvider>
            <DocumentsScreen />
          </FeatureFlagsProvider>
        </ClientProvider>
      </AuthProvider>
    );
    await flushAsync();
  });
  return renderer;
}

const originalOS = Platform.OS;
const originalFetch = global.fetch;

beforeEach(() => {
  Platform.OS = 'web';
  installWindow();
});

afterEach(() => {
  // @ts-expect-error test cleanup
  delete global.window;
  Platform.OS = originalOS;
  global.fetch = originalFetch;
});

describe('DocumentsScreen folder library navigation', () => {
  it('renders "My Library" root contents: a folder row and a document row', async () => {
    const renderer = await renderScreen([
      {
        method: 'GET',
        matches: (u) => u.includes('/status'),
        respond: () => jsonResponse({ folder_library_enabled: true }),
      },
      {
        method: 'GET',
        matches: (u) => u.includes('/folders/contents') && !u.includes('folder_id'),
        respond: () =>
          jsonResponse({
            folder: null,
            breadcrumbs: [],
            folders: [ROOT_FOLDER],
            documents: [ROOT_DOCUMENT],
            documents_total: 1,
          }),
      },
    ]);

    expect(findByText(renderer.root, 'My Library')).toBeTruthy();
    expect(findByText(renderer.root, 'Research')).toBeTruthy();
    expect(findByText(renderer.root, '0 folders · 2 documents')).toBeTruthy();
    expect(findByText(renderer.root, 'root-notes.pdf')).toBeTruthy();
  });

  it('navigates into a folder on press, requesting its contents', async () => {
    const renderer = await renderScreen([
      {
        method: 'GET',
        matches: (u) => u.includes('/status'),
        respond: () => jsonResponse({ folder_library_enabled: true }),
      },
      {
        method: 'GET',
        matches: (u) => u.includes('/folders/contents') && !u.includes('folder_id'),
        respond: () =>
          jsonResponse({
            folder: null,
            breadcrumbs: [],
            folders: [ROOT_FOLDER],
            documents: [],
            documents_total: 0,
          }),
      },
      {
        method: 'GET',
        matches: (u) => u.includes('/folders/contents') && u.includes('folder_id=f1'),
        respond: () =>
          jsonResponse({
            folder: ROOT_FOLDER,
            breadcrumbs: [{ id: 'f1', name: 'Research' }],
            folders: [],
            documents: [ROOT_DOCUMENT],
            documents_total: 1,
          }),
      },
    ]);

    await act(async () => {
      findPressableByText(renderer.root, 'Research').props.onPress();
      await flushAsync();
    });

    // The breadcrumb trail now shows both "My Library" (root) and
    // "Research" (the section header also renders "Research" as the open
    // folder's own name — see documents.tsx — so this is deliberately just
    // presence, not uniqueness).
    expect(findByText(renderer.root, 'My Library')).toBeTruthy();
    expect(queryByText(renderer.root, 'Research')).toBeTruthy();
  });

  it('shows an empty state when a folder has no folders or documents', async () => {
    const renderer = await renderScreen([
      {
        method: 'GET',
        matches: (u) => u.includes('/status'),
        respond: () => jsonResponse({ folder_library_enabled: true }),
      },
      {
        method: 'GET',
        matches: (u) => u.includes('/folders/contents'),
        respond: () =>
          jsonResponse({
            folder: null,
            breadcrumbs: [],
            folders: [],
            documents: [],
            documents_total: 0,
          }),
      },
    ]);

    expect(findByText(renderer.root, 'This folder is empty')).toBeTruthy();
  });
});

describe('DocumentsScreen folder library create/delete', () => {
  it('creating a folder POSTs /folders with the current folder as parent, then refreshes', async () => {
    let createCalled = false;
    const renderer = await renderScreen([
      {
        method: 'GET',
        matches: (u) => u.includes('/status'),
        respond: () => jsonResponse({ folder_library_enabled: true }),
      },
      {
        method: 'GET',
        matches: (u) => u.includes('/folders/contents'),
        respond: () =>
          jsonResponse({
            folder: null,
            breadcrumbs: [],
            folders: createCalled ? [{ ...ROOT_FOLDER, id: 'new', name: 'New Folder' }] : [],
            documents: [],
            documents_total: 0,
          }),
      },
      {
        method: 'POST',
        matches: (u) => u.endsWith('/folders'),
        respond: (_u, init) => {
          createCalled = true;
          const body = JSON.parse(String(init?.body));
          expect(body).toEqual({ name: 'New Folder', parent_id: null });
          return jsonResponse(
            { ...ROOT_FOLDER, id: 'new', name: 'New Folder', folder_count: 0, document_count: 0 },
            201
          );
        },
      },
    ]);

    await act(async () => {
      findPressableByText(renderer.root, 'New folder').props.onPress();
    });

    const input = renderer.root.find(
      (node) => String(node.type) === 'TextInput' && node.props.placeholder === 'e.g. Research'
    );
    await act(async () => {
      input.props.onChangeText('New Folder');
    });
    await act(async () => {
      findPressableByText(renderer.root, 'Create').props.onPress();
      await flushAsync();
    });

    expect(createCalled).toBe(true);
    expect(findByText(renderer.root, 'New Folder')).toBeTruthy();
  });

  it('deleting an empty folder confirms then DELETEs /folders/{id}', async () => {
    let deleteCalled = false;
    const renderer = await renderScreen([
      {
        method: 'GET',
        matches: (u) => u.includes('/status'),
        respond: () => jsonResponse({ folder_library_enabled: true }),
      },
      {
        method: 'GET',
        matches: (u) => u.includes('/folders/contents'),
        respond: () =>
          jsonResponse({
            folder: null,
            breadcrumbs: [],
            folders: deleteCalled ? [] : [{ ...ROOT_FOLDER, folder_count: 0, document_count: 0 }],
            documents: [],
            documents_total: 0,
          }),
      },
      {
        method: 'DELETE',
        matches: (u) => u.includes('/folders/f1'),
        respond: () => {
          deleteCalled = true;
          return jsonResponse({
            deleted: true,
            folder_id: 'f1',
            moved_folders: 0,
            moved_documents: 0,
          });
        },
      },
    ]);

    await act(async () => {
      findPressableByText(renderer.root, 'Delete').props.onPress();
      await flushAsync();
    });

    expect(deleteCalled).toBe(true);
    expect(queryByText(renderer.root, 'Research')).toBeNull();
  });
});

describe('DocumentsScreen folder library document move', () => {
  it('opens the move dialog and PATCHes /documents/{id} with the chosen folder', async () => {
    let moveCalled = false;
    const renderer = await renderScreen([
      {
        method: 'GET',
        matches: (u) => u.includes('/status'),
        respond: () => jsonResponse({ folder_library_enabled: true }),
      },
      {
        method: 'GET',
        matches: (u) => u.includes('/folders/contents') && !u.includes('folder_id'),
        respond: () =>
          jsonResponse({
            folder: null,
            breadcrumbs: [],
            folders: [ROOT_FOLDER],
            documents: [ROOT_DOCUMENT],
            documents_total: 1,
          }),
      },
      {
        method: 'GET',
        matches: (u) => u.includes('/folders/contents') && u.includes('folder_id=f1'),
        respond: () =>
          jsonResponse({
            folder: ROOT_FOLDER,
            breadcrumbs: [{ id: 'f1', name: 'Research' }],
            folders: [],
            documents: [],
            documents_total: 0,
          }),
      },
      {
        method: 'PATCH',
        matches: (u) => u.includes('/documents/d1'),
        respond: (_u, init) => {
          moveCalled = true;
          const body = JSON.parse(String(init?.body));
          expect(body).toEqual({ folder_id: 'f1' });
          return jsonResponse({ ...ROOT_DOCUMENT, folder_id: 'f1' });
        },
      },
    ]);

    await act(async () => {
      findPressableByAccessibilityLabel(renderer.root, 'Move root-notes.pdf').props.onPress();
      await flushAsync();
    });

    // Scoped to the dialog's own subtree — the page underneath (still
    // mounted behind the modal overlay) also has a "Research" folder row,
    // and querying the whole tree would risk clicking that one instead.
    const dialog = renderer.root.findByType(MoveToFolderDialog);

    await act(async () => {
      findPressableByText(dialog, 'Research').props.onPress();
      await flushAsync();
    });
    await act(async () => {
      findPressableByText(dialog, 'Move here').props.onPress();
      await flushAsync();
    });

    expect(moveCalled).toBe(true);
  });
});

describe('DocumentsScreen folder library upload targeting', () => {
  it('shows an upload hint naming the currently-open folder, and picks it via DocumentPicker for the real upload', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getDocumentAsync } = require('expo-document-picker') as { getDocumentAsync: jest.Mock };
    getDocumentAsync.mockResolvedValue({
      canceled: false,
      assets: [
        {
          name: 'notes.txt',
          size: 5,
          mimeType: 'text/plain',
          uri: 'blob:mock',
          file: new File(['hello'], 'notes.txt', { type: 'text/plain' }),
        },
      ],
    });

    let uploadedFolderId: string | null | undefined;
    const renderer = await renderScreen([
      {
        method: 'GET',
        matches: (u) => u.includes('/status'),
        respond: () => jsonResponse({ folder_library_enabled: true }),
      },
      {
        method: 'GET',
        matches: (u) => u.includes('/folders/contents') && !u.includes('folder_id'),
        respond: () =>
          jsonResponse({
            folder: null,
            breadcrumbs: [],
            folders: [ROOT_FOLDER],
            documents: [],
            documents_total: 0,
          }),
      },
      {
        method: 'GET',
        matches: (u) => u.includes('/folders/contents') && u.includes('folder_id=f1'),
        respond: () =>
          jsonResponse({
            folder: ROOT_FOLDER,
            breadcrumbs: [{ id: 'f1', name: 'Research' }],
            folders: [],
            documents: [],
            documents_total: 0,
          }),
      },
      {
        method: 'POST',
        matches: (u) => u.includes('/documents/metadata-preview'),
        respond: () =>
          jsonResponse({
            title: null,
            authors: [],
            publication_year: null,
            source_venue: null,
            doi: null,
            source_url: null,
            page_count: 1,
            file_format: 'txt',
            extraction_sources: {},
            extraction_confidence: {},
          }),
      },
      {
        method: 'POST',
        matches: (u) => u.endsWith('/documents'),
        respond: (_u, init) => {
          const body = init?.body as FormData;
          uploadedFolderId = body.get('folder_id') as string | null;
          return jsonResponse({ job_id: 'job1', status: 'processing' }, 202);
        },
      },
      {
        method: 'GET',
        matches: (u) => u.includes('/documents/jobs/job1'),
        respond: () =>
          jsonResponse({
            job_id: 'job1',
            status: 'completed',
            stage: 'persisting',
            total_chunks: 1,
            embedded_chunks: 1,
            document: {
              document_id: 'd2',
              source_filename: 'notes.txt',
              file_format: 'txt',
              folder_id: 'f1',
              document_type: 'report',
              page_count: 1,
              chunk_count: 1,
              ingested_at: '2026-01-01T00:00:00Z',
            },
          }),
      },
    ]);

    await act(async () => {
      findPressableByText(renderer.root, 'Research').props.onPress();
      await flushAsync();
    });

    expect(findByTextIncluding(renderer.root, 'Uploads land in "Research"')).toBeTruthy();

    await act(async () => {
      findPressableByText(renderer.root, 'Choose file…').props.onPress();
      await flushAsync();
    });
    await act(async () => {
      findPressableByText(renderer.root, 'Upload').props.onPress();
      await flushAsync();
    });

    expect(uploadedFolderId).toBe('f1');
  });
});
