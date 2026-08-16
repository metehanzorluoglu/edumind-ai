import { useWritingProjects } from 'education-assistant-client';
import type { WritingProjectSort, WritingProjectSummary } from 'education-assistant-client';
import { useRouter } from 'expo-router';
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
import { MoreIcon, SortIcon } from '@/components/icons';
import { ActionSheet, type ActionSheetItem } from '@/components/ui/ActionSheet';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { IconButton } from '@/components/ui/IconButton';
import { Notice } from '@/components/ui/Notice';
import { PageHeader } from '@/components/ui/PageHeader';
import { TextField } from '@/components/ui/TextField';
import { useClient } from '@/lib/ClientProvider';
import { formatLibraryDate } from '@/lib/libraryItems';
import { useTheme, type Theme } from '@/lib/Preferences';

const SORT_LABELS: Record<WritingProjectSort, string> = {
  updated_at: 'Last modified',
  name: 'Name',
  created_at: 'Date created',
};

/** Milestone 5.3 Part 28 — persists the user's sort preference locally,
 * the same "remember across visits, per-device, no server round trip"
 * convention this app's other list screens already use for their own
 * sort/view preferences (see lib/Preferences.tsx). */
const SORT_STORAGE_KEY = 'writing.dashboard.sort';

/**
 * Milestone 5 (Academic Writing & LaTeX Foundation) Part 1, upgraded by
 * Milestone 5.3 Part 26-30 into a real project dashboard — search, sort,
 * duplicate, archive/restore, alongside the existing open/rename/
 * delete/export. Visually consistent with Documents/Research Notes (see
 * notes/index.tsx, the closest precedent). Still deliberately simple —
 * no sharing/collaboration, no folders for writing projects themselves.
 */
export default function WritingHomeScreen() {
  const theme = useTheme();
  const styles = useMemo(() => buildStyles(theme), [theme]);
  const router = useRouter();
  const { client } = useClient();
  const {
    listState,
    refresh,
    search,
    setSearch,
    sort,
    setSort,
    showArchived,
    setShowArchived,
    createProject,
    deleteStates,
    deleteProject,
    resetDeleteState,
    archiveStates,
    archiveProject,
    restoreProject,
    duplicateStates,
    duplicateProject,
  } = useWritingProjects(client);

  const [formOpen, setFormOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const sortButtonRef = useRef<View>(null);

  const [menuFor, setMenuFor] = useState<WritingProjectSummary | null>(null);
  const menuAnchorRefs = useRef<Map<string, View>>(new Map());
  const [menuAnchor, setMenuAnchor] = useState<{ current: View | null } | null>(null);

  // Milestone 5.3 Part 28 — restore the persisted sort preference once
  // on mount, before the first refresh() fires, so the very first list
  // request already reflects it (never a visible re-sort flash).
  const restoredSortRef = useRef(false);
  useEffect(() => {
    if (restoredSortRef.current) return;
    restoredSortRef.current = true;
    if (Platform.OS === 'web' && typeof window !== 'undefined' && window.localStorage) {
      const stored = window.localStorage.getItem(SORT_STORAGE_KEY);
      if (stored === 'updated_at' || stored === 'name' || stored === 'created_at') {
        setSort(stored);
      }
    }
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Milestone 5.3 Part 27/28/30 — re-fetches whenever a filter changes.
  // Deliberately NOT re-fetching on every keystroke of `search` here —
  // the caller debounces via handleSearchChange below.
  const isFirstFilterEffect = useRef(true);
  useEffect(() => {
    if (isFirstFilterEffect.current) {
      isFirstFilterEffect.current = false;
      return;
    }
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sort, showArchived]);

  // `refresh` is a new function identity every time `search`/`sort`/
  // `showArchived` change (it closes over them). The debounced
  // setTimeout below is scheduled INSIDE the same synchronous call that
  // also calls setSearch(text) — React hasn't re-rendered yet at that
  // point, so a plain closure over `refresh` would still call the OLD
  // version (with the PREVIOUS search text baked in) once the timer
  // fires 300ms later. Routing every call through this ref (kept
  // current via the effect below, which re-runs on every render) always
  // dispatches to whichever `refresh` is current at FIRE time, not
  // SCHEDULE time.
  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  });

  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  function handleSearchChange(text: string): void {
    setSearch(text);
    if (searchDebounceRef.current !== null) clearTimeout(searchDebounceRef.current);
    searchDebounceRef.current = setTimeout(() => {
      searchDebounceRef.current = null;
      refreshRef.current();
    }, 300);
  }

  function handleSortChange(next: WritingProjectSort): void {
    setSort(next);
    setSortMenuOpen(false);
    if (Platform.OS === 'web' && typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(SORT_STORAGE_KEY, next);
    }
  }

  async function handleCreate(): Promise<void> {
    const trimmed = title.trim();
    if (!trimmed || creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      const project = await createProject({ title: trimmed });
      setFormOpen(false);
      setTitle('');
      router.push(`/writing/${project.id}`);
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : 'Could not create project.');
    } finally {
      setCreating(false);
    }
  }

  function handleDelete(project: WritingProjectSummary): void {
    const message = `Delete "${project.title}"? This removes the writing project and its reference list. Documents, highlights, and Research Notes are not deleted.`;
    const run = (): void => deleteProject(project.id);
    if (Platform.OS === 'web') {
      if (window.confirm(message)) run();
      return;
    }
    Alert.alert(`Delete "${project.title}"?`, message, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: run },
    ]);
  }

  const projects: WritingProjectSummary[] =
    listState.status === 'success' ? listState.projects : [];

  async function handleDuplicate(project: WritingProjectSummary): Promise<void> {
    setMenuFor(null);
    try {
      const copy = await duplicateProject(project.id);
      router.push(`/writing/${copy.id}`);
    } catch {
      // duplicateStates already carries the error; the dashboard has no
      // dedicated per-card error slot for duplicate (mirrors delete's
      // own inline Notice — a future pass could add one), so this is
      // surfaced only via the ActionSheet item re-opening in an error
      // state if the user retries. Never silently pretend it worked.
    }
  }

  // Milestone 5.3 Part 30 — archive is a real, reversible action; the
  // menu offers "Restore" instead of "Archive" when already viewing the
  // archived list (there is nothing to archive further).
  const menuItems: ActionSheetItem[] = menuFor
    ? [
        {
          key: 'duplicate',
          label: 'Duplicate',
          loading: duplicateStates[menuFor.id]?.status === 'working',
          onPress: () => void handleDuplicate(menuFor),
        },
        showArchived
          ? {
              key: 'restore',
              label: 'Restore',
              loading: archiveStates[menuFor.id]?.status === 'working',
              onPress: () => {
                const project = menuFor;
                setMenuFor(null);
                restoreProject(project.id);
              },
            }
          : {
              key: 'archive',
              label: 'Archive',
              loading: archiveStates[menuFor.id]?.status === 'working',
              onPress: () => {
                const project = menuFor;
                setMenuFor(null);
                archiveProject(project.id);
              },
            },
        {
          key: 'delete',
          label: 'Delete project',
          destructive: true,
          loading: deleteStates[menuFor.id]?.status === 'deleting',
          onPress: () => {
            const project = menuFor;
            setMenuFor(null);
            handleDelete(project);
          },
        },
      ]
    : [];

  const sortMenuItems: ActionSheetItem[] = (
    ['updated_at', 'name', 'created_at'] as WritingProjectSort[]
  ).map((key) => ({
    key,
    label: SORT_LABELS[key],
    selected: sort === key,
    onPress: () => handleSortChange(key),
  }));

  return (
    <View style={styles.container}>
      <PageHeader
        title="Writing"
        action={
          <Button
            label="+ New project"
            accessibilityLabel="New writing project"
            variant="primary"
            size="sm"
            onPress={() => setFormOpen((prev) => !prev)}
          />
        }
      />

      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.toolbar}>
          <View style={styles.searchWrap}>
            <TextField
              label="Search writing projects"
              placeholder="Search by title or description…"
              value={search}
              onChangeText={handleSearchChange}
              accessibilityLabel="Search writing projects"
            />
          </View>
          <View style={styles.toolbarActions}>
            <View ref={sortButtonRef}>
              <Button
                label={`Sort: ${SORT_LABELS[sort]}`}
                variant="ghost"
                size="sm"
                icon={<SortIcon size={13} color={theme.subtext} />}
                onPress={() => setSortMenuOpen(true)}
              />
            </View>
            <Button
              label={showArchived ? 'Show active' : 'Show archived'}
              variant="ghost"
              size="sm"
              onPress={() => setShowArchived(!showArchived)}
            />
          </View>
        </View>

        {formOpen && (
          <View style={styles.newForm}>
            <TextField
              label="Project title"
              value={title}
              onChangeText={setTitle}
              placeholder="e.g. Laser Cutting in Design Education"
              editable={!creating}
              autoFocus
              onSubmitEditing={() => void handleCreate()}
              returnKeyType="done"
            />
            {createError && <Notice tone="danger" body={createError} />}
            <View style={styles.newFormActions}>
              <Button
                label="Cancel"
                variant="ghost"
                size="sm"
                disabled={creating}
                onPress={() => {
                  setFormOpen(false);
                  setTitle('');
                  setCreateError(null);
                }}
              />
              <Button
                label="Create"
                variant="primary"
                size="sm"
                loading={creating}
                disabled={!title.trim()}
                onPress={() => void handleCreate()}
              />
            </View>
          </View>
        )}

        {listState.status === 'loading' && (
          <ActivityIndicator style={styles.spinner} color={theme.accent} />
        )}
        {listState.status === 'error' && (
          <EmptyState
            title="Couldn't load your writing projects."
            description={listState.error.message}
            actionLabel="Try again"
            onAction={() => refresh()}
          />
        )}
        {listState.status === 'success' && projects.length === 0 && !formOpen && (
          <View style={styles.emptyWrap}>
            {search ? (
              <EmptyState
                title={`No projects match "${search}".`}
                description="Try a different title or description search."
              />
            ) : showArchived ? (
              <EmptyState
                title="No archived projects."
                description="Projects you archive appear here, and can be restored at any time."
              />
            ) : (
              <EmptyState
                title="No writing projects yet."
                description="Start a LaTeX manuscript, connect it to your library references, and cite them by their stable key as you write."
                actionLabel="+ New project"
                onAction={() => setFormOpen(true)}
              />
            )}
          </View>
        )}
        {projects.length > 0 && (
          <View style={styles.grid}>
            {projects.map((project) => {
              const deleted = deleteStates[project.id]?.status === 'success';
              if (deleted) return null;
              return (
                // A plain View (not a Pressable/accessibilityRole="button")
                // — the "..." IconButton below is itself a real <button> on
                // web, and nesting one <button> inside another is invalid
                // HTML (react-native-web renders accessibilityRole="button"
                // Pressables as <button>). Exactly ONE Pressable covers the
                // whole "open project" area (title + description + meta) so
                // there's a single, unambiguous accessible name for that
                // action — not two identically-labeled controls — with the
                // kebab menu as its own separate sibling control.
                <View key={project.id} style={styles.card}>
                  <View style={styles.cardHeader}>
                    <Pressable
                      onPress={() => router.push(`/writing/${project.id}`)}
                      accessibilityRole="button"
                      accessibilityLabel={`Open writing project ${project.title}`}
                      style={styles.cardTitlePressable}
                    >
                      <View style={styles.cardTitleRow}>
                        <Text style={styles.cardTitle} numberOfLines={1}>
                          {project.title}
                        </Text>
                        {project.archived_at && <Badge label="ARCHIVED" tone="neutral" />}
                      </View>
                      {project.description ? (
                        <Text style={styles.cardDescription} numberOfLines={2}>
                          {project.description}
                        </Text>
                      ) : null}
                      <Text style={styles.cardMeta}>
                        {project.reference_count}{' '}
                        {project.reference_count === 1 ? 'reference' : 'references'}
                        {' · '}
                        {project.file_count} {project.file_count === 1 ? 'file' : 'files'}
                        {' · '}Updated {formatLibraryDate(project.updated_at)}
                      </Text>
                    </Pressable>
                    <View
                      ref={(el) => {
                        if (el) menuAnchorRefs.current.set(project.id, el);
                      }}
                    >
                      <IconButton
                        label={`Options for ${project.title}`}
                        icon={<MoreIcon size={14} color={theme.subtext} />}
                        size="sm"
                        onPress={() => {
                          setMenuFor(project);
                          setMenuAnchor({
                            current: menuAnchorRefs.current.get(project.id) ?? null,
                          });
                        }}
                      />
                    </View>
                  </View>
                  {deleteStates[project.id]?.status === 'error' && (
                    <Notice tone="danger" body="Couldn't delete this project. Try again." />
                  )}
                </View>
              );
            })}
          </View>
        )}
      </ScrollView>

      <ActionSheet
        visible={menuFor !== null}
        title={menuFor?.title}
        items={menuItems}
        onDismiss={() => {
          if (menuFor) resetDeleteState(menuFor.id);
          setMenuFor(null);
          setMenuAnchor(null);
        }}
        anchorRef={menuAnchor ?? undefined}
      />
      <ActionSheet
        visible={sortMenuOpen}
        title="Sort by"
        items={sortMenuItems}
        onDismiss={() => setSortMenuOpen(false)}
        anchorRef={sortButtonRef}
      />
    </View>
  );
}

function buildStyles(theme: Theme) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: theme.background },
    content: { padding: 24, gap: 16, maxWidth: 900, width: '100%', alignSelf: 'center' },
    spinner: { marginTop: 40 },
    emptyWrap: { paddingTop: 40 },
    toolbar: {
      flexDirection: 'row',
      alignItems: 'flex-end',
      justifyContent: 'space-between',
      gap: 12,
      flexWrap: 'wrap',
    },
    searchWrap: { flex: 1, minWidth: 220, maxWidth: 360 },
    toolbarActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    newForm: {
      gap: 10,
      padding: 14,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      borderRadius: theme.radius.md,
      backgroundColor: theme.card,
      maxWidth: 420,
    },
    newFormActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8 },
    grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
    card: {
      flexGrow: 1,
      flexBasis: 260,
      maxWidth: 340,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      borderRadius: theme.radius.md,
      backgroundColor: theme.card,
      padding: 16,
      gap: 5,
    },
    cardHeader: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      justifyContent: 'space-between',
      gap: 8,
    },
    cardTitlePressable: { flex: 1 },
    cardTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    cardTitle: { fontSize: 15, fontFamily: theme.fonts.bodySemibold, color: theme.text, flexShrink: 1 },
    cardDescription: { fontSize: 12.5, fontFamily: theme.fonts.body, color: theme.subtext },
    cardMeta: { fontSize: 12, fontFamily: theme.fonts.body, color: theme.faint },
  });
}
