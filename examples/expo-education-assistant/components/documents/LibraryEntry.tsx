import { createElement, useEffect, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Badge } from '@/components/ui/Badge';
import { IconButton } from '@/components/ui/IconButton';
import { FileIcon, FolderIcon, MoreIcon } from '@/components/icons';
import {
  formatLibraryDate,
  libraryItemDate,
  libraryItemId,
  libraryItemName,
  libraryItemTypeLabel,
  type LibraryItem,
} from '@/lib/libraryItems';
import { useCombinedDomRef } from '@/lib/useCombinedDomRef';
import { isSampleSource } from '@/lib/sampleDocument';
import { useTheme, type Theme } from '@/lib/Preferences';

const MAX_FOLDER_NAME_LENGTH = 255;

export interface LibraryEntryProps {
  layout: 'grid' | 'list';
  item: LibraryItem;
  selected: boolean;
  dragging: boolean;
  moving: boolean;
  dropState: 'none' | 'valid' | 'invalid';
  onPress: (event: unknown) => void;
  onOpenMenu: () => void;
  renaming: boolean;
  onCommitRename: (name: string) => Promise<unknown>;
  onCancelRename: () => void;
  /** Web-only: undefined on native, where nothing here is draggable. */
  attachDragSource?: (node: HTMLElement) => () => void;
  /** Only meaningful for folder items. */
  attachDropTarget?: (node: HTMLElement) => () => void;
}

/**
 * Frontend Milestone 1 (Finder-style Document Library) — one entry
 * (folder or document), rendered either as a grid card or a list row from
 * the same behavior (selection/drag/rename/menu all live here once,
 * rather than being reimplemented per layout). See LibraryGrid.tsx /
 * LibraryList.tsx for the containers that lay these out.
 */
export function LibraryEntry({
  layout,
  item,
  selected,
  dragging,
  moving,
  dropState,
  onPress,
  onOpenMenu,
  renaming,
  onCommitRename,
  onCancelRename,
  attachDragSource,
  attachDropTarget,
}: LibraryEntryProps) {
  const theme = useTheme();
  const styles = layout === 'grid' ? buildGridStyles(theme) : buildListStyles(theme);
  const [nameInput, setNameInput] = useState(libraryItemName(item));
  const [renameError, setRenameError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (renaming) setNameInput(libraryItemName(item));
  }, [renaming, item]);

  const domRef = useCombinedDomRef([
    attachDragSource,
    item.kind === 'folder' ? attachDropTarget : null,
  ]);

  async function commit(): Promise<void> {
    const trimmed = nameInput.trim();
    if (!trimmed || trimmed === libraryItemName(item)) {
      onCancelRename();
      return;
    }
    setSaving(true);
    setRenameError(null);
    try {
      await onCommitRename(trimmed);
    } catch (error) {
      setRenameError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  const isFolder = item.kind === 'folder';
  const name = libraryItemName(item);
  const dropHighlight =
    isFolder && dropState !== 'none'
      ? dropState === 'valid'
        ? styles.dropValid
        : styles.dropInvalid
      : null;

  const icon = isFolder ? (
    <FolderIcon size={layout === 'grid' ? 26 : 18} color={theme.subtext} />
  ) : (
    <FileIcon size={layout === 'grid' ? 26 : 18} color={theme.subtext} />
  );

  const menuButton = (
    <IconButton
      label={`More actions for ${name}`}
      icon={<MoreIcon size={14} color={theme.subtext} />}
      size="sm"
      onPress={onOpenMenu}
    />
  );

  // The selectable/openable surface and the "⋯" actions menu are SIBLINGS,
  // not parent/child: both render as a real `<button>` on web
  // (accessibilityRole="button"), and a `<button>` nested inside another
  // `<button>` is invalid HTML — React logs a DOM-nesting/hydration error
  // for it, and Chrome's own HTML parser will actually close the outer
  // button early, silently breaking its hit area. Found via real-browser
  // validation (Frontend Milestone 1.1), not the unit tests, which use
  // react-test-renderer and never render real DOM. While renaming, the
  // whole surface skips the button semantics entirely (typing into the
  // TextInput has no "selectable card" meaning) and renders as a plain,
  // non-interactive row instead — the alternative (an editable text field
  // inside a `<button>`) has the same class of problem.
  const mainContent =
    layout === 'grid' ? (
      <>
        <View style={styles.iconWrap}>{icon}</View>
        {renaming ? (
          <RenameInput
            value={nameInput}
            onChangeText={setNameInput}
            onCommit={commit}
            saving={saving}
            style={styles.renameInputGrid}
            theme={theme}
          />
        ) : (
          <Text style={styles.name} numberOfLines={2}>
            {name}
          </Text>
        )}
        <Text style={styles.meta} numberOfLines={1}>
          {isFolder
            ? `${item.data.folder_count} folder${item.data.folder_count === 1 ? '' : 's'} · ${item.data.document_count} doc${item.data.document_count === 1 ? '' : 's'}`
            : libraryItemTypeLabel(item)}
        </Text>
        {!isFolder && isSampleSource(item.data.source_filename) && (
          <Badge label="Sample" tone="warning" />
        )}
        {renameError && (
          <Text style={styles.errorText} numberOfLines={2}>
            {renameError}
          </Text>
        )}
      </>
    ) : (
      <>
        <View style={styles.listNameCell}>
          {icon}
          {renaming ? (
            <RenameInput
              value={nameInput}
              onChangeText={setNameInput}
              onCommit={commit}
              saving={saving}
              style={styles.renameInputList}
              theme={theme}
            />
          ) : (
            <Text style={styles.listName} numberOfLines={1}>
              {name}
            </Text>
          )}
          {!isFolder && isSampleSource(item.data.source_filename) && (
            <Badge label="Sample" tone="warning" />
          )}
        </View>
        <Text style={styles.listCell} numberOfLines={1}>
          {libraryItemTypeLabel(item)}
        </Text>
        <Text style={styles.listCell} numberOfLines={1}>
          {formatLibraryDate(libraryItemDate(item))}
        </Text>
        <Text style={styles.listCell} numberOfLines={1}>
          {/* Frontend Milestone 1: no persisted file-size field exists on
              DocumentSummary — see the milestone report's Limitations
              section. An honest "—" beats fabricating a number. */}
          —
        </Text>
      </>
    );

  const content = (
    <View
      style={[
        layout === 'grid' ? styles.card : styles.row,
        selected && styles.selected,
        dragging && styles.dragging,
        dropHighlight,
      ]}
    >
      {renaming ? (
        <View style={layout === 'grid' ? styles.cardMain : styles.listMain}>{mainContent}</View>
      ) : (
        <Pressable
          onPress={onPress}
          accessibilityRole="button"
          accessibilityState={{ selected }}
          accessibilityLabel={`${isFolder ? 'Folder' : 'Document'} ${name}`}
          style={layout === 'grid' ? styles.cardMain : styles.listMain}
        >
          {mainContent}
        </Pressable>
      )}
      <View style={layout === 'grid' ? styles.cardMenuButton : styles.listMenuButton}>
        {menuButton}
      </View>
      {moving && <View style={styles.movingOverlay} pointerEvents="none" />}
    </View>
  );

  if (Platform.OS !== 'web') {
    return content;
  }

  // A raw host <div>, not a RN View — see the module doc above for why.
  // Double-click-to-open is handled entirely by the timestamp-based
  // useDoubleActivate hook the parent wires into onPress (see
  // LibraryGrid/LibraryList), not a native `dblclick` listener here — one
  // mechanism, so mouse and touch/tablet double-tap behave identically
  // (requirement #17) instead of racing two separate open triggers.
  return createElement(
    'div',
    { ref: domRef, 'data-testid': `library-entry-${libraryItemId(item)}` },
    content
  );
}

function RenameInput({
  value,
  onChangeText,
  onCommit,
  saving,
  style,
  theme,
}: {
  value: string;
  onChangeText: (text: string) => void;
  onCommit: () => void;
  saving: boolean;
  style: object;
  theme: Theme;
}) {
  return (
    <TextInput
      style={style}
      value={value}
      onChangeText={onChangeText}
      maxLength={MAX_FOLDER_NAME_LENGTH}
      autoFocus
      editable={!saving}
      onSubmitEditing={onCommit}
      onBlur={onCommit}
      returnKeyType="done"
      accessibilityLabel="Folder name"
      placeholderTextColor={theme.faint}
    />
  );
}

function buildGridStyles(theme: Theme) {
  return StyleSheet.create({
    card: {
      width: 148,
      minHeight: 128,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      borderRadius: theme.radius.md,
      padding: 12,
      alignItems: 'center',
      backgroundColor: theme.card,
      gap: 4,
    },
    selected: { borderColor: theme.accent, backgroundColor: theme.accentSoft },
    dragging: { opacity: 0.45 },
    dropValid: { borderColor: theme.accent, backgroundColor: theme.accentSoft, borderWidth: 2 },
    dropInvalid: { borderColor: theme.danger, backgroundColor: theme.dangerSoft },
    iconWrap: { height: 34, alignItems: 'center', justifyContent: 'center' },
    name: {
      fontSize: 13,
      color: theme.text,
      fontFamily: theme.fonts.bodySemibold,
      textAlign: 'center',
    },
    meta: { fontSize: 11, color: theme.subtext, fontFamily: theme.fonts.body, textAlign: 'center' },
    errorText: {
      fontSize: 10,
      color: theme.danger,
      fontFamily: theme.fonts.body,
      textAlign: 'center',
    },
    renameInputGrid: {
      width: '100%',
      color: theme.text,
      fontSize: 13,
      textAlign: 'center',
      paddingVertical: 2,
      backgroundColor: theme.background,
      borderRadius: theme.radius.sm,
      fontFamily: theme.fonts.body,
    },
    // A sibling of cardMenuButton, not its parent (see the module doc on
    // why a `<button>` can't contain another `<button>`) — absolute
    // positioning on cardMenuButton means this gets no unwanted gap from
    // it, since gap only applies to in-flow siblings.
    cardMain: { alignItems: 'center', gap: 4, width: '100%' },
    cardMenuButton: { position: 'absolute', top: 2, right: 2 },
    row: {},
    listMain: {},
    listName: {},
    listCell: {},
    listNameCell: {},
    listMenuButton: {},
    renameInputList: {},
    movingOverlay: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: theme.overlay,
      borderRadius: theme.radius.md,
      opacity: 0.35,
    },
  });
}

function buildListStyles(theme: Theme) {
  return StyleSheet.create({
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.divider,
      paddingVertical: 8,
      paddingHorizontal: 10,
      gap: 8,
    },
    selected: { backgroundColor: theme.accentSoft },
    dragging: { opacity: 0.45 },
    dropValid: { backgroundColor: theme.accentSoft, borderWidth: 1, borderColor: theme.accent },
    dropInvalid: { backgroundColor: theme.dangerSoft, borderWidth: 1, borderColor: theme.danger },
    // Sibling of listMenuButton, not its parent — see the module doc.
    listMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, minWidth: 0 },
    listNameCell: { flex: 3, flexDirection: 'row', alignItems: 'center', gap: 8, minWidth: 0 },
    listName: {
      fontSize: 13,
      color: theme.text,
      fontFamily: theme.fonts.bodySemibold,
      flexShrink: 1,
    },
    listCell: { flex: 1, fontSize: 12, color: theme.subtext, fontFamily: theme.fonts.body },
    listMenuButton: { flexShrink: 0 },
    renameInputList: {
      flex: 1,
      color: theme.text,
      fontSize: 13,
      paddingVertical: 4,
      paddingHorizontal: 6,
      backgroundColor: theme.background,
      borderRadius: theme.radius.sm,
      fontFamily: theme.fonts.body,
    },
    card: {},
    cardMain: {},
    iconWrap: {},
    name: {},
    meta: {},
    errorText: { fontSize: 10, color: theme.danger, fontFamily: theme.fonts.body },
    renameInputGrid: {},
    cardMenuButton: {},
    movingOverlay: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: theme.overlay,
      opacity: 0.25,
    },
  });
}
