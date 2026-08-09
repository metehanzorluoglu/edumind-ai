import type { FolderResponse } from 'education-assistant-client';
import { useState } from 'react';
import { Alert, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Button } from '@/components/ui/Button';
import { FolderIcon } from '@/components/icons';
import { safeText } from '@/lib/format';
import { useTheme, type Theme } from '@/lib/Preferences';

const MAX_FOLDER_NAME_LENGTH = 255;

export interface FolderRowProps {
  folder: FolderResponse;
  onOpen: (folderId: string) => void;
  onRename: (folderId: string, name: string) => Promise<unknown>;
  onMove: (folder: FolderResponse) => void;
  onDelete: (folder: FolderResponse) => void;
  deleting?: boolean;
}

/**
 * One folder row in the Milestone 1 (Document Library / Folder Management)
 * library view — name + direct-child counts, pressable to navigate in, plus
 * Rename (inline text input, mirrors ProjectRow's own rename-in-place
 * pattern)/Move/Delete actions. Deliberately three always-visible small
 * ghost buttons rather than a "..." popup menu: this screen has no
 * sidebar-style SidebarContextMenuContext wired up (that provider is
 * always-dark, tied to the sidebar's own theme — see ProjectRow.tsx), and
 * three buttons for a library view with typically a handful of folders per
 * level is not the "unnecessary desktop-style complexity" the milestone
 * warns against.
 */
export function FolderRow({
  folder,
  onOpen,
  onRename,
  onMove,
  onDelete,
  deleting,
}: FolderRowProps) {
  const theme = useTheme();
  const styles = buildStyles(theme);
  const [renaming, setRenaming] = useState(false);
  const [nameInput, setNameInput] = useState(folder.name);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function commitRename(): Promise<void> {
    const trimmed = nameInput.trim();
    if (!trimmed || trimmed === folder.name) {
      setRenaming(false);
      setNameInput(folder.name);
      return;
    }
    setSaving(true);
    setRenameError(null);
    try {
      await onRename(folder.id, trimmed);
      setRenaming(false);
    } catch (error) {
      setRenameError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  function handleDeletePress(): void {
    const label = safeText(folder.name, 'this folder');
    if (folder.folder_count === 0 && folder.document_count === 0) {
      const message = `Delete "${label}"? This cannot be undone.`;
      if (Platform.OS === 'web') {
        if (window.confirm(message)) onDelete(folder);
        return;
      }
      Alert.alert('Delete folder', message, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: () => onDelete(folder) },
      ]);
      return;
    }
    onDelete(folder);
  }

  if (renaming) {
    return (
      <View style={styles.row}>
        <FolderIcon size={18} color={theme.subtext} />
        <TextInput
          style={styles.renameInput}
          value={nameInput}
          onChangeText={setNameInput}
          maxLength={MAX_FOLDER_NAME_LENGTH}
          autoFocus
          editable={!saving}
          onSubmitEditing={commitRename}
          onBlur={commitRename}
          returnKeyType="done"
          accessibilityLabel="Folder name"
        />
        {renameError && <Text style={styles.errorText}>{renameError}</Text>}
      </View>
    );
  }

  return (
    <View style={styles.row}>
      <Pressable
        style={styles.main}
        onPress={() => onOpen(folder.id)}
        accessibilityRole="button"
        accessibilityLabel={`Open ${safeText(folder.name, 'folder')}`}
      >
        <FolderIcon size={18} color={theme.subtext} />
        <View style={styles.mainText}>
          <Text style={styles.name} numberOfLines={1}>
            {safeText(folder.name, 'Untitled folder')}
          </Text>
          <Text style={styles.meta}>
            {folder.folder_count} folder{folder.folder_count === 1 ? '' : 's'} ·{' '}
            {folder.document_count} document{folder.document_count === 1 ? '' : 's'}
          </Text>
        </View>
      </Pressable>
      <View style={styles.actions}>
        <Button
          label="Rename"
          variant="ghost"
          size="sm"
          onPress={() => setRenaming(true)}
          disabled={deleting}
          accessibilityLabel={`Rename ${safeText(folder.name, 'folder')}`}
        />
        <Button
          label="Move"
          variant="ghost"
          size="sm"
          onPress={() => onMove(folder)}
          disabled={deleting}
          accessibilityLabel={`Move ${safeText(folder.name, 'folder')}`}
        />
        <Button
          label="Delete"
          variant="dangerGhost"
          size="sm"
          onPress={handleDeletePress}
          disabled={deleting}
          loading={deleting}
          accessibilityLabel={`Delete ${safeText(folder.name, 'folder')}`}
        />
      </View>
    </View>
  );
}

function buildStyles(theme: Theme) {
  return StyleSheet.create({
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      borderRadius: theme.radius.md,
      padding: 10,
      marginTop: 6,
      backgroundColor: theme.card,
      gap: 8,
    },
    main: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, minWidth: 0 },
    mainText: { flex: 1, minWidth: 0 },
    name: { fontSize: 14, color: theme.text, fontFamily: theme.fonts.bodySemibold },
    meta: { fontSize: 12, color: theme.subtext, marginTop: 2, fontFamily: theme.fonts.body },
    actions: { flexDirection: 'row', flexShrink: 0 },
    renameInput: {
      flex: 1,
      color: theme.text,
      fontSize: 14,
      paddingVertical: 6,
      paddingHorizontal: 8,
      backgroundColor: theme.background,
      borderRadius: theme.radius.sm,
      minHeight: 36,
      fontFamily: theme.fonts.body,
    },
    errorText: { color: theme.danger, fontSize: 11, fontFamily: theme.fonts.body },
  });
}
