import type { Citation, DisplayMessage, DisplaySource } from 'education-assistant-client';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { ActivityIndicator, Platform } from 'react-native';
import { ConversationTurnCard } from '../ConversationTurnCard';
import type { AttachmentChipInfo } from '@/lib/chatAttachments';
import { PreferencesProvider } from '@/lib/Preferences';

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
      thinking: null,
      thinkingContext: null,
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
    thinking: 'connecting',
    thinkingContext: { hasAttachments: false, retrievalEnabled: true },
    attachments: [],
    ...overrides,
  };
}

// Recursively joins every string descendant of a test-instance subtree —
// MarkdownAnswer's rendered blocks nest text several levels deep, where
// textContent()'s direct-children join stops seeing it.
function deepTextIncludes(node: ReactTestInstance, substring: string): boolean {
  const join = (n: ReactTestInstance): string =>
    n.children
      .map((child) =>
        typeof child === 'object' && child !== null
          ? join(child)
          : typeof child === 'string'
            ? child
            : ''
      )
      .join('');
  return join(node).includes(substring);
}

// Coverage for the thinking preview that replaced the old centered
// "Connecting…" + spinner pending state: a fixed "Preparing a response..."
// title with a muted, animated shadow box underneath it (truthful rotating
// status text + animated dots) inside the assistant bubble from submission
// until the first streamed token, fading out (never coexisting with the
// answer) once the turn leaves the thinking state, with all timers/
// animations cleaned up on unmount.
describe('ConversationTurnCard thinking placeholder', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const textOnly = { hasAttachments: false, retrievalEnabled: true };
  const visionOnly = { hasAttachments: true, retrievalEnabled: false };

  /** Long enough for the card's ~200ms exit-fade linger to elapse. */
  async function finishFadeOut(): Promise<void> {
    await act(async () => {
      jest.advanceTimersByTime(400);
    });
  }

  // Host instances only (typeof type === 'string'): RN 0.81's View is a
  // composite wrapper around the host view, and both layers expose the
  // testID prop, which would double-count.
  const shadowBoxes = (root: ReactTestInstance): ReactTestInstance[] =>
    root.findAll(
      (node) => typeof node.type === 'string' && node.props.testID === 'thinking-shadow-box'
    );

  it('shows "Preparing a response..." with the shadow box immediately while waiting, and never the old "Connecting…" label or a spinner', async () => {
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

    // The fixed title and the first in-box status are both live from the
    // moment the turn exists.
    expect(queryByText(renderer.root, 'Preparing a response...')).toBeTruthy();
    expect(queryByText(renderer.root, 'Understanding your question...')).toBeTruthy();
    expect(shadowBoxes(renderer.root)).toHaveLength(1);
    // The retired pending state must not leak back in any waiting phase.
    expect(queryByText(renderer.root, 'Connecting…')).toBeNull();
    expect(renderer.root.findAllByType(ActivityIndicator)).toHaveLength(0);

    // Same holds once progress has started but no token has arrived yet
    // (the waiting_for_first_token phase).
    await act(async () => {
      renderer.update(
        <ConversationTurnCard
          userContent="hi"
          assistant={streamingAssistant({
            thinking: 'waiting_for_first_token',
            stage: 'loading_model',
          })}
          onCitationPress={() => {}}
        />
      );
      await Promise.resolve();
    });
    expect(shadowBoxes(renderer.root)).toHaveLength(1);
    expect(queryByText(renderer.root, 'Connecting…')).toBeNull();
    expect(renderer.root.findAllByType(ActivityIndicator)).toHaveLength(0);
  });

  it('rotates the box text every 2s and parks on the final message', async () => {
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <ConversationTurnCard
          userContent="hi"
          assistant={streamingAssistant({ thinkingContext: textOnly })}
          onCitationPress={() => {}}
        />
      );
      await Promise.resolve();
    });
    expect(queryByText(renderer.root, 'Understanding your question...')).toBeTruthy();

    await act(async () => {
      jest.advanceTimersByTime(2000);
    });
    expect(queryByText(renderer.root, 'Organizing key information...')).toBeTruthy();
    expect(queryByText(renderer.root, 'Understanding your question...')).toBeNull();

    await act(async () => {
      jest.advanceTimersByTime(2000);
    });
    expect(queryByText(renderer.root, 'Searching your documents...')).toBeTruthy();

    await act(async () => {
      jest.advanceTimersByTime(2000);
    });
    expect(queryByText(renderer.root, 'Preparing the final response...')).toBeTruthy();

    // Parked on the final status — never cycles back to the start.
    await act(async () => {
      jest.advanceTimersByTime(2000 * 4);
    });
    expect(queryByText(renderer.root, 'Preparing the final response...')).toBeTruthy();
    expect(queryByText(renderer.root, 'Understanding your question...')).toBeNull();
  });

  it('never shows retrieval-specific text for a request that does not use retrieval', async () => {
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <ConversationTurnCard
          userContent="What is in this picture?"
          assistant={streamingAssistant({ thinkingContext: visionOnly })}
          onCitationPress={() => {}}
        />
      );
      await Promise.resolve();
    });
    expect(queryByText(renderer.root, 'Reviewing the attached images...')).toBeTruthy();
    expect(queryByText(renderer.root, 'Searching your documents')).toBeNull();

    // Walk the entire rotation — document-searching text may not appear at
    // any point for a vision-only request.
    for (let i = 0; i < 4; i++) {
      await act(async () => {
        jest.advanceTimersByTime(2000);
      });
      expect(queryByText(renderer.root, 'Searching your documents')).toBeNull();
    }
    expect(queryByText(renderer.root, 'Preparing the final response...')).toBeTruthy();
  });

  it('falls back to always-true statuses when no context is available', async () => {
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <ConversationTurnCard
          userContent="hi"
          assistant={streamingAssistant({ thinkingContext: null })}
          onCitationPress={() => {}}
        />
      );
      await Promise.resolve();
    });

    expect(queryByText(renderer.root, 'Organizing key information...')).toBeTruthy();
  });

  it('the first streamed token fades the placeholder out and reveals the answer in the same card — never both at once', async () => {
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <ConversationTurnCard
          userContent="How do plants grow?"
          assistant={streamingAssistant()}
          onCitationPress={() => {}}
        />
      );
      await Promise.resolve();
    });
    expect(shadowBoxes(renderer.root)).toHaveLength(1);

    await act(async () => {
      renderer.update(
        <ConversationTurnCard
          userContent="How do plants grow?"
          assistant={streamingAssistant({
            thinking: null,
            content: 'Based on the information in your uploaded documents, plants need light.',
          })}
          onCitationPress={() => {}}
        />
      );
      await Promise.resolve();
    });

    // Mid-fade: the box is still mounted (fading out) but the answer is
    // deliberately held back — the two are never on screen at the same time.
    expect(
      deepTextIncludes(
        renderer.root,
        'Based on the information in your uploaded documents, plants need light.'
      )
    ).toBe(false);

    await finishFadeOut();

    // Fade finished: placeholder (title + box) gone, real answer rendered by
    // the real MarkdownAnswer inside the same card.
    expect(shadowBoxes(renderer.root)).toHaveLength(0);
    expect(queryByText(renderer.root, 'Preparing a response...')).toBeNull();
    expect(queryByText(renderer.root, 'Understanding your question...')).toBeNull();
    expect(
      deepTextIncludes(
        renderer.root,
        'Based on the information in your uploaded documents, plants need light.'
      )
    ).toBe(true);
  });

  it('removes the placeholder when the turn errors before the first token', async () => {
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
    expect(shadowBoxes(renderer.root)).toHaveLength(1);

    await act(async () => {
      renderer.update(
        <ConversationTurnCard
          userContent="hi"
          assistant={streamingAssistant({
            thinking: null,
            streaming: false,
            error: 'model unreachable',
          })}
          onCitationPress={() => {}}
        />
      );
      await Promise.resolve();
    });

    // The error state shows immediately; the box finishes its fade and is
    // gone right after.
    expect(queryByText(renderer.root, 'model unreachable')).toBeTruthy();
    await finishFadeOut();
    expect(shadowBoxes(renderer.root)).toHaveLength(0);
    expect(queryByText(renderer.root, 'Understanding your question...')).toBeNull();
  });

  it('removes the placeholder when generation is cancelled', async () => {
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
    expect(shadowBoxes(renderer.root)).toHaveLength(1);

    await act(async () => {
      renderer.update(
        <ConversationTurnCard
          userContent="hi"
          assistant={streamingAssistant({ thinking: null, streaming: false })}
          onCitationPress={() => {}}
        />
      );
      await Promise.resolve();
    });

    await finishFadeOut();
    expect(shadowBoxes(renderer.root)).toHaveLength(0);
    expect(queryByText(renderer.root, 'Preparing a response...')).toBeNull();
    expect(queryByText(renderer.root, 'Understanding your question...')).toBeNull();
  });

  it('cleans up its rotation timer, fade, and dots animation on unmount — even mid-fade', async () => {
    // Baseline: the same card with no pending assistant turn schedules
    // nothing of its own — whatever the environment itself keeps alive
    // under fake timers is not this component's responsibility.
    let control!: ReturnType<typeof create>;
    await act(async () => {
      control = create(
        <ConversationTurnCard userContent="hi" assistant={null} onCitationPress={() => {}} />
      );
      await Promise.resolve();
    });
    const baseline = jest.getTimerCount();
    await act(async () => {
      control.unmount();
    });

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
    // The rotation interval and the dots animation frame are both live.
    expect(jest.getTimerCount()).toBeGreaterThan(baseline);

    // Leave the thinking state so the exit-fade linger timer is scheduled
    // too, then unmount in the middle of the fade — everything must still
    // be released.
    await act(async () => {
      renderer.update(
        <ConversationTurnCard
          userContent="hi"
          assistant={streamingAssistant({
            thinking: null,
            content: 'The answer.',
          })}
          onCitationPress={() => {}}
        />
      );
      await Promise.resolve();
    });
    await act(async () => {
      renderer.unmount();
    });
    // The unmount's own teardown handling enqueues a couple of one-shot
    // callbacks; give them time to expire. A leaked interval or animation
    // loop would keep rescheduling itself forever and never converge.
    await act(async () => {
      jest.advanceTimersByTime(60000);
    });
    // Everything the placeholder scheduled is gone — no leaked interval,
    // linger timer, or orphaned animation frame.
    expect(jest.getTimerCount()).toBe(baseline);
  });
});

// Fixtures for the cited-only Sources section: four retrieved chunks that
// the backend labels S1..S4 (build_citations labels EVERY retrieved chunk),
// of which the answer text cites only a subset.
function sourceFixture(n: number, title: string): DisplaySource {
  return {
    rank: n,
    document_id: `doc-${n}`,
    chunk_id: `chunk-${n}`,
    chunk_index: 0,
    page_number: n,
    score: 0.9,
    text: `${title} excerpt text`,
    title,
    authors: ['A. Researcher'],
    publication_year: 2021,
    source_venue: null,
    document_type: 'journal_article',
    journal_quartile: null,
    doi: null,
    source_url: null,
    source_filename: `file-${n}.pdf`,
    scope: 'general',
  };
}

function citationFixture(n: number, title: string): Citation {
  return {
    source_id: `S${n}`,
    document_id: `doc-${n}`,
    chunk_id: `chunk-${n}`,
    title,
    authors: ['A. Researcher'],
    publication_year: 2021,
    source_venue: null,
    document_type: 'journal_article',
    journal_quartile: null,
    page_start: n,
    page_end: n,
    doi: null,
    source_url: null,
    score: 0.9,
  };
}

const SOURCE_TITLES = ['Alpha source', 'Beta source', 'Gamma source', 'Delta source'];

function answeredAssistant(answer: string): DisplayMessage {
  return streamingAssistant({
    streaming: false,
    thinking: null,
    content: answer,
    sources: SOURCE_TITLES.map((title, i) => sourceFixture(i + 1, title)),
    citations: SOURCE_TITLES.map((title, i) => citationFixture(i + 1, title)),
  });
}

// The Sources section renders one SourceCard per CITED source only —
// retrieved-but-uncited documents are never shown, every displayed card has
// at least one inline [S#] marker in the answer, numbering is the backend's
// (never renumbered), and repeats collapse to a single card.
describe('ConversationTurnCard cited-only sources', () => {
  async function renderAnswer(answer: string): Promise<ReturnType<typeof create>> {
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <ConversationTurnCard
          userContent="What does the research say?"
          assistant={answeredAssistant(answer)}
          onCitationPress={() => {}}
        />
      );
      await Promise.resolve();
    });
    return renderer;
  }

  const cardTitles = (root: ReactTestInstance, title: string): ReactTestInstance[] =>
    root.findAll((node) => String(node.type) === 'Text' && node.children.includes(title));

  // The card badge renders `[{sourceId}]` as three separate string children,
  // so join before matching.
  const badges = (root: ReactTestInstance, badge: string): ReactTestInstance[] =>
    root.findAll((node) => String(node.type) === 'Text' && textContent(node).includes(badge));

  it('one citation renders exactly one source card', async () => {
    const renderer = await renderAnswer('One clear claim [S1].');

    expect(cardTitles(renderer.root, 'Alpha source')).toHaveLength(1);
    // The other three were retrieved but never cited — no cards for them.
    expect(queryByText(renderer.root, 'Beta source')).toBeNull();
    expect(queryByText(renderer.root, 'Gamma source')).toBeNull();
    expect(queryByText(renderer.root, 'Delta source')).toBeNull();
    expect(badges(renderer.root, '[S2]')).toHaveLength(0);
    expect(badges(renderer.root, '[S3]')).toHaveLength(0);
    expect(badges(renderer.root, '[S4]')).toHaveLength(0);
  });

  it('two citations render exactly two source cards, in S-number order', async () => {
    const renderer = await renderAnswer('First point [S1] and third point [S3].');

    expect(cardTitles(renderer.root, 'Alpha source')).toHaveLength(1);
    expect(cardTitles(renderer.root, 'Gamma source')).toHaveLength(1);
    expect(queryByText(renderer.root, 'Beta source')).toBeNull();
    expect(queryByText(renderer.root, 'Delta source')).toBeNull();

    // Card order follows the backend's S-numbering (S1 before S3).
    const shown = renderer.root
      .findAll(
        (node) =>
          String(node.type) === 'Text' &&
          (node.children.includes('Alpha source') || node.children.includes('Gamma source'))
      )
      .map((node) => node.children.join(''));
    expect(shown).toEqual(['Alpha source', 'Gamma source']);
  });

  it('repeated citations of the same source collapse to a single card', async () => {
    const renderer = await renderAnswer('Made twice [S1] and again [S1].');

    // Both inline markers are still in the answer text...
    expect(deepTextIncludes(renderer.root, 'Made twice')).toBe(true);
    // ...but there is exactly one Alpha card, not two.
    expect(cardTitles(renderer.root, 'Alpha source')).toHaveLength(1);
    expect(cardTitles(renderer.root, 'Beta source')).toHaveLength(0);
  });

  it('an answer with no citations shows no Sources section at all', async () => {
    const renderer = await renderAnswer('A plain answer with no citation markers.');

    expect(queryByText(renderer.root, 'Sources')).toBeNull();
    for (const title of SOURCE_TITLES) {
      expect(queryByText(renderer.root, title)).toBeNull();
    }
  });

  it('hides the Sources section entirely when the "Show citations" preference is off', async () => {
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <PreferencesProvider initialOverrides={{ citationDisplay: 'hidden' }}>
          <ConversationTurnCard
            userContent="What does the research say?"
            assistant={answeredAssistant('One clear claim [S1].')}
            onCitationPress={() => {}}
          />
        </PreferencesProvider>
      );
      await Promise.resolve();
    });

    // Cited or not — with the preference off, no source cards render.
    expect(queryByText(renderer.root, 'Sources')).toBeNull();
    expect(queryByText(renderer.root, 'Alpha source')).toBeNull();
    // The inline citation link stays in the answer text itself.
    expect(deepTextIncludes(renderer.root, 'One clear claim')).toBe(true);
  });

  it('citation numbering stays consistent after filtering (S3 stays [S3])', async () => {
    const renderer = await renderAnswer('Only the third document supports this [S3].');

    // The Gamma card keeps its backend-assigned [S3] identity (one badge on
    // the card plus the inline marker in the answer) — it is NOT renumbered
    // to [S1] just because it is the only card shown.
    expect(cardTitles(renderer.root, 'Gamma source')).toHaveLength(1);
    expect(badges(renderer.root, '[S3]').length).toBeGreaterThanOrEqual(1);
    expect(badges(renderer.root, '[S1]')).toHaveLength(0);
    expect(queryByText(renderer.root, 'Alpha source')).toBeNull();
  });
});
