/**
 * Milestone 5.5.1 Part 25 (CORE REQUIREMENT) — "autosave must flush/
 * queue before navigation." The Writing screen's autosave is
 * debounced (a few seconds); `app/(tabs)/_layout.tsx` uses a single
 * `<Slot />` (not a persistent tab navigator), so navigating away —
 * e.g. clicking "Documents" in NavRail/BottomNav — unmounts the
 * Writing screen immediately. The screen's own unmount-cleanup effect
 * already calls flush(), but fires it fire-and-forget (a cleanup
 * function can't make React await a promise) — a user who types, then
 * immediately navigates away and back, could round-trip faster than
 * that in-flight PATCH lands, and see their own edit "disappear"
 * (reverted to the last-saved server copy the remount re-fetches).
 *
 * This is the fix: a screen with pending unsaved work REGISTERS a
 * flush function here on mount; `_layout.tsx`'s single navigation
 * choke point (handleNavigate) AWAITS flushBeforeNavigate() before
 * ever calling router.push — so by the time the destination route
 * mounts, the PATCH has actually completed (or been given its best
 * honest attempt). A plain module-level slot, not a React Context —
 * there is only ever one "currently mounted screen with unsaved work"
 * at a time in this single-Slot architecture, so there's nothing a
 * Context's multi-subscriber machinery would add here.
 */

type FlushFn = () => Promise<void> | void;

let registeredFlush: FlushFn | null = null;

/**
 * Call from the mount effect of any screen with debounced/queued
 * unsaved work. Returns an unregister function — call it from the
 * same effect's cleanup. If a second screen registers before the
 * first unregisters (shouldn't happen in this single-Slot app, but
 * defensive regardless), the unregister call only clears the slot if
 * it still owns it — never clobbers a newer registration.
 */
export function registerNavigationFlush(fn: FlushFn): () => void {
  registeredFlush = fn;
  return () => {
    if (registeredFlush === fn) registeredFlush = null;
  };
}

/**
 * Called once, at the app's single navigation choke point, before
 * every in-app route change. A no-op (resolves immediately) when
 * nothing is registered — the overwhelmingly common case (every
 * screen without debounced unsaved work). Best-effort: a flush
 * failure (e.g. offline) is swallowed here rather than blocking
 * navigation forever — the screen's own save-status UI (see [id].tsx's
 * "Could not save" state) is the durable signal for that, not a
 * navigation guard.
 */
export async function flushBeforeNavigate(): Promise<void> {
  const fn = registeredFlush;
  if (!fn) return;
  try {
    await fn();
  } catch {
    // Best-effort — see docstring above.
  }
}
