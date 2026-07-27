import { Platform } from 'react-native';

import {
  SAMPLE_DOCUMENT_FILENAME,
  SAMPLE_DOCUMENT_TEXT,
  buildSampleUploadFile,
} from '../sampleDocument';

const mockFileCreate = jest.fn();
const mockFileWrite = jest.fn();
let lastExpoFileArgs: unknown[] = [];

jest.mock('expo-file-system', () => ({
  Paths: { cache: { __brand: 'mock-cache-dir' } },
  File: class MockExpoFile {
    uri = 'file:///mock-cache/sample.md';
    constructor(...args: unknown[]) {
      lastExpoFileArgs = args;
    }
    create = mockFileCreate;
    write = mockFileWrite;
  },
}));

describe('buildSampleUploadFile', () => {
  const originalOS = Platform.OS;

  beforeEach(() => {
    mockFileCreate.mockClear();
    mockFileWrite.mockClear();
    lastExpoFileArgs = [];
  });

  afterEach(() => {
    Platform.OS = originalOS;
  });

  it('on web, builds a standards-based browser File (not an Expo FileSystem object)', async () => {
    Platform.OS = 'web';

    const result = buildSampleUploadFile();

    expect(result).toBeInstanceOf(globalThis.File);
    const file = result as File;
    expect(file.name).toBe(SAMPLE_DOCUMENT_FILENAME);
    expect(file.type).toBe('text/markdown');
    // Not an Expo FileSystem { uri, name, type } object — a real File has no `uri`.
    expect('uri' in file).toBe(false);
    await expect(file.text()).resolves.toBe(SAMPLE_DOCUMENT_TEXT);
  });

  it('on web, never touches Expo FileSystem (Paths.cache / File.create / File.write)', () => {
    Platform.OS = 'web';

    expect(() => buildSampleUploadFile()).not.toThrow();

    // Direct proof, not just "didn't throw": expo-file-system's File.create
    // and File.write (the exact calls that throw "this.validatePath is not
    // a function" on the real web build) were never invoked at all.
    expect(mockFileCreate).not.toHaveBeenCalled();
    expect(mockFileWrite).not.toHaveBeenCalled();
  });

  it('on native (iOS/Android), preserves the URI-based multipart upload shape via expo-file-system', () => {
    Platform.OS = 'ios';

    const result = buildSampleUploadFile();

    expect(result).not.toBeInstanceOf(globalThis.File);
    expect(result).toEqual({
      uri: 'file:///mock-cache/sample.md',
      name: SAMPLE_DOCUMENT_FILENAME,
      type: 'text/markdown',
    });
    // Writes to Paths.cache (the app's cache directory), not an arbitrary path.
    expect(lastExpoFileArgs[0]).toEqual({ __brand: 'mock-cache-dir' });
    expect(lastExpoFileArgs[1]).toBe(SAMPLE_DOCUMENT_FILENAME);
    expect(mockFileCreate).toHaveBeenCalledWith({ overwrite: true });
    expect(mockFileWrite).toHaveBeenCalledWith(SAMPLE_DOCUMENT_TEXT);
  });

  it('on android, also uses the Expo FileSystem path (not just ios)', () => {
    Platform.OS = 'android';

    buildSampleUploadFile();

    expect(mockFileCreate).toHaveBeenCalled();
    expect(mockFileWrite).toHaveBeenCalledWith(SAMPLE_DOCUMENT_TEXT);
  });
});
