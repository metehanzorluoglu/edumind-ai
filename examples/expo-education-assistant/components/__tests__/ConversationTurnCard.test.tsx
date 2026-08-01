import type { DisplayMessage } from 'education-assistant-client';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { Platform } from 'react-native';
import { ConversationTurnCard } from '../ConversationTurnCard';
import type { AttachmentChipInfo } from '@/lib/chatAttachments';

const mockGetAttachmentImageSource = jest.fn();
const mockFetchAttachmentBlob = jest.fn();
// Module-scoped (referentially stable) client — the real ClientProvider
// memoizes its client (useMemo on baseUrl/accessToken), and
// AuthenticatedAttachmentImage's fetch effect lists `client` as a
// dependency: a fresh object per render would retrigger the effect on
// every render and never settle.
const mockClient = {
  fetchAttachmentBlob: mockFetchAttachmentBlob,
  getAttachmentImageSource: mockGetAttachmentImageSource,
};
jest.mock('@/lib/ClientProvider', () => ({
  useClient: () => ({ client: mockClient }),
}));

// This suite renders ConversationTurnCard, which delegates image-generation
// turns to GeneratedImageGallery — and that gallery reads the
// image-generator feature flag (see lib/FeatureFlags). This file's
// existing tests are about cross-cutting conversation-card behavior; they
// keep assuming the feature is enabled (so Regenerate is shown). Tests
// covering the disabled Regenerate gate live alongside the gallery, in
// components/__tests__/GeneratedImageGallery.test.tsx.
jest.mock('@/lib/FeatureFlags', () => ({
  useFeatureFlags: () => ({ imageGenerator: true, loaded: true, refresh: jest.fn() }),
}));

/** The counter Text (`{index + 1} / {attachments.length}`) compiles to
 * multiple children (a mix of numbers and strings), not one joined string —
 * join them before comparing. */
function textContent(node: ReactTestInstance): string {
  return node.children.map((child) => (typeof child === 'object' ? '' : String(child))).join('');
}

function findByJoinedText(root: ReactTestInstance, text: string): ReactTestInstance {
  return root.find((node) => String(node.type) === 'Text' && textContent(node) === text);
}

function queryByText(root: ReactTestInstance, text: string): ReactTestInstance | null {
  const matches = root.findAll(
    (node) => String(node.type) === 'Text' && node.children.includes(text)
  );
  return matches[0] ?? null;
}

function persistedImage(overrides: Partial<AttachmentChipInfo> = {}): AttachmentChipInfo {
  return {
    key: 'a1',
    filename: 'photo.png',
    mimeType: 'image/png',
    sizeBytes: 2048,
    pageCount: null,
    pageRangeStart: null,
    pageRangeEnd: null,
    remote: { conversationId: 'c1', messageId: 'm1' },
    ...overrides,
  };
}

function pendingImage(): AttachmentChipInfo {
  return {
    key: 'local-1',
    filename: 'not-yet-sent.png',
    mimeType: 'image/png',
    sizeBytes: 1024,
    pageCount: null,
    pageRangeStart: null,
    pageRangeEnd: null,
    remote: null,
  };
}

describe('ConversationTurnCard attachment lightbox (milestone V4)', () => {
  const originalOS = Platform.OS;

  beforeEach(() => {
    Platform.OS = 'ios';
    mockGetAttachmentImageSource.mockResolvedValue({
      uri: 'http://localhost:8000/conversations/c1/messages/m1/attachments/a1',
      headers: {},
    });
  });

  afterEach(() => {
    Platform.OS = originalOS;
    jest.clearAllMocks();
  });

  it('opens the lightbox when a persisted attachment chip is pressed, and closes it via the close button', async () => {
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <ConversationTurnCard
          userContent="What is in this picture?"
          assistant={null}
          userAttachments={[persistedImage()]}
          onCitationPress={() => {}}
        />
      );
      await Promise.resolve();
    });

    expect(queryByText(renderer.root, 'photo.png')).toBeTruthy(); // filename shown in the chip

    const chipButton = renderer.root.find(
      (node) => node.props.accessibilityLabel === 'View photo.png'
    );
    await act(async () => {
      chipButton.props.onPress();
      await Promise.resolve();
    });

    // The lightbox's own top bar repeats the filename — now findable twice
    // (chip + lightbox) proves the modal actually opened.
    expect(
      renderer.root.findAll((n) => String(n.type) === 'Text' && n.children.includes('photo.png'))
        .length
    ).toBeGreaterThanOrEqual(2);

    const closeButton = renderer.root.find(
      (node) => node.props.accessibilityLabel === 'Close preview'
    );
    await act(async () => {
      closeButton.props.onPress();
      await Promise.resolve();
    });

    expect(
      renderer.root.findAll((n) => String(n.type) === 'Text' && n.children.includes('photo.png'))
        .length
    ).toBe(1);
  });

  it('does not make a not-yet-sent attachment chip pressable (no lightbox to open yet)', async () => {
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <ConversationTurnCard
          userContent="What about this one?"
          assistant={null}
          userAttachments={[pendingImage()]}
          onCitationPress={() => {}}
        />
      );
      await Promise.resolve();
    });

    expect(
      renderer.root.findAll((node) => node.props.accessibilityLabel === 'View not-yet-sent.png')
    ).toHaveLength(0);
  });

  it('shows a counter and lets the user page between multiple attachments in the same turn', async () => {
    const first = persistedImage({ key: 'a1', filename: 'first.png' });
    const second = persistedImage({ key: 'a2', filename: 'second.png' });

    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <ConversationTurnCard
          userContent="Compare these two"
          assistant={null}
          userAttachments={[first, second]}
          onCitationPress={() => {}}
        />
      );
      await Promise.resolve();
    });

    const chipButton = renderer.root.find(
      (node) => node.props.accessibilityLabel === 'View first.png'
    );
    await act(async () => {
      chipButton.props.onPress();
      await Promise.resolve();
    });

    expect(findByJoinedText(renderer.root, '1 / 2')).toBeTruthy();
  });

  it('routes reference attachments to Regenerate, not as gallery tiles', async () => {
    mockGetAttachmentImageSource.mockResolvedValue({ uri: 'http://x/g1', headers: {} });
    const onRegenerateImage = jest.fn();
    const assistant = {
      id: 'm1',
      role: 'assistant',
      content: 'a red apple',
      citations: [],
      citationWarnings: [],
      insufficientEvidence: false,
      streaming: false,
      sources: [],
      error: null,
      attachments: [
        {
          id: 'g1',
          mime: 'image/png',
          filename: 'generated-g1.png',
          size_bytes: 2048,
          page_count: null,
          page_range_start: null,
          page_range_end: null,
          created_at: '2026-01-01T00:00:00Z',
          source: 'generated',
          generation_prompt: 'a red apple',
          generation_negative_prompt: null,
          generation_seed: 7,
          generation_model: 'x/flux2-klein',
          generation_width: 512,
          generation_height: 512,
          saved_project_id: null,
        },
        {
          id: 'r1',
          mime: 'image/png',
          filename: 'finch.png',
          size_bytes: 1024,
          page_count: null,
          page_range_start: null,
          page_range_end: null,
          created_at: '2026-01-01T00:00:00Z',
          source: 'reference',
          generation_prompt: null,
          generation_negative_prompt: null,
          generation_seed: null,
          generation_model: null,
          generation_width: null,
          generation_height: null,
          saved_project_id: null,
        },
      ],
    } as unknown as DisplayMessage;

    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <ConversationTurnCard
          userContent=""
          assistant={assistant}
          conversationId="c1"
          onCitationPress={() => {}}
          onRegenerateImage={onRegenerateImage}
        />
      );
      await Promise.resolve();
    });

    // The reference is NOT rendered as a gallery tile — exactly one Regenerate
    // button (the single generated image), not two.
    const regenerateButtons = renderer.root.findAll(
      (n) =>
        n.props.accessibilityLabel === 'Regenerate image' && typeof n.props.onPress === 'function'
    );
    expect(regenerateButtons).toHaveLength(1);

    await act(async () => {
      regenerateButtons[0]!.props.onPress();
    });

    // …but the reference is forwarded so Regenerate can prefill it.
    expect(onRegenerateImage).toHaveBeenCalledWith(
      expect.objectContaining({
        referenceImages: [
          {
            name: 'finch.png',
            mimeType: 'image/png',
            remote: { conversationId: 'c1', messageId: 'm1', attachmentId: 'r1' },
          },
        ],
      })
    );
  });
});

function streamingAssistant(overrides: Partial<DisplayMessage> = {}): DisplayMessage {
  return {
    id: 'a1',
    role: 'assistant',
    content: '',
    sources: [],
    citations: [],
    citationWarnings: [],
    insufficientEvidence: false,
    createdAt: null,
    streaming: true,
    error: null,
    stage: null,
    attachments: [],
    ...overrides,
  };
}

// Regression coverage for the indefinite "Connecting…" freeze: while
// waiting on a slow (CPU-only Ollama) backend, the card must show real
// backend-reported status (see ChatStage/STAGE_LABELS) instead of a single
// static string for the entire wait, and must fall back sensibly once real
// output starts or for a stage this build doesn't recognize.
describe('ConversationTurnCard progress-stage display', () => {
  it('shows the generic "Connecting…" label before any stage has been received', async () => {
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <ConversationTurnCard
          userContent="hi"
          assistant={streamingAssistant()}
          onCitationPress={() => {}}
        />
      );
      await Promise.resolve();
    });

    expect(queryByText(renderer.root, 'Connecting…')).toBeTruthy();
  });

  it('shows the label for the assistant turn\'s current stage', async () => {
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <ConversationTurnCard
          userContent="hi"
          assistant={streamingAssistant({ stage: 'loading_model' })}
          onCitationPress={() => {}}
        />
      );
      await Promise.resolve();
    });

    expect(queryByText(renderer.root, 'Waking up the model…')).toBeTruthy();
    expect(queryByText(renderer.root, 'Connecting…')).toBeNull();
  });

  it('updates the displayed label as the stage changes across rerenders', async () => {
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <ConversationTurnCard
          userContent="hi"
          assistant={streamingAssistant({ stage: 'retrieving' })}
          onCitationPress={() => {}}
        />
      );
      await Promise.resolve();
    });
    expect(queryByText(renderer.root, 'Searching your documents…')).toBeTruthy();

    await act(async () => {
      renderer.update(
        <ConversationTurnCard
          userContent="hi"
          assistant={streamingAssistant({ stage: 'generating' })}
          onCitationPress={() => {}}
        />
      );
      await Promise.resolve();
    });
    expect(queryByText(renderer.root, 'Generating answer…')).toBeTruthy();
    expect(queryByText(renderer.root, 'Searching your documents…')).toBeNull();
  });

  it('falls back to "Connecting…" for a stage this build does not recognize', async () => {
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <ConversationTurnCard
          userContent="hi"
          // A future backend stage this SDK build predates — same
          // forward-compatible treatment the SSE parser itself gives an
          // unrecognized stage (see stream.ts's parseChatEvent).
          assistant={streamingAssistant({ stage: 'some_future_stage' as never })}
          onCitationPress={() => {}}
        />
      );
      await Promise.resolve();
    });

    expect(queryByText(renderer.root, 'Connecting…')).toBeTruthy();
  });

  it('shows no stage hint once real content has started streaming in', async () => {
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <ConversationTurnCard
          userContent="hi"
          assistant={streamingAssistant({ stage: 'generating', content: 'Hello' })}
          onCitationPress={() => {}}
        />
      );
      await Promise.resolve();
    });

    expect(queryByText(renderer.root, 'Generating answer…')).toBeNull();
    expect(queryByText(renderer.root, 'Connecting…')).toBeNull();
  });
});
