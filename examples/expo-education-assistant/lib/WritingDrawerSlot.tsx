import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * Writing drawer/layout architecture correction — root cause: the shared
 * app shell (app/(tabs)/_layout.tsx) unconditionally renders the Chat/
 * Projects `AppDrawer` beside NavRail for every route, INCLUDING Writing
 * — [id].tsx's own Files/Outline/References/Notes/Tools panel was then
 * stacking a SECOND column beside that, producing "icon rail | chat
 * drawer | research panel | editor | preview" instead of the required
 * "icon rail | Writing drawer | editor | preview".
 *
 * The fix has to happen in `_layout.tsx` — it's the only component that
 * actually renders AppDrawer as a sibling of the routed content (Slot),
 * so it's the only place that can choose something else instead. But
 * `_layout.tsx` has no access to [id].tsx's own state (which file is
 * open, the file tree, references, panelTab, ...) — that state
 * legitimately lives in [id].tsx, and lifting all of it up into the
 * persistent shell would be a much larger, riskier rewrite than this
 * fix calls for.
 *
 * This is a small "slot" registration instead: [id].tsx keeps building
 * its own drawer JSX exactly as it already did (same state, same
 * handlers, same tab strip/bodies, same resize/collapse logic — none of
 * that code moves), and simply hands the resulting React element to this
 * shared slot instead of rendering it inline as a second column.
 * `_layout.tsx` reads the slot and renders it in AppDrawer's position
 * only while a Writing project is actually open — see that file's own
 * `isWritingProjectOpen` check. Leaving Writing (unmount, or navigating
 * to the bare /writing list) automatically clears the slot, reverting
 * the drawer position to the normal Chat/Projects `AppDrawer`.
 *
 * TWO separate contexts, deliberately — not one object holding both the
 * setter and the current value. [id].tsx is a DESCENDANT of _layout.tsx
 * in the real tree (Slot renders it), so if [id].tsx's registration hook
 * subscribed to the current `content` value too, the cycle would be:
 * [id].tsx registers -> content state updates -> _layout.tsx (and every
 * consumer of that context, including [id].tsx's own hook) re-renders ->
 * [id].tsx re-renders as a cascade of its own ancestor re-rendering ->
 * [id].tsx registers a new (referentially different, even if
 * conceptually identical) element -> content state updates again ->
 * forever. This is not hypothetical — it happened during real testing
 * (a genuine infinite loop, caught before being shipped). Splitting the
 * stable `setContent` function (its identity from `useState` never
 * changes) into its own context means [id].tsx's hook subscribes to
 * something that never changes, so registering new content never causes
 * [id].tsx itself to re-render — only `_layout.tsx`'s own small
 * `useWritingDrawerContent()` consumer does, exactly once per real
 * change, which is the correct, terminating behavior. See
 * WritingProjectEditorScreen's own `memo()` wrap in [id].tsx for the
 * second half of this fix: without it, `_layout.tsx` re-rendering (for
 * this reason or any other) would still cascade down and re-render
 * [id].tsx as a plain parent-triggered re-render, restarting the same
 * cycle even with the split contexts in place.
 */

type SetWritingDrawerContent = (content: ReactNode | null) => void;

const SetterContext = createContext<SetWritingDrawerContent | null>(null);
const ContentContext = createContext<ReactNode | null>(null);

export function WritingDrawerSlotProvider({ children }: { children: ReactNode }) {
  const [content, setContent] = useState<ReactNode | null>(null);
  return (
    <SetterContext.Provider value={setContent}>
      <ContentContext.Provider value={content}>{children}</ContentContext.Provider>
    </SetterContext.Provider>
  );
}

/** Reads whatever Writing drawer content is currently registered — used
 * by app/(tabs)/_layout.tsx, the one place that renders it. `null` when
 * no Writing screen is currently registering anything (not on a Writing
 * route at all, or [id].tsx hasn't finished its own initial load yet). */
export function useWritingDrawerContent(): ReactNode | null {
  return useContext(ContentContext);
}

/**
 * Returns a stable `setWritingDrawerContent(content)` function that
 * registers `content` as the app shell's Writing drawer, replacing
 * `_layout.tsx`'s regular AppDrawer for as long as the calling component
 * stays mounted.
 *
 * Deliberately NOT "call a hook with the content value directly" —
 * [id].tsx (the one real caller) only finishes computing its drawer JSX
 * after several early `return`s (still loading, load error, no project
 * yet), and Rules of Hooks forbids a hook call that's skipped on some
 * renders but not others. Calling this hook itself is always safe
 * (unconditional, right alongside this file's other hooks, near the top
 * of the component) — it's the returned function you call, later,
 * wherever `content` is actually ready, including after an early return
 * that fired on a DIFFERENT render. That's a plain function call, not a
 * hook, so it's exempt from that rule; it only ever writes to a ref
 * (never triggers a re-render itself, never touches state during
 * render) — the effect below is what actually commits the value into
 * shared state, safely outside the render phase, once per commit.
 */
export function useRegisterWritingDrawerContent(): SetWritingDrawerContent {
  const setContent = useContext(SetterContext);
  const pendingRef = useRef<ReactNode | null>(null);

  // No dependency array: runs after every render/commit of the calling
  // component, always syncing whatever `setWritingDrawerContent` most
  // recently wrote into the ref during THAT render (or, on a render that
  // returned early before ever calling it, whatever the ref already held
  // from the last render that did — an acceptable brief "shows the
  // previous panel" during a transient loading/error window, never a
  // stale-forever value once the real content resumes being set). Safe
  // from the infinite-loop hazard this file's own docstring describes
  // because `setContent`'s identity never changes — this effect re-runs
  // on every render for its OWN reasons, never because `setContent`
  // itself changed.
  useEffect(() => {
    setContent?.(pendingRef.current);
  });

  useEffect(() => {
    return () => setContent?.(null);
  }, [setContent]);

  return useCallback((content: ReactNode | null) => {
    pendingRef.current = content;
  }, []);
}
