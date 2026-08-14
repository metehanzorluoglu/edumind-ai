import { createElement, useMemo } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text } from 'react-native';
import type { FolderBreadcrumb } from 'education-assistant-client';
import { useTheme, type Theme } from '@/lib/Preferences';
import { useCombinedDomRef } from '@/lib/useCombinedDomRef';

export interface BreadcrumbsDnD {
  attachRootDropTarget: (node: HTMLElement) => () => void;
  attachBreadcrumbDropTarget: (node: HTMLElement, folderId: string) => () => void;
  dropVisualState: (key: string) => 'none' | 'valid' | 'invalid';
}

export interface BreadcrumbsProps {
  /** Root -> ... -> current folder, NOT including a synthetic "root" entry
   * — the root crumb ("My Library") is rendered here unconditionally. */
  path: FolderBreadcrumb[];
  onNavigate: (folderId: string | null) => void;
  /** Frontend Milestone 1 (Finder-style Document Library), requirement #7
   * ("Move to root"): when supplied, every crumb (root + ancestors) also
   * becomes a drag-and-drop target, so dropping an item on "My Library" or
   * any ancestor folder moves it there. Omitted by callers (e.g.
   * ChatSourcesPicker's own folder-browse dialog) that only need plain
   * navigation — this never changes behavior for them. */
  dnd?: BreadcrumbsDnD;
}

/**
 * Milestone 1 (Document Library / Folder Management): "My Library / Research
 * / AI Education"-style trail above the folder/document listing. Every
 * crumb (including the current one) is pressable — clicking the current
 * folder's own crumb is a harmless no-op re-navigation, simpler than
 * disabling just the last item for marginal benefit.
 */
export function Breadcrumbs({ path, onNavigate, dnd }: BreadcrumbsProps) {
  const theme = useTheme();
  const styles = useMemo(() => buildStyles(theme), [theme]);

  const rootDropState = dnd ? dnd.dropVisualState('root') : 'none';
  const rootRef = useCombinedDomRef([dnd ? (node) => dnd.attachRootDropTarget(node) : null]);

  const rootCrumb = (
    <Pressable
      onPress={() => onNavigate(null)}
      accessibilityRole="button"
      accessibilityLabel="My Library (root)"
      hitSlop={6}
      style={[rootDropState !== 'none' && dropStyle(styles, rootDropState)]}
    >
      <Text style={[styles.crumb, path.length === 0 && styles.crumbCurrent]}>My Library</Text>
    </Pressable>
  );

  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.row}>
      {Platform.OS === 'web' && dnd
        ? createElement('div', { ref: rootRef, 'data-testid': 'breadcrumb-root-drop' }, rootCrumb)
        : rootCrumb}
      {path.map((crumb) => (
        <BreadcrumbSegment
          key={crumb.id}
          crumb={crumb}
          isCurrent={crumb.id === path[path.length - 1]!.id}
          onNavigate={onNavigate}
          dnd={dnd}
          styles={styles}
        />
      ))}
    </ScrollView>
  );
}

function dropStyle(styles: ReturnType<typeof buildStyles>, state: 'valid' | 'invalid') {
  return state === 'valid' ? styles.dropValid : styles.dropInvalid;
}

function BreadcrumbSegment({
  crumb,
  isCurrent,
  onNavigate,
  dnd,
  styles,
}: {
  crumb: FolderBreadcrumb;
  isCurrent: boolean;
  onNavigate: (folderId: string | null) => void;
  dnd?: BreadcrumbsDnD;
  styles: ReturnType<typeof buildStyles>;
}) {
  const dropState = dnd ? dnd.dropVisualState(`folder:${crumb.id}`) : 'none';
  const domRef = useCombinedDomRef([
    dnd ? (node: HTMLElement) => dnd.attachBreadcrumbDropTarget(node, crumb.id) : null,
  ]);

  const segment = (
    <Pressable
      onPress={() => onNavigate(crumb.id)}
      accessibilityRole="button"
      accessibilityLabel={crumb.name}
      hitSlop={6}
      style={[styles.crumbGroup, dropState !== 'none' && dropStyle(styles, dropState)]}
    >
      <Text style={styles.separator}>›</Text>
      <Text style={[styles.crumb, isCurrent && styles.crumbCurrent]} numberOfLines={1}>
        {crumb.name}
      </Text>
    </Pressable>
  );

  if (Platform.OS !== 'web' || !dnd) return segment;
  return createElement(
    'div',
    { ref: domRef, 'data-testid': `breadcrumb-drop-${crumb.id}` },
    segment
  );
}

function buildStyles(theme: Theme) {
  return StyleSheet.create({
    row: { flexDirection: 'row' },
    crumbGroup: { flexDirection: 'row', alignItems: 'center' },
    separator: { color: theme.faint, fontSize: 13, marginHorizontal: 6 },
    crumb: { color: theme.subtext, fontSize: 13, fontFamily: theme.fonts.body },
    crumbCurrent: { color: theme.text, fontFamily: theme.fonts.bodySemibold },
    dropValid: {
      backgroundColor: theme.accentSoft,
      borderRadius: theme.radius.sm,
      borderWidth: 1,
      borderColor: theme.accent,
    },
    dropInvalid: {
      backgroundColor: theme.dangerSoft,
      borderRadius: theme.radius.sm,
      borderWidth: 1,
      borderColor: theme.danger,
    },
  });
}
