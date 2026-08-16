import { Platform } from 'react-native';
import { downloadTextFile, safeBibtexFilename } from '../downloadTextFile';

const mockFileCreate = jest.fn();
const mockFileWrite = jest.fn();

jest.mock('expo-file-system', () => ({
  Paths: { cache: { __brand: 'mock-cache-dir' } },
  File: class MockExpoFile {
    uri = 'file:///mock-cache/references.bib';
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

/**
 * Native (iOS/Android) behavior only — same node-vs-jsdom split as
 * downloadAttachment.test.ts/.web.test.ts (a Blob-based web download needs
 * jsdom's `document`; native's expo-file-system path doesn't).
 */
describe('downloadTextFile (native)', () => {
  const originalOS = Platform.OS;

  afterEach(() => {
    Platform.OS = originalOS;
    mockFileCreate.mockClear();
    mockFileWrite.mockClear();
    mockIsAvailableAsync.mockClear();
    mockShareAsync.mockClear();
  });

  it('writes the content to a cache file and hands it to the OS share sheet', async () => {
    Platform.OS = 'ios';
    mockIsAvailableAsync.mockResolvedValue(true);

    await downloadTextFile('references.bib', '@article{Doe2020,}', 'application/x-bibtex');

    expect(mockFileCreate).toHaveBeenCalledWith({ overwrite: true });
    expect(mockFileWrite).toHaveBeenCalledWith('@article{Doe2020,}');
    expect(mockShareAsync).toHaveBeenCalledWith('file:///mock-cache/references.bib', {
      mimeType: 'application/x-bibtex',
    });
  });

  it('throws a clear error when sharing is unavailable on this device', async () => {
    Platform.OS = 'ios';
    mockIsAvailableAsync.mockResolvedValue(false);

    await expect(downloadTextFile('references.bib', 'content')).rejects.toThrow(
      /not available on this device/
    );
    expect(mockShareAsync).not.toHaveBeenCalled();
  });
});

describe('safeBibtexFilename', () => {
  it('hyphenates letter/digit boundaries and lowercases', () => {
    expect(safeBibtexFilename('Forrester2004Laser')).toBe('forrester-2004-laser.bib');
  });

  it('falls back to a safe default for an empty key', () => {
    expect(safeBibtexFilename('')).toBe('reference.bib');
  });

  it('strips characters outside [a-z0-9-]', () => {
    expect(safeBibtexFilename('Doe/2020:Study')).toBe('doe-2020-study.bib');
  });
});
