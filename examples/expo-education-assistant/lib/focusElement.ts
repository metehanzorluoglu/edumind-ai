import type { RefObject } from 'react';
import type { View } from 'react-native';

/**
 * Restores keyboard/screen-reader focus to a trigger element (in practice,
 * always a three-dot menu button — see ConversationRow.tsx/
 * AddToProjectPicker.tsx) after closing a dialog it opened. Meaningful on
 * web only: React Native has no equivalent DOM focus model on iOS/Android,
 * so this is a silent no-op there.
 *
 * RN's own types declare no `.focus()` on a View/Pressable ref (there's no
 * cross-platform concept of it) even though react-native-web forwards the
 * ref straight to the underlying focusable DOM node — this is the one,
 * isolated cast for that gap, mirroring measureWindowRect.ts's own "thin
 * wrapper as a mockable seam" pattern (test-renderer's host-node stub has
 * no real focus() either, so tests substitute this module).
 */
export function focusRef(ref: RefObject<View | null>): void {
  const node = ref.current as unknown as { focus?: () => void } | null;
  node?.focus?.();
}
