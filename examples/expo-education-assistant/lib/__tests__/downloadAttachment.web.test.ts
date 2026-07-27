/**
 * @jest-environment jsdom
 *
 * Web-only behavior — see downloadAttachment.test.ts for why this is a
 * separate file from the native tests.
 */
import { Platform } from 'react-native';
import { downloadAttachment } from '../downloadAttachment';

jest.mock('expo-file-system', () => ({
  Paths: { cache: { __brand: 'mock-cache-dir' } },
  File: class MockExpoFile {
    uri = 'file:///mock-cache/generated-a1.png';
  },
}));

jest.mock('expo-sharing', () => ({
  isAvailableAsync: jest.fn(),
  shareAsync: jest.fn(),
}));

function fakeClient(blob: Blob) {
  return { fetchAttachmentBlob: jest.fn().mockResolvedValue(blob) };
}

const attachment = { id: 'a1', filename: 'generated-a1.png', mime: 'image/png' };

describe('downloadAttachment (web)', () => {
  const originalOS = Platform.OS;

  afterEach(() => {
    Platform.OS = originalOS;
    jest.restoreAllMocks();
  });

  it('triggers a real browser download via a temporary <a download> element, then revokes the object URL', async () => {
    Platform.OS = 'web';
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;
    URL.createObjectURL = jest.fn(() => 'blob:fake-object-url');
    URL.revokeObjectURL = jest.fn();
    const clickSpy = jest.fn();
    const appendSpy = jest.spyOn(document.body, 'appendChild');
    const removeSpy = jest.spyOn(document.body, 'removeChild');
    const originalCreateElement = document.createElement.bind(document);
    jest.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = originalCreateElement(tag);
      if (tag === 'a') el.click = clickSpy;
      return el;
    });

    const client = fakeClient(new Blob(['fake-bytes'], { type: 'image/png' }));
    try {
      await downloadAttachment(
        client as never,
        { conversationId: 'c1', messageId: 'm1' },
        attachment
      );

      expect(client.fetchAttachmentBlob).toHaveBeenCalledWith('c1', 'm1', 'a1');
      expect(clickSpy).toHaveBeenCalled();
      expect(appendSpy).toHaveBeenCalled();
      expect(removeSpy).toHaveBeenCalled();
      expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:fake-object-url');
    } finally {
      URL.createObjectURL = originalCreateObjectURL;
      URL.revokeObjectURL = originalRevokeObjectURL;
    }
  });
});
