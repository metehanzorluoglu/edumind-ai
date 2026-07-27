import { Platform } from 'react-native';
import {
  blobToDataUrl,
  isReferenceMimeType,
  MAX_REFERENCE_IMAGE_BYTES,
  readPickerAssetAsDataUrl,
  resolveRemoteReference,
  validateReferenceCandidate,
} from '../referenceImages';

// The node test env has no real FileReader / fetchable blob: URIs, so the web
// byte-reading path is exercised against deterministic stubs. `Blob` is also
// stubbed so `asset.file instanceof Blob` in readPickerAssetAsDataUrl resolves.
class FakeBlob {
  constructor(
    public readonly parts: unknown[] = [],
    public readonly opts: { type?: string } = {}
  ) {}
}
class FakeFileReader {
  result: string | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readAsDataURL(): void {
    // Mimic a browser data URL whose declared mime we expect to be rewritten.
    this.result = 'data:application/octet-stream;base64,AAAA';
    queueMicrotask(() => this.onload?.());
  }
}

describe('referenceImages helpers', () => {
  const originalOS = Platform.OS;
  const g = global as unknown as {
    FileReader: unknown;
    Blob: unknown;
  };
  const originalFileReader = g.FileReader;
  const originalBlob = g.Blob;
  const originalCreateObjectURL = URL.createObjectURL;

  afterEach(() => {
    Platform.OS = originalOS;
    g.FileReader = originalFileReader;
    g.Blob = originalBlob;
    URL.createObjectURL = originalCreateObjectURL;
  });

  describe('isReferenceMimeType', () => {
    it.each(['image/png', 'image/jpeg', 'IMAGE/JPEG', 'image/webp'])('accepts %s', (m) => {
      expect(isReferenceMimeType(m)).toBe(true);
    });
    it.each(['application/pdf', 'image/gif', null, undefined])('rejects %s', (m) => {
      expect(isReferenceMimeType(m as string | null)).toBe(false);
    });
  });

  describe('validateReferenceCandidate', () => {
    it('passes an image under the size cap', () => {
      expect(validateReferenceCandidate('a.png', 1024, 'image/png')).toBeNull();
    });
    it('rejects a non-image mime', () => {
      expect(validateReferenceCandidate('a.pdf', 1024, 'application/pdf')).toMatch(
        /supported reference image type/
      );
    });
    it('rejects an oversized image', () => {
      expect(
        validateReferenceCandidate('big.png', MAX_REFERENCE_IMAGE_BYTES + 1, 'image/png')
      ).toMatch(/reference limit/);
    });
    it('rejects an empty file', () => {
      expect(validateReferenceCandidate('empty.png', 0, 'image/png')).toMatch(/empty/);
    });
    it('accepts a null size (unknown until read) when the mime is valid', () => {
      expect(validateReferenceCandidate('a.png', null, 'image/png')).toBeNull();
    });
  });

  describe('web byte reading', () => {
    beforeEach(() => {
      Platform.OS = 'web';
      g.Blob = FakeBlob;
      g.FileReader = FakeFileReader;
    });

    it('blobToDataUrl rewrites the embedded mime to the requested one', async () => {
      const dataUrl = await blobToDataUrl(
        new FakeBlob(['x'], { type: 'image/png' }) as unknown as Blob,
        'image/jpeg'
      );
      expect(dataUrl).toBe('data:image/jpeg;base64,AAAA');
    });

    it('readPickerAssetAsDataUrl reads the picker File on web', async () => {
      const dataUrl = await readPickerAssetAsDataUrl(
        {
          uri: 'blob:1',
          file: new FakeBlob(['x'], { type: 'image/png' }) as unknown as Blob,
          mimeType: 'image/png',
        },
        'image/png'
      );
      expect(dataUrl).toBe('data:image/png;base64,AAAA');
    });

    it('resolveRemoteReference fetches the persisted bytes and returns a preview + data URL', async () => {
      URL.createObjectURL = jest.fn(() => 'blob:obj');
      const blob = new FakeBlob(['x'], { type: 'image/png' }) as unknown as Blob;
      const client = {
        fetchAttachmentBlob: jest.fn().mockResolvedValue(blob),
      };

      const result = await resolveRemoteReference(
        client as never,
        { conversationId: 'c1', messageId: 'm1', attachmentId: 'a1' },
        'image/png',
        'finch.png'
      );

      expect(client.fetchAttachmentBlob).toHaveBeenCalledWith('c1', 'm1', 'a1');
      expect(result).toEqual({ previewUri: 'blob:obj', dataUrl: 'data:image/png;base64,AAAA' });
    });
  });
});
