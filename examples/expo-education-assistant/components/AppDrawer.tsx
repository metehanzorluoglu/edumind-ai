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
      setDragWidth(next);
    }
    function handleMouseUp(): void {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      setDragWidth((current) => {
        if (current != null) onResizeEnd(current);
        return null;
      });
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
          accessibilityRole="none"
          accessibilityLabel="Resize conversation list"
          style={styles.handle}
          // react-native-web forwards raw mouse events on View for web
          // targets; RN's own ViewProps type doesn't declare them, hence
          // the cast — same pattern as Button.tsx's web-only transition
          // style cast.
          {...({ onMouseDown: handleMouseDown } as object)}
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
