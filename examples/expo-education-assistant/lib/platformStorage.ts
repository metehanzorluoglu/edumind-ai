import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

/**
 * Platform-aware key/value string storage.
 *
 * expo-secure-store has no web implementation — its web platform file is an
 * empty stub, so calling any of its methods on web throws
 * ("getValueWithKeyAsync is not a function"), not just "unavailable". Web
 * therefore falls back to window.localStorage instead: unencrypted, but this
 * only ever backs the dev-only Settings screen (see authStore.ts). Native
 * platforms keep using expo-secure-store unchanged.
 */

function webLocalStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null {
  // Guards module-init-time and SSR/static-rendering evaluation, where
  // `window` doesn't exist yet even though Platform.OS === 'web'.
  if (typeof window === 'undefined') return null;
  return window.localStorage;
}

export async function getStorageItem(key: string): Promise<string | null> {
  if (Platform.OS === 'web') {
    return webLocalStorage()?.getItem(key) ?? null;
  }
  return SecureStore.getItemAsync(key);
}

export async function setStorageItem(key: string, value: string | null): Promise<void> {
  if (Platform.OS === 'web') {
    const storage = webLocalStorage();
    if (!storage) return;
    if (value === null) {
      storage.removeItem(key);
    } else {
      storage.setItem(key, value);
    }
    return;
  }
  if (value === null) {
    await SecureStore.deleteItemAsync(key);
  } else {
    await SecureStore.setItemAsync(key, value);
  }
}
