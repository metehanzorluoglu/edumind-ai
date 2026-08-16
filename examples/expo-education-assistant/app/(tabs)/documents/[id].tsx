import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
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
import {
  useDocumentContent,
  useDocumentHighlights,
  type DocumentContentChunk,
  type DocumentHighlight,
  type Notebook,
} from 'education-assistant-client';
import { ChevronIcon, CloseIcon } from '@/components/icons';
import { IconButton } from '@/components/ui/IconButton';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { AddToNotebookPicker } from '@/components/documents/AddToNotebookPicker';
import { CitationPopover } from '@/components/documents/CitationPopover';
import { HighlightsPanel } from '@/components/documents/HighlightsPanel';
import { NoteEditorModal } from '@/components/documents/NoteEditorModal';
import { PdfReader } from '@/components/documents/PdfReader';
import { AddToWritingProjectModal } from '@/components/writing/AddToWritingProjectModal';
import { ReaderContent, groupChunksIntoPages } from '@/components/documents/ReaderContent';
import { SelectionToolbar } from '@/components/documents/SelectionToolbar';
import { useClient } from '@/lib/ClientProvider';
import { formatAuthorsCompact, safeText } from '@/lib/format';
import { useTheme, type Theme } from '@/lib/Preferences';
import { useReaderSelection, type ReaderSelection } from '@/lib/useReaderSelection';

const MOBILE_BREAKPOINT_PX = 760;
const FLASH_DURATION_MS = 1600;

/**
 * Frontend Milestone 3.1: which representation of the document is
 * primary. "original" (the real PDF, via pdf.js) is the default whenever
 * the document has a retained original file; "text" (Milestone 3's
 * extracted-text reader, unchanged) is the ONLY option for a legacy
 * document with no original file, and remains available as a secondary
 * "Text view" toggle even when the original is shown — extracted text is
 * still what search/citations/RAG use, so being able to see it directly
 * is still useful, never removed.
 */
type ViewMode = 'original' | 'text';

type NoteEditorTarget =
  | {
      mode: 'new';
      chunkId?: string;
      chunkIndex?: number;
      pageNumber: number;
      selectedText: string;
      visualAnchor?: ReaderSelection['visualAnchor'];
    }
  | { mode: 'edit'; highlight: DocumentHighlight };

/**
 * Frontend Milestone 3 — Document Reader, Highlights & Ask-About-Selection.
 * The stable per-document route: /documents/[id]. Renders the document's
 * EXTRACTED TEXT (see useDocumentContent / the backend's
 * DocumentContentResponse docstring for why — no original file is
 * retained anywhere in this system), lets the user select a passage and
 * Highlight / Add a note / Ask EduM8 about it, and shows saved highlights
 * in a panel (desktop: permanent right column; mobile: full-screen
 * sheet — see HighlightsPanel).
 */
export default function DocumentReaderScreen() {
  const {
    id,
    page: incomingPage,
    highlightId: incomingHighlightId,
    chunkId: incomingChunkId,
  } = useLocalSearchParams<{ id: string; page?: string; highlightId?: string; chunkId?: string }>();
  const router = useRouter();
  const theme = useTheme();
  const styles = useMemo(() => buildStyles(theme), [theme]);
  const { client } = useClient();
  const { width: windowWidth } = useWindowDimensions();
  const isMobile = windowWidth < MOBILE_BREAKPOINT_PX;

  const { contentState, refresh: refreshContent } = useDocumentContent(client);
  const {
    highlightsState,
    refresh: refreshHighlights,
    createHighlight,
    updateHighlightNote,
    deleteHighlight,
  } = useDocumentHighlights(client);

  const containerRef = useRef<HTMLElement | null>(null);
  const { selection: textSelection, clear: clearTextSelection } = useReaderSelection(containerRef);

  const [noteEditorTarget, setNoteEditorTarget] = useState<NoteEditorTarget | null>(null);
  // Milestone 4.2 (Citation & BibTeX Foundation) Section 25 — an
  // unobtrusive entry point into the same Citation popover Documents
  // uses; the Reader header stays focused (Section 25: "do not place
  // long citation text permanently above the PDF").
  const [citationOpen, setCitationOpen] = useState(false);
  // Milestone 5 (Academic Writing & LaTeX Foundation) Part 34 — an
  // unobtrusive entry point into AddToWritingProjectModal, same "stays
  // out of the way" placement as Citation above.
  const [writingProjectPickerOpen, setWritingProjectPickerOpen] = useState(false);
  const [savingHighlight, setSavingHighlight] = useState(false);
  const [deletingHighlightIds, setDeletingHighlightIds] = useState<Set<string>>(new Set());
  const [mobilePanelOpen, setMobilePanelOpen] = useState(false);
  const [flashedChunkId, setFlashedChunkId] = useState<string | null>(null);
  const [flashedHighlightId, setFlashedHighlightId] = useState<string | null>(null);
  const [mobileActionChunk, setMobileActionChunk] = useState<DocumentContentChunk | null>(null);

  // Frontend Milestone 3.1: view-mode toggle. Starts null ("not yet
  // decided") so the effect below can default it to "original" the
  // moment content loads and reports a retained file, without ever
  // flashing "text" first for a document that has one.
  const [viewMode, setViewMode] = useState<ViewMode | null>(null);
  const [pdfSelection, setPdfSelection] = useState<ReaderSelection | null>(null);
  const [pdfScrollToPage, setPdfScrollToPage] = useState<number | null>(null);
  const [notebookPickerHighlight, setNotebookPickerHighlight] = useState<DocumentHighlight | null>(
    null
  );
  // Frontend Milestone 3.2 §5/§27 — "Open source" from a Notebook entry
  // must restore the correct page/anchor, not just open the document at
  // its default view. Keyed on id+page+highlightId+chunkId so navigating
  // Notebook entry -> entry -> entry (same document, different
  // page/highlight) re-applies each time, but an unrelated re-render of
  // this screen never re-triggers the jump/flash a second time.
  const appliedAnchorKeyRef = useRef<string | null>(null);
  // Frontend Milestone 3.2 §22 — "Saved to: <notebook>" on a Reader
  // highlight card. Fetched as one bounded batch tied to this document's
  // own (typically small) highlight list whenever it loads/changes —
  // deliberately NOT the per-open, only-when-the-picker-is-open fetch
  // AddToNotebookPicker uses (see that component's own docstring on why
  // it avoids "an N+1 fetch across the whole panel"): that guidance is
  // about never firing one fetch per highlight on every render/hover;
  // this is a single Promise.all tied to a list load, same cost class as
  // loading the highlights themselves.
  const [notebookMembership, setNotebookMembership] = useState<Map<string, Notebook[]>>(new Map());

  useEffect(() => {
    if (!id) return;
    refreshContent(id);
    refreshHighlights(id);
    setViewMode(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    if (viewMode !== null || contentState.status !== 'success') return;
    setViewMode(contentState.content.original_file_available ? 'original' : 'text');
  }, [viewMode, contentState]);

  useEffect(() => {
    const anchorKey = `${id ?? ''}:${incomingPage ?? ''}:${incomingHighlightId ?? ''}:${incomingChunkId ?? ''}`;
    if (appliedAnchorKeyRef.current === anchorKey) return;
    if (!incomingPage || contentState.status !== 'success' || highlightsState.status !== 'success')
      return;
    appliedAnchorKeyRef.current = anchorKey;
    const pageNum = Number(incomingPage);
    if (!Number.isFinite(pageNum) || pageNum <= 0) return;
    const highlightStillExists =
      !!incomingHighlightId && highlightsState.highlights.some((h) => h.id === incomingHighlightId);
    if (contentState.content.original_file_available) {
      setViewMode('original');
      setPdfScrollToPage(pageNum);
      if (highlightStillExists) setFlashedHighlightId(incomingHighlightId ?? null);
    } else if (incomingChunkId) {
      // No retained original file (legacy document) — fall back to the
      // extracted-text view's own chunk-scroll mechanic (the same one
      // HighlightsPanel's "Go to" uses — see handleGoToHighlight below).
      setFlashedChunkId(incomingChunkId);
      if (Platform.OS === 'web' && typeof document !== 'undefined') {
        const el = document.querySelector(`[data-chunk-id="${incomingChunkId}"]`);
        el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
  }, [id, incomingPage, incomingHighlightId, incomingChunkId, contentState, highlightsState]);

  useEffect(() => {
    if (!flashedChunkId && !flashedHighlightId) return undefined;
    const timer = setTimeout(() => {
      setFlashedChunkId(null);
      setFlashedHighlightId(null);
    }, FLASH_DURATION_MS);
    return () => clearTimeout(timer);
  }, [flashedChunkId, flashedHighlightId]);

  useEffect(() => {
    if (highlightsState.status !== 'success' || highlightsState.highlights.length === 0 || !id) {
      setNotebookMembership(new Map());
      return undefined;
    }
    let cancelled = false;
    Promise.all(
      highlightsState.highlights.map((h) =>
        client
          .getHighlightNotebookMembership(id, h.id)
          .then((res): readonly [string, Notebook[]] => [h.id, res.notebooks])
          .catch((): readonly [string, Notebook[]] => [h.id, []])
      )
    ).then((pairs) => {
      if (!cancelled) setNotebookMembership(new Map(pairs));
    });
    return () => {
      cancelled = true;
    };
  }, [highlightsState, id, client]);

  const highlights = highlightsState.status === 'success' ? highlightsState.highlights : [];
  const pages =
    contentState.status === 'success' ? groupChunksIntoPages(contentState.content.chunks) : [];
  const chunks = contentState.status === 'success' ? contentState.content.chunks : [];
  const documentTitle =
    contentState.status === 'success'
      ? safeText(contentState.content.title, contentState.content.source_filename)
      : null;
  // Milestone 4 (Reference Library & Bibliographic Metadata Foundation)
  // Section 10: bibliographic identity alongside the title, without
  // redesigning the M3.1 Reader — a compact subtitle line under the
  // title, shown only when there's something real to show (never a
  // fabricated placeholder for a document with no known authors/year).
  const documentByline =
    contentState.status === 'success'
      ? [
          (contentState.content.authors ?? []).length > 0
            ? formatAuthorsCompact(contentState.content.authors)
            : null,
          contentState.content.publication_year
            ? String(contentState.content.publication_year)
            : null,
        ]
          .filter(Boolean)
          .join(' · ') || null
      : null;
  const originalAvailable =
    contentState.status === 'success' && contentState.content.original_file_available;
  const effectiveViewMode: ViewMode = viewMode ?? 'text';
  const selection = effectiveViewMode === 'original' ? pdfSelection : textSelection;

  function clearSelection(): void {
    if (
      Platform.OS === 'web' &&
      typeof window !== 'undefined' &&
      typeof window.getSelection === 'function'
    ) {
      window.getSelection()?.removeAllRanges();
    }
    setPdfSelection(null);
    clearTextSelection();
  }

  function goBackToDocuments(): void {
    router.push('/documents');
  }

  async function handleHighlightSelection(sel: ReaderSelection): Promise<void> {
    setSavingHighlight(true);
    try {
      await createHighlight(id, {
        chunkId: sel.chunkId,
        chunkIndex: sel.chunkIndex,
        pageNumber: sel.pageNumber,
        selectedText: sel.text,
        visualAnchor: sel.visualAnchor,
      });
      clearSelection();
    } finally {
      setSavingHighlight(false);
    }
  }

  function handleAddNoteToSelection(sel: ReaderSelection): void {
    setNoteEditorTarget({
      mode: 'new',
      chunkId: sel.chunkId,
      chunkIndex: sel.chunkIndex,
      pageNumber: sel.pageNumber,
      selectedText: sel.text,
      visualAnchor: sel.visualAnchor,
    });
  }

  function handleAskAboutSelection(sel: ReaderSelection): void {
    if (!documentTitle) return;
    clearSelection();
    router.push({
      pathname: '/chat/new',
      params: {
        sources: JSON.stringify([{ documentId: id, displayName: documentTitle }]),
        selectionContext: JSON.stringify({
          documentId: id,
          documentName: documentTitle,
          pageNumber: sel.pageNumber,
          selectedText: sel.text,
        }),
      },
    });
  }

  function handleUseInChat(): void {
    if (!documentTitle) return;
    router.push({
      pathname: '/chat/new',
      params: { sources: JSON.stringify([{ documentId: id, displayName: documentTitle }]) },
    });
  }

  async function handleSaveNote(noteText: string): Promise<void> {
    if (!noteEditorTarget) return;
    setSavingHighlight(true);
    try {
      if (noteEditorTarget.mode === 'new') {
        await createHighlight(id, {
          chunkId: noteEditorTarget.chunkId,
          chunkIndex: noteEditorTarget.chunkIndex,
          pageNumber: noteEditorTarget.pageNumber,
          selectedText: noteEditorTarget.selectedText,
          noteText: noteText || undefined,
          visualAnchor: noteEditorTarget.visualAnchor,
        });
        clearSelection();
      } else {
        await updateHighlightNote(id, noteEditorTarget.highlight.id, noteText || null);
      }
      setNoteEditorTarget(null);
    } finally {
      setSavingHighlight(false);
    }
  }

  async function handleDeleteHighlight(highlight: DocumentHighlight): Promise<void> {
    setDeletingHighlightIds((prev) => new Set(prev).add(highlight.id));
    try {
      await deleteHighlight(id, highlight.id);
    } finally {
      setDeletingHighlightIds((prev) => {
        const next = new Set(prev);
        next.delete(highlight.id);
        return next;
      });
    }
  }

  function handleGoToHighlight(highlight: DocumentHighlight): void {
    setMobilePanelOpen(false);
    if (effectiveViewMode === 'original') {
      setFlashedHighlightId(highlight.id);
      setPdfScrollToPage(highlight.page_number);
      return;
    }
    if (!highlight.chunk_id) {
      // A visual-only highlight (no semantic anchor) has nothing to
      // scroll to in the extracted-text view — switch to Original instead,
      // where its visual anchor DOES resolve, rather than doing nothing.
      if (originalAvailable) {
        setViewMode('original');
        setFlashedHighlightId(highlight.id);
        setPdfScrollToPage(highlight.page_number);
      }
      return;
    }
    setFlashedChunkId(highlight.chunk_id);
    if (Platform.OS === 'web' && typeof document !== 'undefined') {
      const el = document.querySelector(`[data-chunk-id="${highlight.chunk_id}"]`);
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  const highlightsPanel = (
    <HighlightsPanel
      highlights={highlights}
      loading={highlightsState.status === 'loading'}
      onClose={isMobile ? () => setMobilePanelOpen(false) : undefined}
      onGoTo={handleGoToHighlight}
      onEditNote={(h) => setNoteEditorTarget({ mode: 'edit', highlight: h })}
      onDelete={handleDeleteHighlight}
      deletingIds={deletingHighlightIds}
      onAddToNotebook={(h) => setNotebookPickerHighlight(h)}
      notebookMembership={notebookMembership}
    />
  );

  return (
    <View style={styles.screen}>
      <View style={styles.toolbar}>
        <Pressable
          onPress={goBackToDocuments}
          accessibilityRole="button"
          accessibilityLabel="Back to Documents"
          style={styles.backButton}
          hitSlop={8}
        >
          <ChevronIcon size={16} color={theme.subtext} style={styles.backChevron} />
          <Text style={styles.backText}>Documents</Text>
        </Pressable>
        <View style={styles.toolbarTitleBlock}>
          <Text style={styles.toolbarTitle} numberOfLines={1}>
            {documentTitle ?? ''}
          </Text>
          {documentByline && (
            <Text style={styles.toolbarByline} numberOfLines={1}>
              {documentByline}
            </Text>
          )}
        </View>
        <View style={styles.toolbarActions}>
          {originalAvailable && (
            <View style={styles.viewModeToggle}>
              <Pressable
                onPress={() => setViewMode('original')}
                accessibilityRole="button"
                accessibilityLabel="Show original document"
                style={[
                  styles.viewModeOption,
                  effectiveViewMode === 'original' && styles.viewModeOptionActive,
                ]}
              >
                <Text
                  style={[
                    styles.viewModeText,
                    effectiveViewMode === 'original' && styles.viewModeTextActive,
                  ]}
                >
                  Original
                </Text>
              </Pressable>
              <Pressable
                onPress={() => setViewMode('text')}
                accessibilityRole="button"
                accessibilityLabel="Show extracted text view"
                style={[
                  styles.viewModeOption,
                  effectiveViewMode === 'text' && styles.viewModeOptionActive,
                ]}
              >
                <Text
                  style={[
                    styles.viewModeText,
                    effectiveViewMode === 'text' && styles.viewModeTextActive,
                  ]}
                >
                  Text view
                </Text>
              </Pressable>
            </View>
          )}
          <Button label="Use in chat" variant="ghost" size="sm" onPress={handleUseInChat} />
          <Button
            label="Citation"
            variant="ghost"
            size="sm"
            onPress={() => setCitationOpen(true)}
          />
          <Button
            label="Add to writing project"
            variant="ghost"
            size="sm"
            onPress={() => setWritingProjectPickerOpen(true)}
          />
          {isMobile && (
            <Button
              label={`Highlights (${highlights.length})`}
              variant="ghost"
              size="sm"
              onPress={() => setMobilePanelOpen(true)}
            />
          )}
        </View>
      </View>

      <View style={styles.body}>
        {contentState.status === 'success' &&
        effectiveViewMode === 'original' &&
        originalAvailable ? (
          <PdfReader
            documentId={id}
            client={client}
            chunks={chunks}
            highlights={highlights}
            flashedHighlightId={flashedHighlightId}
            onSelectionChange={setPdfSelection}
            scrollToPageNumber={pdfScrollToPage}
            onScrolledToPage={() => setPdfScrollToPage(null)}
          />
        ) : (
          <ScrollView
            style={styles.readerScroll}
            contentContainerStyle={styles.readerContent}
            // @ts-expect-error web-only ref target (a real DOM node) — RN's
            // ScrollView ref type is a component instance, not an
            // HTMLElement; useReaderSelection only ever calls DOM methods on
            // it, guarded by Platform.OS === 'web' internally.
            ref={containerRef}
          >
            {contentState.status === 'loading' && (
              <View style={styles.centered}>
                <ActivityIndicator color={theme.accent} />
                <Text style={styles.loadingText}>Loading document…</Text>
              </View>
            )}
            {contentState.status === 'error' && (
              <View style={styles.centered}>
                <EmptyState
                  title="Couldn't load this document."
                  description={contentState.error.message}
                  actionLabel="Try again"
                  onAction={() => refreshContent(id)}
                />
              </View>
            )}
            {contentState.status === 'success' && pages.length === 0 && (
              <View style={styles.centered}>
                <EmptyState
                  title="No readable text for this document."
                  description={
                    originalAvailable
                      ? 'No extracted text is available for search/citations, but you can still read the original document — see Original above.'
                      : 'This document was indexed for chat, but no extracted text is available to display here. You can still use it as a chat source.'
                  }
                  actionLabel="Use in chat"
                  onAction={handleUseInChat}
                />
              </View>
            )}
            {contentState.status === 'success' && pages.length > 0 && (
              <ReaderContent
                pages={pages}
                highlights={highlights}
                onPressHighlight={(highlightId) => {
                  const h = highlights.find((x) => x.id === highlightId);
                  if (h) setNoteEditorTarget({ mode: 'edit', highlight: h });
                }}
                onLongPressChunk={(chunk) => setMobileActionChunk(chunk)}
                highlightedChunkId={flashedChunkId}
              />
            )}
          </ScrollView>
        )}

        {!isMobile && contentState.status === 'success' && (
          <View style={styles.sidePanel}>{highlightsPanel}</View>
        )}
      </View>

      {selection && (
        <SelectionToolbar
          anchorRect={selection.rect}
          onHighlight={() => void handleHighlightSelection(selection)}
          onAddNote={() => handleAddNoteToSelection(selection)}
          onAskEduM8={() => handleAskAboutSelection(selection)}
          busy={savingHighlight}
        />
      )}

      {mobileActionChunk && (
        <ChunkActionSheet
          chunk={mobileActionChunk}
          busy={savingHighlight}
          onDismiss={() => setMobileActionChunk(null)}
          onHighlight={async () => {
            await handleHighlightSelection({
              text: mobileActionChunk.text,
              chunkId: mobileActionChunk.chunk_id,
              chunkIndex: mobileActionChunk.chunk_index,
              pageNumber: mobileActionChunk.page_number,
              rect: { top: 0, left: 0, width: 0, height: 0 },
            });
            setMobileActionChunk(null);
          }}
          onAddNote={() => {
            setNoteEditorTarget({
              mode: 'new',
              chunkId: mobileActionChunk.chunk_id,
              chunkIndex: mobileActionChunk.chunk_index,
              pageNumber: mobileActionChunk.page_number,
              selectedText: mobileActionChunk.text,
            });
            setMobileActionChunk(null);
          }}
          onAskEduM8={() => {
            handleAskAboutSelection({
              text: mobileActionChunk.text,
              chunkId: mobileActionChunk.chunk_id,
              chunkIndex: mobileActionChunk.chunk_index,
              pageNumber: mobileActionChunk.page_number,
              rect: { top: 0, left: 0, width: 0, height: 0 },
            });
            setMobileActionChunk(null);
          }}
        />
      )}

      {noteEditorTarget && (
        <NoteEditorModal
          selectedText={
            noteEditorTarget.mode === 'new'
              ? noteEditorTarget.selectedText
              : noteEditorTarget.highlight.selected_text
          }
          initialNote={
            noteEditorTarget.mode === 'edit' ? (noteEditorTarget.highlight.note_text ?? '') : ''
          }
          saving={savingHighlight}
          onCancel={() => setNoteEditorTarget(null)}
          onSave={(noteText) => void handleSaveNote(noteText)}
        />
      )}

      {notebookPickerHighlight && (
        <AddToNotebookPicker
          client={client}
          documentId={id}
          highlight={notebookPickerHighlight}
          onClose={() => setNotebookPickerHighlight(null)}
        />
      )}

      {citationOpen && contentState.status === 'success' && (
        <CitationPopover
          document={{
            document_id: id,
            title: contentState.content.title,
            source_filename: contentState.content.source_filename,
          }}
          onClose={() => setCitationOpen(false)}
        />
      )}

      <AddToWritingProjectModal
        visible={writingProjectPickerOpen}
        documentIds={[id]}
        onClose={() => setWritingProjectPickerOpen(false)}
      />

      {isMobile && mobilePanelOpen && (
        <Modal
          visible
          transparent
          animationType="slide"
          onRequestClose={() => setMobilePanelOpen(false)}
        >
          <View style={styles.mobileSheetOverlay}>
            <Pressable
              style={styles.mobileSheetBackdrop}
              onPress={() => setMobilePanelOpen(false)}
              accessibilityRole="button"
              accessibilityLabel="Close highlights panel"
            />
            <View style={styles.mobileSheet}>{highlightsPanel}</View>
          </View>
        </Modal>
      )}
    </View>
  );
}

/** Mobile fallback (§30/§31) for text selection: long-pressing a chunk
 * offers the same three actions over the whole chunk's text, since real
 * text-selection tracking (useReaderSelection) is web-only and mobile
 * touch selection UX differs too much to rely on for these actions being
 * reachable at all. */
function ChunkActionSheet({
  chunk,
  busy,
  onDismiss,
  onHighlight,
  onAddNote,
  onAskEduM8,
}: {
  chunk: DocumentContentChunk;
  busy: boolean;
  onDismiss: () => void;
  onHighlight: () => void;
  onAddNote: () => void;
  onAskEduM8: () => void;
}) {
  const theme = useTheme();
  const styles = useMemo(() => buildSheetStyles(theme), [theme]);
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onDismiss}>
      <View style={styles.overlay}>
        <Pressable
          style={styles.backdrop}
          onPress={onDismiss}
          accessibilityRole="button"
          accessibilityLabel="Dismiss"
        />
        <View style={styles.sheet}>
          <View style={styles.header}>
            <Text style={styles.title}>This passage</Text>
            <IconButton
              label="Close"
              icon={<CloseIcon size={16} color={theme.faint} />}
              size="sm"
              onPress={onDismiss}
            />
          </View>
          <Text style={styles.excerpt} numberOfLines={4}>
            “{chunk.text}”
          </Text>
          <Button label="Highlight" variant="secondary" onPress={onHighlight} disabled={busy} />
          <Button label="Add note" variant="secondary" onPress={onAddNote} disabled={busy} />
          <Button label="Ask EduM8" variant="primary" onPress={onAskEduM8} disabled={busy} />
        </View>
      </View>
    </Modal>
  );
}

function buildSheetStyles(theme: Theme) {
  return StyleSheet.create({
    overlay: {
      ...StyleSheet.absoluteFillObject,
      alignItems: 'stretch',
      justifyContent: 'flex-end',
      zIndex: 40,
      elevation: 40,
    },
    backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: theme.overlay },
    sheet: {
      backgroundColor: theme.card,
      borderTopLeftRadius: theme.radius.lg,
      borderTopRightRadius: theme.radius.lg,
      padding: 18,
      gap: 10,
    },
    header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    title: { color: theme.text, fontSize: 15, fontFamily: theme.fonts.bodySemibold },
    excerpt: {
      fontSize: 13,
      lineHeight: 19,
      color: theme.subtext,
      fontFamily: theme.fonts.body,
      fontStyle: 'italic',
      marginBottom: 6,
    },
  });
}

function buildStyles(theme: Theme) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: theme.background },
    toolbar: {
      flexDirection: 'row',
      // M3.1 final real-browser validation (mobile viewport, 390px): the
      // back button + title + Original/Text-view toggle + "Use in chat"
      // (+ mobile-only "Highlights (N)") previously had no wrap, forcing
      // the page itself to scroll horizontally on narrow screens. Wrap
      // lets the actions drop to their own line instead — desktop widths
      // are unaffected (everything already fit on one line there).
      flexWrap: 'wrap',
      alignItems: 'center',
      gap: 12,
      paddingHorizontal: 16,
      paddingVertical: 10,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.border,
      backgroundColor: theme.card,
    },
    backButton: { flexDirection: 'row', alignItems: 'center', gap: 2 },
    backChevron: { transform: [{ rotate: '180deg' }] },
    backText: { fontSize: 13, color: theme.subtext, fontFamily: theme.fonts.body },
    toolbarTitleBlock: { flex: 1, minWidth: 0 },
    toolbarTitle: {
      fontSize: 14,
      fontFamily: theme.fonts.bodySemibold,
      color: theme.text,
    },
    // Milestone 4: bibliographic identity (authors/year) alongside the
    // title — deliberately small/muted so it reads as supporting detail,
    // never competing with the title or crowding the PDF canvas below it.
    toolbarByline: {
      fontSize: 11,
      fontFamily: theme.fonts.body,
      color: theme.subtext,
      marginTop: 1,
    },
    toolbarActions: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    viewModeToggle: {
      flexDirection: 'row',
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      borderRadius: theme.radius.sm,
      overflow: 'hidden',
      marginRight: 4,
    },
    viewModeOption: { paddingHorizontal: 10, paddingVertical: 5 },
    viewModeOptionActive: { backgroundColor: theme.accentSoft },
    viewModeText: { fontSize: 12, fontFamily: theme.fonts.body, color: theme.subtext },
    viewModeTextActive: { color: theme.accent, fontFamily: theme.fonts.bodySemibold },
    body: { flex: 1, flexDirection: 'row' },
    readerScroll: { flex: 1 },
    readerContent: { padding: 24, maxWidth: 760, width: '100%', alignSelf: 'center' },
    centered: { alignItems: 'center', justifyContent: 'center', paddingTop: 80, gap: 10 },
    loadingText: { color: theme.subtext, fontSize: 13, fontFamily: theme.fonts.body },
    sidePanel: {
      width: 300,
      flexShrink: 0,
      borderLeftWidth: StyleSheet.hairlineWidth,
      borderLeftColor: theme.border,
      paddingHorizontal: 14,
      paddingVertical: 14,
      backgroundColor: theme.card,
    },
    mobileSheetOverlay: {
      ...StyleSheet.absoluteFillObject,
      justifyContent: 'flex-end',
    },
    mobileSheetBackdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: theme.overlay },
    mobileSheet: {
      backgroundColor: theme.card,
      borderTopLeftRadius: theme.radius.lg,
      borderTopRightRadius: theme.radius.lg,
      padding: 16,
      maxHeight: '80%',
    },
  });
}
