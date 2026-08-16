import { useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { DocumentSummary, FolderResponse } from 'education-assistant-client';
import { LibraryEntry } from '@/components/documents/LibraryEntry';
import { ItemActionsMenu, type ItemAction } from '@/components/documents/ItemActionsMenu';
import {
  libraryItemId,
  toDocumentItems,
  toFolderItems,
  type LibraryItem,
} from '@/lib/libraryItems';
import { readSelectionModifiers, type UseLibrarySelectionResult } from '@/lib/useLibrarySelection';
import { useDoubleActivate } from '@/lib/useDoubleActivate';
import type { UseLibraryDnDResult } from '@/lib/useLibraryDnD';
import { useTheme, type Theme } from '@/lib/Preferences';

export interface LibraryContentsViewProps {
  layout: 'grid' | 'list';
  folders: readonly FolderResponse[];
  documents: readonly DocumentSummary[];
  selection: UseLibrarySelectionResult;
  dnd: UseLibraryDnDResult & {
    attachDragSource: (node: HTMLElement, itemId: string) => () => void;
    attachFolderDropTarget: (node: HTMLElement, folderId: string) => () => void;
  };
  onOpenFolder: (folderId: string) => void;
  /** Selects the document so the details panel (if open) shows it — the
   * lightweight "peek" action, distinct from onOpenDocument's full
   * navigation into the Reader. */
  onPreviewDocument: (doc: DocumentSummary) => void;
  /** Frontend Milestone 3 (Document Reader): navigates into the reader —
   * GET /documents/{id}/content now exists, so double-activating a
   * document opens it for reading, the same way double-activating a
   * folder opens it (see the `activate` double-activate wiring below).
   * Optional only for callers that don't want the reader entry point at
   * all (none today — kept optional so this component doesn't force it
   * on hypothetical future callers). */
  onOpenDocument?: (doc: DocumentSummary) => void;
  onRenameFolder: (folderId: string, name: string) => Promise<unknown>;
  onMoveItem: (item: LibraryItem) => void;
  onDeleteItem: (item: LibraryItem) => void;
  deletingIds: ReadonlySet<string>;
  /** Frontend Milestone 2 §12 — omitted entirely (action hidden) when the
   * conversation-scope feature flag is off, mirroring every other
   * flag-gated entry point in this app ("backend enforces, frontend only
   * hides"). Documents itself never touches conversation scope directly —
   * this only navigates to a new chat with a pending selection; the real
   * association is persisted by chat/new.tsx's own existing flow once a
   * conversation actually exists. */
  onUseInChat?: (doc: DocumentSummary) => void;
  /** Milestone 4 (Reference Library & Bibliographic Metadata Foundation)
   * Section 9 — the "Edit metadata" action, from a document's row/card
   * menu. Never re-uploads/re-chunks/re-embeds; see EditMetadataModal. */
  onEditMetadata: (doc: DocumentSummary) => void;
  /** Milestone 4.2 (Citation & BibTeX Foundation) Section 24 — opens the
   * compact Citation surface (style selector, formatted text, Copy
   * citation, Copy BibTeX). One extra row in the actions menu rather than
   * a nested submenu (Section 24: "avoid massive always-visible action
   * lists... put citation actions in a Citation submenu/popover"). */
  onCitation: (doc: DocumentSummary) => void;
}

/**
 * Frontend Milestone 1 (Finder-style Document Library) — renders the
 * currently-open folder's contents as either a grid or a list (same data,
 * same behavior, different layout — see LibraryEntry.tsx). Folders always
 * render before documents (requirement #14's sorting already groups them
 * that way — see lib/libraryItems.ts's sortLibraryContents).
 */
export function LibraryContentsView({
  layout,
  folders,
  documents,
  selection,
  dnd,
  onOpenFolder,
  onPreviewDocument,
  onOpenDocument,
  onRenameFolder,
  onMoveItem,
  onDeleteItem,
  deletingIds,
  onUseInChat,
  onEditMetadata,
  onCitation,
}: LibraryContentsViewProps) {
  const theme = useTheme();
  const styles = useMemo(() => buildStyles(theme), [theme]);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [menuItem, setMenuItem] = useState<LibraryItem | null>(null);

  const items = useMemo<LibraryItem[]>(
    () => [...toFolderItems(folders), ...toDocumentItems(documents)],
    [folders, documents]
  );
  const orderedIds = useMemo(() => items.map(libraryItemId), [items]);
  const itemsById = useMemo(() => {
    const map = new Map<string, LibraryItem>();
    items.forEach((item) => map.set(libraryItemId(item), item));
    return map;
  }, [items]);

  const activate = useDoubleActivate((id) => {
    const item = itemsById.get(id);
    if (!item) return;
    if (item.kind === 'folder') {
      onOpenFolder(item.data.id);
    } else if (onOpenDocument) {
      onOpenDocument(item.data);
    } else {
      onPreviewDocument(item.data);
    }
  });

  function handlePress(id: string, event: unknown): void {
    selection.selectItem(id, orderedIds, readSelectionModifiers(event));
    activate(id);
  }

  function actionsFor(item: LibraryItem): ItemAction[] {
    if (item.kind === 'folder') {
      return [
        { label: 'Open', onPress: () => act(() => onOpenFolder(item.data.id)) },
        { label: 'Rename', onPress: () => act(() => setRenamingId(item.data.id)) },
        { label: 'Move…', onPress: () => act(() => onMoveItem(item)) },
        {
          label: 'Delete',
          destructive: true,
          onPress: () => act(() => onDeleteItem(item)),
        },
      ];
    }
    return [
      // Frontend Milestone 3 (Document Reader): the primary action, same
      // position folders' own "Open" holds — GET /documents/{id}/content
      // makes this a real reader now, not just metadata.
      ...(onOpenDocument
        ? [{ label: 'Open', onPress: () => act(() => onOpenDocument(item.data)) }]
        : []),
      // Frontend Milestone 1.1: renamed from "Preview" — there is no
      // content/download endpoint, so this only ever opens the details
      // panel's metadata. "Preview" implied the user would see the actual
      // file, which was misleading (approved correction, see the M1.1
      // report's "Preview Wording" section).
      { label: 'View details', onPress: () => act(() => onPreviewDocument(item.data)) },
      { label: 'Edit metadata', onPress: () => act(() => onEditMetadata(item.data)) },
      { label: 'Citation…', onPress: () => act(() => onCitation(item.data)) },
      ...(onUseInChat
        ? [{ label: 'Use in chat', onPress: () => act(() => onUseInChat(item.data)) }]
        : []),
      { label: 'Move…', onPress: () => act(() => onMoveItem(item)) },
      { label: 'Delete', destructive: true, onPress: () => act(() => onDeleteItem(item)) },
    ];
  }

  function act(fn: () => void): void {
    setMenuItem(null);
    fn();
  }

  const entries = items.map((item) => {
    const id = libraryItemId(item);
    return (
      <LibraryEntry
        key={id}
        layout={layout}
        item={item}
        selected={selection.isSelected(id)}
        dragging={dnd.isBeingDragged(id)}
        moving={dnd.isMoving(id) || deletingIds.has(id)}
        dropState={item.kind === 'folder' ? dnd.dropVisualState(`folder:${id}`) : 'none'}
        onPress={(event) => handlePress(id, event)}
        onOpenMenu={() => setMenuItem(item)}
        renaming={renamingId === id}
        onCommitRename={async (name) => {
          await onRenameFolder(id, name);
          setRenamingId(null);
        }}
        onCancelRename={() => setRenamingId(null)}
        attachDragSource={(node) => dnd.attachDragSource(node, id)}
        attachDropTarget={
          item.kind === 'folder'
            ? (node) => dnd.attachFolderDropTarget(node, item.data.id)
            : undefined
        }
      />
    );
  });

  return (
    <View>
      {layout === 'list' && (
        <View testID="library-list-header" style={styles.listHeaderRow}>
          <Text style={[styles.listHeaderCell, styles.listHeaderName]}>Name</Text>
          <Text style={styles.listHeaderCell}>Type</Text>
          <Text style={styles.listHeaderCell}>Date modified</Text>
          <Text style={styles.listHeaderCell}>Size</Text>
          <View style={styles.listHeaderMenuSpacer} />
        </View>
      )}
      <View
        testID={layout === 'grid' ? 'library-grid' : 'library-list'}
        style={layout === 'grid' ? styles.gridWrap : styles.listBody}
      >
        {entries}
      </View>

      {menuItem && (
        <ItemActionsMenu
          item={menuItem}
          actions={actionsFor(menuItem)}
          onClose={() => setMenuItem(null)}
        />
      )}
    </View>
  );
}

function buildStyles(theme: Theme) {
  return StyleSheet.create({
    gridWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
    listBody: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      borderRadius: theme.radius.md,
      overflow: 'hidden',
      backgroundColor: theme.card,
    },
    listHeaderRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 6,
      paddingHorizontal: 10,
      gap: 8,
    },
    listHeaderCell: {
      flex: 1,
      fontSize: 11,
      color: theme.faint,
      fontFamily: theme.fonts.bodySemibold,
      textTransform: 'uppercase',
      letterSpacing: 0.3,
    },
    listHeaderName: { flex: 3 },
    listHeaderMenuSpacer: { width: 36 },
  });
}
