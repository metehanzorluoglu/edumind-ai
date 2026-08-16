import { Slot } from 'expo-router';

/**
 * Pass-through only — same reasoning as notes/_layout.tsx and
 * documents/_layout.tsx: the sidebar/nav chrome lives one level up in
 * (tabs)/_layout.tsx, shared across Chat/Documents/Notes/Writing/
 * Settings. Milestone 5 (Academic Writing & LaTeX Foundation).
 */
export default function WritingLayout() {
  return <Slot />;
}
