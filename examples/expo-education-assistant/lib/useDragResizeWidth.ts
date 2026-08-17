import { useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';

export interface UseDragResizeWidthResult {
  /** The width to actually render — the committed `width` while idle, a
   * live in-drag value while dragging. */
  effectiveWidth: number;
  /** Web-only mousedown handler for the resize handle. Cast onto a View
   * the same way AppDrawer.tsx's own handle does — RN's ViewProps type
   * doesn't declare onMouseDown, but react-native-web forwards it:
   * `{...({ onMouseDown: handleMouseDown } as object)}`. */
  handleMouseDown: (e: { clientX: number }) => void;
}

/**
 * Milestone 5.5 Part 8 — generalizes AppDrawer.tsx's own drag-to-resize
 * handle (mousemove/mouseup on window, min/max-clamped, committed only on
 * release so a drag never floods storage writes) for any horizontally
 * resizable panel, so the Writing workspace's Research/Preview columns
 * don't reimplement it from scratch. Web-only — native has no equivalent
 * gesture in scope; callers simply don't render a handle off-web
 * (Platform.OS check stays the caller's job, same as AppDrawer).
 *
 * `invert`: a panel anchored to the LEFT edge of the screen (its handle on
 * its right, like AppDrawer/the Research panel) grows when the handle
 * moves right — the default. A panel anchored to the RIGHT edge (its
 * handle on its left, like the PDF Preview column) grows when the handle
 * moves LEFT, so `invert: true` flips the delta's sign.
 */
export function useDragResizeWidth(params: {
  width: number;
  min: number;
  max: number;
  onResizeEnd: (width: number) => void;
  invert?: boolean;
}): UseDragResizeWidthResult {
  const { width, min, max, onResizeEnd, invert = false } = params;
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const draggingRef = useRef(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(width);
  // Mirrors `dragWidth` for handleMouseUp to read synchronously. Real-
  // browser validation (Milestone 5.5 Part 32) caught a genuine bug here:
  // calling onResizeEnd(current) — which calls Preferences' setState —
  // from INSIDE the functional updater passed to setDragWidth triggered
  // React's "Cannot update a component while rendering a different
  // component" warning, because updater functions must be pure/side-
  // effect-free (React can invoke them during another component's
  // render). Reading the last value off a ref outside the updater avoids
  // the side effect entirely.
  const dragWidthRef = useRef<number | null>(null);
  const effectiveWidth = dragWidth ?? width;

  useEffect(() => {
    // jest-expo reports Platform.OS as 'web' but has no real `window` —
    // same guard as [id].tsx's own beforeunload effect, for the same
    // reason (see that effect's comment).
    if (
      Platform.OS !== 'web' ||
      typeof window === 'undefined' ||
      typeof window.addEventListener !== 'function'
    ) {
      return;
    }
    function handleMouseMove(e: MouseEvent): void {
      if (!draggingRef.current) return;
      const rawDelta = e.clientX - startXRef.current;
      const delta = invert ? -rawDelta : rawDelta;
      const next = Math.min(max, Math.max(min, startWidthRef.current + delta));
      dragWidthRef.current = next;
      setDragWidth(next);
    }
    function handleMouseUp(): void {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      const finalWidth = dragWidthRef.current;
      dragWidthRef.current = null;
      setDragWidth(null);
      if (finalWidth != null) onResizeEnd(finalWidth);
    }
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [min, max, onResizeEnd, invert]);

  function handleMouseDown(e: { clientX: number }): void {
    draggingRef.current = true;
    startXRef.current = e.clientX;
    startWidthRef.current = effectiveWidth;
  }

  return { effectiveWidth, handleMouseDown };
}
