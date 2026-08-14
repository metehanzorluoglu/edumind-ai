import { Slot } from 'expo-router';

/**
 * Pass-through only — same reasoning as chat/_layout.tsx: the sidebar/nav
 * chrome lives one level up in (tabs)/_layout.tsx, shared across
 * Chat/Search/Documents/Settings. This file exists only because Expo
 * Router route groups read more predictably with an explicit (if trivial)
 * layout for the /documents/* subtree than by relying on the absence of
 * one — introduced by Frontend Milestone 3 when documents.tsx became
 * documents/index.tsx (the list) alongside the new documents/[id].tsx
 * (the reader).
 */
export default function DocumentsLayout() {
  return <Slot />;
}
