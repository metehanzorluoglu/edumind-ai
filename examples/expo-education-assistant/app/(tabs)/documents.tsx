import { useEducationDocuments } from 'education-assistant-client';
import type {
  DocumentSummary,
  DocumentType,
  JournalQuartile,
  UploadableFile,
} from 'education-assistant-client';
import * as DocumentPicker from 'expo-document-picker';
import { createElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { FilterChip } from '@/components/ui/FilterChip';
import { Notice } from '@/components/ui/Notice';
import { PageHeader } from '@/components/ui/PageHeader';
import { Skeleton } from '@/components/ui/Skeleton';
import { TextField } from '@/components/ui/TextField';
import { DOCUMENT_TYPES, DOCUMENT_TYPE_LABELS, JOURNAL_QUARTILES } from '@/lib/enums';
import { fileExtension, formatFileSize, validateCandidateFile } from '@/lib/documentUpload';
import { safeText } from '@/lib/format';
import { useClient } from '@/lib/ClientProvider';
import { useTheme, type Theme } from '@/lib/Preferences';
import {
  SAMPLE_DOCUMENT_FILENAME,
  SAMPLE_DOCUMENT_TITLE,
  buildSampleUploadFile,
  isSampleSource,
} from '@/lib/sampleDocument';

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
  const [selectedFile, setSelectedFile] = useState<SelectedFile | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [sampleError, setSampleError] = useState<string | null>(null);
  const [documentType, setDocumentType] = useState<DocumentType>('journal_article');
  const [journalQuartile, setJournalQuartile] = useState<JournalQuartile | undefined>(undefined);
  const [title, setTitle] = useState('');
  const [authorsText, setAuthorsText] = useState('');
  const [publicationYearText, setPublicationYearText] = useState('');
  const [sourceVenue, setSourceVenue] = useState('');
  const [doi, setDoi] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');

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
    refresh({ limit: 20 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated]);

  function resetMetadataFields(): void {
    setTitle('');
    setAuthorsText('');
    setPublicationYearText('');
    setSourceVenue('');
    setDoi('');
    setSourceUrl('');
    setJournalQuartile(undefined);
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

  // Populates the editable fields from the backend's detected metadata once
  // a preview resolves — the user can still change any of these before
  // pressing Upload (see requirement that detected values are a starting
  // point, never forced).
  useEffect(() => {
    if (previewState.status !== 'success') return;
    const { preview } = previewState;
    setTitle(preview.title ?? '');
    setAuthorsText((preview.authors ?? []).join(', '));
    setPublicationYearText(
      preview.publication_year != null ? String(preview.publication_year) : ''
    );
    setSourceVenue(preview.source_venue ?? '');
    setDoi(preview.doi ?? '');
    setSourceUrl(preview.source_url ?? '');
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
  }

  function handleUpload(): void {
    if (!selectedFile || fileError) return;
    const authors = authorsText
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name.length > 0);
    const parsedYear = Number.parseInt(publicationYearText.trim(), 10);

    upload(selectedFile.file, {
      documentType,
      journalQuartile: documentType === 'journal_article' ? journalQuartile : undefined,
      title: title.trim() || undefined,
      authors: authors.length > 0 ? authors : undefined,
      publicationYear: Number.isFinite(parsedYear) ? parsedYear : undefined,
      sourceVenue: sourceVenue.trim() || undefined,
      doi: doi.trim() || undefined,
      sourceUrl: sourceUrl.trim() || undefined,
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
    setDocumentType('curriculum_document');
    setTitle(SAMPLE_DOCUMENT_TITLE);
    upload(sampleFile, { documentType: 'curriculum_document', title: SAMPLE_DOCUMENT_TITLE });
  }

  function handleUploadDone(): void {
    resetUpload();
    handleClearFile();
    refresh({ limit: 20 });
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

  if (!hydrated) {
    return (
      <View style={styles.screenCentered}>
        <ActivityIndicator color={theme.accent} />
      </View>
    );
  }

  const isUploading = uploadState.status === 'uploading' || uploadState.status === 'processing';
  const canUpload = selectedFile !== null && !fileError && !isUploading;
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
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.pageInner}>
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Upload</Text>
            <Text style={styles.hint}>
              Parsing and duplicate checks happen immediately; embedding and indexing run in the
              background afterward and can take a while on this hardware — progress is shown below.
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

            <Text style={styles.filterLabel}>Document type</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipRow}>
              {DOCUMENT_TYPES.map((type) => (
                <FilterChip
                  key={type}
                  label={DOCUMENT_TYPE_LABELS[type]}
                  selected={documentType === type}
                  onPress={() => setDocumentType(type)}
                />
              ))}
            </ScrollView>

            {documentType === 'journal_article' && (
              <>
                <Text style={styles.filterLabel}>Journal quartile</Text>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  style={styles.chipRow}
                >
                  {JOURNAL_QUARTILES.map((quartile) => (
                    <FilterChip
                      key={quartile}
                      label={quartile}
                      selected={journalQuartile === quartile}
                      onPress={() =>
                        setJournalQuartile((current) =>
                          current === quartile ? undefined : quartile
                        )
                      }
                    />
                  ))}
                </ScrollView>
              </>
            )}

            <TextField
              label="Title"
              value={title}
              onChangeText={setTitle}
              placeholder="Title (optional)"
              editable={!isUploading}
            />

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
        </View>
      </ScrollView>
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
    pageInner: { width: '100%', maxWidth: 760, gap: 24 },
    section: { gap: 8 },
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
    centered: { alignItems: 'center', gap: 8 },
    metadataReview: { gap: 8 },
    listHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
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
