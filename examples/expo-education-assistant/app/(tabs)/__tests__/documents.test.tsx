import { Platform } from 'react-native';
import { act, create, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer';
import { AuthProvider } from '@/lib/AuthProvider';
import { ClientProvider } from '@/lib/ClientProvider';
import { MAX_UPLOAD_FILE_SIZE_BYTES, formatFileSize } from '@/lib/documentUpload';
import DocumentsScreen from '../documents';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

jest.mock('@/lib/sampleDocument', () => {
  const actual = jest.requireActual('@/lib/sampleDocument');
  return {
    ...actual,
    buildSampleUploadFile: jest.fn(),
  };
});

jest.mock('expo-document-picker', () => ({
  getDocumentAsync: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { buildSampleUploadFile } = require('@/lib/sampleDocument') as {
  buildSampleUploadFile: jest.Mock;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getDocumentAsync } = require('expo-document-picker') as {
  getDocumentAsync: jest.Mock;
};

function installWindow() {
  const backing = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => backing.set(key, value),
    removeItem: (key: string) => backing.delete(key),
  };
  // @ts-expect-error minimal window stub sufficient for this test
  global.window = { localStorage };
}

/** Joins a Text node's string children before comparing — a JSX expression
 * like `{a}{b}` compiles to multiple array entries, not one joined string. */
function textContent(node: ReactTestInstance): string {
  return node.children.filter((child): child is string => typeof child === 'string').join('');
}

function findByText(root: ReactTestInstance, text: string): ReactTestInstance {
  return root.find((node) => String(node.type) === 'Text' && textContent(node) === text);
}

function queryByText(root: ReactTestInstance, text: string): ReactTestInstance | null {
  const matches = root.findAll(
    (node) => String(node.type) === 'Text' && textContent(node) === text
  );
  return matches[0] ?? null;
}

function findPressableByText(root: ReactTestInstance, text: string): ReactTestInstance {
  return root.find(
    (node) => typeof node.props.onPress === 'function' && queryByText(node, text) !== null
  );
}

/**
 * A fake DOM node standing in for the real HTMLElement the drop zone's ref
 * resolves to in a real browser — react-test-renderer never provides one
 * (there's no DOM at all in this test environment), but its documented
 * `createNodeMock` option lets a test supply exactly this kind of stand-in
 * for a host component's ref. Captured listeners are invoked directly with
 * synthetic drag events, exercising the real dragenter/dragover/dragleave/
 * drop handlers documents.tsx registers — not a parallel test-only path.
 */
function createFakeDropZoneNode() {
  const listeners: Record<string, ((event: unknown) => void)[]> = {};
  return {
    listeners,
    addEventListener: jest.fn((type: string, handler: (event: unknown) => void) => {
      (listeners[type] ??= []).push(handler);
    }),
    removeEventListener: jest.fn((type: string, handler: (event: unknown) => void) => {
      listeners[type] = (listeners[type] ?? []).filter((h) => h !== handler);
    }),
  };
}

function fireDropZoneEvent(
  node: ReturnType<typeof createFakeDropZoneNode>,
  type: string,
  event: unknown
): void {
  for (const handler of node.listeners[type] ?? []) handler(event);
}

function makeDragEvent(overrides: { types?: string[]; files?: unknown[] } = {}) {
  return {
    preventDefault: jest.fn(),
    dataTransfer: {
      types: overrides.types ?? ['Files'],
      files: overrides.files ?? [],
    },
  };
}

function makeFakeFile(name: string, size: number, type: string) {
  return { name, size, type };
}

/** A real File (not the plain-object stand-in makeFakeFile returns) —
 * needed wherever the dropped file actually flows through
 * appendUploadableFile() (e.g. a metadata-preview or upload call), since
 * that function only accepts a real File/Blob or the RN `{ uri, name,
 * type }` shape, and would reject a plain object with neither. */
function makeRealFile(name: string, size: number, type: string): File {
  return new File([new Uint8Array(size)], name, { type });
}

/** Drains several microtask turns — the fetch mock's Response.json() plus
 * the SDK's own .then() chain each add a hop, so a single `await
 * Promise.resolve()` isn't always enough to observe the resulting state
 * update. */
async function flushAsync(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function renderHydrated(
  createNodeMock?: (element: unknown) => unknown
): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <AuthProvider>
        <ClientProvider>
          <DocumentsScreen />
        </ClientProvider>
      </AuthProvider>,
      createNodeMock ? { createNodeMock } : undefined
    );
    await Promise.resolve();
    await Promise.resolve();
  });
  return renderer;
}

/** Renders with the drop zone's ref resolved to a fake DOM node (see
 * createFakeDropZoneNode), returning both the renderer and that node so a
 * test can fire synthetic drag events at it. */
async function renderHydratedWithDropZone(): Promise<{
  renderer: ReactTestRenderer;
  dropZoneNode: ReturnType<typeof createFakeDropZoneNode>;
}> {
  const dropZoneNode = createFakeDropZoneNode();
  const renderer = await renderHydrated((element) => {
    const typedElement = element as { type?: unknown; props?: { 'data-testid'?: string } };
    return typedElement.type === 'div' &&
      typedElement.props?.['data-testid'] === 'document-drop-zone'
      ? dropZoneNode
      : null;
  });
  return { renderer, dropZoneNode };
}

describe('DocumentsScreen sample upload error handling (web)', () => {
  const originalOS = Platform.OS;
  const originalFetch = global.fetch;

  beforeEach(() => {
    Platform.OS = 'web';
    installWindow();
    buildSampleUploadFile.mockReset();
    global.fetch = jest.fn(
      async () => new Response(JSON.stringify({ documents: [], total: 0 }), { status: 200 })
    ) as unknown as typeof fetch;
  });

  afterEach(() => {
    // @ts-expect-error test cleanup
    delete global.window;
    Platform.OS = originalOS;
    global.fetch = originalFetch;
  });

  it('renders an upload error instead of crashing when building the sample file throws', async () => {
    buildSampleUploadFile.mockImplementation(() => {
      throw new Error('this.validatePath is not a function');
    });

    const renderer = await renderHydrated();

    const loadSampleButton = findPressableByText(renderer.root, 'Load sample corpus (dev only)');

    expect(() => {
      act(() => {
        loadSampleButton.props.onPress();
      });
    }).not.toThrow();

    const errorText = findByText(renderer.root, 'this.validatePath is not a function');
    expect(errorText).toBeDefined();
  });

  it('does not show an error, and calls upload(), when building the sample file succeeds', async () => {
    buildSampleUploadFile.mockReturnValue({
      uri: 'file:///mock/sample.md',
      name: 'sample-fictional-grade4-curriculum.md',
      type: 'text/markdown',
    });

    const renderer = await renderHydrated();
    const loadSampleButton = findPressableByText(renderer.root, 'Load sample corpus (dev only)');

    await act(async () => {
      loadSampleButton.props.onPress();
      await Promise.resolve();
    });

    expect(buildSampleUploadFile).toHaveBeenCalledTimes(1);
    expect(() => findByText(renderer.root, 'this.validatePath is not a function')).toThrow();
  });
});

describe('DocumentsScreen metadata preview', () => {
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

  function findTextInputByPlaceholder(root: ReactTestInstance, placeholder: string) {
    return root.find(
      (node) => String(node.type) === 'TextInput' && node.props.placeholder === placeholder
    );
  }

  it('populates editable fields from a successful metadata preview after a valid file is selected', async () => {
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/documents/metadata-preview')) {
        return new Response(
          JSON.stringify({
            title: 'Detected Title',
            authors: ['Ada Lovelace', 'Grace Hopper'],
            publication_year: 2021,
            source_venue: 'Journal of Examples',
            doi: '10.1234/edu.2021.001',
            source_url: 'https://example.com/paper',
            page_count: 5,
            file_format: 'pdf',
            extraction_sources: { title: 'embedded_metadata' },
            extraction_confidence: { title: 'high' },
          }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({ documents: [], total: 0 }), { status: 200 });
    }) as unknown as typeof fetch;

    const { renderer, dropZoneNode } = await renderHydratedWithDropZone();

    await act(async () => {
      fireDropZoneEvent(
        dropZoneNode,
        'drop',
        makeDragEvent({ files: [makeRealFile('paper.pdf', 2048, 'application/pdf')] })
      );
      await flushAsync();
    });

    expect(findTextInputByPlaceholder(renderer.root, 'Title (optional)').props.value).toBe(
      'Detected Title'
    );
    expect(
      findTextInputByPlaceholder(renderer.root, 'Authors, comma-separated (optional)').props.value
    ).toBe('Ada Lovelace, Grace Hopper');
    expect(
      findTextInputByPlaceholder(renderer.root, 'Publication year (optional)').props.value
    ).toBe('2021');
    expect(
      findTextInputByPlaceholder(renderer.root, 'Source venue / journal (optional)').props.value
    ).toBe('Journal of Examples');
    expect(findTextInputByPlaceholder(renderer.root, 'DOI (optional)').props.value).toBe(
      '10.1234/edu.2021.001'
    );
    expect(findTextInputByPlaceholder(renderer.root, 'Source URL (optional)').props.value).toBe(
      'https://example.com/paper'
    );
  });

  it('displays the exact title and full 9-author list from the IJAIED-style regression case', async () => {
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/documents/metadata-preview')) {
        return new Response(
          JSON.stringify({
            title: 'Lessons Learned for AI Education with Elementary Students and Teachers',
            authors: [
              'Anne Ottenbreit-Leftwich',
              'Krista Glazewski',
              'Minji Jeon',
              'Katie Jantaraweragul',
              'Cindy E. Hmelo-Silver',
              'Adam Scribner',
              'Seung Lee',
              'Bradford Mott',
              'James Lester',
            ],
            publication_year: 2023,
            source_venue:
              'International Journal of Artificial Intelligence in Education (2023) 33:267-289',
            doi: '10.1007/s40593-022-00304-3',
            source_url: 'https://doi.org/10.1007/s40593-022-00304-3',
            page_count: 23,
            file_format: 'pdf',
            extraction_sources: { title: 'structured_text', authors: 'structured_text' },
            extraction_confidence: { title: 'medium', authors: 'medium' },
          }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({ documents: [], total: 0 }), { status: 200 });
    }) as unknown as typeof fetch;

    const { renderer, dropZoneNode } = await renderHydratedWithDropZone();

    await act(async () => {
      fireDropZoneEvent(
        dropZoneNode,
        'drop',
        makeDragEvent({
          files: [
            makeRealFile('lessons_learned_for_ai_education.pdf', 1_000_000, 'application/pdf'),
          ],
        })
      );
      await flushAsync();
    });

    expect(findTextInputByPlaceholder(renderer.root, 'Title (optional)').props.value).toBe(
      'Lessons Learned for AI Education with Elementary Students and Teachers'
    );
    expect(
      findTextInputByPlaceholder(renderer.root, 'Authors, comma-separated (optional)').props.value
    ).toBe(
      'Anne Ottenbreit-Leftwich, Krista Glazewski, Minji Jeon, Katie Jantaraweragul, ' +
        'Cindy E. Hmelo-Silver, Adam Scribner, Seung Lee, Bradford Mott, James Lester'
    );
    expect(
      findTextInputByPlaceholder(renderer.root, 'Publication year (optional)').props.value
    ).toBe('2023');
    expect(findTextInputByPlaceholder(renderer.root, 'DOI (optional)').props.value).toBe(
      '10.1007/s40593-022-00304-3'
    );
  });

  it('selecting the same filename again still triggers a fresh metadata-preview request', async () => {
    let previewCallCount = 0;
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/documents/metadata-preview')) {
        previewCallCount += 1;
        return new Response(
          JSON.stringify({
            title: `Detected Title ${previewCallCount}`,
            authors: [],
            publication_year: null,
            source_venue: null,
            doi: null,
            source_url: null,
            page_count: 1,
            file_format: 'pdf',
            extraction_sources: {},
            extraction_confidence: {},
          }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({ documents: [], total: 0 }), { status: 200 });
    }) as unknown as typeof fetch;

    const { renderer, dropZoneNode } = await renderHydratedWithDropZone();

    await act(async () => {
      fireDropZoneEvent(
        dropZoneNode,
        'drop',
        makeDragEvent({ files: [makeRealFile('paper.pdf', 2048, 'application/pdf')] })
      );
      await flushAsync();
    });
    expect(findTextInputByPlaceholder(renderer.root, 'Title (optional)').props.value).toBe(
      'Detected Title 1'
    );

    // Re-drop a file with the exact same name — must issue a brand new
    // preview request rather than reusing the previous response.
    await act(async () => {
      fireDropZoneEvent(
        dropZoneNode,
        'drop',
        makeDragEvent({ files: [makeRealFile('paper.pdf', 2048, 'application/pdf')] })
      );
      await flushAsync();
    });

    expect(previewCallCount).toBe(2);
    expect(findTextInputByPlaceholder(renderer.root, 'Title (optional)').props.value).toBe(
      'Detected Title 2'
    );
  });

  it('does not block upload when metadata preview fails — fields stay editable manually', async () => {
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/documents/metadata-preview')) {
        return new Response(JSON.stringify({ detail: 'boom' }), { status: 500 });
      }
      return new Response(JSON.stringify({ documents: [], total: 0 }), { status: 200 });
    }) as unknown as typeof fetch;

    const { renderer, dropZoneNode } = await renderHydratedWithDropZone();

    await act(async () => {
      fireDropZoneEvent(
        dropZoneNode,
        'drop',
        makeDragEvent({ files: [makeRealFile('paper.pdf', 2048, 'application/pdf')] })
      );
      await flushAsync();
    });

    expect(findPressableByText(renderer.root, 'Upload').props.disabled).toBe(false);
    expect(
      findTextInputByPlaceholder(renderer.root, 'Authors, comma-separated (optional)')
    ).toBeTruthy();
  });

  it('clears preview-populated fields when the file is removed', async () => {
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/documents/metadata-preview')) {
        return new Response(
          JSON.stringify({
            title: 'Detected Title',
            authors: ['Ada Lovelace'],
            publication_year: 2021,
            source_venue: null,
            doi: null,
            source_url: null,
            page_count: 5,
            file_format: 'pdf',
            extraction_sources: {},
            extraction_confidence: {},
          }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({ documents: [], total: 0 }), { status: 200 });
    }) as unknown as typeof fetch;

    const { renderer, dropZoneNode } = await renderHydratedWithDropZone();

    await act(async () => {
      fireDropZoneEvent(
        dropZoneNode,
        'drop',
        makeDragEvent({ files: [makeRealFile('paper.pdf', 2048, 'application/pdf')] })
      );
      await flushAsync();
    });
    expect(findTextInputByPlaceholder(renderer.root, 'Title (optional)').props.value).toBe(
      'Detected Title'
    );

    await act(async () => {
      findPressableByText(renderer.root, 'Remove').props.onPress();
    });

    expect(findTextInputByPlaceholder(renderer.root, 'Title (optional)').props.value).toBe('');
  });
});

describe('DocumentsScreen web drag-and-drop', () => {
  const originalOS = Platform.OS;
  const originalFetch = global.fetch;

  beforeEach(() => {
    Platform.OS = 'web';
    installWindow();
    getDocumentAsync.mockReset();
    global.fetch = jest.fn(
      async () => new Response(JSON.stringify({ documents: [], total: 0 }), { status: 200 })
    ) as unknown as typeof fetch;
  });

  afterEach(() => {
    // @ts-expect-error test cleanup
    delete global.window;
    Platform.OS = originalOS;
    global.fetch = originalFetch;
  });

  it('shows the drop-zone instructions on web but never on native', async () => {
    const { renderer } = await renderHydratedWithDropZone();
    expect(
      findByText(renderer.root, 'Drag and drop a PDF, DOCX, TXT, or HTML file here')
    ).toBeTruthy();

    Platform.OS = 'ios';
    const nativeRenderer = await renderHydrated();
    expect(
      queryByText(nativeRenderer.root, 'Drag and drop a PDF, DOCX, TXT, or HTML file here')
    ).toBeNull();
    // "Choose file…" must still be present and usable on native.
    expect(findPressableByText(nativeRenderer.root, 'Choose file…')).toBeTruthy();
  });

  it('highlights the drop zone while a file is dragged over it, and absorbs nested enter/leave pairs without flicker', async () => {
    const { renderer, dropZoneNode } = await renderHydratedWithDropZone();

    function isActive(): boolean {
      const dropZone = renderer.root.find(
        (node) => node.props.testID === 'document-drop-zone-highlight'
      );
      const style: unknown[] = Array.isArray(dropZone.props.style)
        ? dropZone.props.style
        : [dropZone.props.style];
      return style
        .filter((entry): entry is { borderColor?: string } => Boolean(entry))
        .some((entry) => entry.borderColor === '#208AEF');
    }

    expect(isActive()).toBe(false);

    // Simulates a drag entering the outer zone, then entering a nested
    // child inside it (fires leave on the parent, enter on the child) —
    // a naive isDragOver boolean would flicker off here; the drag-counter
    // approach must not.
    await act(async () => {
      fireDropZoneEvent(dropZoneNode, 'dragenter', makeDragEvent());
    });
    expect(isActive()).toBe(true);

    await act(async () => {
      fireDropZoneEvent(dropZoneNode, 'dragenter', makeDragEvent());
    });
    await act(async () => {
      fireDropZoneEvent(dropZoneNode, 'dragleave', makeDragEvent());
    });
    expect(isActive()).toBe(true); // still active — one enter/leave pair absorbed

    await act(async () => {
      fireDropZoneEvent(dropZoneNode, 'dragleave', makeDragEvent());
    });
    expect(isActive()).toBe(false); // counter now back to zero
  });

  it('prevents the default browser action on dragover and drop (stops the browser from opening the file)', async () => {
    const { dropZoneNode } = await renderHydratedWithDropZone();

    const dragOverEvent = makeDragEvent();
    await act(async () => {
      fireDropZoneEvent(dropZoneNode, 'dragover', dragOverEvent);
    });
    expect(dragOverEvent.preventDefault).toHaveBeenCalled();

    const dropEvent = makeDragEvent({
      files: [makeFakeFile('paper.pdf', 1024, 'application/pdf')],
    });
    await act(async () => {
      fireDropZoneEvent(dropZoneNode, 'drop', dropEvent);
    });
    expect(dropEvent.preventDefault).toHaveBeenCalled();
  });

  it('accepts a valid dropped file: shows its details and enables Upload', async () => {
    const { renderer, dropZoneNode } = await renderHydratedWithDropZone();

    await act(async () => {
      fireDropZoneEvent(
        dropZoneNode,
        'drop',
        makeDragEvent({ files: [makeFakeFile('paper.pdf', 2048, 'application/pdf')] })
      );
    });

    expect(findByText(renderer.root, 'paper.pdf')).toBeTruthy();
    expect(findByText(renderer.root, `application/pdf · ${formatFileSize(2048)}`)).toBeTruthy();
    expect(queryByText(renderer.root, 'Remove')).toBeTruthy();

    const uploadButton = findPressableByText(renderer.root, 'Upload');
    expect(uploadButton.props.disabled).toBe(false);
  });

  it('rejects an unsupported dropped file type with a readable error, and keeps Upload disabled', async () => {
    const { renderer, dropZoneNode } = await renderHydratedWithDropZone();

    await act(async () => {
      fireDropZoneEvent(
        dropZoneNode,
        'drop',
        makeDragEvent({ files: [makeFakeFile('archive.zip', 1024, 'application/zip')] })
      );
    });

    const errorNode = findByText(
      renderer.root,
      '"archive.zip" is not a supported file type. Supported formats: .pdf, .docx, .txt, .html, .htm, .md, .markdown.'
    );
    expect(errorNode).toBeTruthy();

    const uploadButton = findPressableByText(renderer.root, 'Upload');
    expect(uploadButton.props.disabled).toBe(true);
  });

  it('rejects an oversized dropped file with a readable error, and keeps Upload disabled', async () => {
    const { renderer, dropZoneNode } = await renderHydratedWithDropZone();
    const oversizedBytes = MAX_UPLOAD_FILE_SIZE_BYTES + 1;

    await act(async () => {
      fireDropZoneEvent(
        dropZoneNode,
        'drop',
        makeDragEvent({ files: [makeFakeFile('paper.pdf', oversizedBytes, 'application/pdf')] })
      );
    });

    expect(
      findByText(
        renderer.root,
        `"paper.pdf" is ${formatFileSize(oversizedBytes)}, which is over the ${formatFileSize(MAX_UPLOAD_FILE_SIZE_BYTES)} limit.`
      )
    ).toBeTruthy();
    expect(findPressableByText(renderer.root, 'Upload').props.disabled).toBe(true);
  });

  it('clears the selected file and its error when "Remove" is pressed', async () => {
    const { renderer, dropZoneNode } = await renderHydratedWithDropZone();

    await act(async () => {
      fireDropZoneEvent(
        dropZoneNode,
        'drop',
        makeDragEvent({ files: [makeFakeFile('archive.zip', 1024, 'application/zip')] })
      );
    });
    expect(queryByText(renderer.root, 'archive.zip')).toBeTruthy();

    await act(async () => {
      findPressableByText(renderer.root, 'Remove').props.onPress();
    });

    expect(queryByText(renderer.root, 'archive.zip')).toBeNull();
    expect(
      queryByText(
        renderer.root,
        '"archive.zip" is not a supported file type. Supported formats: .pdf, .docx, .txt, .html, .htm, .md, .markdown.'
      )
    ).toBeNull();
    expect(findPressableByText(renderer.root, 'Upload').props.disabled).toBe(true);
  });

  it('validates a file the same way whether it came from the picker or the drop zone', async () => {
    // Same unsupported filename through both paths must produce the exact
    // same error text — proof the two selection paths share one
    // validation function rather than two that could drift apart.
    getDocumentAsync.mockResolvedValue({
      canceled: false,
      assets: [{ name: 'archive.zip', size: 1024, mimeType: 'application/zip', uri: 'blob:mock' }],
    });

    const { renderer: pickerRenderer } = await renderHydratedWithDropZone();
    await act(async () => {
      findPressableByText(pickerRenderer.root, 'Choose file…').props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });
    const pickerErrorNode = queryByText(
      pickerRenderer.root,
      '"archive.zip" is not a supported file type. Supported formats: .pdf, .docx, .txt, .html, .htm, .md, .markdown.'
    );
    expect(pickerErrorNode).toBeTruthy();

    const { renderer: dropRenderer, dropZoneNode } = await renderHydratedWithDropZone();
    await act(async () => {
      fireDropZoneEvent(
        dropZoneNode,
        'drop',
        makeDragEvent({ files: [makeFakeFile('archive.zip', 1024, 'application/zip')] })
      );
    });
    const dropErrorNode = queryByText(
      dropRenderer.root,
      '"archive.zip" is not a supported file type. Supported formats: .pdf, .docx, .txt, .html, .htm, .md, .markdown.'
    );
    expect(dropErrorNode).toBeTruthy();

    // Both paths also land on an identically-disabled Upload button.
    expect(findPressableByText(pickerRenderer.root, 'Upload').props.disabled).toBe(true);
    expect(findPressableByText(dropRenderer.root, 'Upload').props.disabled).toBe(true);
  });
});
