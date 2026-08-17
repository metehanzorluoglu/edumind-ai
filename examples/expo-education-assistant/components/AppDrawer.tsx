import { useEffect, useRef, useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import {
  ConversationSidebar,
  type ConversationSidebarProps,
} from '@/components/ConversationSidebar';
import { DARK_PALETTE, SIDEBAR_WIDTH_MAX, SIDEBAR_WIDTH_MIN } from '@/lib/Preferences';

const dark = DARK_PALETTE;

export interface AppDrawerProps extends ConversationSidebarProps {
  /** Current committed width (from Preferences) — the source of truth
   * whenever the user isn't actively dragging the resize handle. */
  width: number;
  /** Fired once, on drag release, with the final width — the caller
   * persists it (Preferences.update). Never fired on every pixel of
   * movement, so a drag never floods storage writes. */
  onResizeEnd: (width: number) => void;
}

/**
 * Thin composition wrapper around ConversationSidebar — adds a
 * drag-to-resize handle on its right edge without touching
 * ConversationSidebar's own internals (that component has an extensive,
 * tightly-coupled test suite; a wrapper is strictly lower-risk than
 * threading new props through it). Collapsing the drawer entirely is a
 * decision the parent layout makes (whether to render AppDrawer at all),
 * driven by NavRail's collapse toggle.
 *
 * Resize is web-only (mouse drag) — native has no equivalent gesture in
 * scope here, and the handle simply doesn't render off-web.
 */
export function AppDrawer({ width, onResizeEnd, ...sidebarProps }: AppDrawerProps) {
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const draggingRef = useRef(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(width);
  // Mirrors `dragWidth` for handleMouseUp to read synchronously.
  // Milestone 5.5 Part 30 — useDragResizeWidth.ts (generalized FROM this
  // component, see its own header comment) hit React's "Cannot update a
  // component while rendering a different component" warning from this
  // exact shape: calling onResizeEnd(current) — which calls a caller's
  // setState — from INSIDE the functional updater passed to
  // setDragWidth, which React can invoke during another component's
  // render. Applying the same fix here rather than leaving the
  // now-diagnosed original copy of the bug in place.
  const dragWidthRef = useRef<number | null>(null);
  const effectiveWidth = dragWidth ?? width;

  useEffect(() => {
    if (Platform.OS !== 'web') return;
    function handleMouseMove(e: MouseEvent): void {
      if (!draggingRef.current) return;
      const delta = e.clientX - startXRef.current;
      const next = Math.min(
        SIDEBAR_WIDTH_MAX,
        Math.max(SIDEBAR_WIDTH_MIN, startWidthRef.current + delta)
      );
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
  }, [onResizeEnd]);

  function handleMouseDown(e: { clientX: number }): void {
    draggingRef.current = true;
    startXRef.current = e.clientX;
    startWidthRef.current = effectiveWidth;
  }

  return (
    <View style={[styles.container, { width: effectiveWidth }]} testID="app-drawer">
      <View style={styles.sidebar}>
        <ConversationSidebar {...sidebarProps} />
      </View>
      {Platform.OS === 'web' && (
        <View
          // Milestone 5.5 Part 30 — axe-core flagged accessibilityRole=
          // "none" + accessibilityLabel together as an aria-prohibited-
          // attr violation: role="none"/"presentation" strips ALL
          // semantics, including accessible-name computation, so
          // aria-label is meaningless there. "adjustable" (RNW maps it
          // to role="slider", the correct ARIA role for a drag handle)
          // both fixes that and makes the handle's current/min/max width
          // available to assistive tech — role="slider" requires
          // aria-valuenow, which RNW only reads from flat props, not a
          // nested accessibilityValue object (same "no nested object"
          // rule as accessibilityState — see PanelTabButton's own note).
          accessibilityRole="adjustable"
          accessibilityLabel="Resize conversation list"
          style={styles.handle}
          // react-native-web forwards raw mouse events on View for web
          // targets; RN's own ViewProps type doesn't declare them, hence
          // the cast — same pattern as Button.tsx's web-only transition
          // style cast.
          {...({
            onMouseDown: handleMouseDown,
            'aria-valuenow': Math.round(effectiveWidth),
            'aria-valuemin': SIDEBAR_WIDTH_MIN,
            'aria-valuemax': SIDEBAR_WIDTH_MAX,
          } as object)}
        >
          <View style={[styles.handleGrip, { backgroundColor: dark.borderStrong }]} />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flexDirection: 'row' },
  sidebar: { flex: 1, minWidth: 0 },
  handle: {
    width: 6,
    marginLeft: -3,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1,
    ...(Platform.OS === 'web' ? ({ cursor: 'col-resize' } as object) : null),
  },
  handleGrip: { width: 2, height: 32, borderRadius: 1, opacity: 0.6 },
});
