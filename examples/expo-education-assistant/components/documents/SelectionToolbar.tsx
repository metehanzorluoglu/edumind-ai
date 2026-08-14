import { useMemo } from 'react';
import { Platform, StyleSheet, View, useWindowDimensions } from 'react-native';
import { Button } from '@/components/ui/Button';
import { useTheme, type Theme } from '@/lib/Preferences';

export interface SelectionToolbarProps {
  /** Viewport-relative — see useReaderSelection's ReaderSelection.rect. */
  anchorRect: { top: number; left: number; width: number; height: number };
  onHighlight: () => void;
  onAddNote: () => void;
  onAskEduM8: () => void;
  busy?: boolean;
}

const TOOLBAR_HEIGHT_PX = 44;
const TOOLBAR_GAP_PX = 8;

/**
 * Frontend Milestone 3 §11 — the compact contextual toolbar shown above a
 * real text selection: "[ Highlight ] [ Add note ] [ Ask EduM8 ]", never
 * a giant floating panel. Web-only (positioned against a real DOM
 * selection rect from useReaderSelection); the mobile long-press fallback
 * (see ReaderContent) opens the equivalent actions through a plain sheet
 * instead of trying to float against a rect that doesn't exist there.
 */
export function SelectionToolbar({
  anchorRect,
  onHighlight,
  onAddNote,
  onAskEduM8,
  busy = false,
}: SelectionToolbarProps) {
  const theme = useTheme();
  const styles = useMemo(() => buildStyles(theme), [theme]);
  const { width: windowWidth } = useWindowDimensions();

  if (Platform.OS !== 'web') return null;

  const estimatedWidth = 300;
  const left = Math.min(
    Math.max(8, anchorRect.left + anchorRect.width / 2 - estimatedWidth / 2),
    windowWidth - estimatedWidth - 8
  );
  const top = Math.max(8, anchorRect.top - TOOLBAR_HEIGHT_PX - TOOLBAR_GAP_PX);

  return (
    <View
      style={[styles.toolbar, { top, left }]}
      accessibilityRole="toolbar"
      accessibilityLabel="Selected text actions"
    >
      <Button label="Highlight" variant="ghost" size="sm" onPress={onHighlight} disabled={busy} />
      <View style={styles.divider} />
      <Button label="Add note" variant="ghost" size="sm" onPress={onAddNote} disabled={busy} />
      <View style={styles.divider} />
      <Button label="Ask EduM8" variant="primary" size="sm" onPress={onAskEduM8} disabled={busy} />
    </View>
  );
}

function buildStyles(theme: Theme) {
  return StyleSheet.create({
    toolbar: {
      position: 'fixed' as 'absolute',
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      backgroundColor: theme.card,
      borderRadius: theme.radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      paddingHorizontal: 6,
      paddingVertical: 4,
      shadowColor: '#000',
      shadowOpacity: 0.16,
      shadowRadius: 12,
      shadowOffset: { width: 0, height: 4 },
      elevation: 8,
      zIndex: 40,
    },
    divider: { width: StyleSheet.hairlineWidth, height: 18, backgroundColor: theme.border },
  });
}
