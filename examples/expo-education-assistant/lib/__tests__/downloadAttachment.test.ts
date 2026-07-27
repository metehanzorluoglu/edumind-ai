import { Platform } from 'react-native';
import { downloadAttachment } from '../downloadAttachment';

const mockFileCreate = jest.fn();
const mockFileWrite = jest.fn();

jest.mock('expo-file-system', () => ({
  Paths: { cache: { __brand: 'mock-cache-dir' } },
  File: class MockExpoFile {
    uri = 'file:///mock-cache/generated-a1.png';
    create = mockFileCreate;
    write = mockFileWrite;
  },
}));

const mockIsAvailableAsync = jest.fn();
const mockShareAsync = jest.fn();
jest.mock('expo-sharing', () => ({
  isAvailableAsync: () => mockIsAvailableAsync(),
  shareAsync: (...args: unknown[]) => mockShareAsync(...args),
}));

function fakeClient(blob: Blob) {
  return { fetchAttachmentBlob: jest.fn().mockResolvedValue(blob) };
}

const attachment = { id: 'a1', filename: 'generated-a1.png', mime: 'image/png' };

/**
 * Native (iOS/Android) behavior only — run under the default `node` test
 * environment (jest-expo's RN preset), which is where Node's built-in
 * `Blob.arrayBuffer()` is actually available; see downloadAttachment.web.test.ts
 * for the web branch, split into its own file specifically because it needs
 * the `jsdom` environment's `document`, under which jsdom's own `Blob` shim
 * does not implement `arrayBuffer()` — the two environments can't be mixed
 * within one test file.
 */
describe('downloadAttachment (native)', () => {
  const originalOS = Platform.OS;

  afterEach(() => {
    Platform.OS = originalOS;
    mockFileCreate.mockClear();
    mockFileWrite.mockClear();
    mockIsAvailableAsync.mockClear();
    mockShareAsync.mockClear();
  });

  it('writes the fetched bytes to a cache file and hands it to the OS share sheet', async () => {
    Platform.OS = 'ios';
    mockIsAvailableAsync.mockResolvedValue(true);
    const client = fakeClient(new Blob(['fake-bytes'], { type: 'image/png' }));

    await downloadAttachment(
      client as never,
      { conversationId: 'c1', messageId: 'm1' },
      attachment
    );

    expect(client.fetchAttachmentBlob).toHaveBeenCalledWith('c1', 'm1', 'a1');
    expect(mockFileCreate).toHaveBeenCalledWith({ overwrite: true });
    expect(mockFileWrite).toHaveBeenCalled();
    expect(mockShareAsync).toHaveBeenCalledWith('file:///mock-cache/generated-a1.png', {
      mimeType: 'image/png',
    });
  });

  it('throws a clear error when sharing is unavailable on this device', async () => {
    Platform.OS = 'ios';
    mockIsAvailableAsync.mockResolvedValue(false);
    const client = fakeClient(new Blob(['fake-bytes'], { type: 'image/png' }));

    await expect(
      downloadAttachment(client as never, { conversationId: 'c1', messageId: 'm1' }, attachment)
    ).rejects.toThrow(/not available on this device/);
    expect(mockShareAsync).not.toHaveBeenCalled();
  });
});
