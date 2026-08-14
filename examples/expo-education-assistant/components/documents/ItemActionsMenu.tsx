import { useMemo } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import type { LibraryItem } from '@/lib/libraryItems';
import { libraryItemName } from '@/lib/libraryItems';
import { useTheme, type Theme } from '@/lib/Preferences';

export interface ItemAction {
  label: string;
  onPress: () => void;
  destructive?: boolean;
  disabled?: boolean;
}

export interface ItemActionsMenuProps {
  item: LibraryItem;
  actions: ItemAction[];
  onClose: () => void;
}

/**
 * Frontend Milestone 1 (Finder-style Document Library) — the
 * always-available, no-drag-required action menu (requirement #11:
 * "Drag-and-drop complements these actions. It does NOT replace accessible
 * controls."). Triggered by each card/row's "⋯" button; reuses
 * MoveToFolderDialog's own centered-panel/backdrop Modal pattern rather
 * than attempting pixel-anchored popover positioning, which RN has no
 * reliable cross-platform primitive for.
 */
export function ItemActionsMenu({ item, actions, onClose }: ItemActionsMenuProps) {
  const theme = useTheme();
  const styles = useMemo(() => buildStyles(theme), [theme]);

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <Pressable
          style={styles.backdrop}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close menu"
        />
        <View style={styles.panel}>
          <Text style={styles.title} numberOfLines={1}>
            {libraryItemName(item)}
          </Text>
          {actions.map((action) => (
            <Pressable
              key={action.label}
              onPress={() => {
                if (action.disabled) return;
                action.onPress();
              }}
              disabled={action.disabled}
              accessibilityRole="menuitem"
              accessibilityLabel={action.label}
              style={({ pressed }) => [
                styles.row,
                pressed && !action.disabled && { backgroundColor: theme.cardPressed },
                action.disabled && styles.rowDisabled,
              ]}
            >
              <Text
                style={[
                  styles.rowText,
                  {
                    color: action.destructive ? theme.danger : theme.text,
                    fontFamily: theme.fonts.body,
                  },
                ]}
              >
                {action.label}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>
    </Modal>
  );
}

function buildStyles(theme: Theme) {
  return StyleSheet.create({
    overlay: {
      ...StyleSheet.absoluteFillObject,
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 30,
      elevation: 30,
    },
    backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: theme.overlay },
    panel: {
      width: 240,
      backgroundColor: theme.card,
      borderRadius: theme.radius.lg,
      paddingVertical: 6,
      gap: 1,
    },
    title: {
      color: theme.subtext,
      fontSize: 12,
      fontFamily: theme.fonts.bodySemibold,
      paddingHorizontal: 14,
      paddingTop: 8,
      paddingBottom: 6,
    },
    row: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: theme.radius.sm },
    rowDisabled: { opacity: 0.4 },
    rowText: { fontSize: 14 },
  });
}
