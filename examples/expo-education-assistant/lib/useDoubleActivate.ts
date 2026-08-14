import { useCallback, useRef } from 'react';

const DOUBLE_ACTIVATE_WINDOW_MS = 400;

/**
 * Frontend Milestone 1 (Finder-style Document Library) — "single click
 * selects, double click opens" (requirement #3), implemented as one
 * activation function every row/card's onPress calls unconditionally
 * (selection already happens on every single press; this only layers
 * "and if that press was the second one on the *same* item within
 * DOUBLE_ACTIVATE_WINDOW_MS, also open it" on top). Timestamp-based rather
 * than a native `dblclick` listener so it works identically for a mouse
 * *and* a touch/tablet double-tap — one code path for both, matching
 * requirement #17 ("tablet: grid/list + drag where pointer events work").
 */
export function useDoubleActivate(onActivate: (id: string) => void): (id: string) => void {
  const lastRef = useRef<{ id: string; time: number } | null>(null);

  return useCallback(
    (id: string) => {
      const now = Date.now();
      const last = lastRef.current;
      if (last && last.id === id && now - last.time < DOUBLE_ACTIVATE_WINDOW_MS) {
        lastRef.current = null;
        onActivate(id);
        return;
      }
      lastRef.current = { id, time: now };
    },
    [onActivate]
  );
}
