import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

const REFRESH_TOKEN_KEY = 'eac_refresh_token';

/**
 * Native-only persistent storage for the real OAuth refresh token (see
 * lib/AuthProvider.tsx). Deliberately does NOT fall back to
 * window.localStorage on web the way lib/platformStorage.ts does for the
 * dev-only token — a real refresh token must never touch web JS-accessible
 * storage; web relies entirely on the backend's HttpOnly refresh cookie
 * instead (see EducationAssistantClient's session methods, which send
 * `credentials: 'include'`). Every function here is a no-op on web.
 */
export async function getStoredRefreshToken(): Promise<string | null> {
  if (Platform.OS === 'web') return null;
  return SecureStore.getItemAsync(REFRESH_TOKEN_KEY);
}

export async function setStoredRefreshToken(token: string | null): Promise<void> {
  if (Platform.OS === 'web') return;
  if (token) {
    await SecureStore.setItemAsync(REFRESH_TOKEN_KEY, token);
  } else {
    await SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY);
  }
}
