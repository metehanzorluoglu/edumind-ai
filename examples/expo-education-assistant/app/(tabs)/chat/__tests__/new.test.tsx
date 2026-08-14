import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { Alert } from 'react-native';
import { AuthProvider } from '@/lib/AuthProvider';
import { ChatConversationsProvider } from '@/lib/ChatConversationsContext';
import { ClientProvider } from '@/lib/ClientProvider';
import { FeatureFlagsProvider } from '@/lib/FeatureFlags';
import NewChatScreen from '../new';

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

const mockReplace = jest.fn();
const mockSearchParams: { sources?: string; selectionContext?: string } = {};
jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: mockReplace, push: jest.fn() }),
  usePathname: () => '/chat',
  useGlobalSearchParams: () => ({}),
  useLocalSearchParams: () => mockSearchParams,
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

function sseEvent(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

interface ControllableSse {
  response: Response;
  push: (event: string) => void;
  close: () => void;
}

/** An SSE response body the test can feed events into on demand — used to
 * prove navigation/sidebar-refresh never fires before the first message
 * actually finishes, not just that it fires eventually. */
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

async function renderNewChat(
  refreshConversations: () => void = jest.fn()
): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <AuthProvider>
        <ClientProvider>
          <FeatureFlagsProvider>
            <ChatConversationsProvider value={{ refreshConversations }}>
              <NewChatScreen />
            </ChatConversationsProvider>
          </FeatureFlagsProvider>
        </ClientProvider>
      </AuthProvider>
    );
    await Promise.resolve();
    await Promise.resolve();
  });
  return renderer;
}

const AUTH_ROUTES = (url: string): Response | null => {
  if (url.includes('/auth/refresh')) {
    return new Response(JSON.stringify({ detail: 'No refresh token provided' }), { status: 401 });
  }
  if (url.includes('/auth/providers')) {
    return new Response(JSON.stringify({ providers: [], dev_login_enabled: false }), {
      status: 200,
    });
  }
  return null;
};

function conversationCreatedResponse(id = 'new-conversation-id'): Response {
  return new Response(
    JSON.stringify({
      id,
      title: 'New conversation',
      title_is_custom: false,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      messages: [],
    }),
    { status: 201 }
  );
}

describe('NewChatScreen', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    mockReplace.mockReset();
    delete mockSearchParams.sources;
    delete mockSearchParams.selectionContext;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('renders the composer with the generic hint by default', async () => {
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      return AUTH_ROUTES(url) ?? Promise.reject(new Error(`Unexpected fetch call to ${url}`));
    }) as unknown as typeof fetch;

    const renderer = await renderNewChat();

    expect(findByText(renderer.root, 'Ask a question about the ingested corpus.')).toBeTruthy();
  });

  it('the Ask button is disabled when the input is empty', async () => {
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      return AUTH_ROUTES(url) ?? Promise.reject(new Error(`Unexpected fetch call to ${url}`));
    }) as unknown as typeof fetch;

    const renderer = await renderNewChat();

    const askButton = findPressableByText(renderer.root, 'Ask');
    expect(askButton.props.disabled).toBe(true);
  });

  it('the attachment button is rendered beside Ask and offers Photo Library / Camera / Files on native (milestone V2)', async () => {
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      return AUTH_ROUTES(url) ?? Promise.reject(new Error(`Unexpected fetch call to ${url}`));
    }) as unknown as typeof fetch;
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});

    const renderer = await renderNewChat();
    const attachButton = renderer.root.find(
      (node) => node.props.accessibilityLabel === 'Attach image or PDF'
    );
    await act(async () => {
      attachButton.props.onPress();
    });

    expect(alertSpy).toHaveBeenCalledWith(
      'Attach',
      undefined,
      expect.arrayContaining([
        expect.objectContaining({ text: 'Photo Library' }),
        expect.objectContaining({ text: 'Camera' }),
        expect.objectContaining({ text: 'Files' }),
      ])
    );
  });

  it('shows the corpus toggle only after attaching an image, and sends use_corpus=true when it is switched on (milestone V3)', async () => {
    // Node's built-in (spec-strict) global FormData rejects the RN
    // `{ uri, name, type }` file shape appendUploadableFile() sends on
    // native — only a real Blob/File is spec-valid there. A real React
    // Native runtime's own FormData polyfill accepts that shape natively
    // (see appendUploadableFile's docs) and this is exactly what's under
    // test — the FormData *content* (fields/files), not which FormData
    // implementation happens to run in this Node-based test environment
    // — so a minimal lenient stand-in replaces the strict global here,
    // mirroring the same swap the SDK's own vitest tests make for the
    // identical reason (see EducationAssistantClient.test.ts).
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

    let controllable: ControllableSse | null = null;
    let capturedFormData: FakeFormData | null = null;
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const authResponse = AUTH_ROUTES(url);
      if (authResponse) return authResponse;
      if (url.endsWith('/conversations')) return conversationCreatedResponse();
      if (url.endsWith('/conversations/new-conversation-id/messages')) {
        capturedFormData = init?.body as unknown as FakeFormData;
        controllable = controllableSseResponse();
        return controllable.response;
      }
      throw new Error(`Unexpected fetch call to ${url}`);
    }) as unknown as typeof fetch;
    // jest.spyOn on an already-spied method (from an earlier test in this
    // file, e.g. the "attachment button" test above) reuses the same mock
    // instance rather than creating a fresh one, so its .mock.calls would
    // otherwise still carry that earlier test's call(s) — mockClear()
    // ensures `.mock.calls[0]` below is really this test's first call, not
    // some previous test's (whose onPress closures point at an already
    // -unmounted component).
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    alertSpy.mockClear();

    try {
      const renderer = await renderNewChat();

      // Before attaching anything, the toggle must not be rendered at all
      // — a text-only message has no such choice (retrieval always runs).
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

      await act(async () => {
        controllable!.close();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
      act(() => {
        renderer.unmount();
      });
    } finally {
      global.FormData = OriginalFormData;
    }
  });

  it('renders neither quick-action chips nor PDF page-range controls after attaching a file (simplified attachment UI)', async () => {
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      return AUTH_ROUTES(url) ?? Promise.reject(new Error(`Unexpected fetch call to ${url}`));
    }) as unknown as typeof fetch;
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    alertSpy.mockClear();

    const renderer = await renderNewChat();

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

    // No quick-action chips of any kind.
    expect(
      renderer.root.findAll(
        (node) =>
          typeof node.props.accessibilityLabel === 'string' &&
          node.props.accessibilityLabel.startsWith('Quick action:')
      )
    ).toHaveLength(0);
    // No page-range inputs/labels — a PDF is analyzed in full automatically.
    expect(queryByText(renderer.root, 'Pages')).toBeNull();
    expect(renderer.root.findAllByType('TextInput' as never)).toHaveLength(1); // just the chat input
  });

  it('clears the input immediately on submit', async () => {
    let controllable: ControllableSse | null = null;
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      const authResponse = AUTH_ROUTES(url);
      if (authResponse) return authResponse;
      if (url.endsWith('/conversations')) return conversationCreatedResponse();
      if (url.endsWith('/conversations/new-conversation-id/messages')) {
        controllable = controllableSseResponse();
        return controllable.response;
      }
      throw new Error(`Unexpected fetch call to ${url}`);
    }) as unknown as typeof fetch;

    const renderer = await renderNewChat();

    const input = renderer.root.find((node) => String(node.type) === 'TextInput');
    act(() => {
      input.props.onChangeText('What does the research say about peer tutoring?');
    });

    act(() => {
      findPressableByText(renderer.root, 'Ask').props.onPress();
    });

    const inputAfterSubmit = renderer.root.find((node) => String(node.type) === 'TextInput');
    expect(inputAfterSubmit.props.value).toBe('');

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      controllable!.close();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    act(() => {
      renderer.unmount();
    });
  });

  it(
    'does not navigate or refresh the sidebar until the first message finishes, and keeps ' +
      'the question visible the entire time it is pending',
    async () => {
      const refreshConversations = jest.fn();
      let controllable: ControllableSse | null = null;
      const messageBodies: string[] = [];

      global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        const authResponse = AUTH_ROUTES(url);
        if (authResponse) return authResponse;
        if (url.endsWith('/conversations')) return conversationCreatedResponse();
        if (url.endsWith('/conversations/new-conversation-id/messages')) {
          messageBodies.push(String(init?.body));
          controllable = controllableSseResponse();
          return controllable.response;
        }
        throw new Error(`Unexpected fetch call to ${url}`);
      }) as unknown as typeof fetch;

      const renderer = await renderNewChat(refreshConversations);

      const input = renderer.root.find((node) => String(node.type) === 'TextInput');
      act(() => {
        input.props.onChangeText('What about Fictional Grade 4?');
      });
      await act(async () => {
        findPressableByText(renderer.root, 'Ask').props.onPress();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      // Conversation created, first-message request in flight, nothing has
      // resolved yet — this is exactly the window during which the old
      // create-then-navigate-then-send flow would have handed an empty
      // fetch result to a freshly-mounted /chat/[id] and wiped the message.
      expect(mockReplace).not.toHaveBeenCalled();
      expect(refreshConversations).not.toHaveBeenCalled();
      expect(findByText(renderer.root, 'What about Fictional Grade 4?')).toBeTruthy();
      expect(JSON.parse(messageBodies[0]!).query).toBe('What about Fictional Grade 4?');
      // The pending first turn shows the thinking placeholder immediately —
      // "Preparing a response..." over the truthful shadow-box status for a
      // plain chat request, never the retired "Connecting…" label.
      expect(queryByText(renderer.root, 'Preparing a response...')).toBeTruthy();
      expect(queryByText(renderer.root, 'Understanding your question...')).toBeTruthy();
      expect(queryByText(renderer.root, 'Connecting…')).toBeNull();

      await act(async () => {
        controllable!.push(sseEvent({ type: 'token', content: 'Grade 4 covers...' }));
        await Promise.resolve();
        await Promise.resolve();
      });

      // Still on /chat/new — token arrived, but the turn hasn't finished.
      // The first token replaced the placeholder inside the same bubble,
      // once its short exit fade finished.
      expect(mockReplace).not.toHaveBeenCalled();
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 300));
      });
      expect(queryByText(renderer.root, 'Preparing a response...')).toBeNull();
      expect(queryByText(renderer.root, 'Understanding your question...')).toBeNull();
      expect(findByText(renderer.root, 'Grade 4 covers...')).toBeTruthy();
      expect(findByText(renderer.root, 'What about Fictional Grade 4?')).toBeTruthy();

      await act(async () => {
        controllable!.push(sseEvent({ type: 'sources', sources: [] }));
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

      expect(mockReplace).toHaveBeenCalledWith('/chat/new-conversation-id');
      expect(refreshConversations).toHaveBeenCalled();
    }
  );

  it('keeps the question visible and offers Retry if the first message fails, reusing the same conversation and idempotency key', async () => {
    const messageBodies: string[] = [];
    let attempt = 0;
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const authResponse = AUTH_ROUTES(url);
      if (authResponse) return authResponse;
      if (url.endsWith('/conversations')) return conversationCreatedResponse();
      if (url.endsWith('/conversations/new-conversation-id/messages')) {
        messageBodies.push(String(init?.body));
        attempt += 1;
        if (attempt === 1) {
          const encoder = new TextEncoder();
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                encoder.encode(sseEvent({ type: 'error', message: 'LLM unavailable' }))
              );
              controller.close();
            },
          });
          return new Response(stream, {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
          });
        }
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(sseEvent({ type: 'token', content: 'Yes.' })));
            controller.enqueue(encoder.encode(sseEvent({ type: 'sources', sources: [] })));
            controller.enqueue(
              encoder.encode(
                sseEvent({
                  type: 'done',
                  citations: [],
                  citation_warnings: [],
                  insufficient_evidence: false,
                })
              )
            );
            controller.close();
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      throw new Error(`Unexpected fetch call to ${url}`);
    }) as unknown as typeof fetch;

    const renderer = await renderNewChat();

    const input = renderer.root.find((node) => String(node.type) === 'TextInput');
    act(() => {
      input.props.onChangeText('What about reading fluency?');
    });
    await act(async () => {
      findPressableByText(renderer.root, 'Ask').props.onPress();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(findByText(renderer.root, 'LLM unavailable')).toBeTruthy();
    expect(findByText(renderer.root, 'What about reading fluency?')).toBeTruthy();
    expect(mockReplace).not.toHaveBeenCalled();

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
    expect(mockReplace).toHaveBeenCalledWith('/chat/new-conversation-id');

    expect(messageBodies).toHaveLength(2);
    const firstBody = JSON.parse(messageBodies[0]!);
    const secondBody = JSON.parse(messageBodies[1]!);
    expect(secondBody.client_message_id).toBe(firstBody.client_message_id);
    expect(typeof firstBody.client_message_id).toBe('string');
  });

  it('lets the user cancel the in-flight first message via the Cancel button, showing a cancelled message and Retry (milestone V4)', async () => {
    let controllable: ControllableSse | undefined;
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      const authResponse = AUTH_ROUTES(url);
      if (authResponse) return authResponse;
      if (url.endsWith('/conversations')) return conversationCreatedResponse();
      if (url.endsWith('/conversations/new-conversation-id/messages')) {
        controllable = controllableSseResponse();
        return controllable.response;
      }
      throw new Error(`Unexpected fetch call to ${url}`);
    }) as unknown as typeof fetch;

    const renderer = await renderNewChat();

    const input = renderer.root.find((node) => String(node.type) === 'TextInput');
    act(() => {
      input.props.onChangeText('What about reading fluency?');
    });
    await act(async () => {
      findPressableByText(renderer.root, 'Ask').props.onPress();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(findPressableByText(renderer.root, 'Cancel')).toBeTruthy();
    // While in flight, the thinking placeholder is live.
    expect(queryByText(renderer.root, 'Preparing a response...')).toBeTruthy();
    expect(queryByText(renderer.root, 'Understanding your question...')).toBeTruthy();

    await act(async () => {
      findPressableByText(renderer.root, 'Cancel').props.onPress();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(findByText(renderer.root, 'Message generation was cancelled.')).toBeTruthy();
    expect(findPressableByText(renderer.root, 'Retry')).toBeTruthy();
    expect(mockReplace).not.toHaveBeenCalled();
    // Cancelling stops the animation and replaces the placeholder with the
    // cancelled state — once its short exit fade finishes, it never keeps
    // rotating.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    expect(queryByText(renderer.root, 'Preparing a response...')).toBeNull();
    expect(queryByText(renderer.root, 'Understanding your question...')).toBeNull();
    controllable!.close();
  });

  it('restores the typed question into the input if conversation creation itself fails (nothing to retry against yet)', async () => {
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      const authResponse = AUTH_ROUTES(url);
      if (authResponse) return authResponse;
      if (url.endsWith('/conversations')) {
        return new Response(JSON.stringify({ detail: 'Internal error' }), { status: 500 });
      }
      throw new Error(`Unexpected fetch call to ${url}`);
    }) as unknown as typeof fetch;

    const renderer = await renderNewChat();

    const input = renderer.root.find((node) => String(node.type) === 'TextInput');
    act(() => {
      input.props.onChangeText('What does the research say about peer tutoring?');
    });

    await act(async () => {
      findPressableByText(renderer.root, 'Ask').props.onPress();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const inputAfterFailure = renderer.root.find((node) => String(node.type) === 'TextInput');
    expect(inputAfterFailure.props.value).toBe('What does the research say about peer tutoring?');
    expect(mockReplace).not.toHaveBeenCalled();
    expect(queryByText(renderer.root, 'Retry')).toBeNull();
  });

  it('only creates one conversation when Ask is pressed twice in quick succession', async () => {
    let createCalls = 0;
    let controllable: ControllableSse | null = null;
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      const authResponse = AUTH_ROUTES(url);
      if (authResponse) return authResponse;
      if (url.endsWith('/conversations')) {
        createCalls += 1;
        return conversationCreatedResponse();
      }
      if (url.endsWith('/conversations/new-conversation-id/messages')) {
        controllable = controllableSseResponse();
        return controllable.response;
      }
      throw new Error(`Unexpected fetch call to ${url}`);
    }) as unknown as typeof fetch;

    const renderer = await renderNewChat();

    const input = renderer.root.find((node) => String(node.type) === 'TextInput');
    act(() => {
      input.props.onChangeText('What about Fictional Grade 4?');
    });

    await act(async () => {
      const askButton = findPressableByText(renderer.root, 'Ask');
      askButton.props.onPress();
      askButton.props.onPress();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(createCalls).toBe(1);
    await act(async () => {
      controllable!.close();
      await Promise.resolve();
      await Promise.resolve();
    });
    act(() => {
      renderer.unmount();
    });
  });

  it('pressing Enter (onSubmitEditing) submits identically to pressing Ask', async () => {
    let createCalls = 0;
    let controllable: ControllableSse | null = null;
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      const authResponse = AUTH_ROUTES(url);
      if (authResponse) return authResponse;
      if (url.endsWith('/conversations')) {
        createCalls += 1;
        return conversationCreatedResponse();
      }
      if (url.endsWith('/conversations/new-conversation-id/messages')) {
        controllable = controllableSseResponse();
        return controllable.response;
      }
      throw new Error(`Unexpected fetch call to ${url}`);
    }) as unknown as typeof fetch;

    const renderer = await renderNewChat();

    const input = renderer.root.find((node) => String(node.type) === 'TextInput');
    act(() => {
      input.props.onChangeText('What about Fictional Grade 4?');
    });

    await act(async () => {
      input.props.onSubmitEditing();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(createCalls).toBe(1);
    const inputAfterSubmit = renderer.root.find((node) => String(node.type) === 'TextInput');
    expect(inputAfterSubmit.props.value).toBe('');
    expect(findByText(renderer.root, 'What about Fictional Grade 4?')).toBeTruthy();
    await act(async () => {
      controllable!.close();
      await Promise.resolve();
      await Promise.resolve();
    });
    act(() => {
      renderer.unmount();
    });
  });

  it('the Image button is rendered beside the attachment button', async () => {
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      return AUTH_ROUTES(url) ?? Promise.reject(new Error(`Unexpected fetch call to ${url}`));
    }) as unknown as typeof fetch;

    const renderer = await renderNewChat();

    expect(
      renderer.root.find((node) => node.props.accessibilityLabel === 'Attach image or PDF')
    ).toBeTruthy();
    expect(
      renderer.root.find((node) => node.props.accessibilityLabel === 'Generate an image')
    ).toBeTruthy();
  });

  it('generating an image from a new chat creates the conversation first, then generates, and navigates only once generation succeeds', async () => {
    let createCalls = 0;
    let generateCalls = 0;
    let controllable: ControllableSse | null = null;

    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const authResponse = AUTH_ROUTES(url);
      if (authResponse) return authResponse;
      if (url.endsWith('/conversations') && init?.method === 'POST') {
        createCalls += 1;
        return conversationCreatedResponse('generated-from-new-id');
      }
      if (url.endsWith('/images/generate')) {
        generateCalls += 1;
        controllable = controllableSseResponse();
        return controllable.response;
      }
      throw new Error(`Unexpected fetch call to ${url}`);
    }) as unknown as typeof fetch;

    const renderer = await renderNewChat();

    await act(async () => {
      renderer.root
        .find((node) => node.props.accessibilityLabel === 'Generate an image')
        .props.onPress();
    });
    await act(async () => {
      renderer.root
        .find((node) => node.props.accessibilityLabel === 'Image prompt')
        .props.onChangeText('a red apple');
    });
    await act(async () => {
      renderer.root.find((node) => node.props.accessibilityLabel === 'Generate').props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });

    // The conversation is created before any generation request is made,
    // and navigation must not have happened yet — generation is still
    // streaming.
    expect(createCalls).toBe(1);
    expect(generateCalls).toBe(1);
    expect(mockReplace).not.toHaveBeenCalled();

    await act(async () => {
      controllable!.push(sseEvent({ type: 'progress', completed: 1, total: 1 }));
      await Promise.resolve();
    });
    expect(mockReplace).not.toHaveBeenCalled(); // still not yet — only a progress event so far

    await act(async () => {
      controllable!.push(
        sseEvent({
          type: 'done',
          message_id: 'm1',
          conversation_id: 'generated-from-new-id',
          images: [
            {
              id: 'a1',
              mime: 'image/png',
              filename: 'generated-a1.png',
              size_bytes: 10,
              created_at: '2026-01-01T00:00:00Z',
              source: 'generated',
            },
          ],
        })
      );
      controllable!.close();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockReplace).toHaveBeenCalledWith('/chat/generated-from-new-id');

    act(() => {
      renderer.unmount();
    });
  });

  it('a failed generation attempt reuses the already-created conversation on retry, instead of creating a second one', async () => {
    let createCalls = 0;
    let generateCalls = 0;
    const controllables: ControllableSse[] = [];

    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const authResponse = AUTH_ROUTES(url);
      if (authResponse) return authResponse;
      if (url.endsWith('/conversations') && init?.method === 'POST') {
        createCalls += 1;
        return conversationCreatedResponse('generated-from-new-id');
      }
      if (url.endsWith('/images/generate')) {
        generateCalls += 1;
        const controllable = controllableSseResponse();
        controllables.push(controllable);
        return controllable.response;
      }
      throw new Error(`Unexpected fetch call to ${url}`);
    }) as unknown as typeof fetch;

    const renderer = await renderNewChat();

    await act(async () => {
      renderer.root
        .find((node) => node.props.accessibilityLabel === 'Generate an image')
        .props.onPress();
    });
    await act(async () => {
      renderer.root
        .find((node) => node.props.accessibilityLabel === 'Image prompt')
        .props.onChangeText('a red apple');
    });
    await act(async () => {
      renderer.root.find((node) => node.props.accessibilityLabel === 'Generate').props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(createCalls).toBe(1);

    // First attempt fails mid-stream.
    await act(async () => {
      controllables[0]!.push(sseEvent({ type: 'error', message: 'boom' }));
      controllables[0]!.close();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockReplace).not.toHaveBeenCalled();

    // Retry: press Generate again on the same (still-open) dialog.
    await act(async () => {
      renderer.root.find((node) => node.props.accessibilityLabel === 'Generate').props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });

    // No second conversation was created — the same one from the first
    // attempt is reused.
    expect(createCalls).toBe(1);
    expect(generateCalls).toBe(2);

    await act(async () => {
      controllables[1]!.push(
        sseEvent({
          type: 'done',
          message_id: 'm1',
          conversation_id: 'generated-from-new-id',
          images: [
            {
              id: 'a1',
              mime: 'image/png',
              filename: 'generated-a1.png',
              size_bytes: 10,
              created_at: '2026-01-01T00:00:00Z',
              source: 'generated',
            },
          ],
        })
      );
      controllables[1]!.close();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockReplace).toHaveBeenCalledWith('/chat/generated-from-new-id');

    act(() => {
      renderer.unmount();
    });
  });

  describe('Chat Sources (Milestone 3) — new-conversation lifecycle', () => {
    // See [id].test.tsx's identical helper: `Selected ({n})` compiles to
    // multiple Text children, so exact single-child matching can't find it.
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

    it(
      'selecting sources before the first message persists them (PUT) BEFORE the message ' +
        "is sent — §7's critical test: the first message must not silently ignore the " +
        'selected Scope',
      async () => {
        const callOrder: string[] = [];
        let putBody: unknown = null;

        global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = typeof input === 'string' ? input : input.toString();
          const method = (init?.method ?? 'GET').toUpperCase();
          const authResponse = AUTH_ROUTES(url);
          if (authResponse) return authResponse;
          if (method === 'GET' && url.includes('/folders/contents')) {
            return new Response(
              JSON.stringify({
                folder: null,
                breadcrumbs: [],
                folders: [],
                documents: [
                  {
                    document_id: 'doc-a',
                    source_filename: 'a.pdf',
                    title: 'AI Education',
                    folder_id: null,
                    document_type: 'report',
                    chunk_count: 1,
                    ingested_at: '2026-01-01T00:00:00Z',
                  },
                ],
                documents_total: 1,
              }),
              { status: 200 }
            );
          }
          if (method === 'POST' && url.endsWith('/conversations')) {
            callOrder.push('create-conversation');
            return conversationCreatedResponse();
          }
          if (method === 'PUT' && url.endsWith('/conversations/new-conversation-id/documents')) {
            callOrder.push('put-scope');
            putBody = JSON.parse(String(init?.body));
            return new Response(JSON.stringify({ documents: [], total: 1 }), { status: 200 });
          }
          if (method === 'POST' && url.endsWith('/conversations/new-conversation-id/messages')) {
            callOrder.push('send-message');
            return new Response(
              new ReadableStream({
                start(controller) {
                  const encoder = new TextEncoder();
                  controller.enqueue(
                    encoder.encode(`data: ${JSON.stringify({ type: 'token', content: 'Hi' })}\n\n`)
                  );
                  controller.enqueue(
                    encoder.encode(
                      `data: ${JSON.stringify({
                        type: 'done',
                        citations: [],
                        citation_warnings: [],
                        insufficient_evidence: false,
                      })}\n\n`
                    )
                  );
                  controller.close();
                },
              }),
              { status: 200, headers: { 'content-type': 'text/event-stream' } }
            );
          }
          throw new Error(`Unexpected fetch call to ${url} in this test`);
        }) as unknown as typeof fetch;

        const renderer = await renderNewChat();

        // Open the Sources picker and select "AI Education".
        await act(async () => {
          findPressableByText(renderer.root, 'Add sources').props.onPress();
          await Promise.resolve();
          await Promise.resolve();
        });
        await act(async () => {
          const checkbox = renderer.root.find(
            (node) =>
              typeof node.props.onPress === 'function' &&
              node.props.accessibilityLabel === 'Add AI Education'
          );
          checkbox.props.onPress();
        });
        expect(findByTextIncluding(renderer.root, 'Selected sources (1)')).toBeTruthy();
        await act(async () => {
          findPressableByText(renderer.root, 'Save').props.onPress();
        });

        // The composer badge now reflects the LOCAL pending selection —
        // no network call has happened yet (no conversation exists to PUT to).
        expect(findByTextIncluding(renderer.root, '1 source')).toBeTruthy();
        expect(callOrder).toEqual([]);

        const input = renderer.root.find((node) => String(node.type) === 'TextInput');
        act(() => {
          input.props.onChangeText('What does AI Education say?');
        });
        await act(async () => {
          findPressableByText(renderer.root, 'Ask').props.onPress();
          await Promise.resolve();
          await Promise.resolve();
          await Promise.resolve();
          await Promise.resolve();
        });

        // The critical assertion: scope was persisted (PUT) strictly
        // BEFORE the message was sent — so that first message's own
        // retrieval already sees the selected document(s).
        expect(callOrder).toEqual(['create-conversation', 'put-scope', 'send-message']);
        expect(putBody).toEqual({ document_ids: ['doc-a'] });
      }
    );

    it('sending with zero selected sources never calls the scope-replace endpoint', async () => {
      let putCalled = false;
      global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        const method = (init?.method ?? 'GET').toUpperCase();
        const authResponse = AUTH_ROUTES(url);
        if (authResponse) return authResponse;
        if (method === 'POST' && url.endsWith('/conversations')) {
          return conversationCreatedResponse();
        }
        if (method === 'PUT' && url.includes('/documents')) {
          putCalled = true;
          return new Response(JSON.stringify({ documents: [], total: 0 }), { status: 200 });
        }
        if (method === 'POST' && url.endsWith('/conversations/new-conversation-id/messages')) {
          return controllableSseResponse().response;
        }
        throw new Error(`Unexpected fetch call to ${url} in this test`);
      }) as unknown as typeof fetch;

      const renderer = await renderNewChat();
      const input = renderer.root.find((node) => String(node.type) === 'TextInput');
      act(() => {
        input.props.onChangeText('A question with no sources selected');
      });
      await act(async () => {
        findPressableByText(renderer.root, 'Ask').props.onPress();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(putCalled).toBe(false);
    });

    it('the Sources control is hidden when conversationScope is disabled', async () => {
      global.fetch = jest.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        const authResponse = AUTH_ROUTES(url);
        if (authResponse) return authResponse;
        if (url.endsWith('/status')) {
          return new Response(
            JSON.stringify({ image_generation_enabled: true, conversation_scope_enabled: false }),
            { status: 200 }
          );
        }
        if (url.includes('/documents')) {
          return new Response(JSON.stringify({ documents: [], total: 0 }), { status: 200 });
        }
        throw new Error(`Unexpected fetch call to ${url} in this test`);
      }) as unknown as typeof fetch;

      const renderer = await renderNewChat();
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(queryByText(renderer.root, 'Add sources')).toBeNull();
    });
  });

  describe('Frontend Milestone 2 — "Use in chat" from Documents', () => {
    it('seeds pendingSources from the sources search param, with no extra network call for it', async () => {
      mockSearchParams.sources = JSON.stringify([
        { documentId: 'doc-a', displayName: 'AI Education' },
      ]);
      global.fetch = jest.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        const authResponse = AUTH_ROUTES(url);
        if (authResponse) return authResponse;
        if (url.includes('/documents')) {
          return new Response(JSON.stringify({ documents: [], total: 0 }), { status: 200 });
        }
        throw new Error(`Unexpected fetch call to ${url} in this test`);
      }) as unknown as typeof fetch;

      const renderer = await renderNewChat();
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      // The Sources button already shows the seeded count — no document
      // fetch/lookup was needed since the name travelled in the param.
      expect(findByText(renderer.root, '1 source')).toBeTruthy();
    });

    it('ignores a malformed sources param instead of crashing the composer', async () => {
      mockSearchParams.sources = '{not valid json';
      global.fetch = jest.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        const authResponse = AUTH_ROUTES(url);
        if (authResponse) return authResponse;
        if (url.includes('/documents')) {
          return new Response(JSON.stringify({ documents: [], total: 0 }), { status: 200 });
        }
        throw new Error(`Unexpected fetch call to ${url} in this test`);
      }) as unknown as typeof fetch;

      const renderer = await renderNewChat();
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(findByText(renderer.root, 'Add sources')).toBeTruthy();
    });
  });

  describe('Frontend Milestone 3 — "Ask EduM8" about a selected passage', () => {
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

    const SELECTION_CONTEXT = {
      documentId: 'doc-a',
      documentName: 'AI Education',
      pageNumber: 3,
      selectedText: 'Students completed a 12-week program.',
    };

    it('seeds a removable SelectionContextChip and defaults the mode to Zoom-In', async () => {
      mockSearchParams.sources = JSON.stringify([
        { documentId: 'doc-a', displayName: 'AI Education' },
      ]);
      mockSearchParams.selectionContext = JSON.stringify(SELECTION_CONTEXT);
      global.fetch = jest.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        const authResponse = AUTH_ROUTES(url);
        if (authResponse) return authResponse;
        throw new Error(`Unexpected fetch call to ${url} in this test`);
      }) as unknown as typeof fetch;

      const renderer = await renderNewChat();
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(
        findByTextIncluding(renderer.root, 'Selected passage — AI Education, page 3')
      ).toBeTruthy();
      expect(
        findByTextIncluding(renderer.root, 'Students completed a 12-week program.')
      ).toBeTruthy();
      // The composer badge already reads "Zoom-In · 1" — the mode was
      // defaulted, not left at Prioritize, without the user opening the
      // Sources picker at all.
      expect(findByTextIncluding(renderer.root, 'Zoom-In')).toBeTruthy();
    });

    it('removing the chip clears the selection context — it never silently reappears', async () => {
      mockSearchParams.sources = JSON.stringify([
        { documentId: 'doc-a', displayName: 'AI Education' },
      ]);
      mockSearchParams.selectionContext = JSON.stringify(SELECTION_CONTEXT);
      global.fetch = jest.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        const authResponse = AUTH_ROUTES(url);
        if (authResponse) return authResponse;
        throw new Error(`Unexpected fetch call to ${url} in this test`);
      }) as unknown as typeof fetch;

      const renderer = await renderNewChat();
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      act(() => {
        renderer.root
          .find((n) => n.props.accessibilityLabel === 'Remove selected passage from this question')
          .props.onPress();
      });

      expect(queryByTextIncluding(renderer.root, 'Selected passage —')).toBeNull();
    });

    it('ignores a malformed selectionContext param instead of crashing the composer', async () => {
      mockSearchParams.selectionContext = '{not valid json';
      global.fetch = jest.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        const authResponse = AUTH_ROUTES(url);
        if (authResponse) return authResponse;
        throw new Error(`Unexpected fetch call to ${url} in this test`);
      }) as unknown as typeof fetch;

      const renderer = await renderNewChat();
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(queryByTextIncluding(renderer.root, 'Selected passage —')).toBeNull();
    });

    it('sends the selected passage as explicit, visible primary context folded into the actual question — never silently, never the whole document', async () => {
      mockSearchParams.sources = JSON.stringify([
        { documentId: 'doc-a', displayName: 'AI Education' },
      ]);
      mockSearchParams.selectionContext = JSON.stringify(SELECTION_CONTEXT);

      let messageBody: string | null = null;
      let scopePatchBody: string | null = null;
      global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        const method = (init?.method ?? 'GET').toUpperCase();
        const authResponse = AUTH_ROUTES(url);
        if (authResponse) return authResponse;
        if (method === 'POST' && url.endsWith('/conversations')) {
          return conversationCreatedResponse();
        }
        if (method === 'PUT' && url.endsWith('/conversations/new-conversation-id/documents')) {
          return new Response(JSON.stringify({ documents: [], total: 1 }), { status: 200 });
        }
        if (method === 'PATCH' && url.endsWith('/conversations/new-conversation-id/scope')) {
          scopePatchBody = String(init?.body);
          return new Response(
            JSON.stringify({
              chat_enabled: true,
              project_enabled: true,
              general_enabled: true,
              include_other_project_summaries: false,
              zoom_in_mode: true,
            }),
            { status: 200 }
          );
        }
        if (method === 'POST' && url.endsWith('/conversations/new-conversation-id/messages')) {
          messageBody = String(init?.body);
          return controllableSseResponse().response;
        }
        throw new Error(`Unexpected fetch call to ${url} in this test`);
      }) as unknown as typeof fetch;

      const renderer = await renderNewChat();
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      const input = renderer.root.find((node) => String(node.type) === 'TextInput');
      act(() => {
        input.props.onChangeText('What does this mean?');
      });
      await act(async () => {
        findPressableByText(renderer.root, 'Ask').props.onPress();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(JSON.parse(scopePatchBody!)).toEqual({ zoom_in_mode: true });
      const sentQuery = JSON.parse(messageBody!).query as string;
      expect(sentQuery).toContain('AI Education');
      expect(sentQuery).toContain('page 3');
      expect(sentQuery).toContain('Students completed a 12-week program.');
      expect(sentQuery).toContain('What does this mean?');
      // Bounded: only the selected passage, never a broader document dump.
      expect(sentQuery.length).toBeLessThan(500);

      // The chip is cleared from the composer immediately on submit — it
      // must not silently linger or reappear for the next question.
      expect(queryByTextIncluding(renderer.root, 'Selected passage —')).toBeNull();
    });
  });

  // Milestone 4: Zoom-In / strict selected-source mode — new-conversation
  // lifecycle ordering extends Milestone 3's exact pattern above: mode is
  // persisted (PATCH .../scope) immediately after the sources (PUT
  // .../documents), still strictly before the first message is sent.
  describe('Zoom-In (Milestone 4) — new-conversation lifecycle', () => {
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

    it(
      'selecting Zoom-In persists documents (PUT) THEN mode (PATCH), both before the message ' +
        'is sent',
      async () => {
        const callOrder: string[] = [];
        let patchBody: unknown = null;

        global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = typeof input === 'string' ? input : input.toString();
          const method = (init?.method ?? 'GET').toUpperCase();
          const authResponse = AUTH_ROUTES(url);
          if (authResponse) return authResponse;
          if (method === 'GET' && url.includes('/folders/contents')) {
            return new Response(
              JSON.stringify({
                folder: null,
                breadcrumbs: [],
                folders: [],
                documents: [
                  {
                    document_id: 'doc-a',
                    source_filename: 'a.pdf',
                    title: 'AI Education',
                    folder_id: null,
                    document_type: 'report',
                    chunk_count: 1,
                    ingested_at: '2026-01-01T00:00:00Z',
                  },
                ],
                documents_total: 1,
              }),
              { status: 200 }
            );
          }
          if (method === 'POST' && url.endsWith('/conversations')) {
            callOrder.push('create-conversation');
            return conversationCreatedResponse();
          }
          if (method === 'PUT' && url.endsWith('/conversations/new-conversation-id/documents')) {
            callOrder.push('put-documents');
            return new Response(JSON.stringify({ documents: [], total: 1 }), { status: 200 });
          }
          if (method === 'PATCH' && url.endsWith('/conversations/new-conversation-id/scope')) {
            callOrder.push('patch-scope');
            patchBody = JSON.parse(String(init?.body));
            return new Response(
              JSON.stringify({
                chat_enabled: true,
                project_enabled: true,
                general_enabled: true,
                include_other_project_summaries: false,
                zoom_in_mode: true,
              }),
              { status: 200 }
            );
          }
          if (method === 'POST' && url.endsWith('/conversations/new-conversation-id/messages')) {
            callOrder.push('send-message');
            return new Response(
              new ReadableStream({
                start(controller) {
                  const encoder = new TextEncoder();
                  controller.enqueue(
                    encoder.encode(`data: ${JSON.stringify({ type: 'token', content: 'Hi' })}\n\n`)
                  );
                  controller.enqueue(
                    encoder.encode(
                      `data: ${JSON.stringify({
                        type: 'done',
                        citations: [],
                        citation_warnings: [],
                        insufficient_evidence: false,
                      })}\n\n`
                    )
                  );
                  controller.close();
                },
              }),
              { status: 200, headers: { 'content-type': 'text/event-stream' } }
            );
          }
          throw new Error(`Unexpected fetch call to ${url} in this test`);
        }) as unknown as typeof fetch;

        const renderer = await renderNewChat();

        await act(async () => {
          findPressableByText(renderer.root, 'Add sources').props.onPress();
          await Promise.resolve();
          await Promise.resolve();
        });
        await act(async () => {
          const checkbox = renderer.root.find(
            (node) =>
              typeof node.props.onPress === 'function' &&
              node.props.accessibilityLabel === 'Add AI Education'
          );
          checkbox.props.onPress();
        });
        await act(async () => {
          findPressableByText(renderer.root, 'Zoom-In').props.onPress();
        });
        await act(async () => {
          findPressableByText(renderer.root, 'Save').props.onPress();
        });

        // The composer badge reflects the local pending Zoom-In selection.
        expect(findByTextIncluding(renderer.root, 'Zoom-In · 1')).toBeTruthy();
        expect(callOrder).toEqual([]);

        const input = renderer.root.find((node) => String(node.type) === 'TextInput');
        act(() => {
          input.props.onChangeText('What does AI Education say?');
        });
        await act(async () => {
          findPressableByText(renderer.root, 'Ask').props.onPress();
          await Promise.resolve();
          await Promise.resolve();
          await Promise.resolve();
          await Promise.resolve();
        });

        expect(callOrder).toEqual([
          'create-conversation',
          'put-documents',
          'patch-scope',
          'send-message',
        ]);
        expect(patchBody).toEqual({ zoom_in_mode: true });
      }
    );

    it(
      'a scope PATCH failure blocks the message from ever being sent, and Retry resends the ' +
        'exact same PUT+PATCH sequence',
      async () => {
        const callOrder: string[] = [];
        let patchAttempts = 0;

        global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = typeof input === 'string' ? input : input.toString();
          const method = (init?.method ?? 'GET').toUpperCase();
          const authResponse = AUTH_ROUTES(url);
          if (authResponse) return authResponse;
          if (method === 'GET' && url.includes('/folders/contents')) {
            return new Response(
              JSON.stringify({
                folder: null,
                breadcrumbs: [],
                folders: [],
                documents: [
                  {
                    document_id: 'doc-a',
                    source_filename: 'a.pdf',
                    title: 'AI Education',
                    folder_id: null,
                    document_type: 'report',
                    chunk_count: 1,
                    ingested_at: '2026-01-01T00:00:00Z',
                  },
                ],
                documents_total: 1,
              }),
              { status: 200 }
            );
          }
          if (method === 'POST' && url.endsWith('/conversations')) {
            callOrder.push('create-conversation');
            return conversationCreatedResponse();
          }
          if (method === 'PUT' && url.endsWith('/conversations/new-conversation-id/documents')) {
            callOrder.push('put-documents');
            return new Response(JSON.stringify({ documents: [], total: 1 }), { status: 200 });
          }
          if (method === 'PATCH' && url.endsWith('/conversations/new-conversation-id/scope')) {
            callOrder.push('patch-scope');
            patchAttempts += 1;
            return new Response(JSON.stringify({ detail: 'boom' }), { status: 500 });
          }
          if (method === 'POST' && url.endsWith('/conversations/new-conversation-id/messages')) {
            callOrder.push('send-message');
            throw new Error('must never be reached — the scope PATCH failed');
          }
          throw new Error(`Unexpected fetch call to ${url} in this test`);
        }) as unknown as typeof fetch;

        const renderer = await renderNewChat();

        await act(async () => {
          findPressableByText(renderer.root, 'Add sources').props.onPress();
          await Promise.resolve();
          await Promise.resolve();
        });
        await act(async () => {
          const checkbox = renderer.root.find(
            (node) =>
              typeof node.props.onPress === 'function' &&
              node.props.accessibilityLabel === 'Add AI Education'
          );
          checkbox.props.onPress();
        });
        await act(async () => {
          findPressableByText(renderer.root, 'Zoom-In').props.onPress();
        });
        await act(async () => {
          findPressableByText(renderer.root, 'Save').props.onPress();
        });

        const input = renderer.root.find((node) => String(node.type) === 'TextInput');
        act(() => {
          input.props.onChangeText('What does AI Education say?');
        });
        await act(async () => {
          findPressableByText(renderer.root, 'Ask').props.onPress();
          await Promise.resolve();
          await Promise.resolve();
          await Promise.resolve();
          await Promise.resolve();
        });

        expect(callOrder).toEqual(['create-conversation', 'put-documents', 'patch-scope']);
        expect(patchAttempts).toBe(1);
        expect(queryByText(renderer.root, 'Retry')).toBeTruthy();

        await act(async () => {
          findPressableByText(renderer.root, 'Retry').props.onPress();
          await Promise.resolve();
          await Promise.resolve();
          await Promise.resolve();
        });

        // Retry re-attempts the exact same sequence — never skips straight
        // to sending with a broader (non-Zoom-In) scope than was chosen.
        expect(callOrder).toEqual([
          'create-conversation',
          'put-documents',
          'patch-scope',
          'put-documents',
          'patch-scope',
        ]);
        expect(patchAttempts).toBe(2);
      }
    );
  });
});
