import { useEducationDocuments, useFolderLibrary } from 'education-assistant-client';
import type { DocumentSummary, FolderResponse, UploadableFile } from 'education-assistant-client';
import * as DocumentPicker from 'expo-document-picker';
import { useRouter } from 'expo-router';
import { createElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Notice } from '@/components/ui/Notice';
import { PageHeader } from '@/components/ui/PageHeader';
import { Skeleton } from '@/components/ui/Skeleton';
import { TextField } from '@/components/ui/TextField';
import { Breadcrumbs } from '@/components/Breadcrumbs';
import { MoveToFolderDialog } from '@/components/MoveToFolderDialog';
import { LibraryToolbar } from '@/components/documents/LibraryToolbar';
import { LibraryContentsView } from '@/components/documents/LibraryContentsView';
import { DetailsPanel } from '@/components/documents/DetailsPanel';
import { DuplicateCandidateNotice } from '@/components/documents/DuplicateCandidateNotice';
import { EditMetadataModal } from '@/components/documents/EditMetadataModal';
import { CitationPopover } from '@/components/documents/CitationPopover';
import { AddToWritingProjectModal } from '@/components/writing/AddToWritingProjectModal';
import { DOCUMENT_TYPE_LABELS } from '@/lib/enums';
import { fileExtension, formatFileSize, validateCandidateFile } from '@/lib/documentUpload';
import { downloadTextFile } from '@/lib/downloadTextFile';
import { safeText } from '@/lib/format';
import { useClient } from '@/lib/ClientProvider';
import { useFeatureFlags } from '@/lib/FeatureFlags';
import { usePreferences, useTheme, type Theme } from '@/lib/Preferences';
import {
  libraryItemId,
  sortLibraryContents,
  toDocumentItems,
  toFolderItems,
  type LibraryItem,
  type LibrarySortDirection,
  type LibrarySortKey,
} from '@/lib/libraryItems';
import { useLibrarySelection } from '@/lib/useLibrarySelection';
import { useLibraryDnD } from '@/lib/useLibraryDnD';
import {
  SAMPLE_DOCUMENT_FILENAME,
  SAMPLE_DOCUMENT_TITLE,
  buildSampleUploadFile,
  isSampleSource,
} from '@/lib/sampleDocument';

/** Below this width, the optional details panel (requirement #12) never
 * shows — there's no room for a third column next to the library and the
 * upload form, and mobile/tablet already fall back to tap + the actions
 * menu (requirement #17). */
const DESKTOP_DETAILS_PANEL_BREAKPOINT_PX = 900;

/**
 * Converts a picked DocumentPicker asset into the shape the SDK's
 * uploadDocument() actually needs to hand a real Blob/File to FormData.
 *
 * On web, `asset.uri` is a `blob:`/`data:` URI, not a filesystem path —
 * passing `{ uri, name, type }` (the React Native FormData-polyfill shape)
 * to a *real* browser FormData.append() throws "parameter 2 is not of type
 * 'Blob'", because the browser has no polyfill to interpret that plain
 * object. `expo-document-picker` already gives us `asset.file` (a real
 * File) on web in the common case; the fetch(asset.uri)+blob() fallback
 * only matters if that's ever missing. Wrapping the fetched Blob in `new
 * File(...)` (rather than appending a bare Blob) means FormData keeps the
 * original filename automatically — a bare Blob has no name and would
 * upload as "blob".
 *
 * On iOS/Android, `asset.uri` is a real file:// path, which React Native's
 * FormData polyfill *does* understand as `{ uri, name, type }` — that shape
 * must NOT be used on web and a real File/Blob must NOT be constructed on
 * native (there is no browser File/Blob backing a native file:// URI).
 */
async function buildUploadableFileFromPickerAsset(
  asset: DocumentPicker.DocumentPickerAsset
): Promise<UploadableFile> {
  if (Platform.OS === 'web') {
    if (asset.file instanceof File) {
      return asset.file;
    }
    const response = await fetch(asset.uri);
    const blob = await response.blob();
    return new File([blob], asset.name, { type: asset.mimeType || blob.type });
  }
  return { uri: asset.uri, name: asset.name, type: asset.mimeType ?? 'application/octet-stream' };
}

/** Maps DocumentJobResponse.stage to display text for the 'processing' upload state below. */
const STAGE_LABELS: Record<'embedding' | 'indexing' | 'persisting', string> = {
  embedding: 'Embedding',
  indexing: 'Indexing',
  persisting: 'Saving',
};

/** Whatever the user most recently picked or dropped — one file at a time, from either path (see requirement that picker and drop share one selection/upload flow). `size`/`mimeType` are `null` when the source couldn't report them (some native pickers omit size). */
interface SelectedFile {
  file: UploadableFile;
  name: string;
  size: number | null;
  mimeType: string | null;
}

export default function DocumentsScreen() {
  const theme = useTheme();
  const styles = useMemo(() => buildStyles(theme), [theme]);
  const { client, hydrated } = useClient();
  const featureFlags = useFeatureFlags();
  const router = useRouter();
  const {
    listState,
    refresh,
    uploadState,
    upload,
    resetUpload,
    previewState,
    previewMetadata,
    resetPreview,
    deleteStates,
    deleteDocument,
    resetDeleteState,
  } = useEducationDocuments(client);
  // Milestone 1 (Document Library / Folder Management) — the folder-aware
  // listing/navigation data source, used instead of `listState` above
  // whenever featureFlags.folderLibrary is true (see
  // FeatureFlags.tsx's docs: false falls back to the exact pre-Milestone-1
  // flat list, unaffected by anything below).
  const folderLibrary = useFolderLibrary(client);
  const [newFolderFormOpen, setNewFolderFormOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [createFolderError, setCreateFolderError] = useState<string | null>(null);
  const [movingDocument, setMovingDocument] = useState<DocumentSummary | null>(null);
  const [movingFolder, setMovingFolder] = useState<FolderResponse | null>(null);
  // Milestone 4 (Reference Library & Bibliographic Metadata Foundation)
  // Section 9 — the "Edit metadata" action's local state, same shape as
  // movingDocument above.
  const [editingMetadataDocument, setEditingMetadataDocument] = useState<DocumentSummary | null>(
    null
  );
  const [savingMetadata, setSavingMetadata] = useState(false);
  const [metadataSaveError, setMetadataSaveError] = useState<string | null>(null);
  // Milestone 4.1 (Authoritative Metadata Enrichment & Duplicate
  // Awareness) Section 11 — "Refresh metadata" is a separate in-flight
  // flag from savingMetadata: the two actions are mutually exclusive in
  // the UI (EditMetadataModal disables both while either is busy) but are
  // conceptually different requests, so they don't share one flag.
  const [refreshingMetadata, setRefreshingMetadata] = useState(false);
  // Milestone 4.2 (Citation & BibTeX Foundation) Section 24 — the
  // Citation popover's local state, same "one document at a time" shape
  // as editingMetadataDocument above.
  const [citationDocument, setCitationDocument] = useState<DocumentSummary | null>(null);
  const [exportingBibtex, setExportingBibtex] = useState(false);
  // Milestone 5 (Academic Writing & LaTeX Foundation) Part 34 — "Add to
  // writing project" from the multi-selection bar; null document ids
  // means the modal is closed.
  const [writingProjectPickerDocumentIds, setWritingProjectPickerDocumentIds] = useState<
    string[] | null
  >(null);
  const [deletingFolderIds, setDeletingFolderIds] = useState<ReadonlySet<string>>(new Set());
  const [folderActionError, setFolderActionError] = useState<string | null>(null);
  // Folder-library document rows manage their own delete state directly
  // through the client (rather than useEducationDocuments' deleteStates,
  // which optimistically mutates `listState` — the flat list this view
  // doesn't render) so a deletion here reliably refreshes the *folder*
  // listing it actually affects.
  const [deletingDocumentIds, setDeletingDocumentIds] = useState<ReadonlySet<string>>(new Set());
  const [documentActionError, setDocumentActionError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<SelectedFile | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [sampleError, setSampleError] = useState<string | null>(null);
  // Frontend/Platform Milestone 3.2.1 Part D — library search (title/
  // filename, across every folder). `searchInput` is the live text field;
  // `activeSearchQuery` is only set on submit, so search results replace
  // the normal Finder-style view exactly when the user asked for them
  // (not on every keystroke) and "Clear search" has an unambiguous
  // "go back to" state. Reuses `listState`/`refresh` from
  // useEducationDocuments above — that hook's flat list is otherwise
  // unrendered whenever featureFlags.folderLibrary is true, so this
  // never conflicts with the folder-tree view's own data.
  const [searchInput, setSearchInput] = useState('');
  const [activeSearchQuery, setActiveSearchQuery] = useState('');

  function handleSearchSubmit(): void {
    const trimmed = searchInput.trim();
    if (!trimmed) return;
    setActiveSearchQuery(trimmed);
    refresh({ q: trimmed, limit: 50 });
  }

  function handleClearSearch(): void {
    setSearchInput('');
    setActiveSearchQuery('');
  }
  const [authorsText, setAuthorsText] = useState('');
  const [publicationYearText, setPublicationYearText] = useState('');
  const [sourceVenue, setSourceVenue] = useState('');
  const [doi, setDoi] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  // Milestone 4.1 (Authoritative Metadata Enrichment & Duplicate
  // Awareness) Section 24/28 — "Keep both" only ever dismisses this
  // banner locally; it never changes anything about the upload itself
  // (there is nothing to "confirm" server-side — the actual upload
  // proceeds identically whether or not a duplicate candidate exists).
  // Reset to false whenever a new preview arrives (see the effect below)
  // so a freshly picked file always gets its own, un-dismissed warning.
  const [duplicateWarningDismissed, setDuplicateWarningDismissed] = useState(false);
  // Frontend Milestone 1 (Finder-style Document Library): overrides the
  // upload target folder for exactly one upload — set when a file is
  // dropped from the OS directly onto the library area/a folder card
  // (requirement #8) rather than picked/dropped on the upload form above.
  // `null` inside the wrapper means "root"; the wrapper itself absent
  // means "no override, use whichever folder is currently open" (the
  // pre-existing behavior). Reset alongside the rest of the form.
  const [libraryUploadTarget, setLibraryUploadTarget] = useState<{
    folderId: string | null;
  } | null>(null);

  const { preferences, update: updatePreferences } = usePreferences();
  const documentsViewMode = preferences.documentsViewMode;
  const [sortKey, setSortKey] = useState<LibrarySortKey>('name');
  const [sortDirection, setSortDirection] = useState<LibrarySortDirection>('asc');
  const [detailsPanelOpen, setDetailsPanelOpen] = useState(true);
  const { width: windowWidth } = useWindowDimensions();
  const isDesktopWidth = windowWidth >= DESKTOP_DETAILS_PANEL_BREAKPOINT_PX;
  const selection = useLibrarySelection();
  const scrollViewRef = useRef<ScrollView>(null);

  const folderContents =
    folderLibrary.contentsState.status === 'success' ? folderLibrary.contentsState.contents : null;
  // Root→…→currently-open-folder id chain (includes the open folder
  // itself — see routes_folders.py's own breadcrumbs field) — fed to
  // useLibraryDnD purely to build each drop target's cycle-guard
  // ancestor chain, never re-fetched separately (requirement #16).
  const breadcrumbIds = useMemo(
    () => (folderContents?.breadcrumbs ?? []).map((crumb) => crumb.id),
    [folderContents]
  );
  const sortedContents = useMemo(
    () =>
      sortLibraryContents(
        folderContents?.folders ?? [],
        folderContents?.documents ?? [],
        sortKey,
        sortDirection
      ),
    [folderContents, sortKey, sortDirection]
  );
  const libraryItemsById = useMemo(() => {
    const map = new Map<string, LibraryItem>();
    toFolderItems(sortedContents.folders).forEach((item) => map.set(libraryItemId(item), item));
    toDocumentItems(sortedContents.documents).forEach((item) => map.set(libraryItemId(item), item));
    return map;
  }, [sortedContents]);

  // Drops any selected id that's no longer part of the currently-open
  // folder's contents — covers both navigating to a different folder and
  // an item disappearing after a move/delete/refresh.
  useEffect(() => {
    selection.pruneSelection(Array.from(libraryItemsById.keys()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [libraryItemsById]);

  const selectedLibraryItem =
    selection.selectedCount === 1
      ? (libraryItemsById.get(Array.from(selection.selectedIds)[0]!) ?? null)
      : null;
  const selectedDocumentCount = Array.from(selection.selectedIds).filter(
    (id) => libraryItemsById.get(id)?.kind === 'document'
  ).length;
  const currentFolderLocationLabel = folderContents?.folder
    ? safeText(folderContents.folder.name, 'Untitled folder')
    : 'My Library';
  const deletingItemIds = useMemo(
    () => new Set([...deletingFolderIds, ...deletingDocumentIds]),
    [deletingFolderIds, deletingDocumentIds]
  );

  // Web-only drag-and-drop state. `isDragOver` drives the highlight;
  // `dragCounterRef` is what makes that highlight reliable across nested
  // children — dragenter/dragleave fire once per element boundary crossed,
  // so a drag that passes over a child element inside the drop zone fires
  // a dragleave (parent) + dragenter (child) pair that would otherwise
  // flicker the highlight off and back on. Counting enter/leave pairs and
  // only clearing the highlight when the count returns to zero absorbs
  // that without caring how many nested elements there are.
  const [isDragOver, setIsDragOver] = useState(false);
  const dragCounterRef = useRef(0);
  const dropZoneCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    // Waits for hydration: GET /documents requires auth, so firing this
    // before the stored token has loaded would surface a spurious "missing
    // token" error on first mount that never automatically retries (this
    // effect only runs once baseUrl/token are known, not on every render).
    if (!hydrated) return;
    if (featureFlags.folderLibrary) {
      folderLibrary.navigate(null);
    } else {
      refresh({ limit: 20 });
    }
    // Re-fires if the flag itself flips (e.g. an admin disables it and
    // GET /status's next foreground-focus refresh picks that up — see
    // FeatureFlagsProvider) so this screen switches data source live
    // rather than only at the very first mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, featureFlags.folderLibrary]);

  function resetMetadataFields(): void {
    setAuthorsText('');
    setPublicationYearText('');
    setSourceVenue('');
    setDoi('');
    setSourceUrl('');
  }

  // Single entry point for "the user has now selected this file" from
  // *either* the native/web file picker or the web drop zone — the only
  // place validateCandidateFile() is ever called, so the two selection
  // paths can never diverge on what counts as a valid file. A file that
  // passes local validation also triggers POST /documents/metadata-preview
  // (see useEducationDocuments) so detected fields can be shown as
  // editable before the user actually uploads — an invalid file skips
  // that call entirely, since it would only ever fail the same way a real
  // upload would.
  const applySelectedFile = useCallback(
    (candidate: SelectedFile) => {
      setSelectedFile(candidate);
      resetMetadataFields();
      // Cleared by default on every new selection — handleExternalFileDrop
      // (below) sets it again, synchronously right after calling this, when
      // the selection came from dropping a file onto a specific library
      // folder rather than picked/dropped on the upload form itself.
      setLibraryUploadTarget(null);
      const validationError = validateCandidateFile(candidate.name, candidate.size);
      setFileError(validationError);
      if (validationError) {
        resetPreview();
      } else {
        previewMetadata(candidate.file);
      }
    },
    [previewMetadata, resetPreview]
  );

  // Frontend Milestone 1 (Finder-style Document Library) — requirement #8:
  // a file dragged in from the user's OS (not from within this page) and
  // dropped on the library area or a specific folder card. Reuses
  // applySelectedFile() exactly (duplicate-check + metadata preview +
  // manual review before the user presses Upload), the same as picking a
  // file or dropping one on the upload form's own drop zone — never a
  // silent auto-upload that would skip that review.
  const handleExternalFileDrop = useCallback(
    (file: File, targetFolderId: string | null) => {
      applySelectedFile({ file, name: file.name, size: file.size, mimeType: file.type || null });
      setLibraryUploadTarget({ folderId: targetFolderId });
      // The review form (title/type/metadata + the actual Upload button)
      // lives in the Upload section above the library — scroll it into
      // view so a file dropped onto a folder card further down the page
      // doesn't silently stage without the user noticing.
      scrollViewRef.current?.scrollTo({ y: 0, animated: true });
    },
    [applySelectedFile]
  );

  const selectOnlyForDrag = useCallback(
    (id: string) => selection.selectItem(id, [id], { toggle: false, range: false }),
    [selection]
  );

  const libraryDnD = useLibraryDnD({
    client,
    visibleFolders: sortedContents.folders,
    visibleDocuments: sortedContents.documents,
    breadcrumbFolderIds: breadcrumbIds,
    selectedIds: selection.selectedIds,
    selectOnly: selectOnlyForDrag,
    onMoveSettled: folderLibrary.refresh,
    onExternalFileDrop: handleExternalFileDrop,
  });

  // Populates the editable fields from the backend's detected metadata once
  // a preview resolves — the user can still change any of these before
  // pressing Upload (see requirement that detected values are a starting
  // point, never forced).
  useEffect(() => {
    if (previewState.status !== 'success') return;
    const { preview } = previewState;
    setAuthorsText((preview.authors ?? []).join(', '));
    setPublicationYearText(
      preview.publication_year != null ? String(preview.publication_year) : ''
    );
    setSourceVenue(preview.source_venue ?? '');
    setDoi(preview.doi ?? '');
    setSourceUrl(preview.source_url ?? '');
    setDuplicateWarningDismissed(false);
  }, [previewState]);

  // react-native-web's <View> only forwards a fixed whitelist of DOM props
  // (accessibility/click/focus/keyboard/mouse/touch) — onDragEnter/
  // onDragOver/onDragLeave/onDrop are silently dropped if passed as props.
  // A plain host <div> (rendered below via createElement, only on web —
  // see the JSX) is what this ref attaches to instead, so real browser
  // drag-and-drop can be wired imperatively against it here.
  //
  // Deliberately a *callback* ref, not useRef()+useEffect(): the div only
  // ever mounts once this screen's own `hydrated` gate (above) has already
  // resolved, and a plain useEffect keyed on stable dependencies (nothing
  // here needs to change once mounted) only ever runs against the ref's
  // value *at that time* — which is still null on the very first render,
  // before `hydrated` flips. It would never re-run once the div actually
  // exists. A callback ref instead fires exactly when React attaches
  // (node present) or detaches (node null, on unmount or a Platform branch
  // change) the real element, whenever that happens to be.
  const dropZoneRefCallback = useCallback(
    (node: HTMLDivElement | null) => {
      dropZoneCleanupRef.current?.();
      dropZoneCleanupRef.current = null;
      if (!node || Platform.OS !== 'web') return;

      function isFileDrag(event: DragEvent): boolean {
        return Array.from(event.dataTransfer?.types ?? []).includes('Files');
      }

      function onDragEnter(event: DragEvent): void {
        if (!isFileDrag(event)) return;
        event.preventDefault();
        dragCounterRef.current += 1;
        setIsDragOver(true);
      }

      function onDragOver(event: DragEvent): void {
        if (!isFileDrag(event)) return;
        // Required for `drop` to fire at all — without this, the browser's
        // default action for a dropped file is to navigate to/open it.
        event.preventDefault();
      }

      function onDragLeave(event: DragEvent): void {
        if (!isFileDrag(event)) return;
        event.preventDefault();
        dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
        if (dragCounterRef.current === 0) setIsDragOver(false);
      }

      function onDrop(event: DragEvent): void {
        event.preventDefault(); // same as above: stops the browser opening the file itself
        dragCounterRef.current = 0;
        setIsDragOver(false);
        const file = event.dataTransfer?.files?.[0];
        if (!file) return;
        applySelectedFile({ file, name: file.name, size: file.size, mimeType: file.type || null });
      }

      node.addEventListener('dragenter', onDragEnter);
      node.addEventListener('dragover', onDragOver);
      node.addEventListener('dragleave', onDragLeave);
      node.addEventListener('drop', onDrop);
      dropZoneCleanupRef.current = () => {
        node.removeEventListener('dragenter', onDragEnter);
        node.removeEventListener('dragover', onDragOver);
        node.removeEventListener('dragleave', onDragLeave);
        node.removeEventListener('drop', onDrop);
      };
    },
    [applySelectedFile]
  );

  async function handlePickFile(): Promise<void> {
    const picked = await DocumentPicker.getDocumentAsync({
      type: '*/*',
      copyToCacheDirectory: true,
    });
    if (picked.canceled || picked.assets.length === 0) return;
    const asset = picked.assets[0]!;

    try {
      const file = await buildUploadableFileFromPickerAsset(asset);
      applySelectedFile({
        file,
        name: asset.name,
        size: asset.size ?? null,
        mimeType: asset.mimeType ?? null,
      });
    } catch (error) {
      setSelectedFile(null);
      setFileError(
        `Couldn't read "${asset.name}": ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  function handleClearFile(): void {
    setSelectedFile(null);
    setFileError(null);
    resetPreview();
    resetMetadataFields();
    setLibraryUploadTarget(null);
  }

  function handleUpload(): void {
    if (!selectedFile || fileError) return;
    const authors = authorsText
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name.length > 0);
    const parsedYear = Number.parseInt(publicationYearText.trim(), 10);

    upload(selectedFile.file, {
      // Frontend/Platform Milestone 3.2.1 Part C: documentType/
      // journalQuartile/title are no longer collected in the normal
      // upload UI (see this milestone's report) — omitted here rather
      // than sent as a guessed/forced value; the backend defaults
      // document_type to "unknown" and re-derives title from the file's
      // own metadata or filename (already-existing fallback behavior,
      // unrelated to this milestone — see app/ingestion/ingest.py).
      authors: authors.length > 0 ? authors : undefined,
      publicationYear: Number.isFinite(parsedYear) ? parsedYear : undefined,
      sourceVenue: sourceVenue.trim() || undefined,
      doi: doi.trim() || undefined,
      sourceUrl: sourceUrl.trim() || undefined,
      // Milestone 1 (Document Library / Folder Management): uploads land
      // directly in whichever folder is currently open (undefined at root,
      // matching the pre-Milestone-1 "always root" behavior) — see
      // requirement #6 (folder upload). No-op when the flag is off:
      // folderLibrary.currentFolderId never leaves null in that case since
      // navigate() is never called (see the load effect above).
      //
      // Frontend Milestone 1 (Finder-style Document Library), requirement
      // #8: `libraryUploadTarget` overrides this to whichever folder an
      // externally-dropped file actually landed on, when that isn't the
      // currently-open folder (e.g. dropped directly on a folder card).
      folderId: featureFlags.folderLibrary
        ? ((libraryUploadTarget ? libraryUploadTarget.folderId : folderLibrary.currentFolderId) ??
          undefined)
        : undefined,
    });
  }

  function handleLoadSampleCorpus(): void {
    // Dev-only (see the __DEV__ gate below): builds the bundled fictional
    // sample text into an UploadableFile (platform-specific — see
    // buildSampleUploadFile) so it can be uploaded through the exact same
    // multipart path as a real picked file — no separate "fake upload" code
    // path to keep honest.
    setSampleError(null);
    let sampleFile: UploadableFile;
    try {
      sampleFile = buildSampleUploadFile();
    } catch (error) {
      // Building the sample file is synchronous and happens before upload()
      // is ever called, so a failure here can't flow through uploadState —
      // it must be caught here or it becomes an uncaught exception that
      // crashes the whole route instead of showing an error.
      setSampleError(error instanceof Error ? error.message : String(error));
      return;
    }
    // Deliberately bypasses applySelectedFile()'s metadata-preview call: the
    // sample corpus already has known-good, hardcoded metadata below, so
    // there is nothing to detect and nothing for the user to review.
    setSelectedFile({
      file: sampleFile,
      name: SAMPLE_DOCUMENT_FILENAME,
      size: sampleFile instanceof Blob ? sampleFile.size : null,
      mimeType: 'text/markdown',
    });
    setFileError(null);
    resetPreview();
    resetMetadataFields();
    upload(sampleFile, { documentType: 'curriculum_document', title: SAMPLE_DOCUMENT_TITLE });
  }

  function handleUploadDone(): void {
    resetUpload();
    handleClearFile();
    if (featureFlags.folderLibrary) {
      folderLibrary.refresh();
    } else {
      refresh({ limit: 20 });
    }
  }

  function handleDeletePress(doc: DocumentSummary): void {
    const label = safeText(doc.title, doc.source_filename);
    const message = `Delete "${label}"? This removes the document and all its indexed chunks. This cannot be undone.`;

    if (Platform.OS === 'web') {
      if (window.confirm(message)) {
        deleteDocument(doc.document_id);
      }
      return;
    }

    Alert.alert('Delete document', message, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => deleteDocument(doc.document_id) },
    ]);
  }

  // --- Milestone 1 (Document Library / Folder Management) handlers -------

  function handleFolderDeleteDocument(doc: DocumentSummary): void {
    const label = safeText(doc.title, doc.source_filename);
    const message = `Delete "${label}"? This removes the document and all its indexed chunks. This cannot be undone.`;
    const run = (): void => {
      setDeletingDocumentIds((prev) => new Set(prev).add(doc.document_id));
      setDocumentActionError(null);
      client
        .deleteDocument(doc.document_id)
        .then(() => folderLibrary.refresh())
        .catch((error: unknown) => {
          setDocumentActionError(error instanceof Error ? error.message : String(error));
        })
        .finally(() => {
          setDeletingDocumentIds((prev) => {
            const next = new Set(prev);
            next.delete(doc.document_id);
            return next;
          });
        });
    };

    if (Platform.OS === 'web') {
      if (window.confirm(message)) run();
      return;
    }
    Alert.alert('Delete document', message, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: run },
    ]);
  }

  // Milestone 4 Section 9 — "Edit metadata": PATCH-only, never re-uploads/
  // re-chunks/re-embeds (see EducationAssistantClient.updateDocumentMetadata's
  // own docstring). refresh() afterward keeps this screen's list/details
  // panel in sync, same convention as every other Documents Library
  // mutation (move/delete/rename) above.
  async function handleSaveMetadata(
    diff: Parameters<typeof client.updateDocumentMetadata>[1]
  ): Promise<void> {
    if (!editingMetadataDocument) return;
    setSavingMetadata(true);
    setMetadataSaveError(null);
    try {
      await client.updateDocumentMetadata(editingMetadataDocument.document_id, diff);
      folderLibrary.refresh();
      setEditingMetadataDocument(null);
    } catch (error) {
      setMetadataSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setSavingMetadata(false);
    }
  }

  // Milestone 4.1 Section 11 — "Refresh metadata": unlike Save, this does
  // NOT close the modal (the user should see the result summary
  // EditMetadataModal renders from the returned outcome) and keeps
  // editingMetadataDocument pointed at the FRESH DocumentSummary the
  // backend returns, so has_usable_doi/enrichment_status/etc. and any
  // field the merge actually changed are reflected immediately without a
  // second request. folderLibrary.refresh() runs in the background so the
  // list/details panel outside the modal stay in sync too.
  async function handleRefreshMetadata() {
    if (!editingMetadataDocument) {
      throw new Error('No document is being edited');
    }
    setRefreshingMetadata(true);
    try {
      const result = await client.enrichDocumentMetadata(editingMetadataDocument.document_id);
      setEditingMetadataDocument(result.document);
      folderLibrary.refresh();
      return result;
    } finally {
      setRefreshingMetadata(false);
    }
  }

  async function handleCreateFolder(): Promise<void> {
    const name = newFolderName.trim();
    if (!name || creatingFolder) return;
    setCreatingFolder(true);
    setCreateFolderError(null);
    try {
      await folderLibrary.createFolder(name);
      setNewFolderFormOpen(false);
      setNewFolderName('');
    } catch (error) {
      setCreateFolderError(error instanceof Error ? error.message : String(error));
    } finally {
      setCreatingFolder(false);
    }
  }

  function handleFolderDelete(folder: FolderResponse): void {
    const isEmpty = folder.folder_count === 0 && folder.document_count === 0;
    const run = (moveContentsToRoot: boolean): void => {
      setDeletingFolderIds((prev) => new Set(prev).add(folder.id));
      setFolderActionError(null);
      folderLibrary
        .deleteFolder(folder.id, { moveContentsToRoot })
        .catch((error: unknown) => {
          setFolderActionError(error instanceof Error ? error.message : String(error));
        })
        .finally(() => {
          setDeletingFolderIds((prev) => {
            const next = new Set(prev);
            next.delete(folder.id);
            return next;
          });
        });
    };

    // Frontend Milestone 1 (Finder-style Document Library): the actions
    // menu's Delete item calls this directly (there is no longer a
    // dedicated per-row delete button with its own pre-confirmation, as
    // the pre-redesign FolderRow had) — an empty folder still gets a
    // plain confirm here, so deleting one is never a single accidental
    // click either way.
    if (isEmpty) {
      const label = safeText(folder.name, 'this folder');
      const message = `Delete "${label}"? This cannot be undone.`;
      if (Platform.OS === 'web') {
        if (window.confirm(message)) run(false);
        return;
      }
      Alert.alert('Delete folder', message, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: () => run(false) },
      ]);
      return;
    }
    const label = safeText(folder.name, 'this folder');
    const message =
      `"${label}" contains ${folder.folder_count} folder(s) and ${folder.document_count} ` +
      'document(s). Move them to My Library and delete this folder? Nothing inside will be deleted.';
    if (Platform.OS === 'web') {
      if (window.confirm(message)) run(true);
      return;
    }
    Alert.alert('Folder is not empty', message, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Move contents & delete', style: 'destructive', onPress: () => run(true) },
    ]);
  }

  // --- Frontend Milestone 2 (Chat Sources & Zoom-In Workspace UX) -------
  //
  // "Use in chat": Documents and Chat are separate routes, and a genuine
  // same-gesture HTML5 drag from a Documents card into Chat's composer is
  // not achievable — the browser only starts a real OS drag session from
  // a trusted mouse-down-and-move gesture, and there is no way to trigger
  // an SPA route change *during* that same held-mouse-button gesture (no
  // link/button is clickable while the button is down for a drag), so the
  // Chat page (and its drop target) can never exist yet for the drop to
  // land on. This isn't a "fragile global drag state" problem to work
  // around — it's a hard browser/OS constraint. See the milestone report's
  // "Drag / Use-in-Chat Behavior" section for the full writeup, including
  // why a document dragged onto the (persistent) nav rail was considered
  // and deliberately not built this milestone.
  //
  // Instead: a deterministic action, reusing chat/new.tsx's own pending-
  // source architecture exactly as instructed — no parallel source state,
  // no extra fetch on either side of the navigation (the document's id and
  // display name are already in hand from whatever list/card the user
  // acted on).
  function navigateToChatWithSources(docs: { documentId: string; displayName: string }[]): void {
    if (docs.length === 0) return;
    router.push({ pathname: '/chat/new', params: { sources: JSON.stringify(docs) } });
  }

  // Frontend Milestone 3 (Document Reader): the stable per-document route
  // — see app/(tabs)/documents/[id].tsx. document_id is already a stable,
  // globally-unique identifier (see the backend's Document model docs),
  // so this is the only thing the URL needs to carry; the reader fetches
  // everything else itself.
  function handleOpenDocument(doc: DocumentSummary): void {
    router.push(`/documents/${encodeURIComponent(doc.document_id)}`);
  }

  function handleUseInChat(doc: DocumentSummary): void {
    navigateToChatWithSources([
      { documentId: doc.document_id, displayName: safeText(doc.title, doc.source_filename) },
    ]);
  }

  function handleUseSelectedInChat(): void {
    const docs = Array.from(selection.selectedIds)
      .map((id) => libraryItemsById.get(id))
      .filter(
        (item): item is Extract<LibraryItem, { kind: 'document' }> => item?.kind === 'document'
      )
      .map((item) => ({
        documentId: item.data.document_id,
        displayName: safeText(item.data.title, item.data.source_filename),
      }));
    navigateToChatWithSources(docs);
  }

  // Milestone 4.2 (Citation & BibTeX Foundation) Section 20/21 — reuses
  // Documents' existing multi-selection architecture (same selectedIds
  // source handleUseSelectedInChat above already reads) rather than a
  // separate Reference page built solely for export.
  async function handleExportBibtexSelected(): Promise<void> {
    const documentIds = Array.from(selection.selectedIds)
      .map((id) => libraryItemsById.get(id))
      .filter(
        (item): item is Extract<LibraryItem, { kind: 'document' }> => item?.kind === 'document'
      )
      .map((item) => item.data.document_id);
    if (documentIds.length === 0) return;
    setExportingBibtex(true);
    setDocumentActionError(null);
    try {
      const result = await client.exportBibtex({ documentIds });
      await downloadTextFile('references.bib', result.bibtex, 'application/x-bibtex');
      const skippedCount = result.skipped_document_ids?.length ?? 0;
      if (skippedCount > 0) {
        setDocumentActionError(
          `Exported ${result.count} of ${documentIds.length} references — ` +
            `${skippedCount} could not be found.`
        );
      }
    } catch {
      setDocumentActionError('Could not export BibTeX for the selected references.');
    } finally {
      setExportingBibtex(false);
    }
  }

  // Milestone 5 (Academic Writing & LaTeX Foundation) Part 34 — reuses
  // the exact same selectedIds source handleUseSelectedInChat/
  // handleExportBibtexSelected already read.
  function handleAddSelectedToWritingProject(): void {
    const documentIds = Array.from(selection.selectedIds)
      .map((id) => libraryItemsById.get(id))
      .filter(
        (item): item is Extract<LibraryItem, { kind: 'document' }> => item?.kind === 'document'
      )
      .map((item) => item.data.document_id);
    if (documentIds.length === 0) return;
    setWritingProjectPickerDocumentIds(documentIds);
  }

  if (!hydrated) {
    return (
      <View style={styles.screenCentered}>
        <ActivityIndicator color={theme.accent} />
      </View>
    );
  }

  const isUploading = uploadState.status === 'uploading' || uploadState.status === 'processing';
  const canUpload = selectedFile !== null && !fileError && !isUploading;
  // What the "Uploads land in …" hint (below) names — the override target
  // when a file was dropped directly on a specific folder card
  // (requirement #8), otherwise whichever folder is currently open.
  const uploadTargetFolderName = libraryUploadTarget
    ? libraryUploadTarget.folderId === null
      ? 'My Library'
      : (() => {
          const target = libraryItemsById.get(libraryUploadTarget.folderId);
          return target?.kind === 'folder' ? safeText(target.data.name, 'this folder') : null;
        })()
    : (folderContents?.folder?.name ?? null);
  const chooseFileButton = (
    <Button
      label="Choose file…"
      variant="secondary"
      size="sm"
      onPress={handlePickFile}
      disabled={isUploading}
    />
  );

  return (
    <View style={styles.container}>
      <PageHeader title="Documents" />
      <ScrollView ref={scrollViewRef} contentContainerStyle={styles.content}>
        <View style={styles.pageInner}>
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Upload</Text>
            <Text style={styles.hint}>
              Parsing and duplicate checks happen immediately; embedding and indexing run in the
              background afterward and can take a while on this hardware — progress is shown below.
              {featureFlags.folderLibrary &&
                uploadTargetFolderName &&
                ` Uploads land in "${uploadTargetFolderName}".`}
            </Text>

            {Platform.OS === 'web'
              ? createElement(
                  // A plain host <div>, not <View> — react-native-web's View
                  // silently drops onDrag*/onDrop props (they're not in its
                  // forwarded-props whitelist), and its ref resolves to a
                  // class-component instance rather than the DOM node either
                  // way. A raw div gives dropZoneRefCallback a real element to
                  // attach native drag-and-drop listeners to (see above), while
                  // every visible/styled piece below stays an ordinary RN
                  // View/Text/Pressable.
                  'div',
                  { ref: dropZoneRefCallback, 'data-testid': 'document-drop-zone' },
                  <View
                    key="drop-zone-content"
                    testID="document-drop-zone-highlight"
                    style={[styles.dropZone, isDragOver && styles.dropZoneActive]}
                  >
                    <Text style={styles.dropZoneText}>
                      Drag and drop a PDF, DOCX, TXT, or HTML file here
                    </Text>
                    <Text style={styles.dropZoneOr}>or</Text>
                    {chooseFileButton}
                  </View>
                )
              : chooseFileButton}

            {selectedFile && (
              <View style={styles.selectedFileBox}>
                <View style={styles.selectedFileMain}>
                  <Text style={styles.selectedFileName}>{selectedFile.name}</Text>
                  <Text style={styles.hint}>
                    {selectedFile.mimeType ?? (fileExtension(selectedFile.name) || 'Unknown type')}
                    {selectedFile.size !== null ? ` · ${formatFileSize(selectedFile.size)}` : ''}
                  </Text>
                </View>
                <Button
                  label="Remove"
                  variant="ghost"
                  size="sm"
                  onPress={handleClearFile}
                  accessibilityLabel="Remove selected file"
                  disabled={isUploading}
                />
              </View>
            )}
            {fileError && <Notice tone="danger" body={fileError} />}

            {__DEV__ && (
              <View style={styles.sampleBox}>
                <Text style={styles.sampleBoxText}>
                  Dev only: no real documents on hand? Load one small fictional sample document to
                  try chat/search/citations end to end. Never treat it as real research evidence —
                  remove it afterward with{' '}
                  <Text style={styles.sampleBoxCode}>
                    python -m cli.documents remove &lt;id&gt;
                  </Text>{' '}
                  on the backend.
                </Text>
                <Button
                  label="Load sample corpus (dev only)"
                  variant="secondary"
                  size="sm"
                  onPress={handleLoadSampleCorpus}
                  disabled={isUploading}
                />
                {sampleError && <Notice tone="danger" body={sampleError} />}
              </View>
            )}

            {selectedFile && (
              <View style={styles.metadataReview}>
                {previewState.status === 'loading' && (
                  <View style={styles.centered}>
                    <ActivityIndicator size="small" color={theme.accent} />
                    <Text style={styles.hint}>Detecting metadata…</Text>
                  </View>
                )}
                {previewState.status === 'error' && (
                  <Text style={styles.hint}>
                    Couldn&apos;t auto-detect metadata for this file — you can still fill it in
                    manually below.
                  </Text>
                )}
                <Text style={styles.hint}>
                  Review the detected fields below and edit anything that&apos;s wrong before
                  uploading.
                </Text>

                {previewState.status === 'success' &&
                  previewState.preview.duplicate_candidate &&
                  !duplicateWarningDismissed && (
                    <DuplicateCandidateNotice
                      candidate={previewState.preview.duplicate_candidate}
                      onOpenExisting={() => {
                        router.push(
                          `/documents/${previewState.preview.duplicate_candidate!.document_id}`
                        );
                      }}
                      onKeepBoth={() => setDuplicateWarningDismissed(true)}
                    />
                  )}

                <TextField
                  label="Authors"
                  value={authorsText}
                  onChangeText={setAuthorsText}
                  placeholder="Authors, comma-separated (optional)"
                  editable={!isUploading}
                />
                <TextField
                  label="Publication year"
                  value={publicationYearText}
                  onChangeText={setPublicationYearText}
                  placeholder="Publication year (optional)"
                  keyboardType="number-pad"
                  editable={!isUploading}
                />
                <TextField
                  label="Source venue"
                  value={sourceVenue}
                  onChangeText={setSourceVenue}
                  placeholder="Source venue / journal (optional)"
                  editable={!isUploading}
                />
                <TextField
                  label="DOI"
                  value={doi}
                  onChangeText={setDoi}
                  placeholder="DOI (optional)"
                  autoCapitalize="none"
                  editable={!isUploading}
                />
                <TextField
                  label="Source URL"
                  value={sourceUrl}
                  onChangeText={setSourceUrl}
                  placeholder="Source URL (optional)"
                  autoCapitalize="none"
                  editable={!isUploading}
                />
              </View>
            )}

            {uploadState.status === 'idle' && (
              <Button label="Upload" onPress={handleUpload} disabled={!canUpload} fullWidth />
            )}
            {uploadState.status === 'uploading' && (
              <View style={styles.centered}>
                <ActivityIndicator color={theme.accent} />
                <Text style={styles.hint}>Uploading…</Text>
              </View>
            )}
            {uploadState.status === 'processing' && (
              <View style={styles.centered}>
                <ActivityIndicator color={theme.accent} />
                <Text style={styles.hint}>
                  {STAGE_LABELS[uploadState.job.stage]}
                  {uploadState.job.total_chunks > 0
                    ? ` — ${uploadState.job.embedded_chunks} of ${uploadState.job.total_chunks} chunk(s)`
                    : ''}
                </Text>
              </View>
            )}
            {uploadState.status === 'success' && (
              <Notice
                tone="ok"
                body={
                  `Ingested "${safeText(uploadState.document.title, uploadState.document.source_filename)}"` +
                  ` — ${uploadState.document.chunk_count} chunk(s) from ${uploadState.document.page_count} page(s).`
                }
                actionLabel="Done"
                onAction={handleUploadDone}
              />
            )}
            {uploadState.status === 'error' && (
              <Notice
                tone="danger"
                body={
                  uploadState.error.statusCode !== null
                    ? `HTTP ${uploadState.error.statusCode} — ${uploadState.error.message}`
                    : uploadState.error.message
                }
                actionLabel="Try again"
                onAction={resetUpload}
              />
            )}
            {uploadState.status === 'cancelled' && (
              <Text style={styles.hint}>Upload cancelled.</Text>
            )}
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Search</Text>
            <View style={styles.searchRow}>
              <View style={styles.searchField}>
                <TextField
                  label="Search this library"
                  value={searchInput}
                  onChangeText={setSearchInput}
                  placeholder="Search by title, author, year, venue, DOI, or filename…"
                  onSubmitEditing={handleSearchSubmit}
                  returnKeyType="search"
                  accessibilityLabel="Search this library"
                />
              </View>
              <Button
                label="Search"
                variant="secondary"
                size="sm"
                onPress={handleSearchSubmit}
                disabled={!searchInput.trim()}
              />
              {activeSearchQuery && (
                <Button
                  label="Clear search"
                  variant="ghost"
                  size="sm"
                  onPress={handleClearSearch}
                />
              )}
            </View>
          </View>

          {activeSearchQuery && (
            <View style={styles.section}>
              <View style={styles.listHeader}>
                <Text style={styles.sectionTitle}>Results for &quot;{activeSearchQuery}&quot;</Text>
              </View>
              {listState.status === 'loading' && (
                <View style={styles.skeletonList}>
                  {[1, 2, 3].map((i) => (
                    <Skeleton key={i} width="100%" height={56} radius={theme.radius.md} />
                  ))}
                </View>
              )}
              {listState.status === 'error' && (
                <Notice tone="danger" body={listState.error.message} />
              )}
              {listState.status === 'success' && listState.total === 0 && (
                <EmptyState
                  title="No documents match this search."
                  description="Try a different word, or clear the search to browse your library normally."
                  actionLabel="Clear search"
                  onAction={handleClearSearch}
                />
              )}
              {listState.status === 'success' && listState.total > 0 && (
                <>
                  <Text style={styles.hint}>
                    {listState.total} document{listState.total === 1 ? '' : 's'} found
                  </Text>
                  {listState.documents.map((doc) => (
                    <Pressable
                      key={doc.document_id}
                      onPress={() => handleOpenDocument(doc)}
                      accessibilityRole="button"
                      accessibilityLabel={`Open ${safeText(doc.title, doc.source_filename)}`}
                      style={styles.docCard}
                    >
                      <View style={styles.docCardRow}>
                        <View style={styles.docCardMain}>
                          <View style={styles.docTitleRow}>
                            <Text style={styles.docTitle}>
                              {safeText(doc.title, doc.source_filename)}
                            </Text>
                            {isSampleSource(doc.source_filename) && (
                              <Badge label="Sample" tone="warning" />
                            )}
                          </View>
                          <Text style={styles.docMeta}>
                            {doc.folder_name ?? 'My Library'} ·{' '}
                            {DOCUMENT_TYPE_LABELS[doc.document_type]}
                          </Text>
                        </View>
                        {featureFlags.conversationScope && (
                          <Button
                            label="Use in chat"
                            variant="ghost"
                            size="sm"
                            onPress={() => handleUseInChat(doc)}
                          />
                        )}
                      </View>
                    </Pressable>
                  ))}
                </>
              )}
            </View>
          )}

          {!activeSearchQuery && !featureFlags.folderLibrary && (
            <View style={styles.section}>
              <View style={styles.listHeader}>
                <Text style={styles.sectionTitle}>Documents</Text>
                <Button
                  label="Refresh"
                  variant="ghost"
                  size="sm"
                  onPress={() => refresh({ limit: 20 })}
                />
              </View>
              {listState.status === 'loading' && (
                <View style={styles.skeletonList}>
                  {[1, 2, 3].map((i) => (
                    <Skeleton key={i} width="100%" height={56} radius={theme.radius.md} />
                  ))}
                </View>
              )}
              {listState.status === 'error' && (
                <Notice tone="danger" body={listState.error.message} />
              )}
              {listState.status === 'success' && listState.total === 0 && (
                <EmptyState
                  title="No documents yet"
                  description="Upload a PDF, DOCX, TXT, or HTML file above to start building your research corpus."
                />
              )}
              {listState.status === 'success' && listState.total > 0 && (
                <>
                  <Text style={styles.hint}>{listState.total} document(s) total</Text>
                  {listState.documents.map((doc) => {
                    const deleteState = deleteStates[doc.document_id];
                    const isDeleting = deleteState?.status === 'deleting';
                    return (
                      <View key={doc.document_id} style={styles.docCard}>
                        <View style={styles.docCardRow}>
                          <View style={styles.docCardMain}>
                            <View style={styles.docTitleRow}>
                              <Text style={styles.docTitle}>
                                {safeText(doc.title, doc.source_filename)}
                              </Text>
                              {isSampleSource(doc.source_filename) && (
                                <Badge label="Sample" tone="warning" />
                              )}
                            </View>
                            <Text style={styles.docMeta}>
                              {DOCUMENT_TYPE_LABELS[doc.document_type]} · {doc.chunk_count} chunk(s)
                            </Text>
                          </View>
                          <Button
                            label="Delete"
                            variant="dangerGhost"
                            size="sm"
                            accessibilityLabel={`Delete ${safeText(doc.title, doc.source_filename)}`}
                            onPress={() => handleDeletePress(doc)}
                            disabled={isDeleting}
                            loading={isDeleting}
                          />
                        </View>
                        {deleteState?.status === 'error' && (
                          <Notice
                            tone="danger"
                            body={deleteState.error.message}
                            actionLabel="Dismiss"
                            onAction={() => resetDeleteState(doc.document_id)}
                            style={styles.deleteErrorNotice}
                          />
                        )}
                      </View>
                    );
                  })}
                </>
              )}
            </View>
          )}

          {!activeSearchQuery && featureFlags.folderLibrary && (
            <View style={styles.librarySection}>
              <View style={styles.libraryMain}>
                <Breadcrumbs
                  path={folderContents?.breadcrumbs ?? []}
                  onNavigate={folderLibrary.navigate}
                  dnd={libraryDnD}
                />

                <LibraryToolbar
                  viewMode={documentsViewMode}
                  onChangeViewMode={(mode) => updatePreferences('documentsViewMode', mode)}
                  sortKey={sortKey}
                  sortDirection={sortDirection}
                  onChangeSort={setSortKey}
                  onChangeSortDirection={setSortDirection}
                  onNewFolder={() => setNewFolderFormOpen(true)}
                  onUpload={handlePickFile}
                  onRefresh={() => folderLibrary.refresh()}
                  detailsPanelOpen={detailsPanelOpen}
                  onToggleDetailsPanel={() => setDetailsPanelOpen((prev) => !prev)}
                  showDetailsPanelToggle={isDesktopWidth}
                />

                {newFolderFormOpen && (
                  <View style={styles.newFolderForm}>
                    <TextField
                      label="Folder name"
                      value={newFolderName}
                      onChangeText={setNewFolderName}
                      placeholder="e.g. Research"
                      editable={!creatingFolder}
                      autoFocus
                      onSubmitEditing={handleCreateFolder}
                      returnKeyType="done"
                    />
                    {createFolderError && <Notice tone="danger" body={createFolderError} />}
                    <View style={styles.newFolderActions}>
                      <Button
                        label="Cancel"
                        variant="ghost"
                        size="sm"
                        disabled={creatingFolder}
                        onPress={() => {
                          setNewFolderFormOpen(false);
                          setNewFolderName('');
                          setCreateFolderError(null);
                        }}
                      />
                      <Button
                        label="Create"
                        variant="secondary"
                        size="sm"
                        loading={creatingFolder}
                        disabled={creatingFolder || !newFolderName.trim()}
                        onPress={handleCreateFolder}
                      />
                    </View>
                  </View>
                )}

                {folderActionError && (
                  <Notice
                    tone="danger"
                    body={folderActionError}
                    actionLabel="Dismiss"
                    onAction={() => setFolderActionError(null)}
                  />
                )}
                {documentActionError && (
                  <Notice
                    tone="danger"
                    body={documentActionError}
                    actionLabel="Dismiss"
                    onAction={() => setDocumentActionError(null)}
                  />
                )}
                {libraryDnD.error && (
                  <Notice
                    tone="danger"
                    body={libraryDnD.error}
                    actionLabel="Dismiss"
                    onAction={libraryDnD.dismissError}
                  />
                )}

                {folderLibrary.contentsState.status === 'loading' && (
                  <View style={styles.skeletonList}>
                    {[1, 2, 3].map((i) => (
                      <Skeleton key={i} width="100%" height={56} radius={theme.radius.md} />
                    ))}
                  </View>
                )}
                {folderLibrary.contentsState.status === 'error' && (
                  <Notice tone="danger" body={folderLibrary.contentsState.error.message} />
                )}
                {folderLibrary.contentsState.status === 'success' && (
                  <>
                    {sortedContents.folders.length === 0 &&
                      sortedContents.documents.length === 0 && (
                        <EmptyState
                          title="This folder is empty"
                          description="Create a subfolder, or add a PDF, DOCX, TXT, or HTML file above. Drop files here to add them — review the details, then press Upload."
                        />
                      )}
                    {(sortedContents.folders.length > 0 || sortedContents.documents.length > 0) && (
                      <LibraryContentsView
                        layout={documentsViewMode}
                        folders={sortedContents.folders}
                        documents={sortedContents.documents}
                        selection={selection}
                        dnd={libraryDnD}
                        onOpenFolder={folderLibrary.navigate}
                        onPreviewDocument={(doc) => {
                          selection.selectItem(doc.document_id, [doc.document_id], {
                            toggle: false,
                            range: false,
                          });
                          setDetailsPanelOpen(true);
                        }}
                        onOpenDocument={handleOpenDocument}
                        onRenameFolder={folderLibrary.renameFolder}
                        onMoveItem={(item) =>
                          item.kind === 'folder'
                            ? setMovingFolder(item.data)
                            : setMovingDocument(item.data)
                        }
                        onDeleteItem={(item) =>
                          item.kind === 'folder'
                            ? handleFolderDelete(item.data)
                            : handleFolderDeleteDocument(item.data)
                        }
                        deletingIds={deletingItemIds}
                        onUseInChat={featureFlags.conversationScope ? handleUseInChat : undefined}
                        onEditMetadata={(doc) => {
                          setMetadataSaveError(null);
                          setEditingMetadataDocument(doc);
                        }}
                        onCitation={(doc) => setCitationDocument(doc)}
                      />
                    )}
                  </>
                )}
              </View>

              {isDesktopWidth && detailsPanelOpen && (
                <DetailsPanel
                  item={selectedLibraryItem}
                  locationLabel={currentFolderLocationLabel}
                  selectedCount={selection.selectedCount}
                  onClose={() => setDetailsPanelOpen(false)}
                  onUseSelectedInChat={
                    featureFlags.conversationScope ? handleUseSelectedInChat : undefined
                  }
                  selectedDocumentCount={selectedDocumentCount}
                  onOpenDocument={
                    selectedLibraryItem?.kind === 'document'
                      ? () => handleOpenDocument(selectedLibraryItem.data)
                      : undefined
                  }
                  onEditMetadata={
                    selectedLibraryItem?.kind === 'document'
                      ? () => {
                          setMetadataSaveError(null);
                          setEditingMetadataDocument(selectedLibraryItem.data);
                        }
                      : undefined
                  }
                  onCitation={
                    selectedLibraryItem?.kind === 'document'
                      ? () => setCitationDocument(selectedLibraryItem.data)
                      : undefined
                  }
                  onExportBibtexSelected={handleExportBibtexSelected}
                  exportingBibtex={exportingBibtex}
                  onAddSelectedToWritingProject={handleAddSelectedToWritingProject}
                />
              )}
            </View>
          )}
        </View>
      </ScrollView>

      {movingDocument && (
        <MoveToFolderDialog
          title={`Move "${safeText(movingDocument.title, movingDocument.source_filename)}"`}
          onClose={() => setMovingDocument(null)}
          onMove={(destinationFolderId) =>
            folderLibrary.moveDocument(movingDocument.document_id, destinationFolderId)
          }
        />
      )}
      {movingFolder && (
        <MoveToFolderDialog
          title={`Move "${safeText(movingFolder.name, 'this folder')}"`}
          excludeFolderId={movingFolder.id}
          onClose={() => setMovingFolder(null)}
          onMove={(destinationFolderId) =>
            folderLibrary.moveFolder(movingFolder.id, destinationFolderId)
          }
        />
      )}
      {editingMetadataDocument && (
        <EditMetadataModal
          document={editingMetadataDocument}
          saving={savingMetadata}
          error={metadataSaveError}
          onCancel={() => {
            setEditingMetadataDocument(null);
            setMetadataSaveError(null);
          }}
          onSave={handleSaveMetadata}
          onRefreshMetadata={handleRefreshMetadata}
          refreshingMetadata={refreshingMetadata}
        />
      )}
      {citationDocument && (
        <CitationPopover document={citationDocument} onClose={() => setCitationDocument(null)} />
      )}
      <AddToWritingProjectModal
        visible={writingProjectPickerDocumentIds !== null}
        documentIds={writingProjectPickerDocumentIds ?? []}
        onClose={() => setWritingProjectPickerDocumentIds(null)}
      />
    </View>
  );
}

/** Built inside the component via useMemo(() => buildStyles(theme), [theme])
 * — every screen's JSX below references plain `styles.x`, unaware this is
 * theme-derived, so light/dark/brand-font support is one change here
 * rather than touching every call site. */
function buildStyles(theme: Theme) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: theme.background },
    content: { padding: 24, alignItems: 'center' },
    // Widened from the pre-redesign 760px: the Finder-style library
    // (requirement #19 — "the quality level of Finder/Linear/Notion/Arc/
    // Vercel") needs room for a multi-column grid, a comfortably-spaced
    // list, and the optional details panel side by side; the Upload
    // section above it simply gets a bit more breathing room too.
    pageInner: { width: '100%', maxWidth: 1100, gap: 24 },
    section: { gap: 8 },
    librarySection: { flexDirection: 'row', alignItems: 'flex-start', gap: 16 },
    libraryMain: { flex: 1, minWidth: 0, gap: 10 },
    sectionTitle: { fontSize: 16, color: theme.text, fontFamily: theme.fonts.display },
    screenCentered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    hint: { fontSize: 12, color: theme.subtext, fontFamily: theme.fonts.body },
    warning: { fontSize: 12, color: theme.warning, fontFamily: theme.fonts.bodyMedium },
    filterLabel: {
      fontSize: 12,
      color: theme.subtext,
      fontFamily: theme.fonts.bodySemibold,
      marginTop: 4,
    },
    chipRow: { flexDirection: 'row' },
    searchRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 10, flexWrap: 'wrap' },
    searchField: { flex: 1, minWidth: 220 },
    centered: { alignItems: 'center', gap: 8 },
    metadataReview: { gap: 8 },
    listHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
    libraryHeaderActions: { flexDirection: 'row' },
    newFolderForm: {
      gap: 8,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      borderRadius: theme.radius.md,
      padding: 10,
      backgroundColor: theme.card,
    },
    newFolderActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8 },
    skeletonList: { gap: 8, marginTop: 4 },
    dropZone: {
      borderWidth: 2,
      borderColor: theme.border,
      borderStyle: 'dashed',
      borderRadius: theme.radius.lg,
      paddingVertical: 20,
      paddingHorizontal: 16,
      alignItems: 'center',
      gap: 8,
      backgroundColor: theme.background,
    },
    dropZoneActive: { borderColor: theme.accent, backgroundColor: theme.accentSoft },
    dropZoneText: {
      fontSize: 13,
      color: theme.subtext,
      textAlign: 'center',
      fontFamily: theme.fonts.body,
    },
    dropZoneOr: { fontSize: 11, color: theme.faint, fontFamily: theme.fonts.body },
    selectedFileBox: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      borderRadius: theme.radius.md,
      padding: 10,
      backgroundColor: theme.card,
      gap: 8,
    },
    selectedFileMain: { flex: 1, minWidth: 0 },
    selectedFileName: { fontSize: 13, color: theme.text, fontFamily: theme.fonts.bodySemibold },
    docCard: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      borderRadius: theme.radius.md,
      padding: 10,
      marginTop: 6,
      backgroundColor: theme.card,
    },
    docCardRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
    docCardMain: { flex: 1, minWidth: 0 },
    docCardActions: { flexDirection: 'row', flexShrink: 0 },
    docTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    docTitle: {
      fontSize: 14,
      flexShrink: 1,
      color: theme.text,
      fontFamily: theme.fonts.bodySemibold,
    },
    docMeta: { fontSize: 12, color: theme.subtext, marginTop: 2, fontFamily: theme.fonts.body },
    deleteErrorNotice: { marginTop: 6 },
    sampleBox: {
      backgroundColor: theme.warningSoft,
      borderRadius: theme.radius.md,
      padding: 10,
      gap: 8,
      marginTop: 4,
    },
    sampleBoxText: { fontSize: 12, color: theme.warning, fontFamily: theme.fonts.body },
    sampleBoxCode: { fontFamily: theme.fonts.mono, fontSize: 11 },
  });
}
