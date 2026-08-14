import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type View as RNView,
} from 'react-native';
import { CloseIcon } from '@/components/icons';
import { IconButton } from '@/components/ui/IconButton';
import { useTheme, type Theme } from '@/lib/Preferences';

export interface ActionSheetItem {
  key: string;
  label: string;
  onPress: () => void;
  destructive?: boolean;
  disabled?: boolean;
  loading?: boolean;
  /** Marks the option matching the sheet's current state (e.g. the active
   * sort key) with a filled dot instead of a plain row — this sheet is
   * reused for both one-shot actions (entry "More" menu) and single-select
   * pickers (the Sort menu), and the two need to look different. */
  selected?: boolean;
}

// Matches documents/[id].tsx's own MOBILE_BREAKPOINT_PX — one shared
// convention for "is this a small/touch viewport" across the app, not a
// second breakpoint invented for this component.
const DESKTOP_BREAKPOINT_PX = 760;
const POPOVER_WIDTH = 240;
const VIEWPORT_MARGIN = 12;

export interface ActionSheetProps {
  visible: boolean;
  title?: string;
  items: ActionSheetItem[];
  onDismiss: () => void;
  /** Frontend/Platform Milestone 3.2.1 §B1 — a ref to the trigger element
   * (the "..." button). Required for desktop/wide-tablet behavior: when
   * present and the viewport is at least DESKTOP_BREAKPOINT_PX wide, this
   * renders as a small popover anchored near the trigger instead of a
   * full-width bottom sheet. Omit it (or narrow viewports) and this
   * behaves exactly as before — a bottom sheet, still the right call on
   * mobile. */
  anchorRef?: RefObject<RNView | null>;
}

/**
 * Frontend/Platform Milestone 3.2.1 — responsive menu: an anchored
 * popover near the trigger on desktop/wide tablet, a bottom sheet on
 * mobile (§B1). Frontend Milestone 3.2 originally made this ALWAYS a
 * bottom sheet "even on desktop... one visual language is easier to keep
 * restrained than two" — real usage found that reads wrong on desktop
 * specifically (a menu anchored to the bottom of the whole viewport, far
 * from the button that opened it), so this milestone corrects it rather
 * than defending the earlier call. The two presentations still share one
 * component/item model — call sites never know which one rendered.
 */
export function ActionSheet({ visible, title, items, onDismiss, anchorRef }: ActionSheetProps) {
  const theme = useTheme();
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const isDesktop = windowWidth >= DESKTOP_BREAKPOINT_PX;
  const styles = useMemo(() => buildStyles(theme), [theme]);
  const [anchorRect, setAnchorRect] = useState<{
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>(null);
  const measuredForRef = useRef<RefObject<RNView | null> | null>(null);

  useEffect(() => {
    if (!visible || !isDesktop || !anchorRef?.current) {
      if (!visible) setAnchorRect(null);
      return;
    }
    // Re-measure every time this opens (not just once) — the trigger's
    // on-screen position can differ between opens (list scrolled, window
    // resized) even though the ref identity doesn't change.
    if (measuredForRef.current === anchorRef && anchorRect) return;
    anchorRef.current.measureInWindow((x, y, width, height) => {
      setAnchorRect({ x, y, width, height });
      measuredForRef.current = anchorRef;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, isDesktop, anchorRef]);

  if (!visible) return null;

  const usePopover = isDesktop && !!anchorRef?.current && !!anchorRect;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onDismiss}>
      <View style={usePopover ? styles.popoverOverlay : styles.sheetOverlay}>
        <Pressable
          style={styles.backdrop}
          onPress={onDismiss}
          accessibilityRole="button"
          accessibilityLabel="Dismiss"
        />
        <View
          style={
            usePopover && anchorRect
              ? [styles.popover, popoverPosition(anchorRect, windowWidth, windowHeight)]
              : styles.sheet
          }
        >
          {title && (
            <View style={styles.header}>
              <Text style={styles.title}>{title}</Text>
              <IconButton
                label="Close"
                icon={<CloseIcon size={16} color={theme.faint} />}
                size="sm"
                onPress={onDismiss}
              />
            </View>
          )}
          {items.map((item) => (
            <Pressable
              key={item.key}
              onPress={() => {
                if (item.disabled || item.loading) return;
                item.onPress();
              }}
              disabled={item.disabled || item.loading}
              accessibilityRole="menuitem"
              accessibilityLabel={item.label}
              accessibilityState={{ disabled: item.disabled, selected: item.selected }}
              style={({ pressed }) => [
                styles.row,
                pressed && !item.disabled && styles.rowPressed,
                item.disabled && styles.rowDisabled,
              ]}
            >
              {item.selected !== undefined && (
                <View style={[styles.dot, item.selected && styles.dotActive]} />
              )}
              <Text
                style={[
                  styles.rowText,
                  item.destructive && styles.rowTextDestructive,
                  item.selected && styles.rowTextActive,
                ]}
              >
                {item.label}
              </Text>
              {item.loading && <ActivityIndicator size="small" color={theme.faint} />}
            </Pressable>
          ))}
        </View>
      </View>
    </Modal>
  );
}

/** Below-and-right-aligned to the trigger by default (the usual "..."
 * button reads left-to-right into its menu), clamped so the popover never
 * renders off-screen on any edge. */
function popoverPosition(
  anchor: { x: number; y: number; width: number; height: number },
  windowWidth: number,
  windowHeight: number
): { position: 'absolute'; top: number; left: number } {
  const estimatedHeight = 220; // clamped below by the viewport anyway
  let left = anchor.x + anchor.width - POPOVER_WIDTH;
  left = Math.max(VIEWPORT_MARGIN, Math.min(left, windowWidth - POPOVER_WIDTH - VIEWPORT_MARGIN));

  let top = anchor.y + anchor.height + 6;
  if (top + estimatedHeight > windowHeight - VIEWPORT_MARGIN) {
    // Not enough room below — open upward instead.
    top = Math.max(VIEWPORT_MARGIN, anchor.y - estimatedHeight - 6);
  }
  return { position: 'absolute', top, left };
}

function buildStyles(theme: Theme) {
  return StyleSheet.create({
    sheetOverlay: {
      ...StyleSheet.absoluteFillObject,
      alignItems: 'stretch',
      justifyContent: 'flex-end',
      zIndex: 60,
      elevation: 60,
    },
    popoverOverlay: {
      ...StyleSheet.absoluteFillObject,
      zIndex: 60,
      elevation: 60,
    },
    backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: theme.overlay },
    sheet: {
      backgroundColor: theme.card,
      borderTopLeftRadius: theme.radius.lg,
      borderTopRightRadius: theme.radius.lg,
      paddingHorizontal: 8,
      paddingTop: 10,
      paddingBottom: 22,
      gap: 2,
      maxWidth: 420,
      width: '100%',
      alignSelf: 'center',
    },
    popover: {
      width: POPOVER_WIDTH,
      backgroundColor: theme.card,
      borderRadius: theme.radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      paddingHorizontal: 6,
      paddingVertical: 6,
      gap: 1,
      // A popover reads as "attached to the button," which a bottom
      // sheet's heavier backdrop dimming would fight — a visible shadow
      // does the same "this is floating above the page" job instead.
      boxShadow: '0 4px 20px rgba(0,0,0,0.16)',
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 10,
      paddingBottom: 8,
      marginBottom: 4,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.border,
    },
    title: { color: theme.text, fontSize: 14, fontFamily: theme.fonts.bodySemibold },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      paddingVertical: 12,
      paddingHorizontal: 10,
      borderRadius: theme.radius.sm,
    },
    rowPressed: { backgroundColor: theme.cardPressed },
    rowDisabled: { opacity: 0.5 },
    dot: {
      width: 6,
      height: 6,
      borderRadius: 3,
      backgroundColor: 'transparent',
    },
    dotActive: { backgroundColor: theme.accent },
    rowText: { flex: 1, fontSize: 14, fontFamily: theme.fonts.body, color: theme.text },
    rowTextActive: { fontFamily: theme.fonts.bodySemibold, color: theme.accent },
    rowTextDestructive: { color: theme.danger },
  });
}
