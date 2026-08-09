import type { FolderContentsResponse } from 'education-assistant-client';
import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { Button } from '@/components/ui/Button';
import { FolderIcon } from '@/components/icons';
import { useClient } from '@/lib/ClientProvider';
import { safeText } from '@/lib/format';
import { useTheme, type Theme } from '@/lib/Preferences';

const NARROW_BREAKPOINT_PX = 480;
const DESKTOP_PANEL_WIDTH_PX = 420;

export interface MoveToFolderDialogProps {
  /** e.g. `Move "notes.pdf"` or `Move "Research"`. */
  title: string;
  /** Excluded from the browsable tree (and its own "Move here" button) —
   * used when moving a folder, so it can never be moved into itself. Its
   * descendants are NOT filtered client-side (the backend's
   * CircularFolderReferenceError already rejects that with a clear error
   * — see routes_folders.py — so this is only the cheap, obvious case). */
  excludeFolderId?: string;
  onClose: () => void;
  onMove: (destinationFolderId: string | null) => Promise<unknown>;
}

/**
 * Milestone 1 (Document Library / Folder Management): lets the user browse
 * their own folder tree (independent of whatever folder the Documents page
 * itself currently has open) and pick a destination — reuses GET
 * /folders/contents (via client.getFolderContents) the exact same way the
 * main library view does, just with its own local navigation state, so
 * browsing inside this dialog never disturbs the page underneath it.
 */
export function MoveToFolderDialog({
  title,
  excludeFolderId,
  onClose,
  onMove,
}: MoveToFolderDialogProps) {
  const theme = useTheme();
  const styles = useMemo(() => buildStyles(theme), [theme]);
  const { client } = useClient();
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const isNarrow = windowWidth < NARROW_BREAKPOINT_PX;

  const [folderId, setFolderId] = useState<string | null>(null);
  const [contents, setContents] = useState<FolderContentsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);
  const [moveError, setMoveError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    client
      .getFolderContents({ folderId })
      .then((response) => {
        if (cancelled) return;
        setContents(response);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setLoadError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client, folderId]);

  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  async function handleMoveHere(): Promise<void> {
    setMoving(true);
    setMoveError(null);
    try {
      await onMove(folderId);
      onClose();
    } catch (error) {
      setMoveError(error instanceof Error ? error.message : String(error));
      setMoving(false);
    }
  }

  const panelWidth = isNarrow ? windowWidth : Math.min(DESKTOP_PANEL_WIDTH_PX, windowWidth - 32);
  const panelMaxHeight = isNarrow ? windowHeight * 0.85 : Math.min(520, windowHeight - 64);
  const folderListMaxHeight = Math.max(120, Math.min(260, windowHeight * 0.32));
  const visibleFolders = (contents?.folders ?? []).filter((f) => f.id !== excludeFolderId);
  const currentIsExcluded = folderId === excludeFolderId;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={[styles.overlay, isNarrow && styles.overlayBottom]}>
        <Pressable
          style={styles.backdrop}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close move dialog"
        />
        <View
          style={[
            styles.panel,
            isNarrow ? styles.panelSheet : styles.panelCentered,
            { width: panelWidth, maxHeight: panelMaxHeight },
          ]}
        >
          <Text style={styles.title} numberOfLines={2}>
            {title}
          </Text>
          <View style={styles.breadcrumbRow}>
            <Pressable onPress={() => setFolderId(null)} accessibilityRole="button">
              <Text style={[styles.breadcrumb, folderId === null && styles.breadcrumbCurrent]}>
                My Library
              </Text>
            </Pressable>
            {(contents?.breadcrumbs ?? []).map((crumb) => (
              <View key={crumb.id} style={styles.breadcrumbGroup}>
                <Text style={styles.breadcrumbSeparator}>›</Text>
                <Pressable onPress={() => setFolderId(crumb.id)} accessibilityRole="button">
                  <Text
                    style={[styles.breadcrumb, folderId === crumb.id && styles.breadcrumbCurrent]}
                  >
                    {crumb.name}
                  </Text>
                </Pressable>
              </View>
            ))}
          </View>

          {loading && <ActivityIndicator style={styles.spinner} color={theme.accent} />}
          {loadError && <Text style={styles.errorText}>{loadError}</Text>}

          {!loading && !loadError && (
            <ScrollView style={[styles.folderList, { maxHeight: folderListMaxHeight }]}>
              {visibleFolders.length === 0 && (
                <Text style={styles.emptyText}>No subfolders here.</Text>
              )}
              {visibleFolders.map((folder) => (
                <Pressable
                  key={folder.id}
                  style={styles.folderRow}
                  onPress={() => setFolderId(folder.id)}
                  accessibilityRole="button"
                  accessibilityLabel={`Open ${safeText(folder.name, 'folder')}`}
                >
                  <FolderIcon size={16} color={theme.subtext} />
                  <Text style={styles.folderRowText} numberOfLines={1}>
                    {safeText(folder.name, 'Untitled folder')}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
          )}

          {moveError && <Text style={styles.errorText}>{moveError}</Text>}

          <View style={styles.footer}>
            <Button label="Cancel" variant="ghost" size="sm" onPress={onClose} disabled={moving} />
            <Button
              label={folderId === null ? 'Move to My Library' : 'Move here'}
              variant="primary"
              size="sm"
              onPress={handleMoveHere}
              disabled={moving || currentIsExcluded}
              loading={moving}
            />
          </View>
        </View>
      </View>
    </Modal>
  );
}

function buildStyles(theme: Theme) {
  return StyleSheet.create({
    overlay: {
      ...StyleSheet.absoluteFillObject,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 30,
      elevation: 30,
    },
    overlayBottom: { alignItems: 'stretch', justifyContent: 'flex-end' },
    backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(20, 22, 31, 0.6)' },
    panel: { backgroundColor: theme.card, padding: 16, gap: 8 },
    panelCentered: { borderRadius: theme.radius.lg },
    panelSheet: { borderTopLeftRadius: theme.radius.lg, borderTopRightRadius: theme.radius.lg },
    title: { color: theme.text, fontSize: 14, fontFamily: theme.fonts.display },
    breadcrumbRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center' },
    breadcrumbGroup: { flexDirection: 'row', alignItems: 'center' },
    breadcrumb: { color: theme.subtext, fontSize: 12, fontFamily: theme.fonts.body },
    breadcrumbCurrent: { color: theme.text, fontFamily: theme.fonts.bodySemibold },
    breadcrumbSeparator: { color: theme.faint, fontSize: 12, marginHorizontal: 4 },
    spinner: { marginVertical: 12 },
    errorText: { color: theme.danger, fontSize: 12, fontFamily: theme.fonts.body },
    emptyText: {
      color: theme.faint,
      fontSize: 12,
      fontFamily: theme.fonts.body,
      paddingVertical: 8,
    },
    folderList: {},
    folderRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingVertical: 8,
      minHeight: 36,
    },
    folderRowText: { color: theme.text, fontSize: 13, flex: 1, fontFamily: theme.fonts.body },
    footer: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 4 },
  });
}
