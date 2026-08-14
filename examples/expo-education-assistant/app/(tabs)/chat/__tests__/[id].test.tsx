import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { Alert, Dimensions, FlatList, Platform } from 'react-native';
import { ConversationTurnCard } from '@/components/ConversationTurnCard';
import { AuthProvider } from '@/lib/AuthProvider';
import { ChatConversationsProvider } from '@/lib/ChatConversationsContext';
import { ClientProvider } from '@/lib/ClientProvider';
import { FeatureFlagsProvider } from '@/lib/FeatureFlags';
import ChatConversationRoute from '../[id]';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

jest.mock('expo-image-picker', () => ({
  requestMediaLibraryPermissionsAsync: jest.fn().mockResolvedValue({ granted: true }),
  requestCameraPermissionsAsync: jest.fn().mockResolvedValue({ granted: true }),
  launchImageLibraryAsync: jest.fn().mockResolvedValue({
    canceled: false,
    assets: [
      {
        uri: 'file:///tmp/photo.png',
        fileName: 'photo.png',
        fileSize: 2048,
        mimeType: 'image/png',
      },
    ],
  }),
  launchCameraAsync: jest.fn(),
}));

jest.mock('expo-document-picker', () => ({
  getDocumentAsync: jest.fn().mockResolvedValue({
    canceled: false,
    assets: [
      {
        uri: 'file:///tmp/report.pdf',
        name: 'report.pdf',
        size: 204_800,
        mimeType: 'application/pdf',
      },
    ],
  }),
}));

const mockParams: { id: string } = { id: 'c1' };
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockParams,
  usePathname: () => '/chat/c1',
  useGlobalSearchParams: () => ({}),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));

function findByText(root: ReactTestInstance, text: string): ReactTestInstance {
  return root.find((node) => String(node.type) === 'Text' && node.children.includes(text));
}

function queryByText(root: ReactTestInstance, text: string): ReactTestInstance | null {
  const matches = root.findAll(
    (node) => String(node.type) === 'Text' && node.children.includes(text)
  );
  return matches[0] ?? null;
}

/** Merges a React Native style prop (a single object, or a nested array of
 * objects/falsy values — exactly what a `style={[a, b, c]}` prop resolves
 * to) into one plain object, later entries winning — the same semantics
 * RN itself applies when flattening a style array for layout. */
function flattenStyle(style: unknown): Record<string, unknown> {
  if (!style) return {};
  if (Array.isArray(style)) {
    return style.reduce(
      (acc: Record<string, unknown>, entry) => ({ ...acc, ...flattenStyle(entry) }),
      {}
    );
  }
  return style as Record<string, unknown>;
}

/** The width/maxWidth/alignSelf triple that governs how wide a "canvas"
 * element (the message column, the composer, a top banner) actually
 * renders — the exact properties the recovery-banner regression test
 * below compares between the normal and recovering states. */
function widthConfigOf(node: ReactTestInstance): {
  width: unknown;
  maxWidth: unknown;
  alignSelf: unknown;
} {
  const flat = flattenStyle(node.props.style);
  return { width: flat.width, maxWidth: flat.maxWidth, alignSelf: flat.alignSelf };
}

/** Walks up from `node` to the nearest ancestor (inclusive) whose own
 * style sets `maxWidth` — i.e. the width-capped "inner content" wrapper
 * around it (turnWrap, the composer's inner View, or a top banner's inner
 * View), regardless of how many plain layout Views sit in between. */
function ancestorWithMaxWidth(node: ReactTestInstance): ReactTestInstance {
  let current: ReactTestInstance | null = node;
  while (current) {
    if (flattenStyle(current.props.style).maxWidth !== undefined) return current;
    current = current.parent;
  }
  throw new Error('No ancestor with a maxWidth style was found');
}

function findPressableByText(root: ReactTestInstance, text: string): ReactTestInstance {
  return root.find(
    (node) =>
      typeof node.props.onPress === 'function' &&
      node.findAll((n) => String(n.type) === 'Text' && n.children.includes(text)).length > 0
  );
}

function sseResponse(events: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(event));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function sseEvent(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

interface ControllableSse {
  response: Response;
  push: (event: string) => void;
  close: () => void;
}

/** An SSE response body the test can feed events into on demand — see
 * new.test.tsx's identical helper for why (proving a Cancel press actually
 * interrupts an in-flight stream, not just a completed one). */
function controllableSseResponse(): ControllableSse {
  const encoder = new TextEncoder();
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      ctrl = controller;
    },
  });
  return {
    response: new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }),
    push: (event: string) => ctrl.enqueue(encoder.encode(event)),
    close: () => ctrl.close(),
  };
}

function conversationDetail(
  id: string,
  messages: unknown[] = [],
  projects: { id: string; name: string }[] = []
): Response {
  return new Response(
    JSON.stringify({
      id,
      title: 'New conversation',
      title_is_custom: false,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      messages,
      projects,
    }),
    { status: 200 }
  );
}

async function renderChat(
  refreshConversations: () => void = jest.fn()
): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <AuthProvider>
        <ClientProvider>
          <FeatureFlagsProvider>
            <ChatConversationsProvider value={{ refreshConversations }}>
              <ChatConversationRoute />
            </ChatConversationsProvider>
          </FeatureFlagsProvider>
        </ClientProvider>
      </AuthProvider>
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  return renderer;
}

describe('ChatConversationRoute ([id])', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('loads and renders an existing conversation history', async () => {
    mockParams.id = 'c1';
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/auth/refresh')) {
        return new Response(JSON.stringify({ detail: 'none' }), { status: 401 });
      }
      if (url.includes('/auth/providers')) {
        return new Response(JSON.stringify({ providers: [], dev_login_enabled: false }), {
          status: 200,
        });
      }
      if (url.endsWith('/conversations/c1')) {
        return new Response(
          JSON.stringify({
            id: 'c1',
            title: 'Peer tutoring',
            title_is_custom: true,
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
            messages: [
              {
                id: 'm1',
                role: 'user',
                content: 'Does peer tutoring help?',
                citations: [],
                citation_warnings: [],
                insufficient_evidence: false,
                created_at: '2026-01-01T00:00:00Z',
                sources: [],
              },
              {
                id: 'm2',
                role: 'assistant',
                content: 'Yes, according to the research.',
                citations: [],
                citation_warnings: [],
                insufficient_evidence: false,
                created_at: '2026-01-01T00:00:01Z',
                sources: [],
              },
            ],
          }),
          { status: 200 }
        );
      }
      throw new Error(`Unexpected fetch call to ${url} in this test`);
    }) as unknown as typeof fetch;

    const renderer = await renderChat();

    expect(findByText(renderer.root, 'Does peer tutoring help?')).toBeTruthy();
    expect(queryByText(renderer.root, 'Ask about the corpus.')).toBeNull();
  });

  it('renders an attachment chip for a persisted user message (milestone V2)', async () => {
    mockParams.id = 'c5';
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/auth/refresh')) {
        return new Response(JSON.stringify({ detail: 'none' }), { status: 401 });
      }
      if (url.includes('/auth/providers')) {
        return new Response(JSON.stringify({ providers: [], dev_login_enabled: false }), {
          status: 200,
        });
      }
      if (url.endsWith('/conversations/c5')) {
        return new Response(
          JSON.stringify({
            id: 'c5',
            title: 'With a photo',
            title_is_custom: true,
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
            messages: [
              {
                id: 'm1',
                role: 'user',
                content: 'What is in this picture?',
                citations: [],
                citation_warnings: [],
                insufficient_evidence: false,
                created_at: '2026-01-01T00:00:00Z',
                sources: [],
                attachments: [
                  {
                    id: 'a1',
                    mime: 'image/png',
                    filename: 'photo.png',
                    size_bytes: 2048,
                    page_count: null,
                    page_range_start: null,
                    page_range_end: null,
                    created_at: '2026-01-01T00:00:00Z',
                  },
                ],
              },
            ],
          }),
          { status: 200 }
        );
      }
      throw new Error(`Unexpected fetch call to ${url} in this test`);
    }) as unknown as typeof fetch;

    const renderer = await renderChat();

    expect(findByText(renderer.root, 'photo.png')).toBeTruthy();
  });

  it('does not fetch or send anything based on query-string state — the input starts empty', async () => {
    mockParams.id = 'c4';
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/auth/refresh')) {
        return new Response(JSON.stringify({ detail: 'none' }), { status: 401 });
      }
      if (url.includes('/auth/providers')) {
        return new Response(JSON.stringify({ providers: [], dev_login_enabled: false }), {
          status: 200,
        });
      }
      if (url.endsWith('/conversations/c4')) {
        return new Response(
          JSON.stringify({
            id: 'c4',
            title: 'New conversation',
            title_is_custom: false,
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
            messages: [],
          }),
          { status: 200 }
        );
      }
      throw new Error(`Unexpected fetch call to ${url} in this test`);
    }) as unknown as typeof fetch;

    const renderer = await renderChat();

    const input = renderer.root.find((node) => String(node.type) === 'TextInput');
    expect(input.props.value).toBe('');
    expect(queryByText(renderer.root, 'Ask a question about the corpus.')).toBeTruthy();
  });

  it('refreshes the sidebar once a follow-up message finishes sending', async () => {
    mockParams.id = 'c5';
    const refreshConversations = jest.fn();
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/auth/refresh')) {
        return new Response(JSON.stringify({ detail: 'none' }), { status: 401 });
      }
      if (url.includes('/auth/providers')) {
        return new Response(JSON.stringify({ providers: [], dev_login_enabled: false }), {
          status: 200,
        });
      }
      if (url.endsWith('/conversations/c5')) {
        return new Response(
          JSON.stringify({
            id: 'c5',
            title: 'New conversation',
            title_is_custom: false,
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
            messages: [],
          }),
          { status: 200 }
        );
      }
      if (url.endsWith('/conversations/c5/messages')) {
        void init;
        return sseResponse([
          sseEvent({ type: 'token', content: 'Yes.' }),
          sseEvent({ type: 'sources', sources: [] }),
          sseEvent({
            type: 'done',
            citations: [],
            citation_warnings: [],
            insufficient_evidence: false,
          }),
        ]);
      }
      throw new Error(`Unexpected fetch call to ${url} in this test`);
    }) as unknown as typeof fetch;

    const renderer = await renderChat(refreshConversations);

    const input = renderer.root.find((node) => String(node.type) === 'TextInput');
    act(() => {
      input.props.onChangeText('A follow-up question');
    });
    await act(async () => {
      input.props.onSubmitEditing();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // The thinking placeholder's short exit fade holds the answer back
    // briefly after the stream finishes — let it elapse.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    expect(findByText(renderer.root, 'Yes.')).toBeTruthy();
    expect(refreshConversations).toHaveBeenCalled();
  });

  it('shows the thinking placeholder the moment a follow-up is sent, and the first token replaces it inside the same turn', async () => {
    mockParams.id = 'c-think';
    let controllable: ControllableSse | undefined;
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/auth/refresh')) {
        return new Response(JSON.stringify({ detail: 'none' }), { status: 401 });
      }
      if (url.includes('/auth/providers')) {
        return new Response(JSON.stringify({ providers: [], dev_login_enabled: false }), {
          status: 200,
        });
      }
      if (url.endsWith('/conversations/c-think')) return conversationDetail('c-think');
      if (url.endsWith('/conversations/c-think/messages')) {
        controllable = controllableSseResponse();
        return controllable.response;
      }
      throw new Error(`Unexpected fetch call to ${url} in this test`);
    }) as unknown as typeof fetch;

    const renderer = await renderChat();

    const input = renderer.root.find((node) => String(node.type) === 'TextInput');
    act(() => {
      input.props.onChangeText('How do plants grow?');
    });
    await act(async () => {
      findPressableByText(renderer.root, 'Ask').props.onPress();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // Immediately after submission — before any SSE event has arrived — the
    // pending assistant bubble shows the "Preparing a response..." title and
    // the truthful shadow-box status for a plain chat request, never the
    // retired "Connecting…" label or a spinner.
    expect(queryByText(renderer.root, 'Preparing a response...')).toBeTruthy();
    expect(queryByText(renderer.root, 'Understanding your question...')).toBeTruthy();
    expect(queryByText(renderer.root, 'Connecting…')).toBeNull();
    // Exactly one turn card: the pending assistant message was appended in
    // place, not as a second bubble.
    expect(renderer.root.findAllByType(ConversationTurnCard)).toHaveLength(1);

    // The first streamed token swaps the placeholder for the real answer
    // inside that same turn — still one card, never both texts at once.
    await act(async () => {
      controllable!.push(sseEvent({ type: 'token', content: 'With sunlight.' }));
      await Promise.resolve();
      await Promise.resolve();
    });

    // The answer is held back until the placeholder's short exit fade
    // completes — the two are never rendered at the same time.
    expect(queryByText(renderer.root, 'With sunlight.')).toBeNull();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });

    expect(queryByText(renderer.root, 'Preparing a response...')).toBeNull();
    expect(queryByText(renderer.root, 'Understanding your question...')).toBeNull();
    expect(findByText(renderer.root, 'With sunlight.')).toBeTruthy();
    expect(renderer.root.findAllByType(ConversationTurnCard)).toHaveLength(1);

    await act(async () => {
      controllable!.push(
        sseEvent({
          type: 'done',
          citations: [],
          citation_warnings: [],
          insufficient_evidence: false,
        })
      );
      controllable!.close();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  });

  it('shows the corpus toggle only after attaching an image, and sends use_corpus=true when it is switched on (milestone V3)', async () => {
    // See new.test.tsx's identical test for why a lenient FormData
    // stand-in replaces Node's spec-strict global one here.
    class FakeFormData {
      private entries: [string, unknown][] = [];
      append(key: string, value: unknown): void {
        this.entries.push([key, value]);
      }
      getAll(key: string): unknown[] {
        return this.entries.filter(([k]) => k === key).map(([, v]) => v);
      }
    }
    const OriginalFormData = global.FormData;

    global.FormData = FakeFormData as any;

    mockParams.id = 'c6';
    let capturedFormData: FakeFormData | null = null;
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/auth/refresh')) {
        return new Response(JSON.stringify({ detail: 'none' }), { status: 401 });
      }
      if (url.includes('/auth/providers')) {
        return new Response(JSON.stringify({ providers: [], dev_login_enabled: false }), {
          status: 200,
        });
      }
      if (url.endsWith('/conversations/c6')) {
        return new Response(
          JSON.stringify({
            id: 'c6',
            title: 'New conversation',
            title_is_custom: false,
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
            messages: [],
          }),
          { status: 200 }
        );
      }
      if (url.endsWith('/conversations/c6/messages')) {
        capturedFormData = init?.body as unknown as FakeFormData;
        return sseResponse([
          sseEvent({
            type: 'done',
            citations: [],
            citation_warnings: [],
            insufficient_evidence: false,
          }),
        ]);
      }
      throw new Error(`Unexpected fetch call to ${url} in this test`);
    }) as unknown as typeof fetch;
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    alertSpy.mockClear();

    try {
      const renderer = await renderChat();

      expect(
        renderer.root.findAll(
          (node) => node.props.accessibilityLabel === 'Also use my research corpus'
        )
      ).toHaveLength(0);

      const attachButton = renderer.root.find(
        (node) => node.props.accessibilityLabel === 'Attach image or PDF'
      );
      await act(async () => {
        attachButton.props.onPress();
      });
      const alertOptions = alertSpy.mock.calls[0]![2] as {
        text: string;
        onPress?: () => void;
      }[];
      await act(async () => {
        alertOptions.find((option) => option.text === 'Photo Library')!.onPress!();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      const toggle = renderer.root.find(
        (node) => node.props.accessibilityLabel === 'Also use my research corpus'
      );
      await act(async () => {
        toggle.props.onValueChange(true);
      });

      const input = renderer.root.find((node) => String(node.type) === 'TextInput');
      act(() => {
        input.props.onChangeText('What is in this picture?');
      });
      await act(async () => {
        findPressableByText(renderer.root, 'Ask').props.onPress();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(capturedFormData).not.toBeNull();
      expect(capturedFormData!.getAll('use_corpus')).toEqual(['true']);
      expect(capturedFormData!.getAll('files')).toHaveLength(1);
    } finally {
      global.FormData = OriginalFormData;
    }
  });

  it('submits a PDF attachment without any user-selected page range — the backend analyzes the whole document automatically', async () => {
    class FakeFormData {
      private entries: [string, unknown][] = [];
      append(key: string, value: unknown): void {
        this.entries.push([key, value]);
      }
      getAll(key: string): unknown[] {
        return this.entries.filter(([k]) => k === key).map(([, v]) => v);
      }
    }
    const OriginalFormData = global.FormData;
    global.FormData = FakeFormData as any;

    mockParams.id = 'c10';
    let capturedFormData: FakeFormData | null = null;
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/auth/refresh')) {
        return new Response(JSON.stringify({ detail: 'none' }), { status: 401 });
      }
      if (url.includes('/auth/providers')) {
        return new Response(JSON.stringify({ providers: [], dev_login_enabled: false }), {
          status: 200,
        });
      }
      if (url.endsWith('/conversations/c10')) return conversationDetail('c10');
      if (url.endsWith('/conversations/c10/messages')) {
        capturedFormData = init?.body as unknown as FakeFormData;
        return sseResponse([
          sseEvent({
            type: 'done',
            citations: [],
            citation_warnings: [],
            insufficient_evidence: false,
          }),
        ]);
      }
      throw new Error(`Unexpected fetch call to ${url} in this test`);
    }) as unknown as typeof fetch;
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    alertSpy.mockClear();

    try {
      const renderer = await renderChat();

      const attachButton = renderer.root.find(
        (node) => node.props.accessibilityLabel === 'Attach image or PDF'
      );
      await act(async () => {
        attachButton.props.onPress();
      });
      const alertOptions = alertSpy.mock.calls[0]![2] as {
        text: string;
        onPress?: () => void;
      }[];
      await act(async () => {
        alertOptions.find((option) => option.text === 'Files')!.onPress!();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      const input = renderer.root.find((node) => String(node.type) === 'TextInput');
      act(() => {
        input.props.onChangeText('Summarize this PDF');
      });
      await act(async () => {
        findPressableByText(renderer.root, 'Ask').props.onPress();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(capturedFormData).not.toBeNull();
      expect(capturedFormData!.getAll('files')).toHaveLength(1);
      // No page range was ever chosen in the UI — the request must carry
      // null, never a user-selected {start, end}.
      expect(capturedFormData!.getAll('page_ranges')).toEqual([JSON.stringify([null])]);
    } finally {
      global.FormData = OriginalFormData;
    }
  });

  it('renders neither quick-action chips nor PDF page-range controls after attaching a file in an existing conversation (simplified attachment UI)', async () => {
    mockParams.id = 'c9';
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/auth/refresh')) {
        return new Response(JSON.stringify({ detail: 'none' }), { status: 401 });
      }
      if (url.includes('/auth/providers')) {
        return new Response(JSON.stringify({ providers: [], dev_login_enabled: false }), {
          status: 200,
        });
      }
      if (url.endsWith('/conversations/c9')) return conversationDetail('c9');
      throw new Error(`Unexpected fetch call to ${url} in this test`);
    }) as unknown as typeof fetch;
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    alertSpy.mockClear();

    const renderer = await renderChat();

    const attachButton = renderer.root.find(
      (node) => node.props.accessibilityLabel === 'Attach image or PDF'
    );
    await act(async () => {
      attachButton.props.onPress();
    });
    const alertOptions = alertSpy.mock.calls[0]![2] as {
      text: string;
      onPress?: () => void;
    }[];
    await act(async () => {
      alertOptions.find((option) => option.text === 'Photo Library')!.onPress!();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      renderer.root.findAll(
        (node) =>
          typeof node.props.accessibilityLabel === 'string' &&
          node.props.accessibilityLabel.startsWith('Quick action:')
      )
    ).toHaveLength(0);
    expect(queryByText(renderer.root, 'Pages')).toBeNull();
    expect(renderer.root.findAllByType('TextInput' as never)).toHaveLength(1); // just the chat input
  });

  // --- Retry / Cancel for follow-up messages (milestone V4) ---

  it('shows Retry after a follow-up message fails, and Retry resends without duplicating the failed turn', async () => {
    mockParams.id = 'c7';
    let attempt = 0;
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/auth/refresh')) {
        return new Response(JSON.stringify({ detail: 'none' }), { status: 401 });
      }
      if (url.includes('/auth/providers')) {
        return new Response(JSON.stringify({ providers: [], dev_login_enabled: false }), {
          status: 200,
        });
      }
      if (url.endsWith('/conversations/c7')) return conversationDetail('c7');
      if (url.endsWith('/conversations/c7/messages')) {
        void init;
        attempt += 1;
        if (attempt === 1) {
          return sseResponse([sseEvent({ type: 'error', message: 'LLM unavailable' })]);
        }
        return sseResponse([
          sseEvent({ type: 'token', content: 'Yes.' }),
          sseEvent({ type: 'sources', sources: [] }),
          sseEvent({
            type: 'done',
            citations: [],
            citation_warnings: [],
            insufficient_evidence: false,
          }),
        ]);
      }
      throw new Error(`Unexpected fetch call to ${url} in this test`);
    }) as unknown as typeof fetch;

    const renderer = await renderChat();

    const input = renderer.root.find((node) => String(node.type) === 'TextInput');
    act(() => {
      input.props.onChangeText('A follow-up question');
    });
    await act(async () => {
      findPressableByText(renderer.root, 'Ask').props.onPress();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(findByText(renderer.root, 'LLM unavailable')).toBeTruthy();
    expect(findPressableByText(renderer.root, 'Retry')).toBeTruthy();
    // Exactly one user+assistant pair so far (the failed attempt).
    expect(
      renderer.root.findAll(
        (n) => String(n.type) === 'Text' && n.children.includes('A follow-up question')
      )
    ).toHaveLength(1);

    await act(async () => {
      findPressableByText(renderer.root, 'Retry').props.onPress();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // The thinking placeholder's short exit fade holds the answer back
    // briefly after the stream finishes — let it elapse.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    expect(findByText(renderer.root, 'Yes.')).toBeTruthy();
    expect(queryByText(renderer.root, 'LLM unavailable')).toBeNull();
    expect(queryByText(renderer.root, 'Retry')).toBeNull();
    // Still just one user bubble for the question — the failed turn was
    // replaced, not left stacked above the successful retry.
    expect(
      renderer.root.findAll(
        (n) => String(n.type) === 'Text' && n.children.includes('A follow-up question')
      )
    ).toHaveLength(1);
  });

  it('lets the user cancel an in-flight follow-up message via the Cancel button', async () => {
    mockParams.id = 'c8';
    let controllable: ControllableSse | undefined;
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/auth/refresh')) {
        return new Response(JSON.stringify({ detail: 'none' }), { status: 401 });
      }
      if (url.includes('/auth/providers')) {
        return new Response(JSON.stringify({ providers: [], dev_login_enabled: false }), {
          status: 200,
        });
      }
      if (url.endsWith('/conversations/c8')) return conversationDetail('c8');
      if (url.endsWith('/conversations/c8/messages')) {
        controllable = controllableSseResponse();
        return controllable.response;
      }
      throw new Error(`Unexpected fetch call to ${url} in this test`);
    }) as unknown as typeof fetch;

    const renderer = await renderChat();

    const input = renderer.root.find((node) => String(node.type) === 'TextInput');
    act(() => {
      input.props.onChangeText('Cancel me');
    });
    await act(async () => {
      findPressableByText(renderer.root, 'Ask').props.onPress();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(findPressableByText(renderer.root, 'Cancel')).toBeTruthy();

    await act(async () => {
      findPressableByText(renderer.root, 'Cancel').props.onPress();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // Cancelling returns the composer straight to idle (no error banner) —
    // see useConversationMessages' RequestCancelledError branch.
    expect(queryByText(renderer.root, 'Retry')).toBeNull();
    expect(findPressableByText(renderer.root, 'Ask')).toBeTruthy();
    controllable!.close();
  });

  it('renders a generated-image message as a standalone turn (image generation), never glued onto an unrelated pending question', async () => {
    mockParams.id = 'c-img';
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/auth/refresh')) {
        return new Response(JSON.stringify({ detail: 'none' }), { status: 401 });
      }
      if (url.includes('/auth/providers')) {
        return new Response(JSON.stringify({ providers: [], dev_login_enabled: false }), {
          status: 200,
        });
      }
      if (url.endsWith('/conversations/c-img')) {
        return conversationDetail('c-img', [
          {
            id: 'm1',
            role: 'assistant',
            content: 'a red apple on a table',
            citations: [],
            citation_warnings: [],
            insufficient_evidence: false,
            created_at: '2026-01-01T00:00:00Z',
            sources: [],
            attachments: [
              {
                id: 'a1',
                mime: 'image/png',
                filename: 'generated-a1.png',
                size_bytes: 2048,
                page_count: null,
                page_range_start: null,
                page_range_end: null,
                created_at: '2026-01-01T00:00:00Z',
                source: 'generated',
                generation_prompt: 'a red apple on a table',
                generation_negative_prompt: null,
                generation_seed: 7,
                generation_model: 'x/flux2-klein',
                generation_width: 512,
                generation_height: 512,
              },
            ],
          },
        ]);
      }
      throw new Error(`Unexpected fetch call to ${url} in this test`);
    }) as unknown as typeof fetch;

    const renderer = await renderChat();

    // The prompt caption, and the gallery's action buttons, both render —
    // and there is no empty user bubble for this message's (never sent)
    // "userContent".
    expect(queryByText(renderer.root, '“a red apple on a table”')).toBeTruthy();
    expect(
      renderer.root.findAll(
        (n) =>
          n.props.accessibilityLabel === 'Download image' && typeof n.props.onPress === 'function'
      )
    ).toHaveLength(1);
    expect(queryByText(renderer.root, 'Ask about the corpus.')).toBeNull();

    const regenerateButton = renderer.root.find(
      (node) =>
        node.props.accessibilityLabel === 'Regenerate image' &&
        typeof node.props.onPress === 'function'
    );
    await act(async () => {
      regenerateButton.props.onPress();
    });

    const promptInput = renderer.root.find(
      (node) => node.props.accessibilityLabel === 'Image prompt'
    );
    expect(promptInput.props.value).toBe('a red apple on a table');
  });

  /**
   * Regression coverage for the "chat canvas visibly shrinks while the
   * recovery banner is showing" bug.
   *
   * The real root cause was NOT the banner's own styling (an earlier,
   * incomplete fix addressed only that): `listContent`'s `alignItems:
   * 'center'` stopped FlatList's per-row wrapper from stretching to the
   * list's own width, which left turnWrap's `width: '100%'` resolving
   * against an *indeterminate* (content-fitted) parent instead of a fixed
   * one — so turnWrap's actual rendered width silently tracked whatever
   * was inside it (a full streamed answer vs. an empty/compact thinking
   * placeholder, which is exactly what a resuming-generation turn shows)
   * rather than staying a stable reading-column width. Fixed by moving
   * the centering onto turnWrap itself (`alignSelf: 'center'`, the same
   * technique ChatComposer's own `inner` style already used successfully)
   * and letting `listContent` stretch.
   *
   * The tests below only check style *props* — react-test-renderer never
   * runs a real flexbox layout, so they cannot see the actual bug (the
   * style objects here were identical between states even while the bug
   * was live). The real, rendered-layout regression guard is the
   * bounding-box test in e2e/tests/stream-recovery.spec.ts ("the message
   * column and composer render at identical position/width..."), which
   * runs in a real browser.
   */
  describe('recovery banner layout regression', () => {
    const RECOVERY_BANNER_TEXT = 'Picking up a response that was still being generated…';

    function baseMessages(assistantStatus: 'complete' | 'generating'): unknown[] {
      return [
        {
          id: 'm1',
          role: 'user',
          content: 'Does peer tutoring help?',
          citations: [],
          citation_warnings: [],
          insufficient_evidence: false,
          created_at: '2026-01-01T00:00:00Z',
          sources: [],
        },
        {
          id: 'm2',
          role: 'assistant',
          content:
            assistantStatus === 'complete' ? 'Yes, according to the research.' : 'Partial answer',
          citations: [],
          citation_warnings: [],
          insufficient_evidence: false,
          created_at: '2026-01-01T00:00:01Z',
          sources: [],
          status: assistantStatus,
        },
      ];
    }

    function mockFetchFor(id: string, messages: unknown[]): typeof fetch {
      return jest.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('/auth/refresh')) {
          return new Response(JSON.stringify({ detail: 'none' }), { status: 401 });
        }
        if (url.includes('/auth/providers')) {
          return new Response(JSON.stringify({ providers: [], dev_login_enabled: false }), {
            status: 200,
          });
        }
        if (url.endsWith(`/conversations/${id}`)) {
          return conversationDetail(id, messages);
        }
        throw new Error(`Unexpected fetch call to ${url} in this test`);
      }) as unknown as typeof fetch;
    }

    /** The three "canvas" width landmarks the recovery banner must never
     * move: the message column's own wrapper (turnWrap), the composer's
     * width-capped inner View, and the scrollable list area's flex
     * container (the FlatList's direct parent). */
    function canvasLandmarks(renderer: ReactTestRenderer) {
      const turnWrap = ancestorWithMaxWidth(findByText(renderer.root, 'Does peer tutoring help?'));
      const composerInner = ancestorWithMaxWidth(
        renderer.root.find((node) => node.props.accessibilityLabel === 'Ask a question')
      );
      const listWrap = renderer.root.findByType(FlatList).parent!;
      return { turnWrap, composerInner, listWrap };
    }

    it('renders no recovery banner and a normal-width canvas for a normal conversation', async () => {
      mockParams.id = 'c-normal';
      global.fetch = mockFetchFor('c-normal', baseMessages('complete'));
      const renderer = await renderChat();

      expect(queryByText(renderer.root, RECOVERY_BANNER_TEXT)).toBeNull();
      const { turnWrap, composerInner } = canvasLandmarks(renderer);
      // `alignSelf: 'center'` (not an ancestor's `alignItems: 'center'`) is
      // what does turnWrap's centering — see listContent's own style
      // assertion below for why that distinction is the actual fix, not
      // just a style-name difference.
      expect(widthConfigOf(turnWrap)).toEqual({
        width: '100%',
        maxWidth: 720,
        alignSelf: 'center',
      });
      expect(widthConfigOf(composerInner).maxWidth).toBe(720);
    });

    it("never reintroduces alignItems on listContent — that is what made turnWrap's width content-dependent", async () => {
      // This is a narrow, jest-catchable guard on the exact style-level
      // regression (see this describe block's own top-of-file docs for
      // the full root-cause explanation) — it is NOT a substitute for a
      // real rendered-layout check: react-test-renderer never runs an
      // actual flexbox layout, so it cannot see turnWrap's width silently
      // tracking its content the way a real browser does. The
      // bounding-box regression test in
      // e2e/tests/stream-recovery.spec.ts ("the message column and
      // composer render at identical position/width...") is what
      // actually caught the original bug and is what continues to guard
      // against it; this test only stops someone from casually
      // reintroducing the exact style that caused it.
      mockParams.id = 'c-normal';
      global.fetch = mockFetchFor('c-normal', baseMessages('complete'));
      const renderer = await renderChat();

      const flatList = renderer.root.findByType(FlatList);
      const contentContainerStyle = flattenStyle(flatList.props.contentContainerStyle);
      expect(contentContainerStyle.alignItems).not.toBe('center');
    });

    it('keeps the message column, composer, and list-area flex identical whether or not the recovery banner is showing', async () => {
      mockParams.id = 'c-normal';
      global.fetch = mockFetchFor('c-normal', baseMessages('complete'));
      const normalRenderer = await renderChat();
      const normal = canvasLandmarks(normalRenderer);
      const normalWidths = {
        turnWrap: widthConfigOf(normal.turnWrap),
        composerInner: widthConfigOf(normal.composerInner),
        listWrapFlex: flattenStyle(normal.listWrap.props.style).flex,
      };

      mockParams.id = 'c-recovering';
      global.fetch = mockFetchFor('c-recovering', baseMessages('generating'));
      const recoveringRenderer = await renderChat();

      // Sanity: this render actually is the recovery state under test.
      expect(queryByText(recoveringRenderer.root, RECOVERY_BANNER_TEXT)).toBeTruthy();

      const recovering = canvasLandmarks(recoveringRenderer);
      // Style-prop-level guard only (see the "never reintroduces
      // alignItems on listContent" test above and
      // e2e/tests/stream-recovery.spec.ts for the real, rendered-layout
      // guard against the actual bug — the message/composer *style
      // objects* here were already identical between states even while
      // the real bug was live, since the divergence only happened during
      // an actual browser's flex resolution, which react-test-renderer
      // never runs). Kept as a cheap sanity check that a future change
      // doesn't make the banner wrap or restyle turnWrap/the composer
      // directly (e.g. by reusing turnWrap's container instead of adding
      // a sibling).
      expect(widthConfigOf(recovering.turnWrap)).toEqual(normalWidths.turnWrap);
      expect(widthConfigOf(recovering.composerInner)).toEqual(normalWidths.composerInner);
      expect(flattenStyle(recovering.listWrap.props.style).flex).toBe(normalWidths.listWrapFlex);
    });

    it('gives the recovery banner the same inner content width as the message column and composer — it must never render edge-to-edge', async () => {
      mockParams.id = 'c-recovering';
      global.fetch = mockFetchFor('c-recovering', baseMessages('generating'));
      const renderer = await renderChat();

      const bannerInner = ancestorWithMaxWidth(findByText(renderer.root, RECOVERY_BANNER_TEXT));
      const { turnWrap, composerInner } = canvasLandmarks(renderer);

      // The banner has no centering ancestor of its own (unlike turnWrap,
      // which is centered by listContent's alignItems: 'center'), so it
      // self-centers exactly the way the composer's own inner View
      // does — same mechanism, same resulting width — rather than relying
      // on turnWrap's specific (ancestor-driven) centering technique.
      expect(widthConfigOf(bannerInner)).toEqual(widthConfigOf(composerInner));
      expect(widthConfigOf(bannerInner).maxWidth).toBe(widthConfigOf(turnWrap).maxWidth);
    });

    it('still renders the Cancel action, wired to cancelPersistedGeneration', async () => {
      mockParams.id = 'c-recovering';
      global.fetch = mockFetchFor('c-recovering', baseMessages('generating'));
      const renderer = await renderChat();

      expect(findPressableByText(renderer.root, 'Cancel')).toBeTruthy();
    });
  });

  describe('Chat Sources (Milestone 3)', () => {
    // Not `findByText`'s exact-single-child match: `Selected ({n})` compiles
    // to multiple Text children (`["Selected (", n, ")"]`), so this joins
    // them first — same technique documentsFolderLibrary.test.tsx (Milestone 1)
    // already uses for the same reason.
    function findByTextIncluding(root: ReactTestInstance, substring: string): ReactTestInstance {
      const matches = root.findAll((node) => {
        if (String(node.type) !== 'Text') return false;
        const joined = node.children.filter((c): c is string => typeof c === 'string').join('');
        return joined.includes(substring);
      });
      if (matches.length === 0) {
        throw new Error(`No Text node found containing ${JSON.stringify(substring)}`);
      }
      return matches[0]!;
    }

    // Non-throwing counterpart, for negative assertions.
    function queryByTextIncluding(
      root: ReactTestInstance,
      substring: string
    ): ReactTestInstance | null {
      const matches = root.findAll((node) => {
        if (String(node.type) !== 'Text') return false;
        const joined = node.children.filter((c): c is string => typeof c === 'string').join('');
        return joined.includes(substring);
      });
      return matches[0] ?? null;
    }

    function scopeResponse(
      zoomInMode = false,
      overrides: {
        project_enabled?: boolean;
        general_enabled?: boolean;
        chat_enabled?: boolean;
      } = {}
    ) {
      return {
        chat_enabled: true,
        project_enabled: true,
        general_enabled: true,
        ...overrides,
        include_other_project_summaries: false,
        zoom_in_mode: zoomInMode,
      };
    }

    function mockFetchWithDocuments(
      documents: { document_id: string; source_filename: string }[],
      options: {
        scope?: ReturnType<typeof scopeResponse>;
        scopeStatus?: number;
        projects?: { id: string; name: string }[];
      } = {}
    ): typeof fetch {
      return jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        const method = (init?.method ?? 'GET').toUpperCase();
        if (url.includes('/auth/refresh')) {
          return new Response(JSON.stringify({ detail: 'none' }), { status: 401 });
        }
        if (url.includes('/auth/providers')) {
          return new Response(JSON.stringify({ providers: [], dev_login_enabled: false }), {
            status: 200,
          });
        }
        if (url.endsWith('/conversations/c-sources')) {
          return conversationDetail('c-sources', [], options.projects ?? []);
        }
        if (method === 'GET' && url.endsWith('/conversations/c-sources/documents')) {
          return new Response(
            JSON.stringify({
              documents: documents.map((d) => ({
                ...d,
                document_type: 'report',
                added_at: '2026-01-01T00:00:00Z',
              })),
              total: documents.length,
            }),
            { status: 200 }
          );
        }
        if (method === 'PUT' && url.endsWith('/conversations/c-sources/documents')) {
          return new Response(
            JSON.stringify({
              documents: [
                {
                  document_id: 'd1',
                  source_filename: 'a.pdf',
                  document_type: 'report',
                  added_at: '2026-01-01T00:00:00Z',
                },
              ],
              total: 1,
            }),
            { status: 200 }
          );
        }
        if (method === 'GET' && url.endsWith('/conversations/c-sources/scope')) {
          return new Response(JSON.stringify(options.scope ?? scopeResponse()), {
            status: options.scopeStatus ?? 200,
          });
        }
        if (method === 'PATCH' && url.endsWith('/conversations/c-sources/scope')) {
          const body = JSON.parse(String(init?.body));
          return new Response(JSON.stringify(scopeResponse(Boolean(body.zoom_in_mode))), {
            status: 200,
          });
        }
        if (method === 'GET' && url.includes('/folders/contents')) {
          return new Response(
            JSON.stringify({
              folder: null,
              breadcrumbs: [],
              folders: [],
              documents: [],
              documents_total: 0,
            }),
            { status: 200 }
          );
        }
        throw new Error(`Unexpected fetch call to ${url} in this test`);
      }) as unknown as typeof fetch;
    }

    it('shows the loaded source count from GET .../documents', async () => {
      mockParams.id = 'c-sources';
      global.fetch = mockFetchWithDocuments([{ document_id: 'd1', source_filename: 'a.pdf' }]);

      const renderer = await renderChat();

      expect(findByText(renderer.root, '1 source')).toBeTruthy();
    });

    it('shows "Add sources" when the conversation has no selected documents', async () => {
      mockParams.id = 'c-sources';
      global.fetch = mockFetchWithDocuments([]);

      const renderer = await renderChat();

      expect(findByText(renderer.root, 'Add sources')).toBeTruthy();
    });

    it('the Sources control is hidden when conversationScope is disabled', async () => {
      mockParams.id = 'c-sources';
      global.fetch = jest.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('/auth/refresh')) {
          return new Response(JSON.stringify({ detail: 'none' }), { status: 401 });
        }
        if (url.includes('/auth/providers')) {
          return new Response(JSON.stringify({ providers: [], dev_login_enabled: false }), {
            status: 200,
          });
        }
        if (url.endsWith('/status')) {
          return new Response(
            JSON.stringify({ image_generation_enabled: true, conversation_scope_enabled: false }),
            { status: 200 }
          );
        }
        if (url.endsWith('/conversations/c-sources')) return conversationDetail('c-sources');
        // No GET .../documents call is expected at all — the effect that
        // fires it is itself gated on conversationScopeEnabled.
        throw new Error(`Unexpected fetch call to ${url} in this test`);
      }) as unknown as typeof fetch;

      const renderer = await renderChat();
      // Let the /status fetch (and the effect gated on it) settle.
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(queryByText(renderer.root, 'Add sources')).toBeNull();
    });

    it("opening the picker preselects the conversation's current server-side selection, and Save updates the composer badge", async () => {
      mockParams.id = 'c-sources';
      global.fetch = mockFetchWithDocuments([{ document_id: 'd1', source_filename: 'a.pdf' }]);

      const renderer = await renderChat();
      expect(findByText(renderer.root, '1 source')).toBeTruthy();

      await act(async () => {
        findPressableByText(renderer.root, '1 source').props.onPress();
      });

      expect(findByTextIncluding(renderer.root, 'Selected sources (1)')).toBeTruthy(); // preselected from GET

      await act(async () => {
        findPressableByText(renderer.root, 'Save').props.onPress();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      // The PUT mock above always returns total: 1 regardless of body —
      // this proves the composer badge is driven by the picker's onSaved
      // callback (the server's own response), not left stale.
      expect(findByText(renderer.root, '1 source')).toBeTruthy();
    });

    // Frontend/Platform Milestone 3.2.2 Part D — the composer's inline
    // SelectedSourceChips only render on wide web (see chat/[id].tsx's
    // `showSourceChips`), so this scoped describe opts INTO that layout
    // rather than changing it file-wide (every other test here
    // deliberately exercises the default non-web layout).
    describe('Removing the sole selected source inline while in Zoom-In', () => {
      const originalPlatformOS = Platform.OS;

      afterEach(() => {
        Platform.OS = originalPlatformOS;
      });

      it(
        'DELETEs the association THEN PATCHes zoom_in_mode=false — never leaves the backend holding ' +
          'zoom_in_mode=true with zero documents, even momentarily',
        async () => {
          Platform.OS = 'web';
          Dimensions.set({
            window: { width: 1200, height: 900, scale: 1, fontScale: 1 },
            screen: { width: 1200, height: 900, scale: 1, fontScale: 1 },
          });
          mockParams.id = 'c-sources';

          const patchBodies: unknown[] = [];
          let deleteCalled = false;
          // Stateful, like the real backend: the DELETE and PATCH below
          // actually mutate what subsequent GETs (fired by
          // refreshSources()) report, so the test can tell a real
          // fire-and-forget-optimistic-only fix apart from one that
          // correctly round-trips through the server.
          let documentsOnServer = [{ document_id: 'd1', source_filename: 'a.pdf' as const }] as {
            document_id: string;
            source_filename: string;
          }[];
          let zoomInOnServer = true;
          global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = typeof input === 'string' ? input : input.toString();
            const method = (init?.method ?? 'GET').toUpperCase();
            if (url.includes('/auth/refresh')) {
              return new Response(JSON.stringify({ detail: 'none' }), { status: 401 });
            }
            if (url.includes('/auth/providers')) {
              return new Response(JSON.stringify({ providers: [], dev_login_enabled: false }), {
                status: 200,
              });
            }
            if (url.endsWith('/conversations/c-sources')) return conversationDetail('c-sources');
            if (method === 'GET' && url.endsWith('/conversations/c-sources/documents')) {
              return new Response(
                JSON.stringify({
                  documents: documentsOnServer.map((d) => ({
                    ...d,
                    document_type: 'report',
                    added_at: '2026-01-01T00:00:00Z',
                  })),
                  total: documentsOnServer.length,
                }),
                { status: 200 }
              );
            }
            if (method === 'DELETE' && url.endsWith('/conversations/c-sources/documents/d1')) {
              deleteCalled = true;
              documentsOnServer = documentsOnServer.filter((d) => d.document_id !== 'd1');
              return new Response(null, { status: 204 });
            }
            if (method === 'GET' && url.endsWith('/conversations/c-sources/scope')) {
              return new Response(
                JSON.stringify({
                  chat_enabled: true,
                  project_enabled: true,
                  general_enabled: true,
                  include_other_project_summaries: false,
                  zoom_in_mode: zoomInOnServer,
                }),
                { status: 200 }
              );
            }
            if (method === 'PATCH' && url.endsWith('/conversations/c-sources/scope')) {
              // Asserts the DELETE has already landed by the time the PATCH
              // fires — the safe ordering this fix depends on.
              expect(deleteCalled).toBe(true);
              const body = JSON.parse(String(init?.body));
              patchBodies.push(body);
              zoomInOnServer = Boolean(body.zoom_in_mode);
              return new Response(
                JSON.stringify({
                  chat_enabled: true,
                  project_enabled: true,
                  general_enabled: true,
                  include_other_project_summaries: false,
                  zoom_in_mode: zoomInOnServer,
                }),
                { status: 200 }
              );
            }
            throw new Error(`Unexpected fetch call to ${url} in this test`);
          }) as unknown as typeof fetch;

          const renderer = await renderChat();
          expect(findByText(renderer.root, 'Zoom-In · 1')).toBeTruthy();

          const removeChip = renderer.root.find(
            (node) => node.props.accessibilityLabel === 'Remove a.pdf from selected sources'
          );

          await act(async () => {
            removeChip.props.onPress();
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
          });

          expect(deleteCalled).toBe(true);
          expect(patchBodies).toEqual([{ zoom_in_mode: false }]);
          // The badge falls back to ordinary Prioritize copy — no trapped
          // Zoom-In-with-nothing-selected state left on screen.
          expect(queryByText(renderer.root, 'Zoom-In · 1')).toBeNull();
        }
      );
    });

    describe('Project context (Frontend Milestone 2.1)', () => {
      it('an ordinary (non-project) conversation shows no Project indicator and ordinary Prioritize copy', async () => {
        mockParams.id = 'c-sources';
        global.fetch = mockFetchWithDocuments([{ document_id: 'd1', source_filename: 'a.pdf' }], {
          projects: [],
        });
        const renderer = await renderChat();

        await act(async () => {
          findPressableByText(renderer.root, '1 source').props.onPress();
        });

        expect(queryByText(renderer.root, 'Project')).toBeNull();
        expect(
          queryByText(
            renderer.root,
            'Use these sources first, then broaden to other available library knowledge when useful.'
          )
        ).toBeTruthy();
      });

      it('a project-associated conversation shows the Project indicator and project-aware Prioritize copy — restored together with mode and selection on load, no flicker', async () => {
        mockParams.id = 'c-sources';
        global.fetch = mockFetchWithDocuments([{ document_id: 'd1', source_filename: 'a.pdf' }], {
          projects: [{ id: 'p1', name: 'AI Literacy Study' }],
        });
        const renderer = await renderChat();

        await act(async () => {
          findPressableByText(renderer.root, '1 source').props.onPress();
        });

        expect(findByText(renderer.root, 'Project')).toBeTruthy();
        expect(queryByTextIncluding(renderer.root, 'AI Literacy Study')).toBeTruthy();
        expect(
          queryByText(
            renderer.root,
            'Use these sources first, then broaden to project knowledge and other available library knowledge when useful.'
          )
        ).toBeTruthy();
      });

      it('project_enabled=false on a project-associated conversation never claims project knowledge is available', async () => {
        mockParams.id = 'c-sources';
        global.fetch = mockFetchWithDocuments([{ document_id: 'd1', source_filename: 'a.pdf' }], {
          projects: [{ id: 'p1', name: 'AI Literacy Study' }],
          scope: scopeResponse(false, { project_enabled: false }),
        });
        const renderer = await renderChat();

        await act(async () => {
          findPressableByText(renderer.root, '1 source').props.onPress();
        });

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

      it('a conversation still loading its detail renders no composer/Sources control at all — the "no flicker" requirement is structurally satisfied, not just handled in copy', async () => {
        mockParams.id = 'c-sources';
        // The conversation-detail fetch never resolves in this test.
        // ChatConversationScreen gates its ENTIRE body (composer included)
        // behind loadState — see chat/[id].tsx's own `if (loadState.status
        // === 'loading') return <spinner/>` — so there is no code path
        // where the Sources button/picker can render with an unresolved
        // `conversation`, and therefore no path where project copy could
        // ever flicker between "ordinary" and "project" while it loads.
        global.fetch = jest.fn(async (input: RequestInfo | URL) => {
          const url = typeof input === 'string' ? input : input.toString();
          if (url.includes('/auth/refresh')) {
            return new Response(JSON.stringify({ detail: 'none' }), { status: 401 });
          }
          if (url.includes('/auth/providers')) {
            return new Response(JSON.stringify({ providers: [], dev_login_enabled: false }), {
              status: 200,
            });
          }
          if (url.endsWith('/conversations/c-sources')) {
            return new Promise<Response>(() => {}); // never resolves
          }
          throw new Error(`Unexpected fetch call to ${url} in this test`);
        }) as unknown as typeof fetch;
        const renderer = await renderChat();

        expect(queryByText(renderer.root, 'Add sources')).toBeNull();
        expect(queryByText(renderer.root, 'Project')).toBeNull();
      });
    });
  });

  // Milestone 4: Zoom-In / strict selected-source mode.
  describe('Zoom-In (Milestone 4)', () => {
    function scopeResponse(zoomInMode = false) {
      return {
        chat_enabled: true,
        project_enabled: true,
        general_enabled: true,
        include_other_project_summaries: false,
        zoom_in_mode: zoomInMode,
      };
    }

    function mockFetchWithDocumentsAndScope(
      documents: { document_id: string; source_filename: string }[],
      scope: ReturnType<typeof scopeResponse>,
      opts: { scopeStatus?: number; documentsStatus?: number } = {}
    ): typeof fetch {
      return jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        const method = (init?.method ?? 'GET').toUpperCase();
        if (url.includes('/auth/refresh')) {
          return new Response(JSON.stringify({ detail: 'none' }), { status: 401 });
        }
        if (url.includes('/auth/providers')) {
          return new Response(JSON.stringify({ providers: [], dev_login_enabled: false }), {
            status: 200,
          });
        }
        if (url.endsWith('/conversations/c-sources')) return conversationDetail('c-sources');
        if (method === 'GET' && url.endsWith('/conversations/c-sources/documents')) {
          return new Response(
            JSON.stringify({
              documents: documents.map((d) => ({
                ...d,
                document_type: 'report',
                added_at: '2026-01-01T00:00:00Z',
              })),
              total: documents.length,
            }),
            { status: opts.documentsStatus ?? 200 }
          );
        }
        if (method === 'GET' && url.endsWith('/conversations/c-sources/scope')) {
          return new Response(JSON.stringify(scope), { status: opts.scopeStatus ?? 200 });
        }
        throw new Error(`Unexpected fetch call to ${url} in this test`);
      }) as unknown as typeof fetch;
    }

    it('restores Zoom-In mode from GET .../scope and shows the distinct badge', async () => {
      mockParams.id = 'c-sources';
      global.fetch = mockFetchWithDocumentsAndScope(
        [{ document_id: 'd1', source_filename: 'a.pdf' }],
        scopeResponse(true)
      );

      const renderer = await renderChat();

      expect(findByText(renderer.root, 'Zoom-In · 1')).toBeTruthy();
    });

    it('restores Prioritize mode (the default) from GET .../scope', async () => {
      mockParams.id = 'c-sources';
      global.fetch = mockFetchWithDocumentsAndScope(
        [{ document_id: 'd1', source_filename: 'a.pdf' }],
        scopeResponse(false)
      );

      const renderer = await renderChat();

      expect(findByText(renderer.root, '1 source')).toBeTruthy();
      expect(queryByText(renderer.root, 'Zoom-In · 1')).toBeNull();
    });

    it(
      'a failed scope load shows a retry state and never offers a destructive Save over ' +
        'unknown server state (Milestone 3 §14 bug fix)',
      async () => {
        mockParams.id = 'c-sources';
        global.fetch = mockFetchWithDocumentsAndScope(
          [{ document_id: 'd1', source_filename: 'a.pdf' }],
          scopeResponse(false),
          { scopeStatus: 500 }
        );

        const renderer = await renderChat();

        expect(findByText(renderer.root, 'Sources unavailable')).toBeTruthy();
        // The picker must never open from this state — pressing the button
        // retries the failed load instead (see the button's onPress wiring).
        expect(queryByText(renderer.root, 'Save')).toBeNull();
      }
    );

    it('a failed documents load ALSO shows the retry state, even if scope loaded fine', async () => {
      mockParams.id = 'c-sources';
      global.fetch = mockFetchWithDocumentsAndScope(
        [{ document_id: 'd1', source_filename: 'a.pdf' }],
        scopeResponse(false),
        { documentsStatus: 500 }
      );

      const renderer = await renderChat();

      expect(findByText(renderer.root, 'Sources unavailable')).toBeTruthy();
    });

    it('pressing the button in the error state retries both loads instead of opening the picker', async () => {
      mockParams.id = 'c-sources';
      let scopeCallCount = 0;
      global.fetch = jest.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('/auth/refresh')) {
          return new Response(JSON.stringify({ detail: 'none' }), { status: 401 });
        }
        if (url.includes('/auth/providers')) {
          return new Response(JSON.stringify({ providers: [], dev_login_enabled: false }), {
            status: 200,
          });
        }
        if (url.endsWith('/conversations/c-sources')) return conversationDetail('c-sources');
        if (url.endsWith('/conversations/c-sources/documents')) {
          return new Response(JSON.stringify({ documents: [], total: 0 }), { status: 200 });
        }
        if (url.endsWith('/conversations/c-sources/scope')) {
          scopeCallCount += 1;
          if (scopeCallCount === 1) {
            return new Response(JSON.stringify({ detail: 'boom' }), { status: 500 });
          }
          return new Response(JSON.stringify(scopeResponse(false)), { status: 200 });
        }
        throw new Error(`Unexpected fetch call to ${url} in this test`);
      }) as unknown as typeof fetch;

      const renderer = await renderChat();
      expect(findByText(renderer.root, 'Sources unavailable')).toBeTruthy();

      await act(async () => {
        findPressableByText(renderer.root, 'Sources unavailable').props.onPress();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(scopeCallCount).toBe(2);
      expect(queryByText(renderer.root, 'Sources unavailable')).toBeNull();
      expect(findByText(renderer.root, 'Add sources')).toBeTruthy();
    });
  });
});
