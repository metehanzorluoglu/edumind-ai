import { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { GridIcon, InfoIcon, ListIcon, SortIcon, UploadIcon } from '@/components/icons';
import { SortMenu } from '@/components/documents/SortMenu';
import {
  librarySortLabel,
  type LibrarySortDirection,
  type LibrarySortKey,
} from '@/lib/libraryItems';
import { useTheme, type Theme } from '@/lib/Preferences';

export interface LibraryToolbarProps {
  viewMode: 'grid' | 'list';
  onChangeViewMode: (mode: 'grid' | 'list') => void;
  sortKey: LibrarySortKey;
  sortDirection: LibrarySortDirection;
  onChangeSort: (key: LibrarySortKey) => void;
  onChangeSortDirection: (direction: LibrarySortDirection) => void;
  onNewFolder: () => void;
  onUpload: () => void;
  onRefresh: () => void;
  detailsPanelOpen: boolean;
  onToggleDetailsPanel: () => void;
  /** Hidden entirely below the desktop-width breakpoint (documents.tsx) —
   * there is no room for a side panel on narrow layouts, and it has no
   * useful mobile equivalent (requirement #12: "On desktop width, add an
   * optional right-side information panel"). */
  showDetailsPanelToggle: boolean;
}

/**
 * Frontend Milestone 1 (Finder-style Document Library) / 1.1 (real-browser
 * polish) — restrained toolbar: New Folder, Upload, Grid/List, one
 * compact Sort trigger (see SortMenu.tsx — Milestone 1's four always-
 * visible sort chips crowded the toolbar at common laptop widths in real-
 * browser validation), and an optional Details-panel toggle.
 */
export function LibraryToolbar({
  viewMode,
  onChangeViewMode,
  sortKey,
  sortDirection,
  onChangeSort,
  onChangeSortDirection,
  onNewFolder,
  onUpload,
  onRefresh,
  detailsPanelOpen,
  onToggleDetailsPanel,
  showDetailsPanelToggle,
}: LibraryToolbarProps) {
  const theme = useTheme();
  const styles = useMemo(() => buildStyles(theme), [theme]);
  const [sortMenuOpen, setSortMenuOpen] = useState(false);

  return (
    <View style={styles.toolbar}>
      <View style={styles.leftGroup}>
        <Button label="New folder" variant="ghost" size="sm" onPress={onNewFolder} />
        <Button
          label="Upload"
          variant="ghost"
          size="sm"
          icon={<UploadIcon size={15} color={theme.accent} />}
          onPress={onUpload}
        />
        <Button label="Refresh" variant="ghost" size="sm" onPress={onRefresh} />
      </View>

      <View style={styles.rightGroup}>
        <Button
          label={librarySortLabel(sortKey)}
          variant="ghost"
          size="sm"
          icon={<SortIcon size={14} color={theme.subtext} direction={sortDirection} />}
          onPress={() => setSortMenuOpen(true)}
          accessibilityLabel={`Sort by ${librarySortLabel(sortKey)}, ${sortDirection === 'asc' ? 'ascending' : 'descending'}`}
        />

        <View style={styles.viewToggle}>
          <IconButton
            label="Grid view"
            icon={<GridIcon size={16} color={viewMode === 'grid' ? theme.accent : theme.subtext} />}
            size="sm"
            active={viewMode === 'grid'}
            onPress={() => onChangeViewMode('grid')}
          />
          <IconButton
            label="List view"
            icon={<ListIcon size={16} color={viewMode === 'list' ? theme.accent : theme.subtext} />}
            size="sm"
            active={viewMode === 'list'}
            onPress={() => onChangeViewMode('list')}
          />
        </View>

        {showDetailsPanelToggle && (
          <IconButton
            label={detailsPanelOpen ? 'Hide details panel' : 'Show details panel'}
            icon={<InfoIcon size={17} color={detailsPanelOpen ? theme.accent : theme.subtext} />}
            size="sm"
            active={detailsPanelOpen}
            onPress={onToggleDetailsPanel}
          />
        )}
      </View>

      {sortMenuOpen && (
        <SortMenu
          sortKey={sortKey}
          sortDirection={sortDirection}
          onChangeSort={onChangeSort}
          onChangeDirection={onChangeSortDirection}
          onClose={() => setSortMenuOpen(false)}
        />
      )}
    </View>
  );
}

function buildStyles(theme: Theme) {
  return StyleSheet.create({
    toolbar: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 8,
      paddingVertical: 4,
    },
    leftGroup: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    rightGroup: { flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
    viewToggle: {
      flexDirection: 'row',
      alignItems: 'center',
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      borderRadius: theme.radius.md,
      padding: 2,
      gap: 2,
    },
  });
}
