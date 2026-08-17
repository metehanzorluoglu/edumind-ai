import { Platform } from 'react-native';

/**
 * Milestone 5.5.2 Part 26 — "last location per top-level section."
 * Manual testing found M5.5.1's continuity work (sessionNavCache,
 * navigationFlushGuard) insufficient: those fix STATE loss WITHIN an
 * already-open project/document/notebook, but do nothing about the
 * NAV ICON itself, which has always deliberately routed to a
 * section's bare dashboard (`/writing`, `/documents`, `/notes`) —
 * confirmed intentional in M5.5.1's own audit. A user who leaves
 * `/writing/PROJECT_A` for Documents and clicks "Writing" again lands
 * on the dashboard, not back on PROJECT_A — no state was actually
 * lost, but the nav icon's OWN destination was wrong for how people
 * actually use it. This module fixes that: it remembers the last
 * pathname visited within each of these three sections and is
 * consulted by the nav icon's own handler (app/(tabs)/_layout.tsx).
 *
 * sessionStorage (not localStorage/Preferences — Part 28 explicitly
 * rules those out for this) is the right durability tier: same-tab
 * continuity, but a fresh session naturally starts clean and falls
 * back to each section's own deep-route defaults. Native has no
 * sessionStorage; the in-memory fallback below plays the identical
 * role for the lifetime of the app process (there's no persistent
 * "session" concept to leak across on native either).
 */

export type LastLocationSection = 'writing' | 'documents' | 'notes';

const memoryFallback = new Map<string, string>();

function storageKey(section: LastLocationSection): string {
  return `edum8:lastLocation:${section}`;
}

function webSessionStorage(): Storage | null {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return null;
  try {
    return window.sessionStorage;
  } catch {
    // Some environments (private browsing in a few older engines) throw
    // on access rather than merely being unavailable.
    return null;
  }
}

/** Records the current pathname as the last-visited location for a
 * section. Call on every pathname change while inside that section. */
export function recordSectionLocation(section: LastLocationSection, pathname: string): void {
  const storage = webSessionStorage();
  if (storage) {
    storage.setItem(storageKey(section), pathname);
  } else {
    memoryFallback.set(storageKey(section), pathname);
  }
}

/** The last-remembered pathname for a section this session, or null if
 * the section hasn't been visited yet (first visit this session, or a
 * fresh session — deep-route/dashboard defaults apply instead). */
export function getLastSectionLocation(section: LastLocationSection): string | null {
  const storage = webSessionStorage();
  if (storage) return storage.getItem(storageKey(section));
  return memoryFallback.get(storageKey(section)) ?? null;
}
