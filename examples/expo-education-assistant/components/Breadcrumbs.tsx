import { useMemo } from 'react';
import { Pressable, ScrollView, StyleSheet, Text } from 'react-native';
import type { FolderBreadcrumb } from 'education-assistant-client';
import { useTheme, type Theme } from '@/lib/Preferences';

export interface BreadcrumbsProps {
  /** Root -> ... -> current folder, NOT including a synthetic "root" entry
   * — the root crumb ("My Library") is rendered here unconditionally. */
  path: FolderBreadcrumb[];
  onNavigate: (folderId: string | null) => void;
}

/**
 * Milestone 1 (Document Library / Folder Management): "My Library / Research
 * / AI Education"-style trail above the folder/document listing. Every
 * crumb (including the current one) is pressable — clicking the current
 * folder's own crumb is a harmless no-op re-navigation, simpler than
 * disabling just the last item for marginal benefit.
 */
export function Breadcrumbs({ path, onNavigate }: BreadcrumbsProps) {
  const theme = useTheme();
  const styles = useMemo(() => buildStyles(theme), [theme]);

  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.row}>
      <Pressable
        onPress={() => onNavigate(null)}
        accessibilityRole="button"
        accessibilityLabel="My Library (root)"
        hitSlop={6}
      >
        <Text style={[styles.crumb, path.length === 0 && styles.crumbCurrent]}>My Library</Text>
      </Pressable>
      {path.map((crumb) => (
        <Pressable
          key={crumb.id}
          onPress={() => onNavigate(crumb.id)}
          accessibilityRole="button"
          accessibilityLabel={crumb.name}
          hitSlop={6}
          style={styles.crumbGroup}
        >
          <Text style={styles.separator}>›</Text>
          <Text
            style={[styles.crumb, crumb.id === path[path.length - 1]!.id && styles.crumbCurrent]}
            numberOfLines={1}
          >
            {crumb.name}
          </Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

function buildStyles(theme: Theme) {
  return StyleSheet.create({
    row: { flexDirection: 'row' },
    crumbGroup: { flexDirection: 'row', alignItems: 'center' },
    separator: { color: theme.faint, fontSize: 13, marginHorizontal: 6 },
    crumb: { color: theme.subtext, fontSize: 13, fontFamily: theme.fonts.body },
    crumbCurrent: { color: theme.text, fontFamily: theme.fonts.bodySemibold },
  });
}
