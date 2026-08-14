import { Slot } from 'expo-router';

/**
 * Pass-through only — same reasoning as documents/_layout.tsx: the
 * sidebar/nav chrome lives one level up in (tabs)/_layout.tsx, shared
 * across Chat/Search/Documents/Notes/Settings. Frontend Milestone 3.1
 * (Research Notes Workspace).
 */
export default function NotesLayout() {
  return <Slot />;
}
