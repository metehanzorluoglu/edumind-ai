import { useEffect, useMemo, useRef, useState } from 'react';
import { Platform, StyleSheet, Text, TextInput, View } from 'react-native';
import type {
  DocumentContentChunk,
  DocumentHighlight,
  EducationAssistantClient,
} from 'education-assistant-client';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { useTheme, type Theme } from '@/lib/Preferences';
import { getPdfjs } from '@/lib/pdfjs';
import {
  captureVisualAnchor,
  matchSelectionToChunk,
  type PdfViewportLike,
} from '@/lib/pdfHighlightGeometry';
import type { ReaderSelection } from '@/lib/useReaderSelection';
import { PdfPageView, type PdfjsDocumentLike, type PdfjsRenderTextLayer } from './PdfPageView';

const MIN_SCALE = 0.5;
const MAX_SCALE = 3;
const SCALE_STEP = 0.15;
const PAGE_HORIZONTAL_PADDING_PX = 48;

// Standard pdf.js text-layer CSS (Apache-2.0, mozilla/pdf.js), scoped
// under a unique class so it can never leak into/collide with the rest of
// this app's styles. Injected once, web-only. This is what makes the
// (invisible, colorless) text spans line up pixel-for-pixel over the
// canvas so real text selection works — pdf.js positions each span with
// an inline transform; this stylesheet only supplies the base layout
// rules pdf.js's TextLayer class assumes are present.
const TEXT_LAYER_CSS = `
.edum8-pdf-text-layer {
  position: absolute;
  text-align: initial;
  inset: 0;
  overflow: clip;
  line-height: 1;
  opacity: 1;
  -webkit-text-size-adjust: none;
  text-size-adjust: none;
  forced-color-adjust: none;
  transform-origin: 0 0;
  z-index: 2;
  caret-color: transparent;
}
.edum8-pdf-text-layer span, .edum8-pdf-text-layer br {
  color: transparent;
  position: absolute;
  white-space: pre;
  cursor: text;
  transform-origin: 0% 0%;
}
.edum8-pdf-text-layer span.markedContent { top: 0; height: 0; }
.edum8-pdf-text-layer ::selection { background: rgba(47, 95, 224, 0.35); }
.edum8-pdf-text-layer br::selection { background: transparent; }
`;

function ensureTextLayerStylesInjected(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById('edum8-pdf-text-layer-style')) return;
  const style = document.createElement('style');
  style.id = 'edum8-pdf-text-layer-style';
  style.textContent = TEXT_LAYER_CSS;
  document.head.appendChild(style);
}

export interface PdfReaderProps {
  documentId: string;
  client: EducationAssistantClient;
  /** Extracted-text chunks (already fetched for the Text-view/RAG side) —
   * used ONLY for best-effort visual-selection-to-chunk mapping here,
   * never re-fetched or duplicated. */
  chunks: DocumentContentChunk[];
  highlights: DocumentHighlight[];
  flashedHighlightId: string | null;
  /** Fires on every selection change inside the PDF — null when the
   * selection is cleared/collapsed. Same shape the extracted-text reader
   * already produces (see lib/useReaderSelection.ts), so the parent
   * screen's existing Highlight/Add note/Ask EduM8 handlers work
   * unchanged for either reader. */
  onSelectionChange: (selection: ReaderSelection | null) => void;
  /** Parent sets this (e.g. from the Highlights panel's "Go to") to
   * request scrolling a given page into view; PdfReader clears its own
   * copy after acting on it via onScrolledToPage. */
  scrollToPageNumber: number | null;
  onScrolledToPage: () => void;
}

/**
 * Frontend Milestone 3.1 — the PRIMARY Reader view for a document with a
 * retained original file: real PDF pages (typography, columns, figures,
 * tables, page numbers) rendered via pdf.js, with a REAL selectable text
 * layer aligned to the visual page at any zoom level, and saved
 * highlights redrawn from their PDF-space visual anchor so they stay
 * aligned across zoom/resize. Restrained controls only: page nav
 * (prev/next + jump-to-page), zoom in/out, fit width — no Acrobat-level
 * tooling (no drawing, stamps, page edit/rotate/form-fill/mutation
 * anywhere in this component).
 *
 * Pages are virtualized (see lib/useNearViewport.ts via PdfPageView) —
 * only pages near the viewport actually render a canvas/text layer, so
 * opening a 300-page PDF does not render 300 pages at full resolution on
 * mount.
 */
export function PdfReader({
  documentId,
  client,
  chunks,
  highlights,
  flashedHighlightId,
  onSelectionChange,
  scrollToPageNumber,
  onScrolledToPage,
}: PdfReaderProps) {
  const theme = useTheme();
  const styles = useMemo(() => buildStyles(theme), [theme]);

  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [pdfDoc, setPdfDoc] = useState<PdfjsDocumentLike | null>(null);
  const [pdfjsModule, setPdfjsModule] = useState<{ renderTextLayer: PdfjsRenderTextLayer } | null>(
    null
  );
  const [numPages, setNumPages] = useState(0);
  const [scale, setScale] = useState(1);
  const [containerWidth, setContainerWidth] = useState<number | null>(null);
  const [pageJumpText, setPageJumpText] = useState('');

  const pageViewportsRef = useRef<Map<number, PdfViewportLike>>(new Map());
  const pageHostElsRef = useRef<Map<number, HTMLElement>>(new Map());
  const basePageWidthRef = useRef<number | null>(null); // page 1 width at scale=1

  useEffect(() => {
    if (Platform.OS !== 'web') return;
    ensureTextLayerStylesInjected();
  }, []);

  useEffect(() => {
    if (Platform.OS !== 'web') return;
    let cancelled = false;
    setStatus('loading');
    setErrorMessage(null);

    async function load(): Promise<void> {
      try {
        const pdfjs = await getPdfjs();
        const init = await client.getDocumentFileRequestInit(documentId);
        const loadingTask = pdfjs.getDocument({ url: init.url, httpHeaders: init.httpHeaders });
        const doc = (await loadingTask.promise) as unknown as PdfjsDocumentLike & {
          numPages: number;
        };
        if (cancelled) return;
        const page1 = await doc.getPage(1);
        const vp1 = page1.getViewport({ scale: 1 });
        basePageWidthRef.current = vp1.width;
        setPdfjsModule({
          renderTextLayer: pdfjs.renderTextLayer as unknown as PdfjsRenderTextLayer,
        });
        setPdfDoc(doc);
        setNumPages(doc.numPages);
        setStatus('success');
      } catch (cause) {
        if (cancelled) return;
        setErrorMessage(cause instanceof Error ? cause.message : 'Could not load this PDF.');
        setStatus('error');
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentId]);

  // Default to fit-width once both the container width and the page's
  // own (unscaled) width are known.
  useEffect(() => {
    if (containerWidth && basePageWidthRef.current && status === 'success') {
      const available = Math.max(240, containerWidth - PAGE_HORIZONTAL_PADDING_PX);
      setScale(Math.min(MAX_SCALE, available / basePageWidthRef.current));
    }
    // Only on first successful load / container-width-becoming-known —
    // never overrides a zoom the user has already chosen.
  }, [containerWidth, status]);

  useEffect(() => {
    if (!scrollToPageNumber) return;
    const el = pageHostElsRef.current.get(scrollToPageNumber);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    onScrolledToPage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollToPageNumber]);

  // --- Selection tracking (scoped to this reader's own pages only) ---
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return undefined;

    function handleSelectionChange(): void {
      const domSelection = window.getSelection();
      if (!domSelection || domSelection.isCollapsed || domSelection.rangeCount === 0) {
        onSelectionChange(null);
        return;
      }
      const text = domSelection.toString().trim();
      if (!text) {
        onSelectionChange(null);
        return;
      }
      const anchorNode = domSelection.anchorNode;
      const anchorElement =
        anchorNode?.nodeType === Node.ELEMENT_NODE
          ? (anchorNode as HTMLElement)
          : anchorNode?.parentElement;
      const pageHost = anchorElement?.closest('[data-pdf-page-number]') as HTMLElement | null;
      if (!pageHost) {
        onSelectionChange(null);
        return;
      }
      const pageNumber = Number(pageHost.dataset.pdfPageNumber);
      const viewport = pageViewportsRef.current.get(pageNumber);
      if (!viewport) {
        onSelectionChange(null);
        return;
      }
      const range = domSelection.getRangeAt(0);
      const boundingRect = range.getBoundingClientRect();
      if (boundingRect.width === 0 && boundingRect.height === 0) {
        onSelectionChange(null);
        return;
      }
      const pageOrigin = pageHost.getBoundingClientRect();
      const visualAnchor = captureVisualAnchor(range, pageOrigin, viewport);
      if (visualAnchor.rects.length === 0) {
        onSelectionChange(null);
        return;
      }
      const matched = matchSelectionToChunk(pageNumber, text, chunks);
      onSelectionChange({
        text,
        chunkId: matched?.chunk_id,
        chunkIndex: matched?.chunk_index,
        pageNumber,
        rect: {
          top: boundingRect.top,
          left: boundingRect.left,
          width: boundingRect.width,
          height: boundingRect.height,
        },
        visualAnchor,
      });
    }

    document.addEventListener('selectionchange', handleSelectionChange);
    return () => document.removeEventListener('selectionchange', handleSelectionChange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chunks]);

  if (Platform.OS !== 'web') {
    // Native platforms have no pdf.js target; the parent screen only ever
    // mounts PdfReader on web (see DocumentReaderScreen) — this is a
    // defensive fallback, not the primary native experience.
    return (
      <View style={styles.centered}>
        <Text style={styles.statusText}>The original PDF viewer is available on web.</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.toolbar}>
        <View style={styles.toolbarGroup}>
          <Button
            label="−"
            variant="ghost"
            size="sm"
            onPress={() => setScale((s) => Math.max(MIN_SCALE, s - SCALE_STEP))}
            accessibilityLabel="Zoom out"
          />
          <Text style={styles.zoomLabel}>{Math.round(scale * 100)}%</Text>
          <Button
            label="+"
            variant="ghost"
            size="sm"
            onPress={() => setScale((s) => Math.min(MAX_SCALE, s + SCALE_STEP))}
            accessibilityLabel="Zoom in"
          />
          <Button
            label="Fit width"
            variant="ghost"
            size="sm"
            onPress={() => {
              if (containerWidth && basePageWidthRef.current) {
                const available = Math.max(240, containerWidth - PAGE_HORIZONTAL_PADDING_PX);
                setScale(Math.min(MAX_SCALE, available / basePageWidthRef.current));
              }
            }}
          />
        </View>
        {numPages > 0 && (
          <View style={styles.toolbarGroup}>
            <Text style={styles.pageLabel}>Page</Text>
            <TextInput
              value={pageJumpText}
              onChangeText={setPageJumpText}
              onSubmitEditing={() => {
                const n = Number(pageJumpText);
                if (Number.isFinite(n) && n >= 1 && n <= numPages) {
                  pageHostElsRef.current
                    .get(n)
                    ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
                setPageJumpText('');
              }}
              placeholder="#"
              placeholderTextColor={theme.faint}
              style={styles.pageInput}
              keyboardType="number-pad"
            />
            <Text style={styles.pageLabel}>of {numPages}</Text>
          </View>
        )}
      </View>

      <View
        style={styles.scrollArea}
        onLayout={(e) => setContainerWidth(e.nativeEvent.layout.width)}
      >
        {status === 'loading' && (
          <View style={styles.centered}>
            <Text style={styles.statusText}>Loading PDF…</Text>
          </View>
        )}
        {status === 'error' && (
          <View style={styles.centered}>
            <EmptyState
              title="Couldn't load the original PDF."
              description={errorMessage ?? 'An unexpected error occurred.'}
            />
          </View>
        )}
        {status === 'success' &&
          pdfDoc &&
          pdfjsModule &&
          Array.from({ length: numPages }, (_, i) => i + 1).map((pageNumber) => (
            <PdfPageView
              key={pageNumber}
              pdfDoc={pdfDoc}
              pdfjsModule={pdfjsModule}
              pageNumber={pageNumber}
              scale={scale}
              highlights={highlights.filter((h) => h.page_number === pageNumber)}
              flashedHighlightId={flashedHighlightId}
              registerViewport={(n, vp) => {
                if (vp) pageViewportsRef.current.set(n, vp);
                else pageViewportsRef.current.delete(n);
              }}
              onSelectableRangeHost={(n, el) => {
                if (el) pageHostElsRef.current.set(n, el);
                else pageHostElsRef.current.delete(n);
              }}
            />
          ))}
      </View>
    </View>
  );
}

function buildStyles(theme: Theme) {
  return StyleSheet.create({
    container: { flex: 1 },
    toolbar: {
      flexDirection: 'row',
      // M3.1 final real-browser validation (mobile viewport, 390px):
      // this row (zoom controls + page-jump group) previously forced a
      // single line via `justifyContent: 'space-between'` with no wrap,
      // which pushed the page-jump group off-screen and made the whole
      // page scroll horizontally — exactly the "horizontal-layout
      // corruption" the mobile pass explicitly checks for. Wrapping is
      // the smallest fix: at normal desktop widths both groups still fit
      // on one line (unchanged), narrow viewports wrap the page-jump
      // group onto its own line instead of overflowing.
      flexWrap: 'wrap',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.border,
      backgroundColor: theme.card,
      gap: 12,
    },
    toolbarGroup: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    zoomLabel: {
      fontSize: 12,
      color: theme.subtext,
      fontFamily: theme.fonts.body,
      minWidth: 36,
      textAlign: 'center',
    },
    pageLabel: { fontSize: 12, color: theme.subtext, fontFamily: theme.fonts.body },
    pageInput: {
      width: 40,
      fontSize: 12,
      color: theme.text,
      fontFamily: theme.fonts.body,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      borderRadius: theme.radius.sm,
      paddingHorizontal: 6,
      paddingVertical: 3,
      textAlign: 'center',
    },
    scrollArea: {
      flex: 1,
      overflowY: 'auto',
      paddingVertical: 20,
      alignItems: 'center',
    },
    centered: { alignItems: 'center', justifyContent: 'center', paddingTop: 80, gap: 10 },
    statusText: { color: theme.subtext, fontSize: 13, fontFamily: theme.fonts.body },
  });
}
