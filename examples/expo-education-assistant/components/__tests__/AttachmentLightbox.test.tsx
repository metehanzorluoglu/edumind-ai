/**
 * Regression tests for the "clicking a generated image opens the dark
 * overlay, but the image is not visible" bug.
 *
 * Root cause: the lightbox's double-tap-to-zoom wrapper (Animated.View)
 * had no size of its own, and the Image inside it sizes with
 * width/height '100%' — which resolves against that wrapper. An unsized
 * parent collapses percentages to 0×0 on both web and native, so the
 * fetched image rendered invisibly; and AuthenticatedAttachmentImage
 * renders nothing while loading/on error, so there was no feedback at
 * all. These tests pin the wrapper's page-filling size (centered contain
 * image, viewport-limited), the loading state, the explicit error + tap
 * to retry, and the close button.
 */
import { ActivityIndicator, Dimensions, FlatList, Image, Platform, StyleSheet } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { AttachmentLightbox } from '../AttachmentLightbox';
import type { AttachmentChipInfo } from '@/lib/chatAttachments';

const mockFetchAttachmentBlob = jest.fn();
const mockGetAttachmentImageSource = jest.fn();
// Referentially stable client — the real ClientProvider memoizes its
// client, and AuthenticatedAttachmentImage's fetch effect depends on it
// (a fresh object per render would re-trigger the effect every render).
const mockClient = {
  fetchAttachmentBlob: mockFetchAttachmentBlob,
  getAttachmentImageSource: mockGetAttachmentImageSource,
};
jest.mock('@/lib/ClientProvider', () => ({
  useClient: () => ({ client: mockClient }),
}));

function remoteChip(overrides: Partial<AttachmentChipInfo> = {}): AttachmentChipInfo {
  return {
    key: 'a1',
    filename: 'generated-a1.png',
    mimeType: 'image/png',
    sizeBytes: 4096,
    pageCount: null,
    pageRangeStart: null,
    pageRangeEnd: null,
    remote: { conversationId: 'c1', messageId: 'm1' },
    ...overrides,
  };
}

function findByText(root: ReactTestInstance, text: string): ReactTestInstance {
  return root.find((node) => String(node.type) === 'Text' && node.children.includes(text));
}

function queryByText(root: ReactTestInstance, text: string): ReactTestInstance | null {
  const matches = root.findAll(
    (node) => String(node.type) === 'Text' && node.children.includes(text)
  );
  return matches[0] ?? null;
}

async function renderLightbox(
  attachments: AttachmentChipInfo[] = [remoteChip()],
  onClose: () => void = jest.fn()
): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <AttachmentLightbox visible attachments={attachments} initialIndex={0} onClose={onClose} />
    );
    await Promise.resolve();
    await Promise.resolve();
  });
  return renderer;
}

describe('AttachmentLightbox (generated image preview)', () => {
  const originalOS = Platform.OS;
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;

  beforeEach(() => {
    Platform.OS = 'web'; // web path: authenticated fetch → object URL
    URL.createObjectURL = jest.fn(() => 'blob:fake-object-url');
    URL.revokeObjectURL = jest.fn();
  });

  afterEach(() => {
    Platform.OS = originalOS;
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
    jest.clearAllMocks();
  });

  it('fills the page with the zoom wrapper so the 100%-sized image is actually visible (regression: unsized wrapper collapsed it to 0×0)', async () => {
    mockFetchAttachmentBlob.mockResolvedValue({ type: 'image/png' } as Blob);
    const renderer = await renderLightbox();

    // The zoom wrapper (child of the double-tap Pressable) now covers the
    // whole page area — position absolute with all four insets 0 — so the
    // Image's width/height '100%' resolves to the page size, not 0×0.
    const imageWrap = renderer.root.find(
      (node) => node.props.accessibilityHint === 'Double-tap to zoom'
    );
    const zoomWrapper = imageWrap.find(
      (node) =>
        Array.isArray(node.props.style) &&
        node.props.style.some(
          (s: Record<string, unknown> | null | undefined) =>
            !!s &&
            s.position === 'absolute' &&
            s.top === 0 &&
            s.bottom === 0 &&
            s.left === 0 &&
            s.right === 0
        )
    );
    expect(zoomWrapper).toBeTruthy();

    // The image fills that wrapper, centered via contain — preserves aspect
    // ratio and stays within the viewport.
    const image = renderer.root.findByType(Image);
    expect(image.props.resizeMode).toBe('contain');
    expect(StyleSheet.flatten(image.props.style)).toMatchObject({
      width: '100%',
      height: '100%',
    });

    // And the paging FlatList itself carries flex:1 — without a bounded
    // height it collapses to 0px under the top bar, and the whole page
    // chain (page → zoom wrapper → image) collapses with it. That was the
    // other half of the invisible-image bug.
    const pager = renderer.root.findByType(FlatList);
    expect(StyleSheet.flatten(pager.props.style)).toMatchObject({ flex: 1 });

    // The page wrapper carries an explicit height (set from the list's
    // onLayout) — on web the list's auto-height cell chain otherwise
    // collapses the page to 0px (native stretches instead). Before the
    // first layout the window height is the initial value.
    const { width: winW, height: winH } = Dimensions.get('window');
    const pageWrapper = renderer.root.find(
      (node) =>
        String(node.type) === 'View' &&
        !!node.props.style &&
        !Array.isArray(node.props.style) &&
        (node.props.style as { width?: unknown; height?: unknown }).width === winW &&
        (node.props.style as { width?: unknown; height?: unknown }).height === winH
    );
    expect(pageWrapper).toBeTruthy();
  });

  it('shows a loading state while fetching, then the loaded image', async () => {
    let resolveFetch!: (blob: Blob) => void;
    mockFetchAttachmentBlob.mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve;
      })
    );

    const renderer = await renderLightbox();

    // Loading: spinner up, no image yet, no premature error.
    expect(renderer.root.findAllByType(ActivityIndicator).length).toBeGreaterThan(0);
    expect(renderer.root.findAllByType(Image)).toHaveLength(0);
    expect(queryByText(renderer.root, "Couldn't load this image.")).toBeNull();

    await act(async () => {
      resolveFetch({ type: 'image/png' } as Blob);
      await Promise.resolve();
      await Promise.resolve();
    });

    // Loaded: the authenticated object URL is on screen, spinner gone.
    expect(renderer.root.findAllByType(ActivityIndicator)).toHaveLength(0);
    expect(renderer.root.findByType(Image).props.source).toEqual({ uri: 'blob:fake-object-url' });
  });

  it('shows a clear error when the image cannot load, and retries on tap', async () => {
    mockFetchAttachmentBlob
      .mockRejectedValueOnce(new Error('Not found'))
      .mockResolvedValueOnce({ type: 'image/png' } as Blob);

    const renderer = await renderLightbox();

    expect(findByText(renderer.root, "Couldn't load this image.")).toBeTruthy();
    expect(findByText(renderer.root, 'Tap to retry.')).toBeTruthy();
    expect(renderer.root.findAllByType(Image)).toHaveLength(0);

    await act(async () => {
      renderer.root
        .find((node) => node.props.accessibilityLabel === 'Retry loading image')
        .props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockFetchAttachmentBlob).toHaveBeenCalledTimes(2);
    expect(renderer.root.findByType(Image).props.source).toEqual({ uri: 'blob:fake-object-url' });
    expect(queryByText(renderer.root, "Couldn't load this image.")).toBeNull();
  });

  it('keeps the close button present and wired to onClose', async () => {
    mockFetchAttachmentBlob.mockResolvedValue({ type: 'image/png' } as Blob);
    const onClose = jest.fn();
    const renderer = await renderLightbox([remoteChip()], onClose);

    // Present alongside a loaded image (i.e. not painted under it).
    expect(renderer.root.findByType(Image)).toBeTruthy();
    const closeButton = renderer.root.find(
      (node) => node.props.accessibilityLabel === 'Close preview'
    );
    act(() => {
      closeButton.props.onPress();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders a generated-image batch with per-attachment pages (swipe target exists for each)', async () => {
    mockFetchAttachmentBlob.mockResolvedValue({ type: 'image/png' } as Blob);
    const renderer = await renderLightbox([
      remoteChip({ key: 'a1', filename: 'generated-a1.png' }),
      remoteChip({ key: 'a2', filename: 'generated-a2.png' }),
    ]);

    // Counter reflects the batch; the first page's filename is in the top bar.
    expect(findByText(renderer.root, 'generated-a1.png')).toBeTruthy();
  });
});
