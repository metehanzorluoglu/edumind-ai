/**
 * M5.5.3 continuation Part 10 — Reader continuity (zoom + approximate
 * page position) coverage. A real-browser walkthrough found the
 * "same document" restoration the nav rail already provided
 * (lib/sectionLastLocation.ts remembering the last pathname visited)
 * was only pathname-deep: reopening the SAME document after navigating
 * away and back silently reset zoom/scroll to their fresh-mount
 * defaults every time, because nothing in this codebase's own
 * sessionNavCache (Writing's own cursor/scroll continuity mechanism)
 * was ever wired into the Reader side.
 *
 * PdfReader itself needs a real document.createElement('canvas') to
 * reach `status === 'success'` (see CompiledPdfPreview.test.tsx's own
 * docstring for why this monorepo's jest environment — react-native's
 * own jest-preset, not jsdom — has no substitute for that), so this
 * file mocks @/components/documents/PdfReader with a thin stub that
 * exposes exactly the props under test (initialScale, initialPageNumber,
 * onReaderStateChange) instead of rendering the real component — the
 * same "mock the heavy dependency, test the wiring" approach
 * [id].compile.test.tsx already uses for @/lib/pdfjs.
 */
import { Platform } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { AuthProvider } from '@/lib/AuthProvider';
import { ClientProvider } from '@/lib/ClientProvider';
import { getSessionNavState, __resetSessionNavCacheForTests } from '@/lib/sessionNavCache';
import DocumentReaderScreen from '../[id]';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

const mockParams: { id: string; page?: string; highlightId?: string; chunkId?: string } = {
  id: 'doc-1',
};
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  useLocalSearchParams: () => mockParams,
  usePathname: () => '/documents/doc-1',
  useGlobalSearchParams: () => ({}),
}));

jest.mock('@/lib/useReaderSelection', () => ({
  useReaderSelection: () => ({ selection: null, clear: jest.fn() }),
}));

// The stub records whatever props it was last rendered with (readable
// via __lastPdfReaderProps) and exposes onReaderStateChange as a plain
// callable so tests can simulate PdfReader reporting a zoom/scroll
// change, without needing pdf.js or a real canvas at all.
let lastPdfReaderProps: Record<string, unknown> | null = null;
jest.mock('@/components/documents/PdfReader', () => ({
  PdfReader: (props: Record<string, unknown>) => {
    lastPdfReaderProps = props;
    return null;
  },
}));

// A plain function call (rather than reading the module-level `let`
// directly at each assertion site) resets TypeScript's own narrowing —
// without it, every `lastPdfReaderProps = null;` reset below narrows
// the variable's flow-type in a way later `currentPdfReaderProps()?.foo`
// reads in the SAME test function don't recover from, even though the
// mock factory genuinely reassigns it before each read at runtime.
function currentPdfReaderProps(): Record<string, unknown> | null {
  return lastPdfReaderProps;
}

const originalOS = Platform.OS;
beforeAll(() => {
  Platform.OS = 'web';
});
afterAll(() => {
  Platform.OS = originalOS;
});

beforeEach(() => {
  __resetSessionNavCacheForTests();
  lastPdfReaderProps = null;
});

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

function contentFor(documentId: string) {
  return {
    document_id: documentId,
    title: 'A Study',
    source_filename: 'paper.pdf',
    file_format: 'pdf',
    original_file_available: true,
    page_count: 20,
    chunks: [{ chunk_id: 'chunk-0', chunk_index: 0, page_number: 1, text: 'Intro text.' }],
  };
}

function routesFor(documentId: string): FetchRoute[] {
  return [
    {
      method: 'GET',
      matches: (u) => u.includes(`/documents/${documentId}/content`),
      respond: () => jsonResponse(contentFor(documentId)),
    },
    {
      method: 'GET',
      matches: (u) =>
        u.includes(`/documents/${documentId}/highlights`) && !u.endsWith('/notebooks'),
      respond: () => jsonResponse({ highlights: [] }),
    },
  ];
}

async function flushAsync(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function renderReader(documentId: string): Promise<ReactTestRenderer> {
  mockParams.id = documentId;
  installFetchMock(routesFor(documentId));
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <AuthProvider>
        <ClientProvider>
          <DocumentReaderScreen />
        </ClientProvider>
      </AuthProvider>
    );
    await flushAsync();
  });
  return renderer;
}

describe('DocumentReaderScreen — Reader continuity (M5.5.3 continuation Part 10)', () => {
  it('passes no initial zoom/page on a first-ever visit (nothing cached yet)', async () => {
    const renderer = await renderReader('doc-1');
    // Confirms PdfReader actually mounted at all — not a vacuous pass
    // from lastPdfReaderProps having never been set.
    expect(currentPdfReaderProps()).not.toBeNull();
    expect(currentPdfReaderProps()?.documentId).toBe('doc-1');
    expect(currentPdfReaderProps()?.initialScale).toBeUndefined();
    expect(currentPdfReaderProps()?.initialPageNumber).toBeUndefined();
    act(() => {
      renderer.unmount();
    });
  });

  it('onReaderStateChange writes zoom/page into sessionNavCache, keyed per document', async () => {
    const renderer = await renderReader('doc-1');
    const onChange = currentPdfReaderProps()?.onReaderStateChange as
      ((s: { scale: number; page: number }) => void) | undefined;
    expect(onChange).toBeInstanceOf(Function);
    act(() => {
      onChange!({ scale: 1.5, page: 7 });
    });
    expect(getSessionNavState('reader-state:doc-1')).toEqual({ scale: 1.5, page: 7 });
    act(() => {
      renderer.unmount();
    });
  });

  it('restores the cached zoom/page as initialScale/initialPageNumber on the next mount of the SAME document', async () => {
    const first = await renderReader('doc-1');
    const onChange = currentPdfReaderProps()?.onReaderStateChange as (s: {
      scale: number;
      page: number;
    }) => void;
    act(() => {
      onChange({ scale: 2, page: 12 });
    });
    act(() => {
      first.unmount();
    });

    // Simulates "navigate away, then come back" — a fresh mount of the
    // same screen for the same document id, exactly what a Slot-based
    // section switch produces (see [id].continuity.test.tsx's own
    // identical unmount/remount convention for Writing).
    lastPdfReaderProps = null;
    const second = await renderReader('doc-1');
    expect(currentPdfReaderProps()?.initialScale).toBe(2);
    expect(currentPdfReaderProps()?.initialPageNumber).toBe(12);
    act(() => {
      second.unmount();
    });
  });

  it("keeps two different documents' zoom/page fully independent (never a shared, last-document-wins slot)", async () => {
    const docA = await renderReader('doc-1');
    const onChangeA = currentPdfReaderProps()?.onReaderStateChange as (s: {
      scale: number;
      page: number;
    }) => void;
    act(() => {
      onChangeA({ scale: 1.8, page: 9 });
    });
    act(() => {
      docA.unmount();
    });

    lastPdfReaderProps = null;
    const docB = await renderReader('doc-2');
    // doc-2 has never been viewed — no restoration, not doc-1's state.
    expect(currentPdfReaderProps()?.initialScale).toBeUndefined();
    expect(currentPdfReaderProps()?.initialPageNumber).toBeUndefined();
    const onChangeB = currentPdfReaderProps()?.onReaderStateChange as (s: {
      scale: number;
      page: number;
    }) => void;
    act(() => {
      onChangeB({ scale: 0.75, page: 3 });
    });
    act(() => {
      docB.unmount();
    });

    // Both entries coexist, each with its own real value.
    expect(getSessionNavState('reader-state:doc-1')).toEqual({ scale: 1.8, page: 9 });
    expect(getSessionNavState('reader-state:doc-2')).toEqual({ scale: 0.75, page: 3 });

    lastPdfReaderProps = null;
    const docAAgain = await renderReader('doc-1');
    expect(currentPdfReaderProps()?.initialScale).toBe(1.8);
    expect(currentPdfReaderProps()?.initialPageNumber).toBe(9);
    act(() => {
      docAAgain.unmount();
    });
  });
});
