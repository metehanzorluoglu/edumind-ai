import { useWritingProject, useWritingProjectFiles } from 'education-assistant-client';
import type { DisplaySource, NotebookEntry, WritingProjectFileNode } from 'education-assistant-client';
import * as DocumentPicker from 'expo-document-picker';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import { ChevronIcon, MoreIcon, SparkleIcon } from '@/components/icons';
import { ActionSheet, type ActionSheetItem } from '@/components/ui/ActionSheet';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { IconButton } from '@/components/ui/IconButton';
import { Notice } from '@/components/ui/Notice';
import { TextField } from '@/components/ui/TextField';
import { AskEduM8Panel } from '@/components/writing/AskEduM8Panel';
import { BibliographyModal } from '@/components/writing/BibliographyModal';
import { CompileDiagnostics } from '@/components/writing/CompileDiagnostics';
import { CompiledPdfPreview } from '@/components/writing/CompiledPdfPreview';
import { NotesPanel } from '@/components/writing/NotesPanel';
import { ReferencePickerModal } from '@/components/writing/ReferencePickerModal';
import { ReferencesPanel } from '@/components/writing/ReferencesPanel';
import { WritingAssetPreview } from '@/components/writing/WritingAssetPreview';
import { WritingFileTree } from '@/components/writing/WritingFileTree';
import { useClient } from '@/lib/ClientProvider';
import { downloadCompiledPdf, safeCompiledPdfFilename } from '@/lib/downloadCompiledPdf';
import {
  downloadWritingProjectExport,
  safeWritingProjectExportFilename,
} from '@/lib/downloadWritingProjectExport';
import { useFeatureFlags } from '@/lib/FeatureFlags';
import { useTheme, type Theme } from '@/lib/Preferences';
import {
  buildUploadableFileFromPickerAsset,
  WRITING_PROJECT_UPLOAD_MIME_TYPES,
} from '@/lib/writingFileUpload';

const WIDE_BREAKPOINT_PX = 860;

type PanelTab = 'project' | 'references' | 'notes';
type MobileTab = 'editor' | 'preview' | 'files' | 'references' | 'notes' | 'ask';

const SAVE_STATUS_LABEL: Record<string, string> = {
  idle: '',
  editing: 'Editing…',
  saving: 'Saving…',
  saved: 'Saved',
  error: 'Could not save',
};

/**
 * Milestone 5 (Academic Writing & LaTeX Foundation) — the writing
 * project editor: LaTeX source (Part 6), debounced autosave with a
 * visible status (Part 7), a References panel (Parts 4/5/9/10/12/27), and
 * a Supporting Material / Research Notes panel (Parts 14-18). Wide
 * viewports get a persistent split pane; narrow viewports get tabs (Part
 * 35 — never a forced desktop split pane on mobile).
 *
 * Milestone 5.2 (Research-Aware Writing Assistant) adds "Ask EduM8" — a
 * dismissible drawer (AskEduM8Panel), never a permanent third column
 * (Part 11), toggled from the header button (desktop) or its own mobile
 * tab. Every manuscript mutation it can trigger (Insert citation, Add
 * reference) still routes through this screen's OWN deterministic
 * functions (handleInsertCitationForDocument, addReferences) — the AI
 * response itself never touches `content` (Part 14).
 */
export default function WritingProjectEditorScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const theme = useTheme();
  const styles = useMemo(() => buildStyles(theme), [theme]);
  const { client } = useClient();
  const { width } = useWindowDimensions();
  const isWide = width >= WIDE_BREAKPOINT_PX;
  const { latexCompilation } = useFeatureFlags();

  const {
    loadState,
    project,
    reload,
    flush,
    renameProject,
    referencesState,
    loadReferences,
    addReferences,
    removeReference,
    bibliographyState,
    loadBibliography,
    compileState,
    compileProject,
    fetchCompiledPdf,
  } = useWritingProject(client, id ?? '');

  // Milestone 5.3 (LaTeX Project Workspace & File Management) — the
  // project's file tree plus whichever ONE text file is currently open
  // in the editor buffer (the "selected-file model", Part 14's own
  // explicitly-reported decision over a full tab strip). Defaults to
  // the project's root file on load — the exact same file the pre-M5.3
  // single-file editor always showed, so a project with no extra files
  // behaves identically to before.
  const filesHook = useWritingProjectFiles(client, id ?? '');
  const {
    treeState,
    refreshTree,
    activeFileId,
    activeFileNode,
    activeFileLoadState,
    activeFileContent,
    activeFileSaveStatus,
    activeFileSaveError,
    setActiveFileContent,
    flushActiveFile,
    openFile,
    createFolder,
    createTextFile,
    uploadFile,
    renameFile,
    moveFile,
    deleteFile,
    setRootFile,
  } = filesHook;
  const isActiveFileEditable = activeFileNode?.kind === 'text';
  const content = isActiveFileEditable ? activeFileContent : '';

  const [panelTab, setPanelTab] = useState<PanelTab>('references');
  const [mobileTab, setMobileTab] = useState<MobileTab>('editor');
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  const editorRef = useRef<TextInput>(null);

  const [renameOpen, setRenameOpen] = useState(false);
  const [renameText, setRenameText] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const headerMoreRef = useRef<View>(null);

  const [pickerOpen, setPickerOpen] = useState(false);
  const [bibModalOpen, setBibModalOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  // Milestone 5.2 — the "Ask EduM8" drawer's own visibility. A toggle,
  // never a permanent third column (Part 11): closed by default, and
  // creates zero backend state until the researcher actually asks a
  // question (see useWritingAsk's own lazy-conversation-creation docs).
  const [askOpen, setAskOpen] = useState(false);

  // Milestone 5.1 Part 24/25/32/34 — the compiled-PDF preview's own
  // state. Deliberately separate from `compileState` (which tracks the
  // SERVER-SIDE compile job only): `compiledPdfBlob` is the PDF BYTES of
  // the last SUCCESSFUL compile, kept on screen (labeled "Last successful
  // compile") even if a later compile attempt fails — see Part 32's "do
  // not mislead the user" requirement, satisfied by never clearing this
  // on a failed re-compile, only ever replacing it on a new success.
  const [compiledPdfBlob, setCompiledPdfBlob] = useState<Blob | null>(null);
  const [compiledPdfSourceHash, setCompiledPdfSourceHash] = useState<string | null>(null);
  const [pdfFetching, setPdfFetching] = useState(false);
  const [pdfFetchError, setPdfFetchError] = useState<string | null>(null);
  const [previewCollapsed, setPreviewCollapsed] = useState(false);
  const [downloadingPdf, setDownloadingPdf] = useState(false);
  const [downloadPdfError, setDownloadPdfError] = useState<string | null>(null);
  const [compileTransportError, setCompileTransportError] = useState<string | null>(null);

  useEffect(() => {
    if (id) loadReferences();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Part 15/27 — "cited" and "missing_citation_keys" must reflect the
  // manuscript's CURRENT content, computed fresh on every server request.
  // The backend already does this correctly on every call; without this
  // effect, the References panel only ever fetched once at mount and
  // never again — a user who inserted/removed a \cite{} and then checked
  // References (or was already looking at it, on desktop's split pane)
  // would see stale data until a full page reload. Re-fetching whenever a
  // save just completed (not on every keystroke — autosave is already
  // debounced) keeps this live without adding a second request path.
  // Milestone 5.3 — keyed on the ACTIVE FILE's save status now (a
  // citation can be typed/inserted into any project .tex file, not only
  // main.tex).
  useEffect(() => {
    if (id && activeFileSaveStatus === 'saved') loadReferences();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFileSaveStatus]);

  // Milestone 5.2.1 real-browser finding (Part 7/24), generalized by
  // Milestone 5.3 Part 13 to whichever file is active — `selection`
  // starts at {0, 0} on every mount AND every file switch: the editor
  // buffer is entirely new content with no memory of where the user
  // last clicked. Position 0 in a real LaTeX file is BEFORE
  // `\documentclass{...}` (or, in a secondary file, simply "before
  // anything") — inserting a citation there via insertAtCursor without
  // the user ever having clicked into the editor first silently
  // corrupts the source. Defaulting the cursor to the END of the
  // just-loaded content — the same "cursor at the end of a freshly
  // opened document" convention most text editors use — makes every
  // insertion action land somewhere valid by default. Keyed on
  // `activeFileLoadState.status` transitioning to 'success' (not on the
  // content itself), so this never fires again on ordinary edits/
  // autosave and never fights the user's own cursor placement
  // mid-session.
  useEffect(() => {
    if (activeFileLoadState.status === 'success') {
      setSelection({ start: activeFileContent.length, end: activeFileContent.length });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, activeFileId, activeFileLoadState.status]);

  // Part 7 — "no lost content during navigation": flush any pending
  // debounced edit on unmount (best-effort — the request is still
  // in-flight after unmount, JS doesn't cancel it) and, on web, before
  // the tab/window actually closes.
  useEffect(() => {
    // The `typeof window.addEventListener === 'function'` check (not just
    // Platform.OS === 'web') matches lib/useReaderSelection.ts's own
    // convention — the jest-expo test environment reports Platform.OS as
    // 'web' but has no real browser `window`, so relying on Platform.OS
    // alone throws there.
    if (
      Platform.OS !== 'web' ||
      typeof window === 'undefined' ||
      typeof window.addEventListener !== 'function'
    ) {
      return;
    }
    const handler = (): void => {
      void flush();
      void flushActiveFile();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [flush, flushActiveFile]);
  useEffect(() => {
    return () => {
      void flush();
      void flushActiveFile();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Milestone 5.3 Part 24/25 — Insert citation/Insert note always
  // target whichever `.tex`/text file is currently active, never
  // hardcoded to main.tex. A no-op (never a silent corruption of a
  // binary asset or a folder "selection") when nothing editable is
  // open — the References/Notes panels stay usable to browse even
  // while previewing a figure, but an insert action simply does nothing
  // until the researcher switches back to a text file.
  function insertAtCursor(text: string): void {
    if (!isActiveFileEditable) return;
    const before = content.slice(0, selection.start);
    const after = content.slice(selection.end);
    const next = before + text + after;
    const nextCursor = before.length + text.length;
    setActiveFileContent(next);
    setSelection({ start: nextCursor, end: nextCursor });
    editorRef.current?.focus();
  }

  function handleInsertCitation(citationKey: string): void {
    insertAtCursor(`\\cite{${citationKey}}`);
  }

  function handleInsertMultipleCitations(citationKeys: string[]): void {
    insertAtCursor(`\\cite{${citationKeys.join(',')}}`);
  }

  function handleInsertNote(noteText: string): void {
    insertAtCursor(noteText);
  }

  async function handleInsertCitationForDocument(documentId: string): Promise<void> {
    const bibtex = await client.getDocumentBibtex(documentId);
    insertAtCursor(`\\cite{${bibtex.citation_key}}`);
  }

  function handleOpenSource(entry: NotebookEntry): void {
    if (!entry.document_id || !entry.source_available) return;
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

  // Milestone 5.2 Part 6 — Ask EduM8's evidence-card counterpart to
  // handleOpenSource above: same destination (the Reader remains
  // canonical — Part 6: "Don't build another document viewer"), just
  // anchored from a retrieved DisplaySource instead of a saved
  // NotebookEntry, so there is no highlightId to pass (this evidence was
  // never necessarily saved as a highlight — see "Add to notebook" on
  // WritingEvidenceCard for the action that creates one).
  function handleOpenEvidenceSource(source: DisplaySource): void {
    if (!source.document_id) return;
    router.push({
      pathname: '/documents/[id]',
      params: {
        id: source.document_id,
        ...(source.page_number ? { page: String(source.page_number) } : {}),
        ...(source.chunk_id ? { chunkId: source.chunk_id } : {}),
      },
    });
  }

  function handleOpenRename(): void {
    setHeaderMenuOpen(false);
    setRenameText(project?.title ?? '');
    setRenameOpen(true);
  }

  async function handleRename(): Promise<void> {
    const trimmed = renameText.trim();
    if (!trimmed || renaming) return;
    setRenaming(true);
    try {
      await renameProject({ title: trimmed });
      setRenameOpen(false);
    } finally {
      setRenaming(false);
    }
  }

  function handleDelete(): void {
    if (!project) return;
    const message = `Delete "${project.title}"? This removes the writing project and its reference list. Documents, highlights, and Research Notes are not deleted.`;
    const run = async (): Promise<void> => {
      setDeleting(true);
      setDeleteError(null);
      try {
        await client.deleteWritingProject(project.id);
        router.push('/writing');
      } catch (error) {
        setDeleteError(error instanceof Error ? error.message : 'Could not delete this project.');
        setDeleting(false);
      }
    };
    if (Platform.OS === 'web') {
      if (window.confirm(message)) void run();
      return;
    }
    Alert.alert(`Delete "${project.title}"?`, message, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => void run() },
    ]);
  }

  async function handleExport(): Promise<void> {
    if (!project || exporting) return;
    setExporting(true);
    setExportError(null);
    try {
      await flush();
      await flushActiveFile();
      await downloadWritingProjectExport(
        client,
        project.id,
        safeWritingProjectExportFilename(project.title)
      );
    } catch (error) {
      setExportError(error instanceof Error ? error.message : 'Could not export this project.');
    } finally {
      setExporting(false);
    }
  }

  function handleOpenBibliography(): void {
    setBibModalOpen(true);
    loadBibliography();
  }

  // Milestone 5.3 Part 10/11 — a safe, bounded project-asset upload.
  // Reuses the exact web/native DocumentPicker split Documents' own
  // upload flow established (see lib/writingFileUpload.ts's docstring);
  // the backend independently re-validates every byte regardless of
  // what the picker offers (Part 11: never trust the client alone).
  const [uploadError, setUploadError] = useState<string | null>(null);
  async function handleUploadAt(parentId: string | null): Promise<void> {
    setUploadError(null);
    const picked = await DocumentPicker.getDocumentAsync({
      type: WRITING_PROJECT_UPLOAD_MIME_TYPES,
      copyToCacheDirectory: true,
    });
    if (picked.canceled || picked.assets.length === 0) return;
    const asset = picked.assets[0]!;
    try {
      const file = await buildUploadableFileFromPickerAsset(asset);
      await uploadFile(file, { parentId, name: asset.name });
    } catch (error) {
      setUploadError(
        error instanceof Error ? error.message : `Could not upload "${asset.name}".`
      );
    }
  }

  // Milestone 5.1 Part 24/33, extended by Milestone 5.3 Part 17 — the
  // Compile button's handler. compileProject() itself already flushes
  // main.tex's own legacy autosave path and awaits a successful save
  // FIRST (Part 33's "flush -> save -> act"); this ALSO flushes
  // whichever project file is currently active in the editor before
  // that, since Part 17's multi-file compile snapshot must include every
  // project file's truly-current saved content, not just main.tex's —
  // an unsaved edit to a secondary .tex/figure would otherwise silently
  // compile against stale content. Never clears an existing successful
  // preview on a failed re-compile (Part 32) — only a NEW success
  // replaces it.
  async function handleCompile(): Promise<void> {
    setPdfFetchError(null);
    setCompileTransportError(null);
    let result;
    try {
      await flushActiveFile();
      result = await compileProject();
    } catch (error) {
      // A genuine transport/ownership/rate-limit failure — distinct
      // from an ordinary compile outcome (success/error/timeout/busy/
      // unavailable, all handled below via CompileDiagnostics). Never
      // silently swallowed: the button reverting to "Compile" with no
      // explanation at all would leave the user with no idea their
      // click did nothing (e.g. a 429 from Part 39's rate limit, or a
      // save failure from flush() — see compileProject's own "flush
      // first" contract).
      setCompileTransportError(
        error instanceof Error ? error.message : 'Could not compile this project.'
      );
      return;
    }
    if (result.status === 'success' && result.compile_id) {
      setPdfFetching(true);
      try {
        const blob = await fetchCompiledPdf(result.compile_id);
        setCompiledPdfBlob(blob);
        setCompiledPdfSourceHash(result.source_hash);
      } catch (error) {
        setPdfFetchError(
          error instanceof Error ? error.message : 'Could not load the compiled PDF.'
        );
      } finally {
        setPdfFetching(false);
      }
    }
  }

  async function handleDownloadPdf(): Promise<void> {
    if (!compiledPdfBlob || !project || downloadingPdf) return;
    setDownloadingPdf(true);
    setDownloadPdfError(null);
    try {
      await downloadCompiledPdf(compiledPdfBlob, safeCompiledPdfFilename(project.title));
    } catch (error) {
      setDownloadPdfError(error instanceof Error ? error.message : 'Could not download the PDF.');
    } finally {
      setDownloadingPdf(false);
    }
  }

  const references = referencesState.status === 'success' ? referencesState.data.references : [];
  const missingCitationKeys =
    (referencesState.status === 'success' ? referencesState.data.missing_citation_keys : []) ?? [];
  const existingDocumentIds = new Set(references.map((r) => r.document_id));
  // Milestone 5.2 — Ask EduM8's default "Project references" scope reads
  // this array fresh every render (Part 16: no second parallel fetch of
  // what referencesState already holds).
  const referenceDocumentIds = references.map((r) => r.document_id);
  // Milestone 5.2 Part 3 — the editor's CURRENT text selection, read
  // fresh every render so the Ask EduM8 panel's manuscript-context
  // checkbox always reflects what's actually selected right now. Never
  // persisted, never sent anywhere except as this one message's
  // transient context prefix (see AskEduM8Panel/useWritingAsk).
  const manuscriptSelectionText = content.slice(selection.start, selection.end);

  // Milestone 5.1 Part 34/35 — "Preview is current" vs "Source changed
  // since last compile", derived from comparing the CURRENT
  // source_hash (references panel's own always-fresh state — refetched
  // whenever a save completes, see the M5 References-panel-staleness
  // fix above) against the hash the DISPLAYED preview was actually
  // compiled from. No polling, no version-history subsystem.
  const currentSourceHash =
    referencesState.status === 'success' ? referencesState.data.source_hash : null;
  const isPreviewStale =
    compiledPdfBlob !== null &&
    currentSourceHash !== null &&
    compiledPdfSourceHash !== null &&
    currentSourceHash !== compiledPdfSourceHash;

  const compiling = compileState.status === 'compiling' || pdfFetching;
  const compileButtonLabel = compiling
    ? 'Compiling…'
    : compileState.status === 'result'
      ? compileState.data.status === 'success'
        ? 'Compiled'
        : 'Compile failed'
      : 'Compile';

  const headerMenuItems: ActionSheetItem[] = [
    { key: 'rename', label: 'Rename project', onPress: handleOpenRename },
    {
      key: 'delete',
      label: 'Delete project',
      destructive: true,
      loading: deleting,
      onPress: () => {
        setHeaderMenuOpen(false);
        handleDelete();
      },
    },
  ];

  if (!id) return null;

  if (loadState.status === 'loading' || loadState.status === 'idle') {
    return (
      <View style={styles.screen}>
        <ActivityIndicator style={styles.spinner} color={theme.accent} />
      </View>
    );
  }
  if (loadState.status === 'error') {
    return (
      <View style={styles.screen}>
        <EmptyState
          title="Couldn't load this writing project."
          description={loadState.error.message}
          actionLabel="Try again"
          onAction={() => reload()}
        />
      </View>
    );
  }
  if (!project) return null;

  // Milestone 5.1 Part 26/27/28/29, superseded by Milestone 5.3 Part 4 —
  // Overleaf-style layout foundation: the LEFT supporting panel's
  // "Project" tab is now a real file tree (WritingFileTree), not the
  // pre-M5.3 fixed main.tex/references.bib list. Desktop only (Part 42:
  // mobile gets its own "Files" tab instead — see the mobile tab set
  // below).
  const panel = (
    <View style={styles.panel}>
      {isWide && (
        <View style={styles.panelTabs}>
          <PanelTabButton
            label="Files"
            active={panelTab === 'project'}
            onPress={() => setPanelTab('project')}
          />
          <PanelTabButton
            label="References"
            active={panelTab === 'references'}
            onPress={() => setPanelTab('references')}
          />
          <PanelTabButton
            label="Notes"
            active={panelTab === 'notes'}
            onPress={() => setPanelTab('notes')}
          />
        </View>
      )}
      {panelTab === 'project' && (
        <WritingFileTree
          tree={treeState.status === 'success' ? treeState.data : null}
          loading={treeState.status === 'loading'}
          loadError={treeState.status === 'error' ? treeState.error.message : uploadError}
          activeFileId={activeFileId}
          onSelectFile={(node) => void openFile(node.id)}
          onSelectGenerated={handleOpenBibliography}
          onCreateFolder={(parentId, name) => createFolder({ parentId, name })}
          onCreateTextFile={(parentId, name) => createTextFile({ parentId, name })}
          onUpload={(parentId) => void handleUploadAt(parentId)}
          onRename={renameFile}
          onMove={moveFile}
          onDelete={deleteFile}
          onSetRoot={setRootFile}
        />
      )}
      {panelTab === 'references' && (
        <ReferencesPanel
          references={references}
          missingCitationKeys={missingCitationKeys}
          loading={referencesState.status === 'loading'}
          loadError={referencesState.status === 'error' ? referencesState.error.message : null}
          onAddReferences={() => setPickerOpen(true)}
          onInsertCitation={handleInsertCitation}
          onInsertMultipleCitations={handleInsertMultipleCitations}
          onRemoveReference={removeReference}
          onViewBibliography={handleOpenBibliography}
        />
      )}
      {panelTab === 'notes' && (
        <NotesPanel
          onInsertNote={handleInsertNote}
          onInsertCitationForDocument={handleInsertCitationForDocument}
          onOpenSource={handleOpenSource}
        />
      )}
    </View>
  );

  // Milestone 5.1 Part 25/26/31/37 — the RIGHT PDF Preview panel.
  // Entirely absent from the tree (not merely hidden) when the flag is
  // off — matches every other flag-gated surface in this app. Desktop
  // only (mobile gets its own "Preview" tab, wired further below).
  const previewPanel = latexCompilation && (
    <View style={styles.previewPanel}>
      <View style={styles.previewHeader}>
        <Text style={styles.previewHeaderTitle}>Preview</Text>
        <View style={styles.previewHeaderActions}>
          {compiledPdfBlob && (
            <Button
              label={downloadingPdf ? 'Downloading…' : 'Download PDF'}
              variant="ghost"
              size="sm"
              loading={downloadingPdf}
              onPress={() => void handleDownloadPdf()}
            />
          )}
          <IconButton
            label={previewCollapsed ? 'Expand preview' : 'Collapse preview'}
            icon={
              <ChevronIcon
                size={12}
                color={theme.subtext}
                style={{ transform: [{ rotate: previewCollapsed ? '180deg' : '0deg' }] }}
              />
            }
            size="sm"
            variant="outline"
            onPress={() => setPreviewCollapsed((v) => !v)}
          />
        </View>
      </View>
      {!previewCollapsed && (
        <CompiledPdfPreview
          pdfBlob={compiledPdfBlob}
          loading={compiling}
          error={null}
          stale={isPreviewStale}
          emptyMessage="Compile to see a preview."
        />
      )}
    </View>
  );

  return (
    <View style={styles.screen}>
      <Pressable
        onPress={() => router.push('/writing')}
        accessibilityRole="button"
        accessibilityLabel="Back to Writing"
        style={styles.backButton}
        hitSlop={8}
      >
        <ChevronIcon size={14} color={theme.subtext} style={styles.backChevron} />
        <Text style={styles.backText}>Writing</Text>
      </Pressable>

      <View style={styles.header}>
        <View style={styles.headerTitleCol}>
          <Text style={styles.headerTitle} numberOfLines={1}>
            {project.title}
          </Text>
          <Text
            style={[
              styles.saveStatus,
              activeFileSaveStatus === 'error' && styles.saveStatusError,
            ]}
            accessibilityLiveRegion="polite"
          >
            {/* Milestone 5.3 — names WHICH file the save status refers to,
                since editing is no longer always main.tex. */}
            {activeFileNode && SAVE_STATUS_LABEL[activeFileSaveStatus]
              ? `${activeFileNode.path} · ${SAVE_STATUS_LABEL[activeFileSaveStatus]}`
              : SAVE_STATUS_LABEL[activeFileSaveStatus]}
          </Text>
        </View>
        <View style={styles.headerActions}>
          {/* Milestone 5.2 — desktop-only: narrow viewports already have
              the "Ask EduM8" mobile tab below (Part 11's own "avoid
              redundant controls" precedent, matching 3.2.2's drawer-
              control-redundancy decision — never two controls for the
              exact same toggle). */}
          {isWide && (
            <Button
              label="Ask EduM8"
              variant={askOpen ? 'primary' : 'secondary'}
              size="sm"
              icon={<SparkleIcon size={14} color={askOpen ? theme.accentContrast : theme.accent} />}
              onPress={() => setAskOpen((v) => !v)}
            />
          )}
          {latexCompilation && (
            <Button
              label={compileButtonLabel}
              variant="primary"
              size="sm"
              loading={compiling}
              onPress={() => void handleCompile()}
            />
          )}
          <Button
            label={exporting ? 'Exporting…' : 'Export'}
            variant="secondary"
            size="sm"
            loading={exporting}
            onPress={() => void handleExport()}
          />
          <View ref={headerMoreRef}>
            <IconButton
              label="Project options"
              icon={<MoreIcon size={16} color={theme.subtext} />}
              variant="outline"
              size="sm"
              onPress={() => setHeaderMenuOpen(true)}
            />
          </View>
        </View>
      </View>

      {renameOpen && (
        <View style={styles.renameBar}>
          <View style={styles.renameField}>
            <TextField
              label="Project title"
              value={renameText}
              onChangeText={setRenameText}
              editable={!renaming}
              autoFocus
              onSubmitEditing={() => void handleRename()}
              returnKeyType="done"
            />
          </View>
          <Button
            label="Cancel"
            variant="ghost"
            size="sm"
            disabled={renaming}
            onPress={() => setRenameOpen(false)}
          />
          <Button
            label="Save"
            variant="primary"
            size="sm"
            loading={renaming}
            disabled={!renameText.trim()}
            onPress={() => void handleRename()}
          />
        </View>
      )}

      {activeFileSaveStatus === 'error' && activeFileSaveError && (
        <View style={styles.errorBar}>
          <Notice tone="danger" body={`Couldn't save your latest edit: ${activeFileSaveError.message}`} />
        </View>
      )}
      {exportError && (
        <View style={styles.errorBar}>
          <Notice tone="danger" body={exportError} />
        </View>
      )}
      {deleteError && (
        <View style={styles.errorBar}>
          <Notice tone="danger" body={deleteError} />
        </View>
      )}
      {compileTransportError && (
        <View style={styles.errorBar}>
          <Notice tone="danger" body={`Couldn't compile: ${compileTransportError}`} />
        </View>
      )}
      {pdfFetchError && (
        <View style={styles.errorBar}>
          <Notice tone="danger" body={pdfFetchError} />
        </View>
      )}
      {downloadPdfError && (
        <View style={styles.errorBar}>
          <Notice tone="danger" body={downloadPdfError} />
        </View>
      )}
      {compileState.status === 'result' && (
        <View style={styles.errorBar}>
          <CompileDiagnostics
            status={compileState.data.status}
            diagnostics={compileState.data.diagnostics ?? []}
            logExcerpt={compileState.data.log_excerpt}
          />
        </View>
      )}

      {!isWide && (
        <View style={styles.mobileTabs}>
          <MobileTabButton
            label="Editor"
            active={mobileTab === 'editor'}
            onPress={() => setMobileTab('editor')}
          />
          <MobileTabButton
            label="Files"
            active={mobileTab === 'files'}
            onPress={() => {
              setMobileTab('files');
              setPanelTab('project');
            }}
          />
          {latexCompilation && (
            <MobileTabButton
              label="Preview"
              active={mobileTab === 'preview'}
              onPress={() => setMobileTab('preview')}
            />
          )}
          <MobileTabButton
            label="References"
            active={mobileTab === 'references'}
            onPress={() => {
              setMobileTab('references');
              setPanelTab('references');
            }}
          />
          <MobileTabButton
            label="Notes"
            active={mobileTab === 'notes'}
            onPress={() => {
              setMobileTab('notes');
              setPanelTab('notes');
            }}
          />
          <MobileTabButton
            label="Ask EduM8"
            active={mobileTab === 'ask'}
            onPress={() => {
              setMobileTab('ask');
              setAskOpen(true);
            }}
          />
        </View>
      )}

      <View style={styles.body}>
        {isWide && panel}
        {!isWide &&
          mobileTab !== 'editor' &&
          mobileTab !== 'preview' &&
          mobileTab !== 'ask' &&
          panel}
        {(isWide || mobileTab === 'editor') && (
          <View style={styles.editorWrap}>
            {/* Milestone 5.3 Part 13/20/21 — the editor area now shows
                one of three things depending on what's active in the
                file tree: the text editor (a .tex/.cls/.sty/.txt file),
                a small asset preview (a binary figure/PDF), or a loading
                spinner while a file is still being fetched. Never shows
                a blank, ambiguous "editor" for a binary selection. */}
            {activeFileNode?.kind === 'binary' ? (
              <WritingAssetPreview client={client} projectId={id ?? ''} node={activeFileNode} />
            ) : activeFileLoadState.status === 'loading' && !isActiveFileEditable ? (
              <ActivityIndicator style={styles.spinner} color={theme.accent} />
            ) : (
              <TextInput
                ref={editorRef}
                value={content}
                onChangeText={setActiveFileContent}
                selection={selection}
                onSelectionChange={(e) => setSelection(e.nativeEvent.selection)}
                multiline
                editable={isActiveFileEditable}
                style={styles.editor}
                placeholder="\\documentclass{article}…"
                placeholderTextColor={theme.faint}
                autoCapitalize="none"
                autoCorrect={false}
                spellCheck={false}
                textAlignVertical="top"
                accessibilityLabel="LaTeX source editor"
              />
            )}
          </View>
        )}
        {isWide && previewPanel}
        {!isWide && mobileTab === 'preview' && latexCompilation && (
          <View style={styles.mobilePreviewWrap}>
            {compiledPdfBlob && (
              <View style={styles.mobilePreviewHeader}>
                <Button
                  label={downloadingPdf ? 'Downloading…' : 'Download PDF'}
                  variant="ghost"
                  size="sm"
                  loading={downloadingPdf}
                  onPress={() => void handleDownloadPdf()}
                />
              </View>
            )}
            <CompiledPdfPreview
              pdfBlob={compiledPdfBlob}
              loading={compiling}
              error={null}
              stale={isPreviewStale}
              emptyMessage="Compile to see a preview."
            />
          </View>
        )}
        {isWide && askOpen && (
          <AskEduM8Panel
            visible
            onClose={() => setAskOpen(false)}
            projectReferenceDocumentIds={referenceDocumentIds}
            manuscriptSelectionText={manuscriptSelectionText}
            onOpenSource={handleOpenEvidenceSource}
            onAddReference={(documentId) => addReferences([documentId]).then(() => undefined)}
            onInsertCitation={handleInsertCitationForDocument}
          />
        )}
        {!isWide && mobileTab === 'ask' && (
          <AskEduM8Panel
            visible
            onClose={() => {
              setAskOpen(false);
              setMobileTab('editor');
            }}
            projectReferenceDocumentIds={referenceDocumentIds}
            manuscriptSelectionText={manuscriptSelectionText}
            onOpenSource={handleOpenEvidenceSource}
            onAddReference={(documentId) => addReferences([documentId]).then(() => undefined)}
            onInsertCitation={handleInsertCitationForDocument}
          />
        )}
      </View>

      <ActionSheet
        visible={headerMenuOpen}
        title={project.title}
        items={headerMenuItems}
        onDismiss={() => setHeaderMenuOpen(false)}
        anchorRef={headerMoreRef}
      />
      <ReferencePickerModal
        visible={pickerOpen}
        existingDocumentIds={existingDocumentIds}
        onAdd={(documentIds) => addReferences(documentIds).then(() => undefined)}
        onClose={() => setPickerOpen(false)}
      />
      <BibliographyModal
        visible={bibModalOpen}
        loading={bibliographyState.status === 'loading'}
        loadError={bibliographyState.status === 'error' ? bibliographyState.error.message : null}
        bibtex={bibliographyState.status === 'success' ? bibliographyState.data.bibtex : null}
        projectTitle={project.title}
        onClose={() => setBibModalOpen(false)}
      />
    </View>
  );
}

function PanelTabButton({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
      accessibilityLabel={label}
      style={[
        panelTabStyles.tab,
        active && { borderBottomColor: theme.accent, borderBottomWidth: 2 },
      ]}
    >
      <Text
        style={[
          panelTabStyles.tabText,
          { color: active ? theme.accent : theme.subtext, fontFamily: theme.fonts.bodySemibold },
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function MobileTabButton({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
      accessibilityLabel={label}
      style={[mobileTabStyles.tab, active && { backgroundColor: theme.accentSoft }]}
    >
      <Text
        style={[
          mobileTabStyles.tabText,
          { color: active ? theme.accent : theme.subtext, fontFamily: theme.fonts.bodySemibold },
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

const panelTabStyles = StyleSheet.create({
  tab: { paddingHorizontal: 4, paddingVertical: 8, marginRight: 16 },
  tabText: { fontSize: 13 },
});

const mobileTabStyles = StyleSheet.create({
  tab: { flex: 1, alignItems: 'center', paddingVertical: 8, borderRadius: 8 },
  tabText: { fontSize: 12.5 },
});

function buildStyles(theme: Theme) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: theme.background },
    spinner: { marginTop: 60 },
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
      paddingBottom: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.border,
    },
    headerTitleCol: { flex: 1, minWidth: 120, gap: 3 },
    headerTitle: {
      fontSize: theme.scale(22),
      fontFamily: theme.fonts.display,
      color: theme.text,
      letterSpacing: -0.2,
    },
    saveStatus: { fontSize: 12, fontFamily: theme.fonts.body, color: theme.faint, minHeight: 15 },
    saveStatusError: { color: theme.danger },
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
    errorBar: { paddingHorizontal: 24, paddingTop: 10 },
    mobileTabs: {
      flexDirection: 'row',
      gap: 6,
      paddingHorizontal: 24,
      paddingVertical: 10,
    },
    body: { flex: 1, flexDirection: 'row' },
    editorWrap: { flex: 1, padding: 24 },
    editor: {
      flex: 1,
      fontFamily: theme.fonts.mono,
      fontSize: 13,
      lineHeight: 20,
      color: theme.text,
      backgroundColor: theme.cardPressed,
      borderRadius: theme.radius.md,
      padding: 16,
    },
    panel: {
      width: 320,
      maxWidth: '100%',
      borderRightWidth: StyleSheet.hairlineWidth,
      borderRightColor: theme.border,
      padding: 20,
      flex: 1,
    },
    panelTabs: { flexDirection: 'row', marginBottom: 8 },
    // Milestone 5.1 Part 25/26/31 — the right-side PDF Preview panel.
    previewPanel: {
      width: 420,
      maxWidth: '100%',
      borderLeftWidth: StyleSheet.hairlineWidth,
      borderLeftColor: theme.border,
      flex: 1,
    },
    previewHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingVertical: 10,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.border,
    },
    previewHeaderTitle: { fontSize: 13, fontFamily: theme.fonts.bodySemibold, color: theme.text },
    previewHeaderActions: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    mobilePreviewWrap: { flex: 1 },
    mobilePreviewHeader: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
      paddingHorizontal: 16,
      paddingVertical: 6,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.border,
    },
  });
}
