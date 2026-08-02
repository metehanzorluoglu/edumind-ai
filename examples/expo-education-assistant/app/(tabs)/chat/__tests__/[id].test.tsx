import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { Alert } from 'react-native';
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

function conversationDetail(id: string, messages: unknown[] = []): Response {
  return new Response(
    JSON.stringify({
      id,
      title: 'New conversation',
      title_is_custom: false,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      messages,
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
});
