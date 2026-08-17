import type { WritingProjectFileNode, WritingProjectFileTree } from 'education-assistant-client';
import { useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import {
  ChevronIcon,
  FileIcon,
  FolderIcon,
  MoreIcon,
  PlusIcon,
  UploadIcon,
} from '@/components/icons';
import { ActionSheet, type ActionSheetItem } from '@/components/ui/ActionSheet';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Notice } from '@/components/ui/Notice';
import { TextField } from '@/components/ui/TextField';
import { useTheme, type Theme } from '@/lib/Preferences';

interface TreeRow {
  node: WritingProjectFileNode;
  depth: number;
}

/** Milestone 5.3 Part 4/41 — flattens the tree into a depth-first,
 * folders-before-files, alphabetical row list honoring `expanded`, so
 * the FlatList-free render below stays a single flat map (no recursion
 * cost at render time beyond this one pass — trivial at the 150-file
 * ceiling this milestone bounds a project to). */
function flatten(
  nodes: WritingProjectFileNode[],
  parentId: string | null,
  depth: number,
  expanded: Set<string>
): TreeRow[] {
  const children = nodes
    .filter((n) => n.parent_id === parentId)
    .sort((a, b) => {
      if (a.kind === 'folder' && b.kind !== 'folder') return -1;
      if (a.kind !== 'folder' && b.kind === 'folder') return 1;
      return a.name.localeCompare(b.name);
    });
  const rows: TreeRow[] = [];
  for (const node of children) {
    rows.push({ node, depth });
    if (node.kind === 'folder' && expanded.has(node.id)) {
      rows.push(...flatten(nodes, node.id, depth + 1, expanded));
    }
  }
  return rows;
}

export interface WritingFileTreeProps {
  tree: WritingProjectFileTree | null;
  loading: boolean;
  loadError: string | null;
  activeFileId: string | null;
  onSelectFile: (node: WritingProjectFileNode) => void;
  onSelectGenerated: () => void;
  onCreateFolder: (parentId: string | null, name: string) => Promise<unknown>;
  onCreateTextFile: (parentId: string | null, name: string) => Promise<unknown>;
  onUpload: (parentId: string | null) => void;
  onRename: (fileId: string, name: string) => Promise<unknown>;
  onMove: (fileId: string, newParentId: string | null) => Promise<unknown>;
  onDelete: (fileId: string) => Promise<unknown>;
  onSetRoot: (fileId: string) => Promise<unknown>;
}

type PendingForm =
  | { kind: 'create-folder'; parentId: string | null }
  | { kind: 'create-file'; parentId: string | null }
  | { kind: 'rename'; fileId: string; initial: string }
  | { kind: 'move'; fileId: string; currentParentId: string | null };

/**
 * Milestone 5.3 (LaTeX Project Workspace & File Management) Part 4 — the
 * project file tree: expand/collapse, select/open, create file/folder,
 * upload, rename, move (via a menu-driven destination picker — Part 8's
 * "always provide menu fallback"; no drag-and-drop implementation in
 * this milestone, reported as DEFERRED_WITH_REASON in the final report),
 * delete, and "Set as root". `references.bib` always renders last,
 * pinned, never draggable/renameable/deletable (Part 3).
 */
export function WritingFileTree({
  tree,
  loading,
  loadError,
  activeFileId,
  onSelectFile,
  onSelectGenerated,
  onCreateFolder,
  onCreateTextFile,
  onUpload,
  onRename,
  onMove,
  onDelete,
  onSetRoot,
}: WritingFileTreeProps) {
  const theme = useTheme();
  const styles = useMemo(() => buildStyles(theme), [theme]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [menuFileId, setMenuFileId] = useState<string | null>(null);
  const [pendingForm, setPendingForm] = useState<PendingForm | null>(null);
  const [formValue, setFormValue] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [formBusy, setFormBusy] = useState(false);
  const [rowError, setRowError] = useState<string | null>(null);
  const menuAnchorRef = useRef<View>(null);

  const rows = tree ? flatten(tree.files, null, 0, expanded) : [];

  function toggleExpanded(folderId: string): void {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      return next;
    });
  }

  function openMenu(fileId: string): void {
    setRowError(null);
    setMenuFileId(fileId);
  }

  function startForm(form: PendingForm): void {
    setMenuFileId(null);
    setFormError(null);
    setFormValue(form.kind === 'rename' ? form.initial : '');
    setPendingForm(form);
  }

  function cancelForm(): void {
    setPendingForm(null);
    setFormValue('');
    setFormError(null);
  }

  async function submitForm(): Promise<void> {
    if (!pendingForm || formBusy) return;
    const name = formValue.trim();
    if (!name) return;
    setFormBusy(true);
    setFormError(null);
    try {
      if (pendingForm.kind === 'create-folder') {
        await onCreateFolder(pendingForm.parentId, name);
        if (pendingForm.parentId) setExpanded((prev) => new Set(prev).add(pendingForm.parentId!));
      } else if (pendingForm.kind === 'create-file') {
        await onCreateTextFile(pendingForm.parentId, name);
        if (pendingForm.parentId) setExpanded((prev) => new Set(prev).add(pendingForm.parentId!));
      } else if (pendingForm.kind === 'rename') {
        await onRename(pendingForm.fileId, name);
      }
      cancelForm();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'That name could not be used.');
    } finally {
      setFormBusy(false);
    }
  }

  async function handleDelete(node: WritingProjectFileNode): Promise<void> {
    setMenuFileId(null);
    setRowError(null);
    try {
      await onDelete(node.id);
    } catch (error) {
      setRowError(error instanceof Error ? error.message : `Could not delete "${node.name}".`);
    }
  }

  async function handleSetRoot(node: WritingProjectFileNode): Promise<void> {
    setMenuFileId(null);
    setRowError(null);
    try {
      await onSetRoot(node.id);
    } catch (error) {
      setRowError(
        error instanceof Error ? error.message : 'Could not set this file as the root document.'
      );
    }
  }

  function menuItemsFor(node: WritingProjectFileNode): ActionSheetItem[] {
    const items: ActionSheetItem[] = [];
    if (node.kind === 'folder') {
      items.push({
        key: 'new-file',
        label: 'New file here',
        onPress: () => startForm({ kind: 'create-file', parentId: node.id }),
      });
      items.push({
        key: 'new-folder',
        label: 'New folder here',
        onPress: () => startForm({ kind: 'create-folder', parentId: node.id }),
      });
      items.push({
        key: 'upload',
        label: 'Upload file here',
        onPress: () => {
          setMenuFileId(null);
          onUpload(node.id);
        },
      });
    }
    items.push({
      key: 'rename',
      label: 'Rename',
      onPress: () => startForm({ kind: 'rename', fileId: node.id, initial: node.name }),
    });
    items.push({
      key: 'move',
      label: 'Move…',
      onPress: () => startForm({ kind: 'move', fileId: node.id, currentParentId: node.parent_id }),
    });
    if (node.kind === 'text' && node.name.toLowerCase().endsWith('.tex') && !node.is_root) {
      items.push({
        key: 'set-root',
        label: 'Set as root document',
        onPress: () => void handleSetRoot(node),
      });
    }
    items.push({
      key: 'delete',
      label: node.is_root ? 'Delete (root file — reassign root first)' : 'Delete',
      destructive: true,
      disabled: node.is_root,
      onPress: () => void handleDelete(node),
    });
    return items;
  }

  const menuNode = tree?.files.find((f) => f.id === menuFileId) ?? null;

  return (
    <View style={styles.container}>
      <View style={styles.toolbar}>
        <Text style={styles.sectionLabel}>Project files</Text>
        <View style={styles.toolbarActions}>
          <IconButton
            label="New file"
            icon={<PlusIcon size={14} color={theme.subtext} />}
            size="sm"
            variant="ghost"
            onPress={() => startForm({ kind: 'create-file', parentId: null })}
          />
          <IconButton
            label="New folder"
            icon={<FolderIcon size={14} color={theme.subtext} />}
            size="sm"
            variant="ghost"
            onPress={() => startForm({ kind: 'create-folder', parentId: null })}
          />
          <IconButton
            label="Upload file"
            icon={<UploadIcon size={14} color={theme.subtext} />}
            size="sm"
            variant="ghost"
            onPress={() => onUpload(null)}
          />
        </View>
      </View>

      {tree && (
        <Text style={styles.usage}>
          {tree.file_count} / {tree.max_files} files
        </Text>
      )}

      {loading && !tree && <ActivityIndicator style={styles.spinner} color={theme.accent} />}
      {loadError && <Notice tone="danger" body={loadError} />}
      {rowError && <Notice tone="danger" body={rowError} />}

      {pendingForm &&
        (pendingForm.kind === 'create-folder' ||
          pendingForm.kind === 'create-file' ||
          pendingForm.kind === 'rename') && (
          <View style={styles.inlineForm}>
            <TextField
              label={
                pendingForm.kind === 'create-folder'
                  ? 'New folder name'
                  : pendingForm.kind === 'create-file'
                    ? 'New file name (.tex)'
                    : 'New name'
              }
              value={formValue}
              onChangeText={setFormValue}
              autoFocus
              editable={!formBusy}
              onSubmitEditing={() => void submitForm()}
              returnKeyType="done"
            />
            {formError && <Notice tone="danger" body={formError} />}
            <View style={styles.inlineFormActions}>
              <Button
                label="Cancel"
                variant="ghost"
                size="sm"
                disabled={formBusy}
                onPress={cancelForm}
              />
              <Button
                label={formBusy ? 'Saving…' : 'Save'}
                variant="primary"
                size="sm"
                loading={formBusy}
                disabled={!formValue.trim()}
                onPress={() => void submitForm()}
              />
            </View>
          </View>
        )}

      {pendingForm?.kind === 'move' && tree && (
        <MoveFilePicker
          tree={tree}
          fileId={pendingForm.fileId}
          currentParentId={pendingForm.currentParentId}
          busy={formBusy}
          error={formError}
          onCancel={cancelForm}
          onConfirm={async (newParentId) => {
            setFormBusy(true);
            setFormError(null);
            try {
              await onMove(pendingForm.fileId, newParentId);
              cancelForm();
            } catch (error) {
              setFormError(error instanceof Error ? error.message : 'Could not move this item.');
            } finally {
              setFormBusy(false);
            }
          }}
        />
      )}

      {/* Milestone 5.5.3 — real-browser testing with the actual UNLV
          fixture (14 files) found this tree had no scroll boundary of
          its own at all: `container` below never set `flex: 1`, so the
          tree just grew to its full content height, pushing everything
          below it (and eventually the whole workspace) taller than the
          viewport instead of scrolling internally. Only the ROWS region
          scrolls — the toolbar/usage/inline-form/move-picker above stay
          always visible, matching "Research controls / Project Files
          controls / -- scrollable file tree --". */}
      <ScrollView style={styles.rowsScroll} contentContainerStyle={styles.rowsScrollContent}>
        {rows.map(({ node, depth }) => {
          const isActive = node.id === activeFileId;
          return (
            <View key={node.id} style={[styles.row, { paddingLeft: 8 + depth * 16 }]}>
              {node.kind === 'folder' ? (
                <Pressable
                  onPress={() => toggleExpanded(node.id)}
                  accessibilityRole="button"
                  accessibilityLabel={`Folder ${node.name}, ${expanded.has(node.id) ? 'expanded' : 'collapsed'}`}
                  style={styles.rowMain}
                  hitSlop={4}
                >
                  <ChevronIcon
                    size={10}
                    color={theme.faint}
                    style={{ transform: [{ rotate: expanded.has(node.id) ? '90deg' : '0deg' }] }}
                  />
                  <FolderIcon size={14} color={theme.subtext} />
                  <Text style={styles.rowLabel} numberOfLines={1}>
                    {node.name}
                  </Text>
                </Pressable>
              ) : (
                <Pressable
                  onPress={() => onSelectFile(node)}
                  accessibilityRole="button"
                  accessibilityLabel={`${node.kind === 'binary' ? 'Asset' : 'File'} ${node.name}${node.is_root ? ', root document' : ''}${isActive ? ', open' : ''}`}
                  style={[styles.rowMain, isActive && styles.rowMainActive]}
                  hitSlop={4}
                >
                  <FileIcon size={14} color={isActive ? theme.accent : theme.subtext} />
                  <Text
                    style={[styles.rowLabel, isActive && { color: theme.accent }]}
                    numberOfLines={1}
                  >
                    {node.name}
                  </Text>
                  {node.is_root && <Badge label="MAIN" tone="ok" />}
                </Pressable>
              )}
              <View ref={node.id === menuFileId ? menuAnchorRef : undefined}>
                <IconButton
                  label={`${node.name} options`}
                  icon={<MoreIcon size={14} color={theme.faint} />}
                  size="sm"
                  variant="ghost"
                  onPress={() => openMenu(node.id)}
                />
              </View>
            </View>
          );
        })}

        {tree?.generated.map((g) => (
          <View key={g.path} style={styles.row}>
            <Pressable
              onPress={onSelectGenerated}
              accessibilityRole="button"
              accessibilityLabel={`Generated file ${g.name}, read only`}
              style={styles.rowMain}
              hitSlop={4}
            >
              <FileIcon size={14} color={theme.faint} />
              <Text style={[styles.rowLabel, { color: theme.faint }]} numberOfLines={1}>
                {g.name}
              </Text>
              <Badge label="GENERATED" tone="neutral" />
            </Pressable>
          </View>
        ))}
      </ScrollView>

      <ActionSheet
        visible={menuFileId !== null}
        title={menuNode?.name}
        items={menuNode ? menuItemsFor(menuNode) : []}
        onDismiss={() => setMenuFileId(null)}
        anchorRef={menuAnchorRef}
      />
    </View>
  );
}

function MoveFilePicker({
  tree,
  fileId,
  currentParentId,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  tree: WritingProjectFileTree;
  fileId: string;
  currentParentId: string | null;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: (newParentId: string | null) => void;
}) {
  const theme = useTheme();
  const styles = useMemo(() => buildStyles(theme), [theme]);

  // Part 8 — a folder can never be moved into itself or its own
  // descendant; excludes the file itself and (if it's a folder) every
  // folder below it from the destination list. The backend enforces
  // this too (release-critical, never trust the client alone) — this is
  // purely so the picker never offers an obviously-illegal destination.
  function isDescendantOrSelf(candidateId: string): boolean {
    if (candidateId === fileId) return true;
    let cursor = tree.files.find((f) => f.id === candidateId);
    while (cursor?.parent_id) {
      if (cursor.parent_id === fileId) return true;
      cursor = tree.files.find((f) => f.id === cursor!.parent_id);
    }
    return false;
  }

  const folders = tree.files.filter((f) => f.kind === 'folder' && !isDescendantOrSelf(f.id));

  return (
    <View style={styles.inlineForm}>
      <Text style={styles.sectionLabel}>Move to…</Text>
      {error && <Notice tone="danger" body={error} />}
      <Pressable
        onPress={() => onConfirm(null)}
        disabled={busy || currentParentId === null}
        accessibilityRole="button"
        accessibilityLabel="Move to project root"
        style={styles.moveOption}
      >
        <Text style={styles.rowLabel}>Project root</Text>
      </Pressable>
      {folders.map((folder) => (
        <Pressable
          key={folder.id}
          onPress={() => onConfirm(folder.id)}
          disabled={busy || currentParentId === folder.id}
          accessibilityRole="button"
          accessibilityLabel={`Move to ${folder.path}`}
          style={styles.moveOption}
        >
          <Text style={styles.rowLabel}>{folder.path}</Text>
        </Pressable>
      ))}
      <View style={styles.inlineFormActions}>
        <Button label="Cancel" variant="ghost" size="sm" disabled={busy} onPress={onCancel} />
      </View>
    </View>
  );
}

function buildStyles(theme: Theme) {
  return StyleSheet.create({
    // Milestone 5.5.3 — `flex: 1, minHeight: 0` is what actually lets
    // `rowsScroll` below claim "whatever height this component's OWN
    // parent gives it" instead of growing to fit content — the classic
    // "flex child + missing minHeight: 0" gap (a flex item's default
    // min-height is `auto`, i.e. "at least as tall as my content,"
    // which silently defeats a `flex: 1` sibling's own attempt to
    // shrink it). WritingFileTree's parent (the Research panel's
    // "project" tab body in [id].tsx) already has its own `flex: 1`, so
    // this is the one missing link in that chain.
    container: { flex: 1, minHeight: 0, gap: 6 },
    rowsScroll: { flex: 1, minHeight: 0 },
    rowsScrollContent: { gap: 0 },
    toolbar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    toolbarActions: { flexDirection: 'row', gap: 2 },
    sectionLabel: {
      fontSize: 11,
      fontFamily: theme.fonts.bodySemibold,
      color: theme.faint,
      textTransform: 'uppercase',
      letterSpacing: 0.4,
    },
    usage: { fontSize: 10.5, fontFamily: theme.fonts.body, color: theme.faint },
    spinner: { marginTop: 12 },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingVertical: 6,
      paddingRight: 4,
      borderRadius: theme.radius.sm,
    },
    rowMain: { flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1, paddingVertical: 2 },
    rowMainActive: {},
    rowLabel: { fontSize: 12.5, fontFamily: theme.fonts.mono, color: theme.text, flexShrink: 1 },
    inlineForm: {
      gap: 8,
      padding: 10,
      borderRadius: theme.radius.md,
      backgroundColor: theme.cardPressed,
    },
    inlineFormActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8 },
    moveOption: { paddingVertical: 8, paddingHorizontal: 4, borderRadius: theme.radius.sm },
  });
}
