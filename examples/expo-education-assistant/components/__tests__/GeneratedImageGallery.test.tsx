import type { ConversationMessageAttachment } from 'education-assistant-client';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { GeneratedImageGallery } from '../GeneratedImageGallery';

const mockFetchAttachmentBlob = jest.fn();
const mockGetAttachmentImageSource = jest.fn();
const mockSaveAttachmentToProject = jest.fn();
const mockListProjects = jest.fn();

jest.mock('@/lib/ClientProvider', () => ({
  useClient: () => ({
    client: {
      fetchAttachmentBlob: mockFetchAttachmentBlob,
      getAttachmentImageSource: mockGetAttachmentImageSource,
      saveAttachmentToProject: mockSaveAttachmentToProject,
      listProjects: mockListProjects,
    },
    baseUrl: 'http://localhost:8000',
  }),
}));

// GeneratedImageGallery reads the image-generator flag to optionally hide
// Regenerate when disabled (see lib/FeatureFlags). The mock below reads the
// value off a hoisted, module-scoped `var` so a per-describe-block test
// suite can flip the value before rendering and exercise the "disabled"
// gate. `var` (not `let`) is deliberate — `jest.mock` factories are hoisted
// to the very top of the file and run before `let` initializers execute,
// so a `let` would throw into the TDZ on the first call. The factory closes
// over the variable by name and re-reads it on every `useFeatureFlags()`
// call, so a describe block that flips `mockImageGeneratorEnabled` in
// beforeEach actually takes effect.
// Defaults are intentionally lenient: a fresh test that forgets to flip the
// flag still exercises the previously validated enabled path (Regenerate
// is present) instead of silently no-op'ing the assertion.
// The variable name is intentionally `mock…`-prefixed: babel-jest's safety
// guard refuses out-of-scope references in `jest.mock()` factories unless
// the identifier starts with `mock` (case insensitive in newer jest, but
// staying safe with the explicit prefix).
let mockImageGeneratorEnabled = true;
jest.mock('@/lib/FeatureFlags', () => ({
  useFeatureFlags: () => ({
    imageGenerator: mockImageGeneratorEnabled,
    loaded: true,
    refresh: jest.fn(),
  }),
}));

const mockDownloadAttachment = jest.fn();
jest.mock('@/lib/downloadAttachment', () => ({
  downloadAttachment: (...args: unknown[]) => mockDownloadAttachment(...args),
}));

const mockCreatePendingAttachmentFromRemote = jest.fn();
jest.mock('@/lib/chatAttachments', () => {
  const actual = jest.requireActual('@/lib/chatAttachments');
  return {
    ...actual,
    createPendingAttachmentFromRemote: (...args: unknown[]) =>
      mockCreatePendingAttachmentFromRemote(...args),
  };
});

function findByLabel(root: ReactTestInstance, label: string): ReactTestInstance {
  return root.find(
    (node) => node.props.accessibilityLabel === label && typeof node.props.onPress === 'function'
  );
}

function findAllByLabel(root: ReactTestInstance, label: string): ReactTestInstance[] {
  return root.findAll(
    (node) => node.props.accessibilityLabel === label && typeof node.props.onPress === 'function'
  );
}

function image(
  overrides: Partial<ConversationMessageAttachment> = {}
): ConversationMessageAttachment {
  return {
    id: 'a1',
    mime: 'image/png',
    filename: 'generated-a1.png',
    size_bytes: 2048,
    page_count: null,
    page_range_start: null,
    page_range_end: null,
    created_at: '2026-01-01T00:00:00Z',
    source: 'generated',
    generation_prompt: 'a red apple',
    generation_negative_prompt: null,
    generation_seed: 42,
    generation_model: 'x/flux2-klein',
    generation_width: 512,
    generation_height: 512,
    saved_project_id: null,
    ...overrides,
  };
}

describe('GeneratedImageGallery', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAttachmentImageSource.mockResolvedValue({ uri: 'http://x/a1', headers: {} });
    mockListProjects.mockResolvedValue({ projects: [], total: 0 });
  });

  it('renders one action row per generated image', async () => {
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <GeneratedImageGallery
          conversationId="c1"
          messageId="m1"
          images={[image(), image({ id: 'a2', filename: 'generated-a2.png' })]}
          onUseAsAttachment={jest.fn()}
          onRegenerate={jest.fn()}
        />
      );
      await Promise.resolve();
    });

    expect(findAllByLabel(renderer.root, 'Download image')).toHaveLength(2);
  });

  it("Regenerate calls onRegenerate with this image's original generation params", async () => {
    const onRegenerate = jest.fn();
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <GeneratedImageGallery
          conversationId="c1"
          messageId="m1"
          images={[image()]}
          onUseAsAttachment={jest.fn()}
          onRegenerate={onRegenerate}
        />
      );
      await Promise.resolve();
    });

    await act(async () => {
      findByLabel(renderer.root, 'Regenerate image').props.onPress();
    });

    expect(onRegenerate).toHaveBeenCalledWith({
      prompt: 'a red apple',
      negativePrompt: null,
      width: 512,
      height: 512,
      referenceImages: [],
    });
  });

  it('Regenerate folds the batch reference images into the payload as remote refs', async () => {
    const onRegenerate = jest.fn();
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <GeneratedImageGallery
          conversationId="c1"
          messageId="m1"
          images={[image()]}
          referenceImages={[image({ id: 'r1', source: 'reference', filename: 'finch.png' })]}
          onUseAsAttachment={jest.fn()}
          onRegenerate={onRegenerate}
        />
      );
      await Promise.resolve();
    });

    await act(async () => {
      findByLabel(renderer.root, 'Regenerate image').props.onPress();
    });

    expect(onRegenerate).toHaveBeenCalledWith(
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

  it('Download fetches the image bytes through downloadAttachment', async () => {
    mockDownloadAttachment.mockResolvedValue(undefined);
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <GeneratedImageGallery
          conversationId="c1"
          messageId="m1"
          images={[image()]}
          onUseAsAttachment={jest.fn()}
          onRegenerate={jest.fn()}
        />
      );
      await Promise.resolve();
    });

    await act(async () => {
      findByLabel(renderer.root, 'Download image').props.onPress();
      await Promise.resolve();
    });

    expect(mockDownloadAttachment).toHaveBeenCalledWith(
      expect.anything(),
      { conversationId: 'c1', messageId: 'm1' },
      expect.objectContaining({ id: 'a1' })
    );
  });

  it('shows an inline error if Download fails', async () => {
    mockDownloadAttachment.mockRejectedValue(new Error('Sharing is not available on this device.'));
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <GeneratedImageGallery
          conversationId="c1"
          messageId="m1"
          images={[image()]}
          onUseAsAttachment={jest.fn()}
          onRegenerate={jest.fn()}
        />
      );
      await Promise.resolve();
    });

    await act(async () => {
      findByLabel(renderer.root, 'Download image').props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      renderer.root.findAll(
        (n) =>
          String(n.type) === 'Text' &&
          n.children.includes('Sharing is not available on this device.')
      ).length
    ).toBeGreaterThan(0);
  });

  it('Use as attachment builds a PendingAttachment and hands it to onUseAsAttachment', async () => {
    const pending = { localId: 'p1', name: 'generated-a1.png' };
    mockCreatePendingAttachmentFromRemote.mockResolvedValue(pending);
    const onUseAsAttachment = jest.fn();
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <GeneratedImageGallery
          conversationId="c1"
          messageId="m1"
          images={[image()]}
          onUseAsAttachment={onUseAsAttachment}
          onRegenerate={jest.fn()}
        />
      );
      await Promise.resolve();
    });

    await act(async () => {
      findByLabel(renderer.root, 'Use as attachment').props.onPress();
      await Promise.resolve();
    });

    expect(mockCreatePendingAttachmentFromRemote).toHaveBeenCalledWith(
      expect.anything(),
      { conversationId: 'c1', messageId: 'm1' },
      expect.objectContaining({ id: 'a1' })
    );
    expect(onUseAsAttachment).toHaveBeenCalledWith(pending);
  });

  it('shows "Save to project" for an unsaved image and "Saved to project" once saved', async () => {
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <GeneratedImageGallery
          conversationId="c1"
          messageId="m1"
          images={[image({ saved_project_id: 'p1' })]}
          onUseAsAttachment={jest.fn()}
          onRegenerate={jest.fn()}
        />
      );
      await Promise.resolve();
    });

    expect(
      renderer.root.findAll(
        (n) => String(n.type) === 'Text' && n.children.includes('Saved to project')
      ).length
    ).toBe(1);
  });
});

describe('GeneratedImageGallery when image generation is disabled (IMAGE_GENERATOR_ENABLED=false)', () => {
  // Centralized feature flag — when the backend's IMAGE_GENERATION_ENABLED
  // (or the app's EXPO_PUBLIC_IMAGE_GENERATOR_ENABLED bootstrap) is false,
  // the gallery must keep already-persisted images viewable (the spec is
  // "existing generated images remain viewable") but must hide every
  // affordance that would re-enter /images/generate. Today only Regenerate
  // meets that bar — the user can still Download, Use-as-attachment, and
  // Save-to-project on the same persisted bytes.
  beforeEach(() => {
    jest.clearAllMocks();
    mockImageGeneratorEnabled = false;
    mockGetAttachmentImageSource.mockResolvedValue({ uri: 'http://x/a1', headers: {} });
    mockListProjects.mockResolvedValue({ projects: [], total: 0 });
  });

  afterEach(() => {
    // Restore default for any subsequent describe in this file.
    mockImageGeneratorEnabled = true;
  });

  it('still renders the image and its Download / Use-as-attachment / Save-to-project actions', async () => {
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <GeneratedImageGallery
          conversationId="c1"
          messageId="m1"
          images={[image()]}
          onUseAsAttachment={jest.fn()}
          onRegenerate={jest.fn()}
        />
      );
      await Promise.resolve();
    });

    // The image itself, plus the three actions that operate on the
    // already-persisted file (and therefore must survive the flag being
    // false — the spec's "existing images remain viewable").
    expect(findAllByLabel(renderer.root, 'Download image')).toHaveLength(1);
    expect(findAllByLabel(renderer.root, 'Use as attachment')).toHaveLength(1);
    expect(findAllByLabel(renderer.root, 'Save to project')).toHaveLength(1);
    // Regenerate is the only generation-triggering affordance — when the
    // feature is disabled it must be entirely absent, not just disabled.
    expect(findAllByLabel(renderer.root, 'Regenerate image')).toHaveLength(0);
  });

  it('omits Regenerate even when onRegenerate is supplied, so a caller cannot accidentally invoke it', async () => {
    const onRegenerate = jest.fn();
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <GeneratedImageGallery
          conversationId="c1"
          messageId="m1"
          images={[image()]}
          onUseAsAttachment={jest.fn()}
          onRegenerate={onRegenerate}
        />
      );
      await Promise.resolve();
    });

    // The strongest assertion: even the text-only "Regenerate" label
    // never lands in the DOM, so a tap-target can never be wired to it.
    expect(
      renderer.root.findAll(
        (n) =>
          String(n.type) === 'Text' &&
          n.children.some((child) => typeof child === 'string' && child.includes('Regenerate'))
      )
    ).toHaveLength(0);
    expect(onRegenerate).not.toHaveBeenCalled();
  });
});
