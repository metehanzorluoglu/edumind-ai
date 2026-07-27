import type { RefObject } from 'react';
import type { View } from 'react-native';

export interface MeasuredRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Thin wrapper around `View.measureInWindow` — its own module purely so
 * tests can mock it deterministically: react-test-renderer's host-component
 * stub for `measureInWindow` never actually invokes its callback (there's
 * no real layout engine underneath it), so a trigger press would silently
 * do nothing in a test without a seam like this one to substitute a fixed
 * rect. In the real app (native or web), this just forwards to the real
 * measurement.
 */
export function measureWindowRect(
  ref: RefObject<View | null>,
  callback: (rect: MeasuredRect) => void
): void {
  ref.current?.measureInWindow((x, y, width, height) => {
    callback({ x, y, width, height });
  });
}
