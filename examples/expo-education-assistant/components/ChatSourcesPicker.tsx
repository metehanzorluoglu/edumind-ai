import { useFolderLibrary } from 'education-assistant-client';
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
import { Breadcrumbs } from '@/components/Breadcrumbs';
import { Button } from '@/components/ui/Button';
import { CheckIcon, CloseIcon, FolderIcon } from '@/components/icons';
import { useClient } from '@/lib/ClientProvider';
import { safeText } from '@/lib/format';
import { useTheme, type Theme } from '@/lib/Preferences';

const NARROW_BREAKPOINT_PX = 480;
const DESKTOP_PANEL_WIDTH_PX = 460;

/** The minimal, display-ready shape this picker needs for any selected
 * document — whether it came from GET .../documents (Milestone 2, no
 * `title`) or from browsing a folder (Milestone 1's DocumentSummary,
 * which has one). Keeping selection state in this one small shape (rather
 * than the two different backend response shapes) is what lets a document
 * selected in one folder stay displayable in the "Selected" summary even
 * after navigating away from the folder it lives in — see Milestone 3's
 * large-libraries requirement: selection must survive without re-fetching
 * every folder a selected document happens to be in. */
export interface PendingSourceDoc {
  documentId: string;
  displayName: string;
}

/**
 * Milestone 4 (Zoom-In / strict selected-source mode): 'prioritize' is
 * this picker's original Milestone 3 behavior (selected sources rank
 * first, ahead of project knowledge and the general library — never
 * exclusive). 'zoom-in' is the new explicit strict mode — retrieval draws
 * ONLY from the selected source(s), no project/general fallback at all
 * (see rag-backend's app/db/models_conversation_scope.py). Never inferred
 * from selection count; always the user's explicit choice via the toggle
 * below.
 */
export type SourceMode = 'prioritize' | 'zoom-in';

type SaveTarget =
  /** An already-persisted conversation — Save calls the real bulk-replace
   * endpoint directly (one HTTP request) and reports the server's own
   * resulting list back to the caller. */
  | { kind: 'conversation'; conversationId: string }
  /** Milestone 3 §7: a not-yet-created conversation (chat/new.tsx, before
   * the first message is sent) — there is no conversation_id to call the
   * API with yet. Save never touches the network here; it just reports
   * the locally-chosen full list back to the caller, which persists it
   * (one PUT, immediately after conversation creation, before the first
   * message's retrieval runs — see chat/new.tsx's handleAsk). */
  | { kind: 'pending' };

export interface ChatSourcesPickerProps {
  target: SaveTarget;
  /** The selection to preselect when the picker opens — the conversation's
   * current server-side selection (`target.kind === 'conversation'`) or
   * chat/new.tsx's own locally-held pending list (`target.kind ===
   * 'pending'`). Always authoritative over anything this picker itself
   * remembered from a previous open (see Milestone 3 §5: reopening must
   * reflect real state, not stale local memory). */
  initialSelection: PendingSourceDoc[];
  /** The mode to preselect when the picker opens — same "always
   * authoritative over stale local memory" rule as `initialSelection`.
   * Defaults to 'prioritize' if omitted (a not-yet-created conversation
   * with no prior mode choice). */
  initialMode?: SourceMode;
  /** Milestone 4: hides the mode toggle entirely (only 'prioritize'
   * selection remains available) when the `zoom_in_enabled` backend flag
   * is off — mirrors every other flag's "backend enforces, frontend only
   * hides" split. Defaults to true. */
  zoomInEnabled?: boolean;
  onClose: () => void;
  /**
   * Called once after a successful Save with the final selection and mode
   * — `target.kind === 'conversation'` calls this with the server's own
   * response (the definitive post-save state); `'pending'` calls this
   * with exactly the locally-chosen list/mode (there is no server
   * response to defer to yet).
   */
  onSaved: (selection: PendingSourceDoc[], mode: SourceMode) => void;
}

/**
 * Milestone 3 (Chat Scope / Add Sources): lets a user pick documents from
 * their existing Library (Milestone 1's folder architecture, via
 * useFolderLibrary — the exact same hook documents.tsx uses) to prioritize
 * for one conversation. Selection is local (a plain in-memory map) until
 * Save, which always issues exactly ONE bulk request regardless of how
 * many checkboxes changed — see PUT .../documents (Milestone 2's
 * replaceConversationDocuments), never one call per checkbox.
 *
 * Deliberately reuses useFolderLibrary directly rather than introducing a
 * second "browse documents" data source — folder navigation, breadcrumbs,
 * and pagination all come from the exact same place documents.tsx gets
 * them, so this picker can never drift from the Library's own real
 * structure.
 */
export function ChatSourcesPicker({
  target,
  initialSelection,
  initialMode = 'prioritize',
  zoomInEnabled = true,
  onClose,
  onSaved,
}: ChatSourcesPickerProps) {
  const theme = useTheme();
  const styles = useMemo(() => buildStyles(theme), [theme]);
  const { client } = useClient();
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const isNarrow = windowWidth < NARROW_BREAKPOINT_PX;

  const folderLibrary = useFolderLibrary(client);
  // documentId -> display info. A Map (not a bare Set<string>) so the
  // "Selected" summary can show a name for a document that isn't in the
  // currently-open folder (or was picked from a different folder
  // entirely) without any extra request — see PendingSourceDoc's docstring
  // and Milestone 3 §12 (large libraries: never fetch every folder
  // recursively just to label a selection).
  const [selected, setSelected] = useState<Map<string, PendingSourceDoc>>(
    () => new Map(initialSelection.map((doc) => [doc.documentId, doc]))
  );
  const [mode, setMode] = useState<SourceMode>(initialMode);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    folderLibrary.navigate(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  function toggleDocument(doc: PendingSourceDoc): void {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(doc.documentId)) {
        next.delete(doc.documentId);
      } else {
        next.set(doc.documentId, doc);
      }
      return next;
    });
  }

  function removeSelected(documentId: string): void {
    setSelected((prev) => {
      const next = new Map(prev);
      next.delete(documentId);
      return next;
    });
  }

  const isZoomIn = mode === 'zoom-in';
  // Milestone 4: Zoom-In requires >=1 selected source, enforced here (UI)
  // AND on the backend (PATCH .../scope 422s otherwise) — defense in
  // depth, and this client-side check avoids a doomed round trip.
  const zoomInNeedsASource = isZoomIn && selected.size === 0;

  async function handleSave(): Promise<void> {
    if (zoomInNeedsASource) return; // Save is disabled in this state; belt and suspenders.
    const finalSelection = Array.from(selected.values());
    if (target.kind === 'pending') {
      // Milestone 3 §7 / Milestone 4: no network here — chat/new.tsx
      // persists both the selection AND the mode together, in order,
      // after the conversation is actually created (see runFirstMessage).
      onSaved(finalSelection, mode);
      onClose();
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      // Milestone 4 "atomic-as-possible" save: the selection is persisted
      // first (one bulk PUT), then the mode (one PATCH) — never streamed/
      // saved in the other order, since a Zoom-In PATCH would otherwise
      // race the very selection it depends on (the backend's own >=1-
      // source check reads the CURRENT persisted selection). If the PATCH
      // fails after the PUT already succeeded, the selection is safely
      // saved server-side (idempotent to retry) and the error surfaces
      // here rather than silently misreporting the mode as saved.
      const response = await client.replaceConversationDocuments(
        target.conversationId,
        finalSelection.map((doc) => doc.documentId)
      );
      await client.updateConversationScope(target.conversationId, { zoomInMode: isZoomIn });
      onSaved(
        response.documents.map((doc) => ({
          documentId: doc.document_id,
          displayName: doc.source_filename,
        })),
        mode
      );
      onClose();
    } catch (error) {
      // Deliberately does NOT call onClose()/onSaved() — a failed save
      // must never look like a successful one (Milestone 3 §20: "server
      // error does not falsely display saved state"). The picker stays
      // open with the error shown and the user's local selection intact,
      // so Save can simply be pressed again.
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  const panelWidth = isNarrow ? windowWidth : Math.min(DESKTOP_PANEL_WIDTH_PX, windowWidth - 32);
  const panelMaxHeight = isNarrow ? windowHeight * 0.9 : Math.min(620, windowHeight - 64);
  const browseMaxHeight = Math.max(160, Math.min(320, windowHeight * 0.35));
  const selectedMaxHeight = Math.max(80, Math.min(160, windowHeight * 0.18));

  const contents = folderLibrary.contentsState;
  const selectedList = Array.from(selected.values());

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={[styles.overlay, isNarrow && styles.overlayBottom]}>
        <Pressable
          style={styles.backdrop}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close add sources dialog"
        />
        <View
          style={[
            styles.panel,
            isNarrow ? styles.panelSheet : styles.panelCentered,
            { width: panelWidth, maxHeight: panelMaxHeight },
          ]}
        >
          <View style={styles.header}>
            <Text style={styles.title}>Add sources</Text>
            <Pressable
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel="Close"
              hitSlop={8}
            >
              <CloseIcon size={16} color={theme.faint} />
            </Pressable>
          </View>
          {zoomInEnabled && (
            <View style={styles.modeRow} accessibilityRole="radiogroup">
              <Pressable
                style={[styles.modeChip, !isZoomIn && styles.modeChipActive]}
                onPress={() => setMode('prioritize')}
                accessibilityRole="radio"
                accessibilityState={{ checked: !isZoomIn }}
                accessibilityLabel="Prioritize — selected sources rank first, other sources still available"
              >
                <Text style={[styles.modeChipText, !isZoomIn && styles.modeChipTextActive]}>
                  Prioritize
                </Text>
              </Pressable>
              <Pressable
                style={[styles.modeChip, isZoomIn && styles.modeChipActive]}
                onPress={() => setMode('zoom-in')}
                accessibilityRole="radio"
                accessibilityState={{ checked: isZoomIn }}
                accessibilityLabel="Zoom-In — chat answers ONLY from the selected sources, nothing else"
              >
                <Text style={[styles.modeChipText, isZoomIn && styles.modeChipTextActive]}>
                  Zoom-In
                </Text>
              </Pressable>
            </View>
          )}
          <Text style={styles.subtitle}>
            {isZoomIn
              ? 'Zoom-In: chat answers ONLY using the sources selected below — no project knowledge, ' +
                'no general library, no fallback. Requires at least one source.'
              : 'Selected sources are prioritized for this conversation, ahead of your project ' +
                'knowledge and general library.'}
          </Text>

          <Breadcrumbs
            path={contents.status === 'success' ? contents.contents.breadcrumbs : []}
            onNavigate={folderLibrary.navigate}
          />

          <ScrollView style={[styles.browseList, { maxHeight: browseMaxHeight }]}>
            {contents.status === 'loading' && (
              <ActivityIndicator style={styles.spinner} color={theme.accent} />
            )}
            {contents.status === 'error' && (
              <Text style={styles.errorText}>{contents.error.message}</Text>
            )}
            {contents.status === 'success' && (
              <>
                {contents.contents.folders.length === 0 &&
                  contents.contents.documents.length === 0 && (
                    <Text style={styles.emptyText}>This folder is empty.</Text>
                  )}
                {contents.contents.folders.map((folder) => (
                  <Pressable
                    key={folder.id}
                    style={styles.folderRow}
                    onPress={() => folderLibrary.navigate(folder.id)}
                    accessibilityRole="button"
                    accessibilityLabel={`Open ${safeText(folder.name, 'folder')}`}
                  >
                    <FolderIcon size={16} color={theme.subtext} />
                    <Text style={styles.folderRowText} numberOfLines={1}>
                      {safeText(folder.name, 'Untitled folder')}
                    </Text>
                  </Pressable>
                ))}
                {contents.contents.documents.map((doc) => {
                  const displayName = safeText(doc.title, doc.source_filename);
                  const isChecked = selected.has(doc.document_id);
                  return (
                    <Pressable
                      key={doc.document_id}
                      style={styles.documentRow}
                      onPress={() => toggleDocument({ documentId: doc.document_id, displayName })}
                      accessibilityRole="checkbox"
                      accessibilityState={{ checked: isChecked }}
                      accessibilityLabel={`${isChecked ? 'Remove' : 'Add'} ${displayName}`}
                    >
                      <View
                        style={[
                          styles.checkbox,
                          {
                            backgroundColor: isChecked ? theme.accent : 'transparent',
                            borderColor: isChecked ? theme.accent : theme.border,
                          },
                        ]}
                      >
                        {isChecked && (
                          <CheckIcon size={11} color={theme.background} strokeWidth={2.5} />
                        )}
                      </View>
                      <Text style={styles.documentRowText} numberOfLines={1}>
                        {displayName}
                      </Text>
                    </Pressable>
                  );
                })}
              </>
            )}
          </ScrollView>

          <View style={styles.selectedHeader}>
            <Text style={styles.selectedTitle}>Selected ({selectedList.length})</Text>
          </View>
          {selectedList.length === 0 ? (
            <Text style={styles.emptyText}>
              {isZoomIn
                ? 'Select at least one source — Zoom-In has nothing to answer from otherwise.'
                : 'No sources selected — chat uses normal retrieval.'}
            </Text>
          ) : (
            <ScrollView style={[styles.selectedList, { maxHeight: selectedMaxHeight }]}>
              {selectedList.map((doc) => (
                <View key={doc.documentId} style={styles.selectedRow}>
                  <Text style={styles.selectedRowText} numberOfLines={1}>
                    {doc.displayName}
                  </Text>
                  <Pressable
                    onPress={() => removeSelected(doc.documentId)}
                    accessibilityRole="button"
                    accessibilityLabel={`Remove ${doc.displayName} from selection`}
                    hitSlop={8}
                  >
                    <CloseIcon size={13} color={theme.faint} />
                  </Pressable>
                </View>
              ))}
            </ScrollView>
          )}

          {zoomInNeedsASource && (
            <Text style={styles.errorText}>Zoom-In requires at least one selected source.</Text>
          )}
          {saveError && <Text style={styles.errorText}>{saveError}</Text>}

          <View style={styles.footer}>
            <Button label="Cancel" variant="ghost" size="sm" onPress={onClose} disabled={saving} />
            <Button
              label="Save"
              variant="primary"
              size="sm"
              onPress={handleSave}
              loading={saving}
              disabled={saving || zoomInNeedsASource}
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
    header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    title: { color: theme.text, fontSize: 15, fontFamily: theme.fonts.display },
    modeRow: { flexDirection: 'row', gap: 6 },
    modeChip: {
      paddingVertical: 5,
      paddingHorizontal: 10,
      borderRadius: theme.radius.sm,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      backgroundColor: 'transparent',
    },
    modeChipActive: { backgroundColor: theme.accent, borderColor: theme.accent },
    modeChipText: { color: theme.subtext, fontSize: 12, fontFamily: theme.fonts.bodySemibold },
    modeChipTextActive: { color: theme.background },
    subtitle: { color: theme.subtext, fontSize: 12, fontFamily: theme.fonts.body, lineHeight: 17 },
    spinner: { marginVertical: 12 },
    errorText: { color: theme.danger, fontSize: 12, fontFamily: theme.fonts.body },
    emptyText: {
      color: theme.faint,
      fontSize: 12,
      fontFamily: theme.fonts.body,
      paddingVertical: 6,
    },
    browseList: { borderRadius: theme.radius.md },
    folderRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingVertical: 8,
      minHeight: 36,
    },
    folderRowText: {
      color: theme.text,
      fontSize: 13,
      flex: 1,
      fontFamily: theme.fonts.bodySemibold,
    },
    documentRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingVertical: 8,
      minHeight: 36,
    },
    checkbox: {
      width: 16,
      height: 16,
      borderRadius: 4,
      borderWidth: StyleSheet.hairlineWidth * 2,
      alignItems: 'center',
      justifyContent: 'center',
    },
    documentRowText: { color: theme.text, fontSize: 13, flex: 1, fontFamily: theme.fonts.body },
    selectedHeader: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 },
    selectedTitle: { color: theme.subtext, fontSize: 12, fontFamily: theme.fonts.bodySemibold },
    selectedList: {},
    selectedRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingVertical: 6,
      gap: 8,
    },
    selectedRowText: { color: theme.text, fontSize: 12, flex: 1, fontFamily: theme.fonts.body },
    footer: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 4 },
  });
}
