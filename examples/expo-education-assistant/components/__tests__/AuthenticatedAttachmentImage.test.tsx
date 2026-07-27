import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Image, Platform } from 'react-native';
import { AuthenticatedAttachmentImage } from '../AuthenticatedAttachmentImage';

const mockFetchAttachmentBlob = jest.fn();
const mockGetAttachmentImageSource = jest.fn();

jest.mock('@/lib/ClientProvider', () => ({
  useClient: () => ({
    client: {
      fetchAttachmentBlob: mockFetchAttachmentBlob,
      getAttachmentImageSource: mockGetAttachmentImageSource,
    },
  }),
}));

async function renderImage(page?: number): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <AuthenticatedAttachmentImage
        conversationId="c1"
        messageId="m1"
        attachmentId="a1"
        page={page}
      />
    );
    await Promise.resolve();
    await Promise.resolve();
  });
  return renderer;
}

describe('AuthenticatedAttachmentImage (milestone V3)', () => {
  const originalOS = Platform.OS;

  afterEach(() => {
    Platform.OS = originalOS;
    jest.clearAllMocks();
  });

  // --- native (mobile) ---

  it('on native, resolves the Image source via getAttachmentImageSource, never fetching a Blob', async () => {
    Platform.OS = 'ios';
    mockGetAttachmentImageSource.mockResolvedValue({
      uri: 'http://localhost:8000/conversations/c1/messages/m1/attachments/a1',
      headers: { Authorization: 'Bearer test-token' },
    });

    const renderer = await renderImage();

    expect(mockGetAttachmentImageSource).toHaveBeenCalledWith('c1', 'm1', 'a1', undefined);
    expect(mockFetchAttachmentBlob).not.toHaveBeenCalled();
    const image = renderer.root.findByType(Image);
    expect(image.props.source).toEqual({
      uri: 'http://localhost:8000/conversations/c1/messages/m1/attachments/a1',
      headers: { Authorization: 'Bearer test-token' },
    });
  });

  it('on native, renders nothing while the image source is still resolving', async () => {
    Platform.OS = 'ios';
    mockGetAttachmentImageSource.mockReturnValue(new Promise(() => {})); // never resolves

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <AuthenticatedAttachmentImage conversationId="c1" messageId="m1" attachmentId="a1" />
      );
    });

    expect(renderer.root.findAllByType(Image)).toHaveLength(0);
  });

  it('on native, renders nothing (not a crash) if getAttachmentImageSource rejects', async () => {
    Platform.OS = 'ios';
    mockGetAttachmentImageSource.mockRejectedValue(new Error('network error'));

    const renderer = await renderImage();

    expect(renderer.root.findAllByType(Image)).toHaveLength(0);
  });

  it('on native, forwards a page number to getAttachmentImageSource (milestone V4 PDF preview)', async () => {
    Platform.OS = 'ios';
    mockGetAttachmentImageSource.mockResolvedValue({
      uri: 'http://localhost:8000/conversations/c1/messages/m1/attachments/a1/preview?page=3',
      headers: { Authorization: 'Bearer test-token' },
    });

    await renderImage(3);

    expect(mockGetAttachmentImageSource).toHaveBeenCalledWith('c1', 'm1', 'a1', 3);
  });

  // --- web ---

  describe('on web', () => {
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;

    beforeEach(() => {
      Platform.OS = 'web';
      URL.createObjectURL = jest.fn(() => 'blob:fake-object-url');
      URL.revokeObjectURL = jest.fn();
    });

    afterEach(() => {
      URL.createObjectURL = originalCreateObjectURL;
      URL.revokeObjectURL = originalRevokeObjectURL;
    });

    it('fetches the attachment as a Blob and renders an object URL, never using getAttachmentImageSource', async () => {
      const fakeBlob = { type: 'image/png' } as Blob;
      mockFetchAttachmentBlob.mockResolvedValue(fakeBlob);

      const renderer = await renderImage();

      expect(mockFetchAttachmentBlob).toHaveBeenCalledWith('c1', 'm1', 'a1', { page: undefined });
      expect(mockGetAttachmentImageSource).not.toHaveBeenCalled();
      expect(URL.createObjectURL).toHaveBeenCalledWith(fakeBlob);
      const image = renderer.root.findByType(Image);
      expect(image.props.source).toEqual({ uri: 'blob:fake-object-url' });
    });

    it('revokes the object URL on unmount', async () => {
      mockFetchAttachmentBlob.mockResolvedValue({ type: 'image/png' } as Blob);
      const renderer = await renderImage();

      await act(async () => {
        renderer.unmount();
      });

      expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:fake-object-url');
    });

    it('renders nothing if fetchAttachmentBlob rejects (e.g. a 404)', async () => {
      mockFetchAttachmentBlob.mockRejectedValue(new Error('not found'));

      const renderer = await renderImage();

      expect(renderer.root.findAllByType(Image)).toHaveLength(0);
    });

    it('forwards a page number to fetchAttachmentBlob (milestone V4 PDF preview)', async () => {
      mockFetchAttachmentBlob.mockResolvedValue({ type: 'image/png' } as Blob);

      await renderImage(2);

      expect(mockFetchAttachmentBlob).toHaveBeenCalledWith('c1', 'm1', 'a1', { page: 2 });
    });
  });
});
