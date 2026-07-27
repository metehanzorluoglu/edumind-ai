import { Platform } from 'react-native';

import * as SecureStore from 'expo-secure-store';
import { getStorageItem, setStorageItem } from '../platformStorage';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

const mockedSecureStore = SecureStore as jest.Mocked<typeof SecureStore>;

describe('platformStorage on native (iOS/Android)', () => {
  const originalOS = Platform.OS;

  beforeEach(() => {
    jest.clearAllMocks();
    Platform.OS = 'ios';
  });

  afterAll(() => {
    Platform.OS = originalOS;
  });

  it('get delegates to SecureStore.getItemAsync', async () => {
    mockedSecureStore.getItemAsync.mockResolvedValue('stored-value');

    await expect(getStorageItem('some-key')).resolves.toBe('stored-value');
    expect(mockedSecureStore.getItemAsync).toHaveBeenCalledWith('some-key');
  });

  it('missing value resolves to null', async () => {
    mockedSecureStore.getItemAsync.mockResolvedValue(null);

    await expect(getStorageItem('missing-key')).resolves.toBeNull();
  });

  it('set with a value delegates to SecureStore.setItemAsync', async () => {
    await setStorageItem('some-key', 'a-value');

    expect(mockedSecureStore.setItemAsync).toHaveBeenCalledWith('some-key', 'a-value');
    expect(mockedSecureStore.deleteItemAsync).not.toHaveBeenCalled();
  });

  it('set with null deletes via SecureStore.deleteItemAsync', async () => {
    await setStorageItem('some-key', null);

    expect(mockedSecureStore.deleteItemAsync).toHaveBeenCalledWith('some-key');
    expect(mockedSecureStore.setItemAsync).not.toHaveBeenCalled();
  });
});

describe('platformStorage on web', () => {
  const originalOS = Platform.OS;

  function installWindow() {
    const backing = new Map<string, string>();
    const localStorage = {
      getItem: jest.fn((key: string) => backing.get(key) ?? null),
      setItem: jest.fn((key: string, value: string) => {
        backing.set(key, value);
      }),
      removeItem: jest.fn((key: string) => {
        backing.delete(key);
      }),
    };
    // @ts-expect-error minimal window stub sufficient for this module
    global.window = { localStorage };
    return localStorage;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    Platform.OS = 'web';
  });

  afterEach(() => {
    // @ts-expect-error test cleanup — restores the "no window" default
    delete global.window;
  });

  afterAll(() => {
    Platform.OS = originalOS;
  });

  it('set then get round-trips through window.localStorage', async () => {
    const localStorage = installWindow();

    await setStorageItem('base-url', 'http://localhost:8000');

    expect(localStorage.setItem).toHaveBeenCalledWith('base-url', 'http://localhost:8000');
    await expect(getStorageItem('base-url')).resolves.toBe('http://localhost:8000');
  });

  it('set with null removes the key via window.localStorage.removeItem', async () => {
    const localStorage = installWindow();
    await setStorageItem('base-url', 'http://localhost:8000');

    await setStorageItem('base-url', null);

    expect(localStorage.removeItem).toHaveBeenCalledWith('base-url');
    await expect(getStorageItem('base-url')).resolves.toBeNull();
  });

  it('missing key resolves to null', async () => {
    installWindow();

    await expect(getStorageItem('never-set')).resolves.toBeNull();
  });

  it('never touches expo-secure-store on web', async () => {
    installWindow();

    await setStorageItem('base-url', 'http://localhost:8000');
    await getStorageItem('base-url');
    await setStorageItem('base-url', null);

    expect(mockedSecureStore.getItemAsync).not.toHaveBeenCalled();
    expect(mockedSecureStore.setItemAsync).not.toHaveBeenCalled();
    expect(mockedSecureStore.deleteItemAsync).not.toHaveBeenCalled();
  });

  it('does not crash when window is unavailable (SSR/module init)', async () => {
    // Deliberately no installWindow() call here — `window` stays undefined.
    await expect(getStorageItem('any-key')).resolves.toBeNull();
    await expect(setStorageItem('any-key', 'a-value')).resolves.toBeUndefined();
  });
});
