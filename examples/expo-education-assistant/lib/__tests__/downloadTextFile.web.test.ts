/**
 * @jest-environment jsdom
 *
 * Web-only behavior — see downloadTextFile.test.ts for why this is a
 * separate file from the native tests.
 */
import { Platform } from 'react-native';
import { downloadTextFile } from '../downloadTextFile';

jest.mock('expo-file-system', () => ({
  Paths: { cache: { __brand: 'mock-cache-dir' } },
  File: class MockExpoFile {
    uri = 'file:///mock-cache/references.bib';
  },
}));

jest.mock('expo-sharing', () => ({
  isAvailableAsync: jest.fn(),
  shareAsync: jest.fn(),
}));

describe('downloadTextFile (web)', () => {
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
    let downloadAttr: string | null = null;
    jest.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = originalCreateElement(tag);
      if (tag === 'a') {
        el.click = clickSpy;
        Object.defineProperty(el, 'download', {
          set: (v: string) => {
            downloadAttr = v;
          },
          get: () => downloadAttr,
        });
      }
      return el;
    });

    try {
      await downloadTextFile('references.bib', '@article{Doe2020,}', 'application/x-bibtex');

      expect(clickSpy).toHaveBeenCalled();
      expect(appendSpy).toHaveBeenCalled();
      expect(removeSpy).toHaveBeenCalled();
      expect(downloadAttr).toBe('references.bib');
      expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:fake-object-url');
    } finally {
      URL.createObjectURL = originalCreateObjectURL;
      URL.revokeObjectURL = originalRevokeObjectURL;
    }
  });

  it('revokes the object URL even if something throws before the click', async () => {
    Platform.OS = 'web';
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;
    URL.createObjectURL = jest.fn(() => 'blob:fake-object-url');
    URL.revokeObjectURL = jest.fn();
    jest.spyOn(document.body, 'appendChild').mockImplementation(() => {
      throw new Error('boom');
    });

    try {
      await expect(downloadTextFile('references.bib', 'content')).rejects.toThrow('boom');
      expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:fake-object-url');
    } finally {
      URL.createObjectURL = originalCreateObjectURL;
      URL.revokeObjectURL = originalRevokeObjectURL;
    }
  });
});
