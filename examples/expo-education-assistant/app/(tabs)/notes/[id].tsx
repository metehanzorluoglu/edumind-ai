import type { Notebook, NotebookEntry } from 'education-assistant-client';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { ChevronIcon, FileIcon, MoreIcon, NoteIcon } from '@/components/icons';
import { ActionSheet, type ActionSheetItem } from '@/components/ui/ActionSheet';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { IconButton } from '@/components/ui/IconButton';
import { Notice } from '@/components/ui/Notice';
import { TextField } from '@/components/ui/TextField';
import { useClient } from '@/lib/ClientProvider';
import { safeText } from '@/lib/format';
import { useTheme, type Theme } from '@/lib/Preferences';
import {
  MAX_TRANSIENT_AI_CONTEXT_ENTRIES,
  type TransientAIContextEntry,
} from '@/lib/transientAIContext';

type SortKey = 'newest' | 'oldest' | 'source';

const PAGE_SIZE = 20;
const SORT_LABELS: Record<SortKey, string> = {
  newest: 'Newest',
  oldest: 'Oldest',
  source: 'Source',
};

function toTransientEntry(entry: NotebookEntry): TransientAIContextEntry {
  const isManual = entry.entry_type === 'manual';
  return {
    sourceType: 'notebook-entry',
    documentId: isManual ? null : (entry.document_id ?? null),
    documentTitle: isManual ? null : (entry.document_title ?? null),
    pageNumber: isManual ? null : (entry.page_number ?? null),
    excerpt: isManual ? (entry.note_text ?? '') : (entry.excerpt ?? ''),
    userNote: isManual ? null : entry.note_text,
  };
}

/**
 * Frontend Milestone 3.2 — the Notebook detail screen, redesigned into a
 * research evidence desk (see the M3.2 spec's "PRIMARY PRODUCT GOAL"):
 * SOURCE EVIDENCE and MY THINKING stay two visibly distinct blocks (never
 * merged — carried over unchanged from M3.1 §10, still important for
 * academic integrity), row actions are restrained to Ask EduM8/Open
 * source plus a "More" menu (no five always-visible buttons per row —
 * §6), and multi-selection is an explicit "Select" mode rather than
 * always-on checkboxes crowding ordinary browsing (§15). Everything here
 * reuses the exact M3.1 Notebook backend/hooks unchanged — this is a
 * presentation pass, not a rebuild.
 */
export default function NotebookDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const theme = useTheme();
  const styles = useMemo(() => buildStyles(theme), [theme]);
  const { client } = useClient();

  const [notebook, setNotebook] = useState<Notebook | null>(null);
  const [entries, setEntries] = useState<NotebookEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const [filterText, setFilterText] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('newest');
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectionNotice, setSelectionNotice] = useState<string | null>(null);

  const [manualFormOpen, setManualFormOpen] = useState(false);
  const [manualNoteText, setManualNoteText] = useState('');
  const [savingManual, setSavingManual] = useState(false);
  const [editingEntryId, setEditingEntryId] = useState<string | null>(null);
  const [editingNoteText, setEditingNoteText] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);
  const [removingIds, setRemovingIds] = useState<Set<string>>(new Set());
  const [entryMenuFor, setEntryMenuFor] = useState<NotebookEntry | null>(null);

  const [renameFormOpen, setRenameFormOpen] = useState(false);
  const [renameText, setRenameText] = useState('');
  const [savingRename, setSavingRename] = useState(false);
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false);
  const [deletingNotebook, setDeletingNotebook] = useState(false);

  // Frontend/Platform Milestone 3.2.1 §B1 — anchors for the desktop
  // popover variant of each "..." menu (ActionSheet falls back to a
  // bottom sheet on mobile/when unset — see that component).
  const headerMoreRef = useRef<View>(null);
  const sortButtonRef = useRef<View>(null);
  const entryMoreRefs = useRef<Map<string, View>>(new Map());
  const [entryMenuAnchor, setEntryMenuAnchor] = useState<{ current: View | null } | null>(null);

  async function loadFirstPage(): Promise<void> {
    if (!id) return;
    setStatus('loading');
    try {
      const [nb, page] = await Promise.all([
        client
          .listNotebooks({ limit: 50 })
          .then((r) => r.notebooks.find((n) => n.id === id) ?? null),
        client.listNotebookEntries(id, { limit: PAGE_SIZE, offset: 0 }),
      ]);
      setNotebook(nb);
      setEntries(page.entries);
      setTotal(page.total);
      setStatus('success');
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Could not load this notebook.');
      setStatus('error');
    }
  }

  useEffect(() => {
    void loadFirstPage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function handleLoadMore(): Promise<void> {
    if (!id || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await client.listNotebookEntries(id, {
        limit: PAGE_SIZE,
        offset: entries.length,
      });
      setEntries((prev) => [...prev, ...page.entries]);
      setTotal(page.total);
    } finally {
      setLoadingMore(false);
    }
  }

  async function handleAddManualNote(): Promise<void> {
    if (!id) return;
    const trimmed = manualNoteText.trim();
    if (!trimmed || savingManual) return;
    setSavingManual(true);
    try {
      await client.addNotebookEntry(id, { entryType: 'manual', noteText: trimmed });
      setManualNoteText('');
      setManualFormOpen(false);
      await loadFirstPage();
    } finally {
      setSavingManual(false);
    }
  }

  async function handleSaveEdit(entryId: string): Promise<void> {
    if (!id || savingEdit) return;
    setSavingEdit(true);
    try {
      await client.updateNotebookEntry(id, entryId, { noteText: editingNoteText.trim() || null });
      setEditingEntryId(null);
      await loadFirstPage();
    } finally {
      setSavingEdit(false);
    }
  }

  async function handleRemove(entryId: string): Promise<void> {
    if (!id) return;
    setRemovingIds((prev) => new Set(prev).add(entryId));
    try {
      await client.removeNotebookEntry(id, entryId);
      setEntries((prev) => prev.filter((e) => e.id !== entryId));
      setTotal((prev) => Math.max(0, prev - 1));
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.delete(entryId);
        return next;
      });
    } finally {
      setRemovingIds((prev) => {
        const next = new Set(prev);
        next.delete(entryId);
        return next;
      });
    }
  }

  function handleOpenSource(entry: NotebookEntry): void {
    // M3.1 final real-browser validation found `entry.document_id` alone
    // is NOT a valid "can I open this" signal: it's a snapshot field that
    // stays populated even after the source document is deleted (by
    // design — see NotebookEntry's backend docstring). `source_available`
    // is computed fresh server-side on every read and is what actually
    // answers "does this document still exist right now."
    if (!entry.document_id || !entry.source_available) return;
    // M3.2 §5/§27: restore the correct page (and briefly emphasize the
    // highlight, if it still exists) rather than just landing on the
    // document's default view — see documents/[id].tsx's handling of the
    // `page`/`highlightId`/`chunkId` params, which reuses the exact same
    // pdfScrollToPage/flashedHighlightId/flashedChunkId mechanics the
    // in-Reader "Go to highlight" action already relies on. A highlight
    // that was itself deleted (but the document wasn't) still resolves
    // correctly here — the jump only ever depends on document_id/
    // page_number/chunk_id, all independent NotebookEntry snapshots (§27:
    // do not label this "source unavailable" just because the visual
    // highlight is gone).
    router.push({
      pathname: '/documents/[id]',
      params: {
        id: entry.document_id,
        ...(entry.page_number ? { page: String(entry.page_number) } : {}),
        ...(entry.highlight_id ? { highlightId: entry.highlight_id } : {}),
        ...(entry.chunk_id ? { chunkId: entry.chunk_id } : {}),
      },
    });
  }

  function toggleSelected(entryId: string): void {
    setSelectionNotice(null);
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(entryId)) {
        next.delete(entryId);
        return next;
      }
      if (next.size >= MAX_TRANSIENT_AI_CONTEXT_ENTRIES) {
        setSelectionNotice(
          `You can use up to ${MAX_TRANSIENT_AI_CONTEXT_ENTRIES} notebook entries at once.`
        );
        return prev;
      }
      next.add(entryId);
      return next;
    });
  }

  function handleAskAboutOne(entry: NotebookEntry): void {
    router.push({
      pathname: '/chat/new',
      params: {
        sources: entry.document_id
          ? JSON.stringify([
              { documentId: entry.document_id, displayName: entry.document_title ?? 'Document' },
            ])
          : undefined,
        notebookContext: JSON.stringify([toTransientEntry(entry)]),
      },
    });
  }

  function handleAskAboutSelected(): void {
    const chosen = entries.filter((e) => selectedIds.has(e.id));
    if (chosen.length === 0) return;
    const uniqueDocs = new Map<string, string>();
    for (const e of chosen)
      if (e.document_id) uniqueDocs.set(e.document_id, e.document_title ?? 'Document');
    router.push({
      pathname: '/chat/new',
      params: {
        sources:
          uniqueDocs.size > 0
            ? JSON.stringify(
                Array.from(uniqueDocs.entries()).map(([documentId, displayName]) => ({
                  documentId,
                  displayName,
                }))
              )
            : undefined,
        notebookContext: JSON.stringify(chosen.map(toTransientEntry)),
      },
    });
  }

  function exitSelectMode(): void {
    setSelectMode(false);
    setSelectedIds(new Set());
    setSelectionNotice(null);
  }

  async function handleRename(): Promise<void> {
    if (!id) return;
    const trimmed = renameText.trim();
    if (!trimmed || savingRename) return;
    setSavingRename(true);
    try {
      const updated = await client.renameNotebook(id, { name: trimmed });
      setNotebook(updated);
      setRenameFormOpen(false);
    } finally {
      setSavingRename(false);
    }
  }

  function handleDeleteNotebook(): void {
    if (!id || !notebook) return;
    const message = `Delete "${notebook.name}"? This removes the notebook and its saved entries. Original documents and highlights are not deleted.`;
    const run = async (): Promise<void> => {
      setDeletingNotebook(true);
      try {
        await client.deleteNotebook(id);
        router.push('/notes');
      } finally {
        setDeletingNotebook(false);
      }
    };
    if (Platform.OS === 'web') {
      if (window.confirm(message)) void run();
      return;
    }
    Alert.alert(`Delete "${notebook.name}"?`, message, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => void run() },
    ]);
  }

  const visibleEntries = useMemo(() => {
    const needle = filterText.trim().toLowerCase();
    let list = entries;
    if (needle) {
      list = list.filter((e) => {
        const haystack = [e.excerpt, e.note_text, e.document_title]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        return haystack.includes(needle);
      });
    }
    const sorted = [...list];
    if (sortKey === 'oldest') sorted.sort((a, b) => a.created_at.localeCompare(b.created_at));
    else if (sortKey === 'newest') sorted.sort((a, b) => b.created_at.localeCompare(a.created_at));
    else sorted.sort((a, b) => (a.document_title ?? '').localeCompare(b.document_title ?? ''));
    return sorted;
  }, [entries, filterText, sortKey]);

  const headerMenuItems: ActionSheetItem[] = [
    {
      key: 'rename',
      label: 'Rename',
      onPress: () => {
        setHeaderMenuOpen(false);
        setRenameText(notebook?.name ?? '');
        setRenameFormOpen(true);
      },
    },
    {
      key: 'delete',
      label: 'Delete notebook',
      destructive: true,
      loading: deletingNotebook,
      onPress: () => {
        setHeaderMenuOpen(false);
        handleDeleteNotebook();
      },
    },
  ];

  const sortMenuItems: ActionSheetItem[] = (['newest', 'oldest', 'source'] as SortKey[]).map(
    (key) => ({
      key,
      label: SORT_LABELS[key],
      selected: sortKey === key,
      onPress: () => {
        setSortKey(key);
        setSortMenuOpen(false);
      },
    })
  );

  const entryMenuItems: ActionSheetItem[] = entryMenuFor
    ? [
        {
          key: 'edit',
          label:
            entryMenuFor.entry_type === 'manual'
              ? 'Edit'
              : entryMenuFor.note_text
                ? 'Edit note'
                : 'Add note',
          onPress: () => {
            setEditingEntryId(entryMenuFor.id);
            setEditingNoteText(entryMenuFor.note_text ?? '');
            setEntryMenuFor(null);
          },
        },
        {
          key: 'remove',
          label: entryMenuFor.entry_type === 'manual' ? 'Delete note' : 'Remove from notebook',
          destructive: true,
          loading: removingIds.has(entryMenuFor.id),
          onPress: () => {
            const entryId = entryMenuFor.id;
            setEntryMenuFor(null);
            void handleRemove(entryId);
          },
        },
      ]
    : [];

  return (
    <View style={styles.screen}>
      <Pressable
        onPress={() => router.push('/notes')}
        accessibilityRole="button"
        accessibilityLabel="Back to Research Notes"
        style={styles.backButton}
        hitSlop={8}
      >
        <ChevronIcon size={14} color={theme.subtext} style={styles.backChevron} />
        <Text style={styles.backText}>Research Notes</Text>
      </Pressable>

      <View style={styles.header}>
        <View style={styles.headerTitleCol}>
          <Text style={styles.headerTitle} numberOfLines={1}>
            {safeText(notebook?.name, '')}
          </Text>
          {status === 'success' && (
            <Text style={styles.headerMeta}>
              {total} {total === 1 ? 'entry' : 'entries'}
            </Text>
          )}
        </View>
        <View style={styles.headerActions}>
          <Button
            label="+ Add note"
            variant="secondary"
            size="sm"
            onPress={() => setManualFormOpen(true)}
          />
          <View ref={headerMoreRef}>
            <IconButton
              label="Notebook options"
              icon={<MoreIcon size={16} color={theme.subtext} />}
              variant="outline"
              size="sm"
              onPress={() => setHeaderMenuOpen(true)}
            />
          </View>
        </View>
      </View>

      {renameFormOpen && (
        <View style={styles.renameBar}>
          <View style={styles.renameField}>
            <TextField
              label="Notebook name"
              value={renameText}
              onChangeText={setRenameText}
              editable={!savingRename}
              autoFocus
              onSubmitEditing={() => void handleRename()}
              returnKeyType="done"
            />
          </View>
          <Button
            label="Cancel"
            variant="ghost"
            size="sm"
            disabled={savingRename}
            onPress={() => setRenameFormOpen(false)}
          />
          <Button
            label="Save"
            variant="primary"
            size="sm"
            loading={savingRename}
            disabled={!renameText.trim()}
            onPress={() => void handleRename()}
          />
        </View>
      )}

      <ScrollView contentContainerStyle={styles.content}>
        {status === 'loading' && <ActivityIndicator style={styles.spinner} color={theme.accent} />}
        {status === 'error' && (
          <EmptyState
            title="Couldn't load this notebook."
            description={errorMessage ?? 'An unexpected error occurred.'}
            actionLabel="Try again"
            onAction={() => void loadFirstPage()}
          />
        )}

        {status === 'success' && (
          <>
            {manualFormOpen && (
              <View style={styles.manualForm}>
                <TextField
                  label="Note"
                  value={manualNoteText}
                  onChangeText={setManualNoteText}
                  placeholder="Write a standalone note…"
                  editable={!savingManual}
                  multiline
                  autoFocus
                />
                <View style={styles.manualFormActions}>
                  <Button
                    label="Cancel"
                    variant="ghost"
                    size="sm"
                    disabled={savingManual}
                    onPress={() => {
                      setManualFormOpen(false);
                      setManualNoteText('');
                    }}
                  />
                  <Button
                    label="Save"
                    variant="primary"
                    size="sm"
                    loading={savingManual}
                    disabled={!manualNoteText.trim()}
                    onPress={() => void handleAddManualNote()}
                  />
                </View>
              </View>
            )}

            {entries.length > 0 && (
              <View style={styles.controlsRow}>
                <View style={styles.filterField}>
                  <TextField
                    label="Filter this notebook"
                    value={filterText}
                    onChangeText={setFilterText}
                    placeholder="Search title, excerpt, or note…"
                  />
                </View>
                <View ref={sortButtonRef}>
                  <Button
                    label={`Sort: ${SORT_LABELS[sortKey]}`}
                    variant="ghost"
                    size="sm"
                    onPress={() => setSortMenuOpen(true)}
                  />
                </View>
                <Button
                  label={selectMode ? 'Cancel' : 'Select'}
                  variant={selectMode ? 'ghost' : 'secondary'}
                  size="sm"
                  onPress={() => (selectMode ? exitSelectMode() : setSelectMode(true))}
                />
              </View>
            )}

            {selectMode && (
              <View style={styles.selectionBar}>
                <Text style={styles.selectionText}>
                  {selectedIds.size} / {MAX_TRANSIENT_AI_CONTEXT_ENTRIES} selected
                </Text>
                <Button
                  label="Ask EduM8"
                  variant="primary"
                  size="sm"
                  disabled={selectedIds.size === 0}
                  onPress={handleAskAboutSelected}
                />
                <Button
                  label="Clear"
                  variant="ghost"
                  size="sm"
                  onPress={() => setSelectedIds(new Set())}
                />
              </View>
            )}
            {selectionNotice && <Notice tone="warning" body={selectionNotice} />}

            {entries.length === 0 && (
              <EmptyState
                title="No research notes here yet."
                description="Save highlights from documents or add a note."
                actionLabel="Add note"
                onAction={() => setManualFormOpen(true)}
                secondaryActionLabel="Browse Documents"
                onSecondaryAction={() => router.push('/documents')}
              />
            )}

            {entries.length > 0 && visibleEntries.length === 0 && (
              <EmptyState
                title="No entries match your filter."
                description="Try a different word, or clear the filter to see everything in this notebook."
                actionLabel="Clear filter"
                onAction={() => setFilterText('')}
              />
            )}

            {visibleEntries.map((entry) => {
              const isManual = entry.entry_type === 'manual';
              const selected = selectedIds.has(entry.id);
              return (
                <Pressable
                  key={entry.id}
                  onPress={selectMode ? () => toggleSelected(entry.id) : undefined}
                  accessibilityRole={selectMode ? 'checkbox' : undefined}
                  accessibilityState={selectMode ? { checked: selected } : undefined}
                  accessibilityLabel={
                    selectMode
                      ? selected
                        ? `Deselect entry ${entry.id}`
                        : `Select entry ${entry.id} for Ask EduM8`
                      : undefined
                  }
                  style={[styles.row, selectMode && selected && styles.rowSelected]}
                >
                  {selectMode && (
                    <View style={[styles.checkboxBox, selected && styles.checkboxBoxActive]} />
                  )}
                  <View style={styles.rowBody}>
                    <View style={styles.typeRow}>
                      {isManual ? (
                        <NoteIcon size={13} color={theme.faint} />
                      ) : (
                        <FileIcon size={13} color={theme.faint} />
                      )}
                      {!isManual && (
                        <Text style={styles.sourceLabel} numberOfLines={1}>
                          {safeText(entry.document_title, 'Untitled document')}
                          {entry.page_number ? ` · p. ${entry.page_number}` : ''}
                        </Text>
                      )}
                      {isManual && <Text style={styles.sourceLabel}>My note</Text>}
                    </View>

                    {!isManual && (
                      <View style={styles.excerptBlock}>
                        <Text style={styles.blockLabel}>EXCERPT</Text>
                        <Text style={styles.excerptText} numberOfLines={4}>
                          “{entry.excerpt}”
                        </Text>
                      </View>
                    )}
                    {!isManual && entry.note_text && editingEntryId !== entry.id && (
                      <View style={styles.noteBlock}>
                        <Text style={styles.blockLabel}>MY NOTE</Text>
                        <Text style={styles.noteText}>{entry.note_text}</Text>
                      </View>
                    )}
                    {isManual && editingEntryId !== entry.id && (
                      <View style={styles.noteBlock}>
                        <Text style={styles.noteText}>{entry.note_text}</Text>
                      </View>
                    )}
                    {editingEntryId === entry.id && (
                      <View style={styles.editForm}>
                        <TextField
                          label="Note"
                          value={editingNoteText}
                          onChangeText={setEditingNoteText}
                          multiline
                          editable={!savingEdit}
                          autoFocus
                        />
                        <View style={styles.manualFormActions}>
                          <Button
                            label="Cancel"
                            variant="ghost"
                            size="sm"
                            disabled={savingEdit}
                            onPress={() => setEditingEntryId(null)}
                          />
                          <Button
                            label="Save"
                            variant="primary"
                            size="sm"
                            loading={savingEdit}
                            onPress={() => void handleSaveEdit(entry.id)}
                          />
                        </View>
                      </View>
                    )}

                    {!selectMode && (
                      <View style={styles.actionsRow}>
                        {!isManual && entry.source_available && (
                          <Pressable
                            onPress={() => handleOpenSource(entry)}
                            accessibilityRole="button"
                            accessibilityLabel={`Open source for entry ${entry.id}`}
                            hitSlop={6}
                          >
                            <Text style={styles.actionText}>Open source</Text>
                          </Pressable>
                        )}
                        {!isManual && !entry.source_available && (
                          <Text
                            style={styles.disabledActionText}
                            accessibilityLabel={`Open source for entry ${entry.id} unavailable`}
                          >
                            Source unavailable
                          </Text>
                        )}
                        <Pressable
                          onPress={() => handleAskAboutOne(entry)}
                          accessibilityRole="button"
                          accessibilityLabel={`Ask EduM8 about entry ${entry.id}`}
                          hitSlop={6}
                        >
                          <Text style={styles.actionText}>Ask EduM8</Text>
                        </Pressable>
                        <View style={styles.spacer} />
                        <View
                          ref={(el) => {
                            if (el) entryMoreRefs.current.set(entry.id, el);
                          }}
                        >
                          <IconButton
                            label={`More actions for entry ${entry.id}`}
                            icon={<MoreIcon size={15} color={theme.subtext} />}
                            size="sm"
                            onPress={() => {
                              setEntryMenuFor(entry);
                              setEntryMenuAnchor({
                                current: entryMoreRefs.current.get(entry.id) ?? null,
                              });
                            }}
                          />
                        </View>
                      </View>
                    )}
                  </View>
                </Pressable>
              );
            })}

            {entries.length < total && (
              <Button
                label={`Load more (${entries.length} of ${total})`}
                variant="ghost"
                size="sm"
                loading={loadingMore}
                onPress={() => void handleLoadMore()}
              />
            )}
          </>
        )}
      </ScrollView>

      <ActionSheet
        visible={headerMenuOpen}
        title={notebook?.name}
        items={headerMenuItems}
        onDismiss={() => setHeaderMenuOpen(false)}
        anchorRef={headerMoreRef}
      />
      <ActionSheet
        visible={sortMenuOpen}
        title="Sort"
        items={sortMenuItems}
        onDismiss={() => setSortMenuOpen(false)}
        anchorRef={sortButtonRef}
      />
      <ActionSheet
        visible={entryMenuFor !== null}
        items={entryMenuItems}
        onDismiss={() => {
          setEntryMenuFor(null);
          setEntryMenuAnchor(null);
        }}
        anchorRef={entryMenuAnchor ?? undefined}
      />
    </View>
  );
}

function buildStyles(theme: Theme) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: theme.background },
    // Frontend/Platform Milestone 3.2.1 §B2 — a real page header (large
    // display title, like PageHeader.tsx uses for Documents/Search/
    // Settings) replaces M3.2's single thin toolbar row: that row's 14px
    // sans title read as weak hierarchy at desktop widths ("too much
    // unused horizontal space and weak hierarchy" — this milestone's
    // report). The back-link sits above it, out of the title's way,
    // rather than crowding the same row.
    backButton: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 2,
      paddingHorizontal: 24,
      paddingTop: 16,
    },
    backChevron: { transform: [{ rotate: '180deg' }] },
    backText: { fontSize: 13, color: theme.subtext, fontFamily: theme.fonts.body },
    header: {
      flexDirection: 'row',
      alignItems: 'flex-end',
      justifyContent: 'space-between',
      gap: 16,
      paddingHorizontal: 24,
      paddingTop: 6,
      paddingBottom: 18,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.border,
    },
    headerTitleCol: { flex: 1, minWidth: 120, gap: 3 },
    headerTitle: {
      fontSize: theme.scale(26),
      fontFamily: theme.fonts.display,
      color: theme.text,
      letterSpacing: -0.2,
    },
    headerMeta: { fontSize: 13, fontFamily: theme.fonts.body, color: theme.subtext },
    headerActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    renameBar: {
      flexDirection: 'row',
      alignItems: 'flex-end',
      gap: 10,
      paddingHorizontal: 24,
      paddingVertical: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.border,
      backgroundColor: theme.card,
    },
    renameField: { flex: 1, maxWidth: 360 },
    // Widened from M3.1/early-M3.2's 760 — real desktop review (1440/
    // 1280/1024 — §B2) found 760 left the page feeling like a narrow
    // form floating in a lot of unused space. 900 still keeps a sensible
    // reading measure (excerpts/notes are short passages, not prose
    // paragraphs) while using the width a Notebook actually has to show.
    content: { padding: 24, gap: 12, maxWidth: 900, width: '100%', alignSelf: 'center' },
    spinner: { marginTop: 60 },
    manualForm: {
      gap: 10,
      padding: 14,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      borderRadius: theme.radius.md,
      backgroundColor: theme.card,
    },
    manualFormActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8 },
    controlsRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 10, flexWrap: 'wrap' },
    filterField: { flex: 1, minWidth: 200 },
    selectionBar: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      backgroundColor: theme.accentSoft,
      borderRadius: theme.radius.md,
      paddingHorizontal: 12,
      paddingVertical: 8,
    },
    selectionText: {
      fontSize: 12,
      fontFamily: theme.fonts.bodySemibold,
      color: theme.accent,
      flex: 1,
    },
    row: {
      flexDirection: 'row',
      gap: 10,
      paddingVertical: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.border,
    },
    rowSelected: { backgroundColor: theme.accentSoft, borderRadius: theme.radius.sm },
    checkboxBox: {
      width: 16,
      height: 16,
      marginTop: 3,
      borderRadius: 4,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
    },
    checkboxBoxActive: { backgroundColor: theme.accent, borderColor: theme.accent },
    rowBody: { flex: 1, gap: 6 },
    typeRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    sourceLabel: {
      flex: 1,
      fontSize: 11,
      fontFamily: theme.fonts.bodySemibold,
      color: theme.faint,
    },
    blockLabel: {
      fontSize: 9.5,
      fontFamily: theme.fonts.bodySemibold,
      color: theme.faint,
      textTransform: 'uppercase',
      letterSpacing: 0.4,
      marginBottom: 2,
    },
    // SOURCE EXCERPT and MY NOTE are deliberately styled as two visibly
    // distinct blocks (different background) — M3.1/M3.2 spec: never let
    // the two read as one merged paragraph. This is academic-integrity
    // load-bearing, not just visual taste.
    excerptBlock: {
      backgroundColor: theme.background,
      borderRadius: theme.radius.sm,
      padding: 8,
      marginLeft: 19,
    },
    excerptText: {
      fontSize: 13,
      lineHeight: 19,
      color: theme.text,
      fontFamily: theme.fonts.body,
      fontStyle: 'italic',
    },
    noteBlock: {
      backgroundColor: theme.accentSoft,
      borderRadius: theme.radius.sm,
      padding: 8,
      marginLeft: 19,
    },
    noteText: { fontSize: 13, lineHeight: 19, color: theme.text, fontFamily: theme.fonts.body },
    editForm: { gap: 8, marginLeft: 19 },
    actionsRow: {
      flexDirection: 'row',
      alignItems: 'center',
      flexWrap: 'wrap',
      gap: 14,
      marginTop: 2,
      marginLeft: 19,
    },
    actionText: { fontSize: 12, fontFamily: theme.fonts.bodySemibold, color: theme.accent },
    disabledActionText: { fontSize: 12, fontFamily: theme.fonts.body, color: theme.faint },
    spacer: { flex: 1 },
  });
}
