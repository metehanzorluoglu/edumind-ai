import { Platform } from 'react-native';
import { getLastSectionLocation, recordSectionLocation } from '../sectionLastLocation';

// This jest environment's default `window` (unlike a real browser) has no
// sessionStorage of its own — matching lib/__tests__/platformStorage.test.ts's
// own established convention, a minimal in-memory stub is installed directly.
function installSessionStorage() {
  const backing = new Map<string, string>();
  const sessionStorage = {
    getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => {
      backing.set(key, value);
    },
    clear: () => backing.clear(),
  };
  // @ts-expect-error minimal stub sufficient for this module
  window.sessionStorage = sessionStorage;
  return sessionStorage;
}

describe('sectionLastLocation', () => {
  const originalOS = Platform.OS;
  beforeAll(() => {
    Platform.OS = 'web';
  });
  afterAll(() => {
    Platform.OS = originalOS;
  });
  beforeEach(() => {
    installSessionStorage();
  });
  afterEach(() => {
    // @ts-expect-error test cleanup
    delete window.sessionStorage;
  });

  it('returns null for a section never visited this session', () => {
    expect(getLastSectionLocation('writing')).toBeNull();
  });

  it('round-trips the last recorded pathname for a section', () => {
    recordSectionLocation('writing', '/writing/project-a');
    expect(getLastSectionLocation('writing')).toBe('/writing/project-a');
  });

  it('keeps sections independent', () => {
    recordSectionLocation('writing', '/writing/project-a');
    recordSectionLocation('documents', '/documents/doc-1');
    recordSectionLocation('notes', '/notes/notebook-1');
    expect(getLastSectionLocation('writing')).toBe('/writing/project-a');
    expect(getLastSectionLocation('documents')).toBe('/documents/doc-1');
    expect(getLastSectionLocation('notes')).toBe('/notes/notebook-1');
  });

  it('overwrites the previous location as the user navigates within a section', () => {
    recordSectionLocation('writing', '/writing/project-a');
    recordSectionLocation('writing', '/writing/project-b');
    expect(getLastSectionLocation('writing')).toBe('/writing/project-b');
  });

  it('persists via window.sessionStorage directly (survives this module being re-imported)', () => {
    recordSectionLocation('documents', '/documents/doc-9');
    expect(window.sessionStorage.getItem('edum8:lastLocation:documents')).toBe('/documents/doc-9');
  });
});
