import { getStorageItem, setStorageItem } from './platformStorage';

const BASE_URL_KEY = 'eac_dev_base_url';

/**
 * Per-device override of the backend base URL, surfaced in Settings'
 * "Developer Options" section. On native this is backed by
 * expo-secure-store; on web it falls back to window.localStorage (see
 * platformStorage.ts). Not a credential — real authentication is JWT-based
 * (see AuthProvider), unrelated to anything stored here.
 */
export async function getStoredBaseUrl(): Promise<string | null> {
  return getStorageItem(BASE_URL_KEY);
}

export async function setStoredBaseUrl(url: string | null): Promise<void> {
  await setStorageItem(BASE_URL_KEY, url);
}
