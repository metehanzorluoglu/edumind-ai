/**
 * Milestone 5.5.1 Part 25 (CORE REQUIREMENT) — cross-navigation
 * continuity ("Writing/Reader/Research Notes must preserve project/
 * file/cursor/scroll/panel/scope state across navigation away and
 * back") for state that is deliberately NOT written to Preferences
 * (lib/Preferences.tsx's own persisted blob): cursor offsets, scroll
 * positions, and similar per-session UI position — exactly the kind
 * of state Milestone 5.5 Part 9 explicitly excluded from cross-DEVICE,
 * cross-SESSION persistence ("Explicitly not persisted: manuscript
 * selection, draft answer text..."). That exclusion is still correct
 * for a fresh login or a new day's session; it was never meant to mean
 * "reset the instant the user clicks to a different tab and back,
 * within the SAME browser session" — which is what Part 25 is about.
 *
 * A plain module-level Map is the right size for this: it lives only
 * as long as the JS module does, which is exactly "this page load" —
 * surviving any number of Slot-driven mount/unmount cycles as the user
 * navigates around the app, but naturally, correctly gone on a hard
 * reload (Part 25's own "hard reload must restore via deep routes" —
 * meaning via the URL + a fresh server fetch, not via this cache,
 * which a reload wipes right along with the rest of the JS heap).
 * Never persisted to platformStorage — this is intentionally NOT the
 * same durability tier as Preferences.
 */

const cache = new Map<string, unknown>();

/** Reads a previously cached value for `key`, or undefined if none
 * exists yet this session. Callers own their own key-shape contract
 * (e.g. `writing-cursor:${projectId}`) — this module doesn't validate
 * shapes, matching platformStorage.ts's own "caller-typed" convention. */
export function getSessionNavState<T>(key: string): T | undefined {
  return cache.get(key) as T | undefined;
}

export function setSessionNavState<T>(key: string, value: T): void {
  cache.set(key, value);
}

/** Test-only: the cache is a module-level singleton, so tests that
 * exercise it (directly or via a screen that reads/writes it) need a
 * way to start from a clean slate between cases — production code
 * never calls this. */
export function __resetSessionNavCacheForTests(): void {
  cache.clear();
}
