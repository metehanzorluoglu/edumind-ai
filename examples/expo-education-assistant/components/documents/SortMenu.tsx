import { useMemo } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { CheckIcon } from '@/components/icons';
import {
  LIBRARY_SORT_KEYS,
  librarySortLabel,
  type LibrarySortDirection,
  type LibrarySortKey,
} from '@/lib/libraryItems';
import { useTheme, type Theme } from '@/lib/Preferences';

export interface SortMenuProps {
  sortKey: LibrarySortKey;
  sortDirection: LibrarySortDirection;
  onChangeSort: (key: LibrarySortKey) => void;
  onChangeDirection: (direction: LibrarySortDirection) => void;
  onClose: () => void;
}

/**
 * Frontend Milestone 1.1 — one compact "Sort" trigger replacing Milestone
 * 1's four always-visible FilterChips (Name/Date modified/Size/Type) plus
 * a separate direction toggle. Real-browser validation at common laptop
 * widths (1024–1280px, this app's own maxWidth container) showed those
 * five controls crowding the toolbar's right edge, sometimes right up
 * against the details panel — this single button + popover reads the same
 * way FolderRow/ItemActionsMenu's own Modal-panel pattern already does
 * elsewhere on this screen, so it's not a new interaction idiom.
 */
export function SortMenu({
  sortKey,
  sortDirection,
  onChangeSort,
  onChangeDirection,
  onClose,
}: SortMenuProps) {
  const theme = useTheme();
  const styles = useMemo(() => buildStyles(theme), [theme]);

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <Pressable
          style={styles.backdrop}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close sort menu"
        />
        <View style={styles.panel}>
          <Text style={styles.sectionTitle}>Sort by</Text>
          {LIBRARY_SORT_KEYS.map((key) => (
            <MenuRow
              key={key}
              label={librarySortLabel(key)}
              checked={sortKey === key}
              onPress={() => {
                onChangeSort(key);
                onClose();
              }}
              styles={styles}
              theme={theme}
            />
          ))}
          <View style={styles.divider} />
          <Text style={styles.sectionTitle}>Order</Text>
          <MenuRow
            label="Ascending"
            checked={sortDirection === 'asc'}
            onPress={() => {
              onChangeDirection('asc');
              onClose();
            }}
            styles={styles}
            theme={theme}
          />
          <MenuRow
            label="Descending"
            checked={sortDirection === 'desc'}
            onPress={() => {
              onChangeDirection('desc');
              onClose();
            }}
            styles={styles}
            theme={theme}
          />
        </View>
      </View>
    </Modal>
  );
}

function MenuRow({
  label,
  checked,
  onPress,
  styles,
  theme,
}: {
  label: string;
  checked: boolean;
  onPress: () => void;
  styles: ReturnType<typeof buildStyles>;
  theme: Theme;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ checked }}
      accessibilityLabel={label}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: theme.cardPressed }]}
    >
      <Text style={[styles.rowText, checked && styles.rowTextActive]}>{label}</Text>
      {checked && <CheckIcon size={14} color={theme.accent} />}
    </Pressable>
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
      width: 220,
      backgroundColor: theme.card,
      borderRadius: theme.radius.lg,
      paddingVertical: 6,
    },
    sectionTitle: {
      fontSize: 11,
      color: theme.faint,
      fontFamily: theme.fonts.bodySemibold,
      textTransform: 'uppercase',
      letterSpacing: 0.3,
      paddingHorizontal: 14,
      paddingTop: 8,
      paddingBottom: 4,
    },
    divider: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: theme.divider,
      marginVertical: 4,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 14,
      paddingVertical: 9,
    },
    rowText: { fontSize: 14, color: theme.text, fontFamily: theme.fonts.body },
    rowTextActive: { color: theme.accent, fontFamily: theme.fonts.bodySemibold },
  });
}
