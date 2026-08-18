import {
  useWritingProject,
  useWritingProjectFiles,
  useWritingProjectReferenceMode,
} from 'education-assistant-client';
import type {
  DisplaySource,
  NotebookEntry,
  WritingProjectFileNode,
} from 'education-assistant-client';
import * as DocumentPicker from 'expo-document-picker';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { ChevronIcon, MoreIcon, PanelIcon, SparkleIcon } from '@/components/icons';
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
import { LatexCodeEditor, type LatexCodeEditorHandle } from '@/components/writing/LatexCodeEditor';
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
import { useDragResizeWidth } from '@/lib/useDragResizeWidth';
import { useFeatureFlags } from '@/lib/FeatureFlags';
import { registerNavigationFlush } from '@/lib/navigationFlushGuard';
import { getSessionNavState, setSessionNavState } from '@/lib/sessionNavCache';
import {
  useTheme,
  usePreferences,
  WRITING_RESEARCH_PANEL_WIDTH_MIN,
  WRITING_RESEARCH_PANEL_WIDTH_MAX,
  WRITING_PREVIEW_PANEL_WIDTH_MIN,
  WRITING_PREVIEW_PANEL_WIDTH_MAX,
  type Theme,
} from '@/lib/Preferences';
import {
  buildUploadableFileFromPickerAsset,
  WRITING_PROJECT_UPLOAD_MIME_TYPES,
} from '@/lib/writingFileUpload';

const WIDE_BREAKPOINT_PX = 860;

// Milestone 5.5 Part 6 — "Ask EduM8" is now a 4th tab of the same
// Research panel as Files/References/Notes, not a separately-positioned
// drawer (see the panel/askOpen removal below).
type PanelTab = 'project' | 'references' | 'notes' | 'ask';
type MobileTab = 'editor' | 'preview' | 'files' | 'references' | 'notes' | 'ask';

/** Milestone 5.5.1 Part 25 — what this screen remembers about itself
 * across an in-session navigate-away-and-back, via lib/sessionNavCache.ts.
 * Deliberately narrow: NOT the manuscript content itself (that's the
 * server's job, guaranteed current by the navigation-flush-guard —
 * see registerNavigationFlush below — never a second source of truth
 * for content), just enough UI position to feel like nothing moved. */
interface WritingSessionState {
  activeFileId: string | null;
  cursorByFile: Record<string, { start: number; end: number }>;
}

const SAVE_STATUS_LABEL: Record<string, string> = {
  idle: '',
  editing: 'Editing…',
  saving: 'Saving…',
  saved: 'Saved',
  error: 'Could not save',
};

/** Milestone 5.5 Part 12 — documents a keyboard shortcut via a native
 * browser tooltip (web-only; a no-op object elsewhere). RN's ViewProps/
 * TextProps don't declare `title`, but react-native-web forwards it to
 * the underlying DOM node — same cast idiom as the resize handles'
 * onMouseDown. */
function webTitle(text: string): object {
  return Platform.OS === 'web' ? ({ title: text } as object) : {};
}

/** Milestone 5.5 Part 14 — the character offset of the START of a 1-indexed
 * line, clamped to the content's actual line count so a stale diagnostic
 * (compiled against an edit made since) never throws or lands out of
 * range — collapses to the nearest valid line instead of guessing. */
function offsetForLine(content: string, line: number): { start: number; end: number } {
  const lines = content.split('\n');
  const targetIndex = Math.max(0, Math.min(line - 1, lines.length - 1));
  let offset = 0;
  for (let i = 0; i < targetIndex; i += 1) {
    offset += lines[i]!.length + 1; // +1 for the '\n' consumed by split('\n')
  }
  return { start: offset, end: offset };
}

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
  // Milestone 5.5 Part 9 — panel tab/preview-collapsed/panel-width state
  // all live in the existing local-preferences blob (same "remember
  // across visits, per-device, no server round trip" mechanism the app
  // drawer's own width/collapse already use — app/(tabs)/_layout.tsx).
  const { preferences, update, hydrated } = usePreferences();

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

  // Bibliography Source Detection — how THIS project actually manages
  // its citations/references (never assumed EduM8-library just because
  // references.bib exists — see rag-backend's app/core/reference_mode.py
  // and this hook's own docstring). Deliberately separate from
  // useWritingProject's own referencesState (EduM8's reference LIBRARY,
  // a per-user resource) — this is per-project, derived from real file
  // content.
  const {
    referenceModeState,
    reload: reloadReferenceMode,
    applyEdum8Switch,
  } = useWritingProjectReferenceMode(client, id ?? '');

  // Milestone 5.5.1 Part 25 (CORE REQUIREMENT) — cross-navigation
  // continuity: which file was open and where the cursor sat in each
  // one, restored from lib/sessionNavCache.ts's session-lived (not
  // Preferences-persisted — see that module's own docstring for why
  // this is a deliberately different durability tier) cache. Read via
  // a lazy useState initializer, not a plain variable, so this is only
  // ever evaluated ONCE at this component's own mount — a later
  // unrelated re-render must never re-read a since-changed cache entry
  // out from under an already-open editing session.
  const sessionCacheKey = `writing:${id ?? ''}`;
  const [initialSessionState] = useState<WritingSessionState | undefined>(() =>
    getSessionNavState<WritingSessionState>(sessionCacheKey)
  );

  // Milestone 5.3 (LaTeX Project Workspace & File Management) — the
  // project's file tree plus whichever ONE text file is currently open
  // in the editor buffer (the "selected-file model", Part 14's own
  // explicitly-reported decision over a full tab strip). Defaults to
  // the project's root file on load — the exact same file the pre-M5.3
  // single-file editor always showed, so a project with no extra files
  // behaves identically to before — UNLESS Part 25's session cache
  // remembers a different file from a previous visit THIS session, in
  // which case that one opens first instead (see useWritingProjectFiles'
  // own initialFileId option and its "falls back to root if that file no
  // longer exists" guard).
  const filesHook = useWritingProjectFiles(client, id ?? '', {
    initialFileId: initialSessionState?.activeFileId ?? null,
  });
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
    refreshActiveFileContent,
  } = filesHook;
  const isActiveFileEditable = activeFileNode?.kind === 'text';
  const content = isActiveFileEditable ? activeFileContent : '';

  // Local state, seeded from (and kept in sync with) Preferences once
  // hydration completes — NOT a direct `preferences.writingPanelTab`
  // read. Preferences hydrates asynchronously (a storage read after
  // mount), and its `update()` is a same-tick no-op outside a
  // PreferencesProvider (see that module's own null-safe fallback) — a
  // direct read would leave every tab click silently inert in any
  // render tree that hasn't mounted the provider. Local state means tab
  // switching always works this session regardless; the effect below
  // only pulls in a REMEMBERED tab once, when hydration resolves, and
  // never fights a click that happens first.
  const [panelTab, setPanelTabState] = useState<PanelTab>(preferences.writingPanelTab);
  useEffect(() => {
    if (hydrated) setPanelTabState(preferences.writingPanelTab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated]);
  const setPanelTab = useCallback(
    (tab: PanelTab) => {
      setPanelTabState(tab);
      update('writingPanelTab', tab);
    },
    [update]
  );
  const [mobileTab, setMobileTab] = useState<MobileTab>('editor');
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  // Milestone 5.5.1 Part 11 — the plain TextInput this ref used to point
  // to is now LatexCodeEditor (web: real syntax highlighting/autocomplete
  // over react-simple-code-editor; native: the exact same TextInput as
  // before, unchanged). LatexCodeEditorHandle keeps the one thing this
  // screen actually needs from it — `.focus()` — the same shape a plain
  // TextInput ref already exposed, so insertAtCursor's own call site
  // below needed no changes.
  const editorRef = useRef<LatexCodeEditorHandle>(null);

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
  const previewCollapsed = preferences.writingPreviewCollapsed;
  const setPreviewCollapsed = useCallback(
    (next: boolean | ((prev: boolean) => boolean)) =>
      update(
        'writingPreviewCollapsed',
        typeof next === 'function' ? next(preferences.writingPreviewCollapsed) : next
      ),
    [update, preferences.writingPreviewCollapsed]
  );
  // Milestone 5.5.1 Part 4/5 — the Research panel's own open/closed
  // state, independent of `panelTab` (Part 4: closing/reopening the
  // drawer must land back on the same tab, not reset it). Same
  // Preferences-backed pattern as `previewCollapsed` above.
  const researchDrawerOpen = preferences.writingResearchDrawerOpen;
  const setResearchDrawerOpen = useCallback(
    (next: boolean | ((prev: boolean) => boolean)) =>
      update(
        'writingResearchDrawerOpen',
        typeof next === 'function' ? next(preferences.writingResearchDrawerOpen) : next
      ),
    [update, preferences.writingResearchDrawerOpen]
  );
  // Milestone 5.5 Part 8 — drag-resize for the Research/Preview columns,
  // wide-web only (the hook itself no-ops off-web). Widths persist via
  // Preferences (Part 9), committed only on release.
  const researchPanelResize = useDragResizeWidth({
    width: preferences.writingResearchPanelWidth,
    min: WRITING_RESEARCH_PANEL_WIDTH_MIN,
    max: WRITING_RESEARCH_PANEL_WIDTH_MAX,
    onResizeEnd: (w) => update('writingResearchPanelWidth', w),
  });
  const previewPanelResize = useDragResizeWidth({
    width: preferences.writingPreviewPanelWidth,
    min: WRITING_PREVIEW_PANEL_WIDTH_MIN,
    max: WRITING_PREVIEW_PANEL_WIDTH_MAX,
    onResizeEnd: (w) => update('writingPreviewPanelWidth', w),
    // The Preview column is anchored to the right edge of the screen —
    // its handle sits on its LEFT, so dragging left (not right) widens it.
    invert: true,
  });
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

  // Bibliography Source Detection — the detected reference mode depends
  // on real file CONTENT (a `\bibliography{...}` argument, an `\input`/
  // `\include` target, a `\begin{thebibliography}` block) as well as
  // file STRUCTURE (which files exist at all). Re-fetched on the same
  // two triggers as loadReferences above: once at mount, and whenever
  // any file's save just completed — covers editing the root document's
  // own `\bibliography{...}`/`\input`/`\include` lines directly. File
  // structure changes (creating/renaming/deleting a `.bib`/`.tex` file)
  // are covered separately below, keyed on treeState.
  useEffect(() => {
    if (id && activeFileSaveStatus === 'saved') reloadReferenceMode();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFileSaveStatus]);

  useEffect(() => {
    if (id && treeState.status === 'success') reloadReferenceMode();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [treeState]);

  // Milestone 5.5 Part 10 — per-file cursor memory: switching away from a
  // file and back restores exactly where you were, rather than always
  // resetting to the end. Session-only (an in-memory ref, not
  // Preferences — Part 9 explicitly excludes transient/content-shaped
  // state from persistence), keyed by fileId.
  //
  // Milestone 5.5.1 Part 25 extends this across a full navigate-away-
  // and-back (not just switching files WITHIN one mounted session):
  // seeded from the same sessionNavCache read as initialSessionState
  // above, so a cursor position remembered from before the user left
  // for Documents is still here when they come back — this ref would
  // otherwise have been destroyed along with the rest of this
  // component's state on unmount.
  const cursorMemoryRef = useRef<Record<string, { start: number; end: number }>>(
    initialSessionState?.cursorByFile ?? {}
  );
  // Milestone 5.5.1 Part 25 — a "latest value" ref for the unmount-time
  // session-cache write below (see that effect's own comment): a plain
  // `useEffect(..., [id])` cleanup closes over whatever `activeFileId`
  // was AT THE TIME THIS EFFECT LAST RAN, not whatever it actually is
  // the moment the component unmounts — those differ the instant the
  // user switches files even once. Kept current every render via the
  // effect right below, cheaply (no re-render of its own).
  const activeFileIdRef = useRef(activeFileId);
  useEffect(() => {
    activeFileIdRef.current = activeFileId;
  }, [activeFileId]);
  function handleSelectionChange(next: { start: number; end: number }): void {
    setSelection(next);
    if (activeFileId) cursorMemoryRef.current[activeFileId] = next;
  }
  // Milestone 5.5 Part 14 — set by handleOpenDiagnostic just before
  // openFile(); consumed (and cleared) by the very next load-effect run
  // below, taking priority over both the remembered-cursor and
  // end-of-content fallbacks — "go to line" always wins the one time
  // it's actually requested.
  const pendingDiagnosticLineRef = useRef<number | null>(null);
  // Milestone 5.5.3 — "go to line" full-line flash highlight (see
  // LatexCodeEditor's own `flashLine` prop docstring). A fresh `token`
  // on every request (even a repeat of the same line) is what makes
  // the effect that consumes it re-fire every time, not just the first.
  const [flashLine, setFlashLine] = useState<{ line: number; token: number } | null>(null);

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
  //
  // Milestone 5.5 Part 10 extends this: if cursorMemoryRef already has a
  // position for this exact fileId (a previous visit this session) and
  // it's still in-range for the freshly-loaded content, that position
  // wins over the "end of content" fallback.
  useEffect(() => {
    if (activeFileLoadState.status === 'success') {
      const pendingLine = pendingDiagnosticLineRef.current;
      let next: { start: number; end: number };
      if (pendingLine != null) {
        pendingDiagnosticLineRef.current = null;
        next = offsetForLine(activeFileContent, pendingLine);
        // Milestone 5.5.3 — the cross-file leg of "go to line": the
        // same-file leg (handleOpenDiagnostic below) flashes
        // immediately since no load is needed; this is the other half,
        // once the target file has actually finished loading.
        setFlashLine({ line: pendingLine, token: Date.now() });
      } else {
        const remembered = activeFileId ? cursorMemoryRef.current[activeFileId] : undefined;
        const inRange =
          remembered !== undefined &&
          remembered.start <= activeFileContent.length &&
          remembered.end <= activeFileContent.length;
        next = inRange
          ? remembered!
          : { start: activeFileContent.length, end: activeFileContent.length };
      }
      setSelection(next);
      if (activeFileId) cursorMemoryRef.current[activeFileId] = next;
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
      // Milestone 5.5.1 Part 25 — captures exactly what
      // initialSessionState/cursorMemoryRef above read back on the NEXT
      // mount of this same project: which file was open, and the cursor
      // remembered for every file visited this session (cursorMemoryRef
      // is already kept live by handleSelectionChange/the load-effect
      // below — nothing further to do for it here beyond reading it).
      // Reading cursorMemoryRef.current AT cleanup time is exactly the
      // point (the freshest known cursor for every file), not a stale
      // snapshot; the lint rule's "may have changed by the time this
      // runs" caution is written for DOM-node refs that can be nulled
      // out by React itself, which doesn't apply to this plain mutable
      // object ref.
      setSessionNavState<WritingSessionState>(sessionCacheKey, {
        activeFileId: activeFileIdRef.current,
        // eslint-disable-next-line react-hooks/exhaustive-deps
        cursorByFile: cursorMemoryRef.current,
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Milestone 5.5.1 Part 25 (CORE REQUIREMENT) — "autosave must flush/
  // queue before navigation." Registers this screen's flush with the
  // app's single navigation choke point (app/(tabs)/_layout.tsx's
  // handleNavigate) — see lib/navigationFlushGuard.ts's own docstring
  // for the exact race this closes ("type -> immediately click
  // Documents -> return Writing" must never lose the edit): the
  // unmount-cleanup flush above is fire-and-forget and can't be
  // guaranteed to land before a fast round-trip back re-fetches from
  // the server; this one is AWAITED by the navigation itself, before
  // the route (and this component) ever changes.
  useEffect(() => {
    return registerNavigationFlush(async () => {
      await flushActiveFile();
      await flush();
    });
  }, [flush, flushActiveFile]);

  // Milestone 5.3 Part 24/25 — Insert citation/Insert note always
  // target whichever `.tex`/text file is currently active, never
  // hardcoded to main.tex. A no-op (never a silent corruption of a
  // binary asset or a folder "selection") when nothing editable is
  // open — the References/Notes panels stay usable to browse even
  // while previewing a figure, but an insert action simply does nothing
  // until the researcher switches back to a text file.
  //
  // Milestone 5.5 Part 5 — `selection` doubles as BOTH this function's
  // insertion point AND, via manuscriptSelectionText below, the passage
  // Ask EduM8 treats as read-only AI context. Root-cause of the M5.4
  // production finding ("Add-to-Notebook/evidence actions may not
  // render consistently when manuscript-selection context is
  // simultaneously active"): the evidence actions always rendered fine
  // — what actually broke was Insert citation/note treating a genuine
  // (non-collapsed) manuscript selection as a range to OVERWRITE,
  // silently deleting the very passage the researcher selected to keep
  // in place while asking about it. Insertion therefore always happens
  // at `selection.end` — the tail of whatever is selected — so a
  // collapsed cursor (start === end, the ordinary case) behaves exactly
  // as before, and a real selection is always preserved, never
  // consumed, by these actions.
  function insertAtCursor(text: string): void {
    if (!isActiveFileEditable) return;
    const insertionPoint = selection.end;
    const before = content.slice(0, insertionPoint);
    const after = content.slice(insertionPoint);
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

  // M5.5.3 continuation — real-world finding: the compile sandbox
  // always writes the project's root file as the literal "main.tex"
  // (latex-compiler/app/compiler.py's own hardcoded entry point —
  // extra_files never includes the root under its OWN name), so every
  // diagnostic located in the root file itself reports `file: "main.tex"`
  // regardless of what the project's real root is actually named.
  // Reproduced live against the real Springer Nature fixture: a
  // main.tex:309 diagnostic (the project's real root is "sn-article.tex")
  // offered no "Go to line" action at all, silently, because a straight
  // path comparison against the tree never matches "main.tex" to
  // anything real. The EduM8 default blank-project template (whose own
  // root genuinely IS named "main.tex") and the earlier UNLV validation
  // (Abstract.tex — a \input-ed FILE, which keeps its own real name,
  // never rewritten) both happened to avoid exercising this path, which
  // is why it wasn't caught until this real-fixture walkthrough.
  // Translating "main.tex" back to the tree's actual is_root node's real
  // path — and passing any other filename through unchanged, since
  // every non-root file already keeps its real project-relative path —
  // fixes diagnostic navigation AND persistent gutter/editor decoration
  // for the root file for every imported project whose root isn't
  // literally named "main.tex" (i.e. nearly every real-world import).
  function normalizeDiagnosticFile(rawFile: string | null | undefined): string | null {
    if (!rawFile) return null;
    if (rawFile !== 'main.tex') return rawFile;
    if (treeState.status !== 'success') return rawFile;
    const root = treeState.data.files.find((f) => f.is_root);
    return root ? root.path : rawFile;
  }

  // Milestone 5.5 Part 14 — resolves a compile diagnostic's `file` (a
  // project-relative path) against the CURRENT file tree; a diagnostic
  // from a stale compile (a file since renamed/deleted) simply gets no
  // match, and CompileDiagnostics never offers the action in that case.
  // Callers always pass an already-normalized path (see
  // normalizedDiagnostics below) — normalizeDiagnosticFile is a no-op
  // on anything that isn't literally "main.tex", so this stays correct
  // even if called with a raw diagnostic.file directly.
  function resolveDiagnosticFile(path: string): boolean {
    const normalized = normalizeDiagnosticFile(path);
    return (
      normalized != null &&
      treeState.status === 'success' &&
      treeState.data.files.some((f) => f.path === normalized && f.kind === 'text')
    );
  }

  // M5.5.3 continuation — the compile result's diagnostics with `file`
  // run through normalizeDiagnosticFile ONCE here, so every consumer
  // (the Preview pane's CompileDiagnostics list — including its own
  // "Go to line" vs "Open file" label choice, which compares `file`
  // against the active file's real path — and the editor's persistent
  // gutter/line decoration below) sees the project's real root filename
  // consistently, never the compiler's internal "main.tex".
  const normalizedDiagnostics =
    compileState.status === 'result'
      ? (compileState.data.diagnostics ?? []).map((d) => ({
          ...d,
          file: normalizeDiagnosticFile(d.file),
        }))
      : [];

  // Milestone 5.5.3 continuation — PERSISTENT editor error decoration
  // (LatexCodeEditor's own `errorLines` prop): the CURRENT compile's
  // error-severity diagnostics that name the file currently open in
  // the editor, with a real line number. Deliberately NOT stored in
  // separate state — derived fresh from `compileState` on every render,
  // so the "atomic replace/clear" lifecycle (Part 11: a successful
  // recompile clears every mark, a different failed one shows only the
  // new set, never stale) falls out of React's own data flow for free:
  // compileState.status === 'result' with a fresh `.data` object IS
  // the single source of truth, never accumulated or manually cleared
  // here. Warnings are deliberately excluded — persistent IN-EDITOR
  // decoration is scoped to errors only (Part 9); warnings stay listed
  // in the Preview panel's own diagnostics list.
  const activeFileErrorLines = activeFileNode
    ? normalizedDiagnostics
        .filter(
          (d): d is typeof d & { line: number } =>
            d.severity === 'error' && d.file === activeFileNode.path && d.line != null
        )
        .map((d) => ({ line: d.line, message: d.message }))
    : [];

  function handleOpenDiagnostic(diagnostic: { file?: string | null; line?: number | null }): void {
    // diagnostic.file is already normalized — it comes from
    // normalizedDiagnostics via CompileDiagnostics' own onOpenDiagnostic
    // callback, never a raw compile-result diagnostic directly.
    const file = diagnostic.file;
    if (!file || treeState.status !== 'success') return;
    const node = treeState.data.files.find((f) => f.path === file && f.kind === 'text');
    if (!node) return;
    if (node.id === activeFileId) {
      // Already the open file — openFile() below would be a no-op (no
      // 'loading' -> 'success' transition to hang the pending-line ref
      // on), so jump the cursor directly instead of going through that
      // load-effect at all.
      if (diagnostic.line != null) {
        const next = offsetForLine(activeFileContent, diagnostic.line);
        setSelection(next);
        cursorMemoryRef.current[node.id] = next;
        setFlashLine({ line: diagnostic.line, token: Date.now() });
      }
    } else {
      if (diagnostic.line != null) pendingDiagnosticLineRef.current = diagnostic.line;
      void openFile(node.id);
    }
    // Surfaces the editor even if a narrow viewport was showing Preview
    // (where a diagnostic click most likely originates from).
    setMobileTab('editor');
  }

  // Milestone 5.5 Part 15 — References panel's own "Open source" (a
  // whole-document reference has no specific page/chunk to anchor to,
  // unlike Ask EduM8 evidence — see handleOpenEvidenceSource above).
  function handleOpenReferenceSource(documentId: string): void {
    router.push({ pathname: '/documents/[id]', params: { id: documentId } });
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

  // Bibliography Source Detection — applyEdum8Switch() rewrites the
  // root file's `\bibliography{...}` line directly, server-side,
  // out-of-band from this screen's own editor save loop. If the root
  // file happens to be the one currently open in the editor, its local
  // buffer would otherwise keep showing the OLD `\bibliography{...}`
  // line — a real risk (found via real-browser testing, not assumed):
  // the next autosave would silently overwrite the just-applied change
  // right back to the old text. refreshActiveFileContent() re-fetches
  // and replaces the buffer (never discarding a genuine unsaved edit —
  // see its own docstring), so this only ever needs to run when the
  // switch actually touched what's currently open.
  async function handleSwitchToEdum8References(): Promise<unknown> {
    const result = await applyEdum8Switch();
    if (activeFileNode?.is_root) {
      await refreshActiveFileContent();
    }
    return result;
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
      setUploadError(error instanceof Error ? error.message : `Could not upload "${asset.name}".`);
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

  // Milestone 5.5.1 Part 15-19 — real completion data for the editor's
  // autocomplete: citation keys from the project's ACTUAL added
  // references (never invented) and .tex file paths (extension
  // stripped, matching how \input/\include arguments are conventionally
  // written) from the real file tree. Recomputed only when those
  // underlying lists actually change, not on every keystroke.
  const autocompleteData = useMemo(() => {
    // Depends on referencesState/treeState/referenceModeState directly
    // (not the `references` local above) so this only recomputes when
    // the underlying fetched data actually changes — `references`
    // itself is a fresh `[]` literal every render while
    // referencesState.status !== 'success', by the same deliberate
    // "reads fresh every render" design as referenceDocumentIds above
    // (see its own comment); that's fine for a plain render-time read,
    // but would defeat this memo's purpose.
    //
    // Bibliography Source Detection — which KEY SOURCE feeds
    // autocomplete depends on the project's actual reference mode
    // (never always EduM8's own references, which may not even be
    // connected to this manuscript — see ReferencesPanel's own mode
    // card). EDUM8_REFERENCE_LIBRARY keeps using the existing
    // referencesState-derived list (unchanged — this hook has no DB
    // access and doesn't duplicate it); every other mode uses the
    // deterministically-parsed keys the backend already resolved.
    if (
      referenceModeState.status === 'success' &&
      referenceModeState.data.mode !== 'edum8_library'
    ) {
      return {
        citationKeys: referenceModeState.data.keys.map((k) => ({ key: k.key, title: k.title })),
        filePaths:
          treeState.status === 'success'
            ? treeState.data.files
                .filter((f) => f.kind === 'text' && f.path.endsWith('.tex'))
                .map((f) => f.path.replace(/\.tex$/, ''))
            : [],
      };
    }
    const currentReferences =
      referencesState.status === 'success' ? referencesState.data.references : [];
    return {
      citationKeys: currentReferences
        .filter((r): r is typeof r & { citation_key: string } => !!r.citation_key)
        .map((r) => ({ key: r.citation_key, title: r.title })),
      filePaths:
        treeState.status === 'success'
          ? treeState.data.files
              .filter((f) => f.kind === 'text' && f.path.endsWith('.tex'))
              .map((f) => f.path.replace(/\.tex$/, ''))
          : [],
    };
  }, [referencesState, treeState, referenceModeState]);

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

  // Milestone 5.5 Part 12 — safe, conventional keyboard shortcuts, scoped
  // to this screen's lifetime. Same Platform.OS==='web' &&
  // document-exists guard + document.addEventListener('keydown', ...)
  // idiom as SidebarContextMenuContext.tsx/ConversationRow.tsx's own
  // Escape handlers. Never a browser-critical combo (no Ctrl+W/T/N/Q) —
  // preventDefault only fires for the three combos actually handled, and
  // only when the modifier key is held, so ordinary typing is untouched.
  //
  // Real-browser validation (Part 32) caught that a document-level
  // listener alone is not enough: react-native-web's <TextInput> calls
  // e.stopPropagation() on EVERY keydown while it's focused ("Prevent
  // key events bubbling", see node_modules/react-native-web/dist/
  // exports/TextInput/index.js) — meaning these shortcuts would have
  // silently gone dead the instant the cursor was inside the LaTeX
  // editor, i.e. almost all the time. handleShortcutKey is therefore
  // wired to BOTH the document listener (for focus outside the editor —
  // toolbar buttons, tabs, etc.) and the editor's own onKeyPress (for
  // focus inside it) — RNW forwards the same real KeyboardEvent-shaped
  // synthetic event to onKeyPress before stopping its propagation, so
  // one handler covers both paths with no double-firing.
  const handleShortcutKey = useCallback(
    (e: { key: string; ctrlKey: boolean; metaKey: boolean; preventDefault: () => void }): void => {
      if (!e.metaKey && !e.ctrlKey) return;
      const key = e.key.toLowerCase();
      if (key === 's') {
        e.preventDefault();
        void flushActiveFile();
        void flush();
      } else if (key === 'enter') {
        if (latexCompilation && !compiling) {
          e.preventDefault();
          void handleCompile();
        }
      } else if (key === 'k') {
        e.preventDefault();
        if (isWide) {
          setPanelTab('ask');
          setResearchDrawerOpen(true);
        } else {
          setMobileTab('ask');
        }
      }
    },
    [
      flushActiveFile,
      flush,
      latexCompilation,
      compiling,
      isWide,
      setPanelTab,
      setMobileTab,
      setResearchDrawerOpen,
    ]
  );
  useEffect(() => {
    if (
      Platform.OS !== 'web' ||
      typeof document === 'undefined' ||
      typeof document.addEventListener !== 'function'
    ) {
      return;
    }
    document.addEventListener('keydown', handleShortcutKey);
    return () => document.removeEventListener('keydown', handleShortcutKey);
  }, [handleShortcutKey]);

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

  // Milestone 5.1 Part 26/27/28/29, superseded by Milestone 5.3 Part 4 and
  // 5.5 Part 6/7/8 — the unified "RESEARCH" panel: Files, References,
  // Notes, and (folded in by 5.5, previously its own separately-
  // positioned drawer) Ask EduM8, as one coherent left column instead of
  // an N-column layout. Desktop only (Part 42: mobile gets its own tab
  // bar instead — see the mobile tab set below). Non-"ask" tabs keep
  // their own padding (panelBodyPadded); Ask EduM8 is full-bleed, same as
  // it always was as a drawer.
  // Milestone 5.5.1 Part 4/5 — on wide/desktop, the whole panel (tab
  // strip + all four bodies + resize handle) is hidden via `display:
  // 'none'` rather than removed from the tree when the drawer is
  // closed, for the same "never destroy state you might come back to"
  // reason the four tab bodies above stay mounted. Mobile is
  // unaffected — its own tab-driven visibility (see the `!isWide &&
  // mobileTab !== ...` check where `panel` is used below) already
  // decides when this renders there; the drawer concept doesn't apply
  // to mobile at all (Part 6).
  const panel = (
    <View
      style={[
        styles.panel,
        isWide && { width: researchPanelResize.effectiveWidth },
        isWide && !researchDrawerOpen && styles.panelHidden,
      ]}
    >
      <View style={styles.panelInner}>
        <Text style={styles.panelSectionLabel}>Research</Text>
        {isWide && (
          // Milestone 5.5 Part 30 — axe-core flagged this as a CRITICAL
          // aria-required-parent violation: each PanelTabButton has
          // accessibilityRole="tab" (role="tab" on web), which WAI-ARIA
          // requires to live inside a role="tablist" container. Nothing
          // upstream of the milestone provided one.
          <View style={styles.panelTabs} accessibilityRole="tablist">
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
            <PanelTabButton
              label="Ask EduM8"
              active={panelTab === 'ask'}
              onPress={() => setPanelTab('ask')}
            />
          </View>
        )}
        {/* Milestone 5.5.1 Part 4 — all four tab bodies stay mounted all
            the time now (display toggles which one is visible), instead
            of the previous `{panelTab === 'x' && <Y/>}` pattern that
            actually UNMOUNTED whichever tab you weren't looking at. That
            was silently destroying real state on every switch —
            ReferencesPanel's own search text, and (the one explicitly
            named in the spec) AskEduM8Panel's entire conversation, since
            its useWritingAsk() call lived inside a component that got
            torn down and rebuilt from scratch. Applies equally to
            toggling the drawer itself (Part 4/5) below, which now hides
            this whole tree via the same technique rather than unmounting
            it — closing and reopening the drawer must not lose any of
            this either. */}
        <View
          style={[styles.panelBodyPadded, { display: panelTab === 'project' ? 'flex' : 'none' }]}
        >
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
            scrollRestoreKey={id ? `writing-filetree-scroll:${id}` : null}
          />
        </View>
        <View
          style={[styles.panelBodyPadded, { display: panelTab === 'references' ? 'flex' : 'none' }]}
        >
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
            onOpenSource={handleOpenReferenceSource}
            referenceMode={referenceModeState.status === 'success' ? referenceModeState.data : null}
            onSwitchToEdum8={handleSwitchToEdum8References}
          />
        </View>
        <View style={[styles.panelBodyPadded, { display: panelTab === 'notes' ? 'flex' : 'none' }]}>
          <NotesPanel
            onInsertNote={handleInsertNote}
            onInsertCitationForDocument={handleInsertCitationForDocument}
            onOpenSource={handleOpenSource}
          />
        </View>
        <View style={[styles.panelAskWrap, { display: panelTab === 'ask' ? 'flex' : 'none' }]}>
          <AskEduM8Panel
            visible
            embedded
            onClose={() => setPanelTab('references')}
            projectReferenceDocumentIds={referenceDocumentIds}
            manuscriptSelectionText={manuscriptSelectionText}
            onOpenSource={handleOpenEvidenceSource}
            onAddReference={(documentId) => addReferences([documentId]).then(() => undefined)}
            onInsertCitation={handleInsertCitationForDocument}
          />
        </View>
      </View>
      {isWide && Platform.OS === 'web' && (
        <View
          // Milestone 5.5 Part 30 — see AppDrawer.tsx's identical
          // resize-handle comment: role="none" + accessibilityLabel is
          // an aria-prohibited-attr violation (role="none" strips
          // accessible-name computation entirely); "adjustable" maps to
          // the correct role="slider" instead, plumbed with the
          // required aria-valuenow/min/max below.
          accessibilityRole="adjustable"
          accessibilityLabel="Resize Research panel (arrow keys to adjust)"
          style={styles.panelResizeHandle}
          // Milestone 5.5.1 Part 10 — focusable so Tab can reach it (RN's
          // cross-platform prop; RNW maps it to tabIndex=0), plus a raw
          // onKeyDown cast for the arrow-key resize — same "RN doesn't
          // declare this DOM prop but RNW forwards it" cast idiom as
          // onMouseDown right below.
          focusable
          // react-native-web forwards raw mouse/keyboard events on View
          // for web targets — same pattern as AppDrawer.tsx's own resize
          // handle.
          {...({
            onMouseDown: researchPanelResize.handleMouseDown,
            onKeyDown: researchPanelResize.handleKeyDown,
            'aria-valuenow': Math.round(researchPanelResize.effectiveWidth),
            'aria-valuemin': WRITING_RESEARCH_PANEL_WIDTH_MIN,
            'aria-valuemax': WRITING_RESEARCH_PANEL_WIDTH_MAX,
          } as object)}
        >
          <View style={styles.panelResizeHandleGrip} />
        </View>
      )}
    </View>
  );

  // Milestone 5.5.3 continuation — "Preview is primary home" for
  // compile diagnostics: previously a full-width Notice banner spanning
  // the whole workspace ABOVE the editor/preview/research columns
  // (`styles.errorBar`); now rendered INSIDE the Preview pane itself,
  // above wherever the PDF (or its own empty/stale state) would show.
  // Shown for any result worth saying something about — a clean
  // success with zero diagnostics renders nothing (the PDF itself is
  // the confirmation); a success WITH diagnostics (e.g. an undefined-
  // citation warning) still shows the (warnings-only) section above
  // the PDF; a failure shows the full error/warning breakdown, with no
  // redundant PDF-area empty state underneath (see the `hidePdfArea`
  // check just below this).
  const diagnosticsPanel = compileState.status === 'result' &&
    (normalizedDiagnostics.length > 0 || compileState.data.status !== 'success') && (
      <CompileDiagnostics
        status={compileState.data.status}
        diagnostics={normalizedDiagnostics}
        logExcerpt={compileState.data.log_excerpt}
        resolveDiagnosticFile={resolveDiagnosticFile}
        activeFilePath={activeFileNode?.path ?? null}
        onOpenDiagnostic={handleOpenDiagnostic}
      />
    );
  // Skip CompiledPdfPreview's own "Compile to see a preview" empty
  // state specifically when the diagnostics panel is ALREADY showing
  // why there's nothing to preview yet (no PDF, not currently
  // compiling) — showing both would read as a redundant, slightly
  // contradictory second message under the real explanation.
  const showPdfArea = Boolean(compiledPdfBlob) || compiling || !diagnosticsPanel;

  // Milestone 5.1 Part 25/26/31/37 — the RIGHT PDF Preview panel.
  // Entirely absent from the tree (not merely hidden) when the flag is
  // off — matches every other flag-gated surface in this app. Desktop
  // only (mobile gets its own "Preview" tab, wired further below).
  const previewPanel = latexCompilation && (
    <View style={[styles.previewPanel, isWide && { width: previewPanelResize.effectiveWidth }]}>
      {isWide && Platform.OS === 'web' && (
        <View
          // Milestone 5.5 Part 30 — see the Research panel handle's
          // identical comment above.
          accessibilityRole="adjustable"
          accessibilityLabel="Resize Preview panel (arrow keys to adjust)"
          style={styles.previewResizeHandle}
          focusable
          // react-native-web forwards raw mouse/keyboard events on View
          // for web targets — same pattern as AppDrawer.tsx's own resize
          // handle.
          {...({
            onMouseDown: previewPanelResize.handleMouseDown,
            onKeyDown: previewPanelResize.handleKeyDown,
            'aria-valuenow': Math.round(previewPanelResize.effectiveWidth),
            'aria-valuemin': WRITING_PREVIEW_PANEL_WIDTH_MIN,
            'aria-valuemax': WRITING_PREVIEW_PANEL_WIDTH_MAX,
          } as object)}
        >
          <View style={styles.panelResizeHandleGrip} />
        </View>
      )}
      <View style={styles.previewInner}>
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
          <View style={styles.previewBody}>
            {/* Milestone 5.5.3 continuation — diagnostics render at
                their own NATURAL height (never flex:1), same
                convention as the rest of this screen's own audited
                flex/minHeight/overflow architecture: only the ONE
                area that actually needs internal scrolling
                (CompiledPdfPreview's own PDF pages, below) gets
                `flex:1, minHeight:0` — deliberately NOT wrapped in a
                second, outer ScrollView, which would be exactly the
                "flex child + missing minHeight:0 + nested overflow
                container" bug class this app has already been bitten
                by once (see WritingFileTree's own Files-pane fix). If
                diagnostics content is ever long enough to want its own
                scroll, CompileDiagnostics' internal "Show log" box
                already bounds itself via `maxHeight` (a ScrollView, not
                a flex child — no nesting hazard there either). */}
            {diagnosticsPanel}
            {showPdfArea && (
              <View style={styles.previewPdfArea}>
                <CompiledPdfPreview
                  pdfBlob={compiledPdfBlob}
                  loading={compiling}
                  error={null}
                  stale={isPreviewStale}
                  emptyMessage="Compile to see a preview."
                />
              </View>
            )}
          </View>
        )}
      </View>
    </View>
  );

  return (
    <View style={styles.screen}>
      {/* Milestone 5.5.1 Part 3 — a compact workspace header: "← Writing"
          used to be its own full-width row above the title, costing a
          whole row of vertical space for four words. Folded onto the
          SAME row as the title/actions instead — matches the spec's own
          "← Writing   Literature Review" sketch, one row instead of two,
          leaving more room for the actual research/editor workspace. */}
      <View style={styles.header}>
        <View style={styles.headerTitleCol}>
          <View style={styles.headerTitleRow}>
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
            <Text style={styles.headerTitleSeparator}>·</Text>
            <Text style={styles.headerTitle} numberOfLines={1}>
              {project.title}
            </Text>
          </View>
          <Text
            style={[styles.saveStatus, activeFileSaveStatus === 'error' && styles.saveStatusError]}
            accessibilityLiveRegion="polite"
            // Part 12 — documents the Cmd/Ctrl+S shortcut via a native
            // browser tooltip, same cast idiom as the resize handles'
            // onMouseDown (RN's TextProps doesn't declare `title`, but
            // react-native-web forwards it to the underlying DOM node).
            {...webTitle('Cmd/Ctrl+S to save now')}
          >
            {/* Milestone 5.3 — names WHICH file the save status refers to,
                since editing is no longer always main.tex. */}
            {activeFileNode && SAVE_STATUS_LABEL[activeFileSaveStatus]
              ? `${activeFileNode.path} · ${SAVE_STATUS_LABEL[activeFileSaveStatus]}`
              : SAVE_STATUS_LABEL[activeFileSaveStatus]}
          </Text>
        </View>
        <View style={styles.headerActions}>
          {/* Milestone 5.5.1 Part 4/5 — THE one dedicated Research-drawer
              toggle: click to open, click again to close, same
              "analogous to Chat's drawer" affordance as PanelIcon's
              other use (NavRail's own conversation-list toggle). Never
              resets `panelTab` — see researchDrawerOpen/panelTab being
              two independent pieces of state above. */}
          {isWide && (
            <IconButton
              label={researchDrawerOpen ? 'Hide Research panel' : 'Show Research panel'}
              icon={<PanelIcon size={16} color={theme.subtext} open={researchDrawerOpen} />}
              variant="outline"
              size="sm"
              onPress={() => setResearchDrawerOpen((v) => !v)}
            />
          )}
          {/* Milestone 5.2, repointed at the unified Research panel's own
              "Ask EduM8" tab by 5.5 Part 6 — desktop-only: narrow
              viewports already have the "Ask EduM8" mobile tab below
              (Part 11's own "avoid redundant controls" precedent). A
              quick-jump shortcut, not a second source of truth — the
              panel tab strip itself has the exact same control. Distinct
              in INTENT from the drawer toggle right above it (this one
              means "take me to Ask EduM8", opening the drawer if needed
              is incidental to that, not this button's own job) — same
              "one control, one understandable action" reasoning
              NavRail's logo-vs-toggle split documents. */}
          {isWide && (
            <View {...webTitle('Ctrl/Cmd+K')}>
              <Button
                label="Ask EduM8"
                // Distinct from the Research panel's own "Ask EduM8" tab
                // (same visible text, different control) — otherwise two
                // on-screen elements would share one accessibilityLabel,
                // indistinguishable to a screen reader.
                accessibilityLabel="Show Ask EduM8 panel"
                variant={panelTab === 'ask' ? 'primary' : 'secondary'}
                size="sm"
                icon={
                  <SparkleIcon
                    size={14}
                    color={panelTab === 'ask' ? theme.accentContrast : theme.accent}
                  />
                }
                onPress={() => {
                  setPanelTab('ask');
                  setResearchDrawerOpen(true);
                }}
              />
            </View>
          )}
          {latexCompilation && (
            <View {...webTitle('Ctrl/Cmd+Enter to compile')}>
              <Button
                label={compileButtonLabel}
                variant="primary"
                size="sm"
                loading={compiling}
                onPress={() => void handleCompile()}
              />
            </View>
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
          <Notice
            tone="danger"
            body={`Couldn't save your latest edit: ${activeFileSaveError.message}`}
          />
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
      {!isWide && (
        // Milestone 5.5 Part 29 — real-browser validation at 390×844
        // caught this row squeezing 5-6 equal-width (flex: 1) tabs into
        // one line: "Ask EduM8" had no room and wrapped onto a second
        // line inside its own cell while "Preview"/"References" crowded
        // together, reading as broken rather than just dense. A
        // horizontally-scrolling strip (same ScrollView-horizontal
        // idiom as Breadcrumbs.tsx/search.tsx's filter chips) lets each
        // tab keep its natural, unwrapped width instead.
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.mobileTabsScroll}
          contentContainerStyle={styles.mobileTabs}
          accessibilityRole="tablist"
        >
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
            onPress={() => setMobileTab('ask')}
          />
        </ScrollView>
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
              <LatexCodeEditor
                ref={editorRef}
                value={content}
                onValueChange={setActiveFileContent}
                selection={selection}
                onSelectionChange={handleSelectionChange}
                editable={isActiveFileEditable}
                theme={theme}
                placeholder="\\documentclass{article}…"
                autocompleteData={autocompleteData}
                flashLine={flashLine}
                errorLines={activeFileErrorLines}
                accessibilityLabel="LaTeX source editor"
                // Milestone 5.5 Part 12 — see handleShortcutKey's own
                // comment: a raw DOM <textarea> doesn't stop keydown from
                // reaching the document-level listener above the way
                // react-native-web's old TextInput did, but this is wired
                // explicitly anyway — see LatexCodeEditor's own comment on
                // never depending on unforced event bubbling for a
                // release-critical shortcut path.
                onShortcutKeyDown={(e) =>
                  handleShortcutKey(e as unknown as Parameters<typeof handleShortcutKey>[0])
                }
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
            {/* Milestone 5.5.3 continuation — same "Preview owns the
                diagnostics list" placement as desktop's previewInner
                above, mobile's own single-column equivalent. */}
            {diagnosticsPanel}
            {showPdfArea && (
              <View style={styles.previewPdfArea}>
                <CompiledPdfPreview
                  pdfBlob={compiledPdfBlob}
                  loading={compiling}
                  error={null}
                  stale={isPreviewStale}
                  emptyMessage="Compile to see a preview."
                />
              </View>
            )}
          </View>
        )}
        {/* Desktop's Ask EduM8 now renders INSIDE `panel` above, as the
            Research panel's "Ask EduM8" tab (5.5 Part 6) — no separate
            drawer mount here anymore. */}
        {!isWide && mobileTab === 'ask' && (
          <AskEduM8Panel
            visible
            onClose={() => setMobileTab('editor')}
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
      // Milestone 5.5 Part 30 — react-native-web 0.21's createDOMProps
      // only recognizes a flat `aria-selected` prop, not RN's nested
      // `accessibilityState.selected` object (confirmed by reading
      // node_modules/react-native-web/dist/modules/createDOMProps —
      // accessibilityState is never destructured there), so the line
      // above silently produces no `aria-selected` attribute on web,
      // failing WAI-ARIA's required-attribute rule for role="tab".
      // This same accessibilityState={{...}} pattern is used ~25 other
      // places across the app (pre-existing, not introduced by M5.5) —
      // out of scope to sweep all of them here; fixing it on this
      // milestone's own audited surface (the Research tab strip) via
      // the same raw-DOM-prop-cast idiom AppDrawer.tsx already uses.
      {...(Platform.OS === 'web' ? ({ 'aria-selected': active } as object) : {})}
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
      {...(Platform.OS === 'web' ? ({ 'aria-selected': active } as object) : {})}
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
  // Milestone 5.5 Part 29 — no more `flex: 1`: with the strip now
  // horizontally scrollable, each tab should size to its own label
  // ("Ask EduM8" needs more room than "Notes") rather than all six
  // splitting equal width and wrapping the longest ones.
  tab: { alignItems: 'center', paddingVertical: 8, paddingHorizontal: 12, borderRadius: 8 },
  tabText: { fontSize: 12.5 },
});

function buildStyles(theme: Theme) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: theme.background },
    spinner: { marginTop: 60 },
    // Milestone 5.5.1 Part 3 — folded onto the title row (see the render
    // comment above), so this no longer needs its own top padding/row.
    backButton: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 2,
    },
    backChevron: { transform: [{ rotate: '180deg' }] },
    backText: { fontSize: 13, color: theme.subtext, fontFamily: theme.fonts.body },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      // M5.5.3 continuation Part 11 — real mobile pass (390px) found
      // the title column's own `minWidth: 120` plus headerActions'
      // un-shrinking button row (Compile[ failed]/Export/⋯, `isWide`
      // already drops the two desktop-only buttons) genuinely don't
      // both fit in a 390px viewport's remaining ~340px of content
      // width once "Compile failed" — a longer label than plain
      // "Compile" — is showing; the page's own scrollWidth measurably
      // exceeded its viewport width, not just a cosmetic squeeze. Same
      // fix PdfReader.tsx's own analogous toolbar-row overflow already
      // uses: wrap onto a second line rather than force a
      // whole-page horizontal scroll. No effect at desktop widths,
      // where everything already fits on one line.
      flexWrap: 'wrap',
      gap: 16,
      paddingHorizontal: 24,
      paddingVertical: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.border,
    },
    headerTitleCol: { flex: 1, minWidth: 120, gap: 3 },
    headerTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    headerTitleSeparator: { fontSize: 14, color: theme.faint },
    headerTitle: {
      fontSize: theme.scale(18),
      fontFamily: theme.fonts.display,
      color: theme.text,
      letterSpacing: -0.2,
      flexShrink: 1,
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
    // Milestone 5.5 Part 29 — `mobileTabsScroll` is the ScrollView's own
    // `style` (flexGrow: 0 stops it stretching to fill the remaining
    // column height it's now sitting in, which — before this was added —
    // blew the active tab's background pill up to fill most of the
    // screen); `mobileTabs` stays its `contentContainerStyle`, with
    // `alignItems: 'center'` so the row's cross-axis doesn't default to
    // 'stretch' and re-introduce the same problem.
    mobileTabsScroll: { flexGrow: 0, flexShrink: 0 },
    mobileTabs: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingHorizontal: 24,
      paddingVertical: 10,
    },
    body: { flex: 1, flexDirection: 'row' },
    // Milestone 5.5.1 Part 8 — minWidth guards the one column that's
    // ALWAYS meant to flex (fills whatever the fixed-width Research/
    // Preview columns don't take): with both of those now correctly
    // fixed-width instead of fighting for flex space, the editor could
    // otherwise be squeezed to near-zero if a user drags both siblings
    // to their max on a narrower "wide" viewport.
    editorWrap: { flex: 1, minWidth: 320, padding: 24 },
    // Milestone 5.5 Part 6/8 — the unified Research panel is now a ROW
    // (content column + resize handle), not a padded column, since the
    // "Ask EduM8" tab needs full-bleed width the same way it always had
    // as its own drawer (panelBodyPadded below carries the padding the
    // other three tabs still want).
    // Milestone 5.5.1 Part 7 — root cause of the "resize does nothing"
    // report: this column previously had BOTH an explicit `width` AND
    // `flex: 1`. In real CSS flexbox (which react-native-web compiles
    // to), `flex: 1` expands to `flex-grow:1; flex-shrink:1;
    // flex-basis:0%` — and flex-basis, even at 0%, takes priority over
    // `width` for sizing a flex item. Confirmed live: dragging the
    // handle correctly updated React state and the DOM's inline
    // `style="width: ...px"` attribute every step, but
    // getComputedStyle/getBoundingClientRect never moved off the
    // flex-distributed value — the width was being set, just always
    // ignored for layout. `flexGrow: 0, flexShrink: 0` (no flex-basis
    // override) makes `width` authoritative again, matching the two
    // fixed-width flex-row siblings this column was always meant to be.
    panel: {
      width: 320,
      maxWidth: '100%',
      borderRightWidth: StyleSheet.hairlineWidth,
      borderRightColor: theme.border,
      flexDirection: 'row',
      flexGrow: 0,
      flexShrink: 0,
    },
    // Milestone 5.5.1 Part 4/5 — `display: 'none'` hides the whole
    // drawer (including its border) without unmounting it, so every
    // tab's state — most importantly Ask EduM8's live conversation —
    // survives closing and reopening.
    panelHidden: { display: 'none' },
    panelInner: { flex: 1, minWidth: 0 },
    panelBodyPadded: { flex: 1, padding: 20 },
    // The Ask EduM8 tab is full-bleed (AskEduM8Panel owns its own
    // internal padding/scroll regions), unlike the other three tabs.
    panelAskWrap: { flex: 1, minHeight: 0 },
    panelSectionLabel: {
      fontSize: 10.5,
      fontFamily: theme.fonts.bodySemibold,
      color: theme.faint,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
      paddingHorizontal: 20,
      paddingTop: 16,
    },
    panelTabs: { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 20, marginTop: 8 },
    // Same "6px wide, centered on the border, small grip line" idiom as
    // AppDrawer.tsx's own resize handle.
    panelResizeHandle: {
      width: 6,
      marginRight: -3,
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 1,
      ...(Platform.OS === 'web' ? ({ cursor: 'col-resize' } as object) : null),
    },
    panelResizeHandleGrip: { width: 2, height: 32, borderRadius: 1, opacity: 0.6 },
    // Milestone 5.1 Part 25/26/31 — the right-side PDF Preview panel, a
    // ROW (resize handle + content column, in that order since this
    // panel is anchored to the right edge — Part 8) rather than a single
    // padded column.
    // Milestone 5.5.1 Part 7 — same fix, same root cause as `panel` above.
    previewPanel: {
      width: 420,
      maxWidth: '100%',
      borderLeftWidth: StyleSheet.hairlineWidth,
      borderLeftColor: theme.border,
      flexDirection: 'row',
      flexGrow: 0,
      flexShrink: 0,
    },
    previewInner: { flex: 1, minWidth: 0 },
    previewBody: { flex: 1, minHeight: 0 },
    previewPdfArea: { flex: 1, minHeight: 0 },
    previewResizeHandle: {
      width: 6,
      marginLeft: -3,
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 1,
      ...(Platform.OS === 'web' ? ({ cursor: 'col-resize' } as object) : null),
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
