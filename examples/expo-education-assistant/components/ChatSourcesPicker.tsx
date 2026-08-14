import { useFolderLibrary, type ConversationProjectRef } from 'education-assistant-client';
import { useRouter } from 'expo-router';
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
import { EmptyState } from '@/components/ui/EmptyState';
import { TextField } from '@/components/ui/TextField';
import { CheckIcon, CloseIcon, FileIcon, FolderIcon } from '@/components/icons';
import { SortMenu } from '@/components/documents/SortMenu';
import {
  sortLibraryContents,
  type LibrarySortDirection,
  type LibrarySortKey,
} from '@/lib/libraryItems';
import { useClient } from '@/lib/ClientProvider';
import { safeText } from '@/lib/format';
import { useTheme, type Theme } from '@/lib/Preferences';

const NARROW_BREAKPOINT_PX = 480;
const DESKTOP_PANEL_WIDTH_PX = 760;

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
  /**
   * Frontend Milestone 2.1: the conversation's AUTHORITATIVE project
   * membership — `ConversationDetail.projects` (see GET /conversations/
   * {id}), never inferred from the conversation-scope `project_enabled`
   * toggle (that flag defaults true for every conversation, project or
   * not — see modeCopy's own history for the truthfulness bug this
   * replaces). `null` means "not yet known" (still loading, or the
   * conversation fetch failed) — treated the same as "no project" for
   * copy purposes, since inventing membership on a guess would be worse
   * than a brief, always-honest delay before the project-aware wording
   * appears (see requirement #23). Always `[]` for a not-yet-created
   * conversation (chat/new.tsx) — a conversation can't belong to a
   * project before it exists; association only ever happens afterward,
   * through the existing "Add to project" sidebar action. Always a list:
   * ProjectConversation is a genuine many-to-many association, so a
   * conversation can belong to more than one project.
   */
  projectContext?: ConversationProjectRef[] | null;
  /**
   * Frontend Milestone 2.1: the conversation's real chat/project/general
   * retrieval-tier toggles (`ConversationScopeResponse`, minus
   * `zoom_in_mode` — the mode radio above already represents that
   * separately). Omitted (or any field omitted) defaults to `true` for
   * that tier, matching the backend's own column defaults for a
   * conversation whose scope has never been touched — see
   * app/db/models_conversation_scope.py. There is currently no product
   * UI that sets these to non-default values (see this milestone's
   * report §11/§12); they're only reachable via a direct PATCH
   * .../scope API call, but the copy below reads them for real rather
   * than assuming defaults, so it stays truthful if that ever happens.
   */
  scope?: { chatEnabled?: boolean; projectEnabled?: boolean; generalEnabled?: boolean };
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

/** Zoom-In's copy never varies — it's unconditionally true regardless of
 * project membership, selection count, or any scope-tier toggle: Zoom-In
 * mode itself overrides everything else off (see
 * app/db/models_conversation_scope.py's zoom_in_mode docstring). */
const ZOOM_IN_COPY = 'Answer only from the selected sources.';

export interface PrioritizeScopeInput {
  /** The CURRENT in-progress selection count (live, not the persisted
   * one) — the card previews what Prioritize would do with what's
   * selected right now, updating as the user checks/unchecks tiles. */
  selectedCount: number;
  /** Whether the chat tier (the user's own selected sources) is actually
   * queried in Prioritize mode. Always true in every reachable product
   * state today — see ChatSourcesPickerProps.scope's docstring — but
   * read for real rather than assumed. */
  chatEnabled: boolean;
  /** True only when the conversation is BOTH actually in >=1 project
   * (authoritative membership, never inferred) AND the project tier
   * isn't turned off. Project knowledge that exists but is toggled off
   * must never be described as available. */
  projectAvailable: boolean;
  generalEnabled: boolean;
}

/**
 * Frontend Milestone 2.1: truthful Prioritize-mode copy, composed from the
 * conversation's REAL effective scope rather than a single always-on
 * `project_enabled` toggle (see Frontend Milestone 2's own report for the
 * gap this replaces). Every sentence below only claims a tier is
 * available when it actually is — never "project knowledge" for a
 * conversation that isn't in any project, never "broaden to your
 * library" when the general tier is off, and never "use these sources
 * first" when there are none selected or the chat tier itself is off.
 */
export function prioritizeModeCopy({
  selectedCount,
  chatEnabled,
  projectAvailable,
  generalEnabled,
}: PrioritizeScopeInput): string {
  const usingSelected = selectedCount > 0 && chatEnabled;

  if (usingSelected) {
    if (projectAvailable && generalEnabled) {
      return 'Use these sources first, then broaden to project knowledge and other available library knowledge when useful.';
    }
    if (projectAvailable) {
      return 'Use these sources first, then broaden to project knowledge when useful.';
    }
    if (generalEnabled) {
      return 'Use these sources first, then broaden to other available library knowledge when useful.';
    }
    return 'Use only these selected sources — broader search is currently turned off for this chat.';
  }

  if (selectedCount > 0 && !chatEnabled) {
    // Pathological / not reachable through any shipped product UI today
    // (chat_enabled can only become false via a direct PATCH .../scope
    // API call) — handled for truthfulness, not because real users can
    // get here. See this milestone's report §11/§12.
    if (projectAvailable && generalEnabled) {
      return "Your selected sources aren't currently included in this chat's search. Using project knowledge and your available library knowledge instead.";
    }
    if (projectAvailable) {
      return "Your selected sources aren't currently included in this chat's search. Using project knowledge instead.";
    }
    if (generalEnabled) {
      return "Your selected sources aren't currently included in this chat's search. Using your available library knowledge instead.";
    }
    return "Your selected sources aren't currently included in this chat's search, and no other retrieval sources are enabled for this chat.";
  }

  // selectedCount === 0 — never claim "use these sources first" when
  // there is nothing selected (requirement #6).
  if (projectAvailable && generalEnabled) {
    return 'Use project knowledge and your available library knowledge.';
  }
  if (projectAvailable) {
    return 'Use project knowledge.';
  }
  if (generalEnabled) {
    return 'Use your available library knowledge.';
  }
  return 'No sources selected, and broader search is currently turned off for this chat — add sources to get an answer.';
}

/** "AI Literacy Study" / "AI Literacy Study and Reading Group" / "AI
 * Literacy Study, Reading Group +1 more" — never silently drops a
 * membership down to an arbitrary "first" project; an overflow past two
 * names is always labeled as an overflow, and the full list is always in
 * the accessible label (see the project-context row below), never lossy
 * for screen-reader users even when the count is truncated on screen. */
export function describeProjectNames(names: string[]): string {
  if (names.length === 0) return '';
  if (names.length === 1) return names[0]!;
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names[0]}, ${names[1]} +${names.length - 2} more`;
}

/**
 * Frontend Milestone 2 (Chat Sources & Zoom-In Workspace UX): a knowledge-
 * workspace-grade evolution of Milestone 3's original small utility modal
 * — same underlying architecture (useFolderLibrary, one bulk save,
 * client/server selection shapes unified into PendingSourceDoc), a wider
 * "workspace" surface visually consistent with the Documents library
 * (folder breadcrumbs, file-type icons, a compact Sort trigger reused
 * directly from Documents' own SortMenu). Deliberately does NOT reuse
 * Documents' LibraryEntry/LibraryContentsView components — this picker's
 * responsibilities (toggle a source on/off) are narrower than the
 * library's (drag, rename, move, delete — see requirement #24: "Source
 * picker is for choosing sources, not managing the library"), so sharing
 * only the low-level pieces (icons, Breadcrumbs, sort primitives) keeps
 * each surface's own concerns separate.
 */
export function ChatSourcesPicker({
  target,
  initialSelection,
  initialMode = 'prioritize',
  zoomInEnabled = true,
  projectContext = [],
  scope,
  onClose,
  onSaved,
}: ChatSourcesPickerProps) {
  const theme = useTheme();
  const styles = useMemo(() => buildStyles(theme), [theme]);
  const { client } = useClient();
  const router = useRouter();
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
  const [filterText, setFilterText] = useState('');
  const [sortKey, setSortKey] = useState<LibrarySortKey>('name');
  const [sortDirection, setSortDirection] = useState<LibrarySortDirection>('asc');
  const [sortMenuOpen, setSortMenuOpen] = useState(false);

  useEffect(() => {
    folderLibrary.navigate(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Clears the folder-local filter on navigation — a filter that silently
  // kept applying after opening a different folder (and, worse, hiding
  // everything in it because the text no longer matches anything there)
  // would read as a bug, not a feature.
  useEffect(() => {
    setFilterText('');
  }, [folderLibrary.currentFolderId]);

  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  // Frontend/Platform Milestone 3.2.2 Part D — reverses Milestone 2
  // requirement #6's original "never silently fall back" rule: the PO
  // found the old last-source guard was just friction, not a useful
  // safeguard. Removing the last selected source while in Zoom-In now
  // auto-switches `mode` back to 'prioritize' in the SAME state update
  // that empties the selection — never a moment where `mode==='zoom-in'`
  // and the selection is empty, so the backend invariant (zoom_in_mode
  // requires >=1 document) is upheld by construction, not by disabling
  // the remove action. See zoomInNeedsASource below for why it's kept
  // anyway, as a belt-and-suspenders guard on Save.
  function toggleDocument(doc: PendingSourceDoc): void {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(doc.documentId)) {
        next.delete(doc.documentId);
      } else {
        next.set(doc.documentId, doc);
      }
      if (next.size === 0 && mode === 'zoom-in') setMode('prioritize');
      return next;
    });
  }

  function removeSelected(documentId: string): void {
    setSelected((prev) => {
      const next = new Map(prev);
      next.delete(documentId);
      if (next.size === 0 && mode === 'zoom-in') setMode('prioritize');
      return next;
    });
  }

  const isZoomIn = mode === 'zoom-in';
  // Milestone 4: Zoom-In requires >=1 selected source, enforced here (UI)
  // AND on the backend (PATCH .../scope 422s otherwise) — defense in
  // depth, and this client-side check avoids a doomed round trip. The
  // interactive remove path above now prevents this from ever actually
  // becoming true (mode flips the instant selection would hit zero), so
  // in practice this only guards a hypothetical initial-state edge case
  // (e.g. a picker opened with initialMode="zoom-in" and an empty
  // initialSelection) — kept as defense in depth per this milestone's
  // explicit "we are NOT weakening the Zoom-In invariant" instruction.
  const zoomInNeedsASource = isZoomIn && selected.size === 0;

  // Frontend Milestone 2.1 — real effective scope, not assumed defaults
  // (see ChatSourcesPickerProps.scope's docstring for why `?? true`
  // matches the backend's own column defaults rather than an arbitrary
  // choice here).
  const chatEnabled = scope?.chatEnabled ?? true;
  const generalEnabled = scope?.generalEnabled ?? true;
  const projectTierEnabled = scope?.projectEnabled ?? true;
  const hasProjectMembership = projectContext !== null && projectContext.length > 0;
  const projectAvailable = hasProjectMembership && projectTierEnabled;
  const prioritizeCopy = prioritizeModeCopy({
    selectedCount: selected.size,
    chatEnabled,
    projectAvailable,
    generalEnabled,
  });
  const projectNamesText =
    projectContext !== null ? describeProjectNames(projectContext.map((p) => p.name)) : '';

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

  function goToDocuments(): void {
    onClose();
    router.push('/documents');
  }

  const panelWidth = isNarrow ? windowWidth : Math.min(DESKTOP_PANEL_WIDTH_PX, windowWidth - 32);
  const panelMaxHeight = isNarrow ? windowHeight * 0.94 : Math.min(680, windowHeight - 64);
  const browseMaxHeight = Math.max(200, Math.min(360, windowHeight * 0.38));
  const selectedMaxHeight = Math.max(80, Math.min(180, windowHeight * 0.2));

  const contents = folderLibrary.contentsState;
  const selectedList = Array.from(selected.values());

  const rawFolders = contents.status === 'success' ? contents.contents.folders : [];
  const rawDocuments = contents.status === 'success' ? contents.contents.documents : [];
  const sorted = sortLibraryContents(rawFolders, rawDocuments, sortKey, sortDirection);
  const query = filterText.trim().toLowerCase();
  // Client-side, current-folder-only — see requirement #20: this is
  // honestly a filter over what's already loaded, never presented as a
  // whole-corpus search, and no backend search endpoint was added for it.
  const visibleFolders = query
    ? sorted.folders.filter((f) => safeText(f.name, '').toLowerCase().includes(query))
    : sorted.folders;
  const visibleDocuments = query
    ? sorted.documents.filter((d) =>
        safeText(d.title, d.source_filename).toLowerCase().includes(query)
      )
    : sorted.documents;
  const libraryIsEmpty =
    contents.status === 'success' &&
    folderLibrary.currentFolderId === null &&
    rawFolders.length === 0 &&
    rawDocuments.length === 0;
  const folderIsEmpty =
    contents.status === 'success' && rawFolders.length === 0 && rawDocuments.length === 0;
  const filterHasNoMatches =
    !folderIsEmpty &&
    query.length > 0 &&
    visibleFolders.length === 0 &&
    visibleDocuments.length === 0;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={[styles.overlay, isNarrow && styles.overlayBottom]}>
        <Pressable
          style={styles.backdrop}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close sources"
        />
        <View
          style={[
            styles.panel,
            isNarrow ? styles.panelSheet : styles.panelCentered,
            { width: panelWidth, maxHeight: panelMaxHeight },
          ]}
        >
          <View style={styles.header}>
            <Text style={styles.title}>Sources</Text>
            <Pressable
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel="Close"
              hitSlop={8}
            >
              <CloseIcon size={16} color={theme.faint} />
            </Pressable>
          </View>

          {hasProjectMembership && (
            <View
              style={styles.projectContextRow}
              accessibilityLabel={`Part of ${projectContext!.length === 1 ? 'project' : `${projectContext!.length} projects`}: ${projectContext!.map((p) => p.name).join(', ')}`}
            >
              <Text style={styles.projectContextLabel}>
                {projectContext!.length === 1 ? 'Project' : 'Projects'}
              </Text>
              <Text style={styles.projectContextName} numberOfLines={1}>
                {projectNamesText}
                {isZoomIn
                  ? ' — Zoom-In restricts this chat to only the selected sources.'
                  : !projectTierEnabled
                    ? ' — project knowledge is currently off for this chat.'
                    : ''}
              </Text>
            </View>
          )}

          {zoomInEnabled && (
            <View style={styles.modeRow} accessibilityRole="radiogroup">
              <Pressable
                style={[styles.modeCard, !isZoomIn && styles.modeCardActive]}
                onPress={() => setMode('prioritize')}
                accessibilityRole="radio"
                accessibilityState={{ checked: !isZoomIn }}
                accessibilityLabel="Prioritize — selected sources rank first, other sources still available"
              >
                <Text style={[styles.modeCardTitle, !isZoomIn && styles.modeCardTitleActive]}>
                  Prioritize
                </Text>
                <Text style={styles.modeCardCopy}>{prioritizeCopy}</Text>
              </Pressable>
              <Pressable
                style={[styles.modeCard, isZoomIn && styles.modeCardActive]}
                onPress={() => setMode('zoom-in')}
                accessibilityRole="radio"
                accessibilityState={{ checked: isZoomIn }}
                accessibilityLabel="Zoom-In — chat answers ONLY from the selected sources, nothing else"
              >
                <Text style={[styles.modeCardTitle, isZoomIn && styles.modeCardTitleActive]}>
                  Zoom-In
                </Text>
                <Text style={styles.modeCardCopy}>{ZOOM_IN_COPY}</Text>
              </Pressable>
            </View>
          )}

          <View style={styles.libraryHeaderRow}>
            {/* "Library" not "My Library" — Breadcrumbs' own root crumb
                already says "My Library" right below this; a second copy
                of the same words directly above it would read as a typo,
                not a section heading. */}
            <Text style={styles.libraryLabel}>Library</Text>
            <View style={styles.libraryHeaderActions}>
              <Button
                label={`Sort by ${sortKey === 'name' ? 'Name' : sortKey === 'modified' ? 'Date modified' : sortKey === 'size' ? 'Size' : 'Type'}`}
                variant="ghost"
                size="sm"
                onPress={() => setSortMenuOpen(true)}
              />
              <Button label="Manage library" variant="ghost" size="sm" onPress={goToDocuments} />
            </View>
          </View>

          <Breadcrumbs
            path={contents.status === 'success' ? contents.contents.breadcrumbs : []}
            onNavigate={folderLibrary.navigate}
          />

          {!libraryIsEmpty && (
            <TextField
              label="Filter this folder"
              placeholder="Filter by name…"
              value={filterText}
              onChangeText={setFilterText}
              autoCapitalize="none"
              autoCorrect={false}
            />
          )}

          <ScrollView style={[styles.browseList, { maxHeight: browseMaxHeight }]}>
            {contents.status === 'loading' && (
              <ActivityIndicator style={styles.spinner} color={theme.accent} />
            )}
            {contents.status === 'error' && (
              <Text style={styles.errorText}>{contents.error.message}</Text>
            )}
            {contents.status === 'success' && libraryIsEmpty && (
              <EmptyState
                title="No documents yet."
                description="Upload documents in your Library to use them as chat sources."
                actionLabel="Go to Documents"
                onAction={goToDocuments}
              />
            )}
            {contents.status === 'success' && !libraryIsEmpty && folderIsEmpty && (
              <Text style={styles.emptyText}>This folder is empty.</Text>
            )}
            {contents.status === 'success' && filterHasNoMatches && (
              <Text style={styles.emptyText}>
                No items in this folder match &quot;{filterText.trim()}&quot;.
              </Text>
            )}
            {contents.status === 'success' && !libraryIsEmpty && !filterHasNoMatches && (
              <View style={styles.tileWrap}>
                {visibleFolders.map((folder) => (
                  <Pressable
                    key={folder.id}
                    style={styles.tile}
                    onPress={() => folderLibrary.navigate(folder.id)}
                    accessibilityRole="button"
                    accessibilityLabel={`Open ${safeText(folder.name, 'folder')}`}
                  >
                    <FolderIcon size={22} color={theme.subtext} />
                    <Text style={styles.tileText} numberOfLines={2}>
                      {safeText(folder.name, 'Untitled folder')}
                    </Text>
                  </Pressable>
                ))}
                {visibleDocuments.map((doc) => {
                  const displayName = safeText(doc.title, doc.source_filename);
                  const isChecked = selected.has(doc.document_id);
                  return (
                    <Pressable
                      key={doc.document_id}
                      style={[styles.tile, isChecked && styles.tileSelected]}
                      onPress={() => toggleDocument({ documentId: doc.document_id, displayName })}
                      accessibilityRole="checkbox"
                      accessibilityState={{ checked: isChecked }}
                      accessibilityLabel={`${isChecked ? 'Remove' : 'Add'} ${displayName}`}
                    >
                      <FileIcon size={22} color={isChecked ? theme.accent : theme.subtext} />
                      <Text style={styles.tileText} numberOfLines={2}>
                        {displayName}
                      </Text>
                      {isChecked && (
                        <View style={styles.tileCheck}>
                          <CheckIcon size={10} color={theme.background} strokeWidth={2.5} />
                        </View>
                      )}
                    </Pressable>
                  );
                })}
              </View>
            )}
          </ScrollView>

          <View style={styles.selectedHeader}>
            <Text style={styles.selectedTitle}>Selected sources ({selectedList.length})</Text>
          </View>
          {selectedList.length === 0 ? (
            <Text style={styles.emptyText}>
              {isZoomIn
                ? 'Select at least one source — Zoom-In has nothing to answer from otherwise.'
                : /* The mode card above already spells out exactly what
                     will be searched instead — this stays a short factual
                     note about the list itself, not a second copy of
                     that explanation. */
                  'No sources selected.'}
            </Text>
          ) : (
            <ScrollView style={[styles.selectedList, { maxHeight: selectedMaxHeight }]}>
              {selectedList.map((doc) => (
                <View key={doc.documentId} style={styles.selectedRow}>
                  <FileIcon size={14} color={theme.subtext} />
                  <Text style={styles.selectedRowText} numberOfLines={1}>
                    {doc.displayName}
                  </Text>
                  <Pressable
                    onPress={() => removeSelected(doc.documentId)}
                    accessibilityRole="button"
                    accessibilityLabel={`Remove ${doc.displayName} from selection`}
                    hitSlop={8}
                  >
                    <CloseIcon size={13} color={theme.subtext} />
                  </Pressable>
                </View>
              ))}
            </ScrollView>
          )}

          {zoomInNeedsASource && (
            <View style={styles.zoomInNotice}>
              <Text style={styles.zoomInNoticeText}>
                Zoom-In requires at least one selected source.
              </Text>
            </View>
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

      {sortMenuOpen && (
        <SortMenu
          sortKey={sortKey}
          sortDirection={sortDirection}
          onChangeSort={setSortKey}
          onChangeDirection={setSortDirection}
          onClose={() => setSortMenuOpen(false)}
        />
      )}
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
    backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: theme.overlay },
    panel: { backgroundColor: theme.card, padding: 18, gap: 10 },
    panelCentered: { borderRadius: theme.radius.lg },
    panelSheet: { borderTopLeftRadius: theme.radius.lg, borderTopRightRadius: theme.radius.lg },
    header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    title: { color: theme.text, fontSize: 17, fontFamily: theme.fonts.display },
    projectContextRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingVertical: 6,
      paddingHorizontal: 10,
      borderRadius: theme.radius.sm,
      backgroundColor: theme.accentSoft,
    },
    projectContextLabel: {
      color: theme.accent,
      fontSize: 11,
      fontFamily: theme.fonts.bodySemibold,
      textTransform: 'uppercase',
      letterSpacing: 0.3,
    },
    projectContextName: {
      color: theme.text,
      fontSize: 12,
      fontFamily: theme.fonts.body,
      flex: 1,
    },
    modeRow: { flexDirection: 'row', gap: 8 },
    modeCard: {
      flex: 1,
      padding: 10,
      borderRadius: theme.radius.md,
      borderWidth: StyleSheet.hairlineWidth * 2,
      borderColor: theme.border,
      backgroundColor: theme.background,
      gap: 2,
    },
    modeCardActive: { borderColor: theme.accent, backgroundColor: theme.accentSoft },
    modeCardTitle: { color: theme.text, fontSize: 13, fontFamily: theme.fonts.bodySemibold },
    modeCardTitleActive: { color: theme.accent },
    modeCardCopy: {
      color: theme.subtext,
      fontSize: 11.5,
      lineHeight: 15,
      fontFamily: theme.fonts.body,
    },
    libraryHeaderRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginTop: 4,
    },
    libraryLabel: { color: theme.subtext, fontSize: 12, fontFamily: theme.fonts.bodySemibold },
    libraryHeaderActions: { flexDirection: 'row', alignItems: 'center', gap: 2 },
    spinner: { marginVertical: 12 },
    errorText: { color: theme.danger, fontSize: 12, fontFamily: theme.fonts.body },
    emptyText: {
      color: theme.faint,
      fontSize: 12,
      fontFamily: theme.fonts.body,
      paddingVertical: 6,
    },
    browseList: { borderRadius: theme.radius.md },
    tileWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingVertical: 4 },
    tile: {
      width: 104,
      minHeight: 84,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      borderRadius: theme.radius.md,
      backgroundColor: theme.background,
      padding: 8,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 4,
    },
    tileSelected: { borderColor: theme.accent, backgroundColor: theme.accentSoft },
    tileText: {
      color: theme.text,
      fontSize: 11.5,
      textAlign: 'center',
      fontFamily: theme.fonts.body,
    },
    tileCheck: {
      position: 'absolute',
      top: 4,
      right: 4,
      width: 14,
      height: 14,
      borderRadius: 7,
      backgroundColor: theme.accent,
      alignItems: 'center',
      justifyContent: 'center',
    },
    selectedHeader: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 },
    selectedTitle: { color: theme.subtext, fontSize: 12, fontFamily: theme.fonts.bodySemibold },
    selectedList: {},
    selectedRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingVertical: 6,
    },
    selectedRowText: { color: theme.text, fontSize: 12, flex: 1, fontFamily: theme.fonts.body },
    zoomInNotice: {
      backgroundColor: theme.warningSoft,
      borderRadius: theme.radius.sm,
      paddingVertical: 6,
      paddingHorizontal: 10,
    },
    zoomInNoticeText: { color: theme.warning, fontSize: 12, fontFamily: theme.fonts.body },
    footer: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 4 },
  });
}
