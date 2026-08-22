import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { IconButton } from '@/components/ui/IconButton';
import { Notice } from '@/components/ui/Notice';
import { ensureTextLayerStylesInjected, PDF_TEXT_LAYER_CLASS_NAME } from '@/lib/pdfTextLayerStyles';
import { getPdfjs } from '@/lib/pdfjs';
import { useTheme, type Theme } from '@/lib/Preferences';

const MIN_SCALE = 0.5;
const MAX_SCALE = 3;
const SCALE_STEP = 0.25;
const PAGE_HORIZONTAL_PADDING_PX = 32;

/**
 * SyncTeX implementation (Writing UX Refinement milestone) — the exact
 * click location a rendered-PDF double-click resolves to, in the same
 * page/coordinate space real SyncTeX's own inverse-search command
 * expects: 1-based page number, x/y in PDF points (big points, 1/72"),
 * measured from the page's own top-left corner. This is deliberately
 * NOT rendered/clicked TEXT — the previous text-search heuristic
 * (lib/writingPreviewSourceMap.ts, removed this milestone) resolved a
 * clicked WORD, which real-browser validation proved unreliable for
 * common words appearing many times in one document (see this
 * milestone's own report). Source navigation now depends only on WHERE
 * on the page was clicked, resolved server-side via authoritative
 * SyncTeX data — see [id].tsx's handlePreviewDoubleClick.
 */
export interface PreviewClickLocation {
  page: number;
  x: number;
  y: number;
}

interface PdfjsPageLike {
  getViewport(params: { scale: number }): { width: number; height: number; scale: number };
  render(params: { canvasContext: CanvasRenderingContext2D; viewport: unknown }): {
    promise: Promise<void>;
  };
  getTextContent(): Promise<unknown>;
}
interface PdfjsDocumentLike {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfjsPageLike>;
}
// pdfjs-dist@3's text-layer API — see components/documents/PdfPageView.tsx's
// identical type (pinned to v3 for Metro web bundling; v4 replaced this
// function with a `TextLayer` class).
type PdfjsRenderTextLayer = (params: {
  textContentSource: unknown;
  container: HTMLElement;
  viewport: unknown;
}) => { promise: Promise<void>; cancel(): void };

/**
 * Milestone 5.1 Part 25/31 — the compiled-manuscript PDF preview.
 * Originally deliberately NOT the Document Reader (components/documents/
 * PdfReader.tsx + PdfPageView.tsx): no highlights, no saved reading
 * position — a compiled Writing preview is still a disposable build
 * artifact, not a library document a user annotates. Reuses only the
 * lowest-level shared pieces (lib/pdfjs.ts's lazy web-only loader, and —
 * since the Writing UX Refinement milestone — lib/pdfTextLayerStyles.ts's
 * shared text-layer CSS/injection) and reimplements a minimal
 * page-to-canvas render loop rather than pulling in PdfPageView's
 * highlight-geometry machinery this screen still has no use for (Part
 * 31: "Do not overbuild").
 *
 * Writing UX Refinement milestone — renders pdf.js's standard text
 * layer (invisible, colorless spans positioned exactly over the canvas
 * bitmap — the PDF's own visual appearance is unchanged) purely for
 * SELECTION UX (the reader can still select/copy rendered text
 * natively). Double-click source NAVIGATION no longer depends on it at
 * all: a double-click reports its raw PAGE + PDF-point COORDINATES via
 * `onDoubleClickLocation`, and the caller ([id].tsx) resolves that
 * through the backend's authoritative SyncTeX inverse-search endpoint —
 * never a text-matching guess (a prior text-search heuristic, lib/
 * writingPreviewSourceMap.ts, was removed this milestone after real-
 * browser validation proved it unreliable for common/repeated words).
 */
export function CompiledPdfPreview({
  pdfBlob,
  loading,
  error,
  stale,
  emptyMessage,
  onDoubleClickLocation,
}: {
  pdfBlob: Blob | null;
  loading: boolean;
  error: string | null;
  /** Part 34/36 — "Source changed since last compile": the currently
   * displayed PDF no longer matches the manuscript's current saved
   * source. Never hidden silently — see the module docstring on Part
   * 32's "do not mislead user" requirement. */
  stale: boolean;
  emptyMessage: string;
  /** SyncTeX implementation — fired when the reader double-clicks
   * anywhere in the rendered preview, with the exact page/PDF-point
   * coordinates clicked (see PreviewClickLocation's own docstring).
   * Omitted (no-op) on native. The preview itself never navigates
   * anywhere on its own — resolving this to a source location (via
   * SyncTeX) and driving the editor is entirely the caller's
   * responsibility. */
  onDoubleClickLocation?: (location: PreviewClickLocation) => void;
}) {
  const theme = useTheme();
  const styles = useMemo(() => buildStyles(theme), [theme]);
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pdfDoc, setPdfDoc] = useState<PdfjsDocumentLike | null>(null);
  const [renderTextLayer, setRenderTextLayer] = useState<PdfjsRenderTextLayer | null>(null);
  const [scale, setScale] = useState(1);
  const [containerWidth, setContainerWidth] = useState<number | null>(null);
  const basePageWidthRef = useRef<number | null>(null);

  useEffect(() => {
    if (Platform.OS !== 'web' || !pdfBlob) {
      setPdfDoc(null);
      setStatus('idle');
      return;
    }
    let cancelled = false;
    setStatus('loading');
    setLoadError(null);

    async function load(): Promise<void> {
      try {
        const pdfjs = await getPdfjs();
        const bytes = await pdfBlob!.arrayBuffer();
        if (cancelled) return;
        const loadingTask = pdfjs.getDocument({ data: bytes });
        const doc = (await loadingTask.promise) as unknown as PdfjsDocumentLike;
        if (cancelled) return;
        const page1 = await doc.getPage(1);
        basePageWidthRef.current = page1.getViewport({ scale: 1 }).width;
        setPdfDoc(doc);
        setRenderTextLayer(() => pdfjs.renderTextLayer as unknown as PdfjsRenderTextLayer);
        setStatus('success');
      } catch (cause) {
        if (cancelled) return;
        setLoadError(cause instanceof Error ? cause.message : 'Could not render this PDF.');
        setStatus('error');
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [pdfBlob]);

  useEffect(() => {
    if (containerWidth && basePageWidthRef.current && status === 'success') {
      const available = Math.max(200, containerWidth - PAGE_HORIZONTAL_PADDING_PX);
      setScale(Math.min(MAX_SCALE, available / basePageWidthRef.current));
    }
    // Only on first successful load / container-width-becoming-known —
    // never overrides a zoom the user has already chosen.
  }, [containerWidth, status]);

  if (Platform.OS !== 'web') {
    return (
      <View style={styles.centerFill}>
        <Text style={styles.emptyText}>PDF preview is available on web.</Text>
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.centerFill}>
        <Notice tone="danger" body={error} />
      </View>
    );
  }

  if (loading) {
    return (
      <View style={styles.centerFill}>
        <ActivityIndicator color={theme.accent} />
        <Text style={styles.loadingText}>Compiling…</Text>
      </View>
    );
  }

  if (!pdfBlob) {
    return (
      <View style={styles.centerFill}>
        <Text style={styles.emptyText}>{emptyMessage}</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {stale && (
        <View style={styles.staleBanner} accessibilityLabel="Source changed since last compile">
          <Text style={styles.staleBannerText}>Source changed since last compile</Text>
        </View>
      )}
      <PdfZoomBar
        scale={scale}
        minScale={MIN_SCALE}
        maxScale={MAX_SCALE}
        onZoomOut={() => setScale((s) => Math.max(MIN_SCALE, s - SCALE_STEP))}
        onZoomIn={() => setScale((s) => Math.min(MAX_SCALE, s + SCALE_STEP))}
        onSetScale={setScale}
        onFitWidth={() => {
          if (containerWidth && basePageWidthRef.current) {
            const available = Math.max(200, containerWidth - PAGE_HORIZONTAL_PADDING_PX);
            setScale(Math.min(MAX_SCALE, available / basePageWidthRef.current));
          }
        }}
      />

      {status === 'error' && (
        <View style={styles.centerFill}>
          <Notice tone="danger" body={loadError ?? 'Could not render this PDF.'} />
        </View>
      )}
      {status === 'loading' && (
        <View style={styles.centerFill}>
          <ActivityIndicator color={theme.accent} />
        </View>
      )}
      {status === 'success' && pdfDoc && (
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          onLayout={(e) => setContainerWidth(e.nativeEvent.layout.width)}
        >
          {Array.from({ length: pdfDoc.numPages }, (_, i) => i + 1).map((pageNumber) => (
            <CompiledPdfPage
              key={pageNumber}
              pdfDoc={pdfDoc}
              pageNumber={pageNumber}
              scale={scale}
              renderTextLayer={renderTextLayer}
              onDoubleClickLocation={onDoubleClickLocation}
            />
          ))}
        </ScrollView>
      )}
    </View>
  );
}

/**
 * M5.5.3 continuation Part 8 — the zoom bar's direct-percentage-entry
 * interaction, extracted into its own presentational component (no PDF/
 * canvas logic of its own) so it can be unit-tested directly: reaching
 * `CompiledPdfPreview`'s own `status === 'success'` branch requires a
 * real `document.createElement('canvas')` call this monorepo's jest
 * environment (react-native's own jest-preset, not jsdom) has no
 * substitute for — see CompiledPdfPreview.test.tsx's own docstring for
 * why that file deliberately never exercises `pdfBlob !== null`. This
 * component has no such dependency, so its own test file can render it
 * standalone with plain numeric props.
 */
export function PdfZoomBar({
  scale,
  minScale,
  maxScale,
  onZoomOut,
  onZoomIn,
  onFitWidth,
  onSetScale,
}: {
  scale: number;
  minScale: number;
  maxScale: number;
  onZoomOut: () => void;
  onZoomIn: () => void;
  onFitWidth: () => void;
  /** Applies a validated, already-clamped scale (0–1 fraction, not a
   * percentage) chosen via direct percentage entry. */
  onSetScale: (scale: number) => void;
}) {
  const theme = useTheme();
  const styles = useMemo(() => buildZoomBarStyles(theme), [theme]);
  // A separate string buffer (not derived from `scale` while editing)
  // so a user can freely type/backspace through an intermediate
  // invalid state ("1", "15", "150") without it being clamped/rejected
  // mid-keystroke — validation only happens at commit (Enter/blur).
  const [editingZoom, setEditingZoom] = useState(false);
  const [zoomInputValue, setZoomInputValue] = useState('');
  // Removing the TextInput from the tree (editingZoom -> false) fires
  // its own blur as part of unmounting — without this guard, an
  // Escape-triggered cancel would immediately be followed by onBlur
  // re-committing the very value Escape was meant to discard.
  const suppressNextBlurCommitRef = useRef(false);

  function beginEditingZoom(): void {
    setZoomInputValue(String(Math.round(scale * 100)));
    setEditingZoom(true);
  }

  function commitZoomInput(): void {
    if (suppressNextBlurCommitRef.current) {
      suppressNextBlurCommitRef.current = false;
      setEditingZoom(false);
      return;
    }
    const parsed = Number(zoomInputValue.trim());
    // Invalid input (empty, non-numeric, zero/negative) leaves the
    // current zoom unchanged — never falls back to a guessed value.
    if (Number.isFinite(parsed) && parsed > 0) {
      const clamped = Math.min(maxScale, Math.max(minScale, parsed / 100));
      onSetScale(clamped);
    }
    setEditingZoom(false);
  }

  function cancelZoomInput(): void {
    suppressNextBlurCommitRef.current = true;
    setEditingZoom(false);
  }

  return (
    <View style={styles.zoomBar}>
      <IconButton
        label="Zoom out"
        icon={<Text style={styles.zoomGlyph}>−</Text>}
        size="sm"
        variant="outline"
        disabled={scale <= minScale}
        onPress={onZoomOut}
      />
      {editingZoom ? (
        <TextInput
          style={styles.zoomInput}
          value={zoomInputValue}
          onChangeText={setZoomInputValue}
          onSubmitEditing={commitZoomInput}
          onBlur={commitZoomInput}
          onKeyPress={(e) => {
            if (e.nativeEvent.key === 'Escape') cancelZoomInput();
          }}
          keyboardType="number-pad"
          autoFocus
          selectTextOnFocus
          accessibilityLabel="Zoom percentage"
        />
      ) : (
        <Pressable
          onPress={beginEditingZoom}
          accessibilityRole="button"
          accessibilityLabel={`Zoom level: ${Math.round(scale * 100)}%. Tap to edit.`}
        >
          <Text style={styles.zoomLabel}>{Math.round(scale * 100)}%</Text>
        </Pressable>
      )}
      <IconButton
        label="Zoom in"
        icon={<Text style={styles.zoomGlyph}>+</Text>}
        size="sm"
        variant="outline"
        disabled={scale >= maxScale}
        onPress={onZoomIn}
      />
      <Pressable
        onPress={onFitWidth}
        accessibilityRole="button"
        accessibilityLabel="Fit width"
        style={styles.fitWidthButton}
      >
        <Text style={styles.fitWidthText}>Fit width</Text>
      </Pressable>
    </View>
  );
}

function buildZoomBarStyles(theme: Theme) {
  return StyleSheet.create({
    zoomBar: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.border,
    },
    zoomGlyph: { fontSize: 16, color: theme.subtext, fontFamily: theme.fonts.bodySemibold },
    zoomLabel: {
      fontSize: 12.5,
      color: theme.subtext,
      fontFamily: theme.fonts.body,
      minWidth: 40,
      textAlign: 'center',
    },
    zoomInput: {
      fontSize: 12.5,
      color: theme.text,
      fontFamily: theme.fonts.body,
      minWidth: 40,
      textAlign: 'center',
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.accent,
      borderRadius: 4,
      paddingVertical: 2,
      paddingHorizontal: 4,
    },
    fitWidthButton: { paddingHorizontal: 8, paddingVertical: 6 },
    fitWidthText: { fontSize: 12.5, color: theme.accent, fontFamily: theme.fonts.bodySemibold },
  });
}

function CompiledPdfPage({
  pdfDoc,
  pageNumber,
  scale,
  renderTextLayer,
  onDoubleClickLocation,
}: {
  pdfDoc: PdfjsDocumentLike;
  pageNumber: number;
  scale: number;
  /** Null until pdf.js's lazy load resolves — the page still renders as
   * a plain bitmap (today's exact original behavior) until then; the
   * text layer (selection UX only, see the module docstring) simply
   * isn't available yet for a page rendered in that brief window. */
  renderTextLayer: PdfjsRenderTextLayer | null;
  onDoubleClickLocation?: (location: PreviewClickLocation) => void;
}) {
  const theme = useTheme();
  const canvasHostRef = useRef<View>(null);
  // SyncTeX implementation — the actual rendered <canvas> element,
  // captured at render time so the double-click listener below can
  // measure a click's position relative to IT specifically (never the
  // host div, which also contains the invisible text-layer overlay —
  // measuring against the canvas's own bounding box is what makes the
  // page-relative coordinate correct regardless of which of the two
  // overlapping layers the native event actually landed on).
  const canvasElRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function render(): Promise<void> {
      const host = canvasHostRef.current as unknown as HTMLDivElement | null;
      if (!host) return;
      const page = await pdfDoc.getPage(pageNumber);
      if (cancelled) return;
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      // Milestone 5.5.2 Part 42-43 — the exact same HiDPI defect as
      // Reader's PdfPageView (independently implemented, same root
      // cause: canvas.width/height, the backing-store resolution, was
      // set 1:1 with the CSS display size, so any devicePixelRatio > 1
      // display upscaled a lower-resolution bitmap). Same fix: render
      // into a devicePixelRatio-times-larger backing store, scale the
      // context to match, keep the CSS size at the logical viewport —
      // see PdfPageView.tsx's own comment for the full explanation.
      const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
      canvas.width = Math.round(viewport.width * dpr);
      canvas.height = Math.round(viewport.height * dpr);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      canvas.style.display = 'block';
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.scale(dpr, dpr);
      host.innerHTML = '';
      host.appendChild(canvas);
      canvasElRef.current = canvas;
      await page.render({ canvasContext: ctx, viewport }).promise;
      if (cancelled) return;

      // Writing UX Refinement milestone — an invisible, colorless text
      // layer positioned exactly over the canvas above (never visually
      // duplicating the rendered PDF — see lib/pdfTextLayerStyles.ts).
      // SyncTeX implementation — this is now SELECTION UX ONLY (the
      // reader can still select/copy rendered text natively);
      // double-click source NAVIGATION no longer reads from it at all
      // (see the module docstring and handleNativeDoubleClick below). A
      // failure here (or renderTextLayer not being ready yet) degrades
      // gracefully to exactly today's canvas-only preview — never
      // fatal to the page render that already succeeded above, and
      // never a loss of navigation capability either.
      if (renderTextLayer) {
        ensureTextLayerStylesInjected();
        const textLayerEl = document.createElement('div');
        textLayerEl.className = PDF_TEXT_LAYER_CLASS_NAME;
        textLayerEl.style.width = `${viewport.width}px`;
        textLayerEl.style.height = `${viewport.height}px`;
        // pdfjs-dist@3's renderTextLayer reads this CSS variable back
        // off the container to sanity-check its own `viewport.scale`
        // argument — see PdfPageView.tsx's identical comment.
        textLayerEl.style.setProperty('--scale-factor', String(viewport.scale));
        host.appendChild(textLayerEl);
        try {
          const textContent = await page.getTextContent();
          if (cancelled) return;
          await renderTextLayer({
            textContentSource: textContent,
            container: textLayerEl,
            viewport,
          }).promise;
        } catch {
          // Swallow — see the comment above this block.
        }
      }
    }
    void render();
    return () => {
      cancelled = true;
    };
  }, [pdfDoc, pageNumber, scale, renderTextLayer]);

  // Real-browser validation (Writing UX Refinement milestone,
  // post-implementation manual QA) found double-click navigation
  // silently did nothing outside of Jest — root cause: react-native-web's
  // `View` only forwards an explicit allowlist of DOM event props (see
  // node_modules/react-native-web/dist/modules/forwardedProps — `onClick`,
  // `onMouseDown/Up/Move/...`, the pointer-event family, etc.) and
  // `onDoubleClick` simply isn't in that list (unlike `onMouseDown`,
  // which [id].tsx's resize handles rely on and which DOES work). The
  // prop was silently dropped before ever reaching the DOM — no
  // `dblclick` listener was ever attached. Fixed by attaching a REAL
  // `dblclick` listener straight to the host DOM node via
  // `addEventListener`, bypassing react-native-web's prop allowlist
  // entirely — the same imperative-DOM style this component's own
  // render effect above already uses for the canvas/text-layer
  // elements.
  const onDoubleClickLocationRef = useRef(onDoubleClickLocation);
  useEffect(() => {
    onDoubleClickLocationRef.current = onDoubleClickLocation;
  }, [onDoubleClickLocation]);

  useEffect(() => {
    const host = canvasHostRef.current as unknown as HTMLElement | null;
    if (!host || typeof window === 'undefined') return;

    // SyncTeX implementation — the click's exact PAGE POSITION, not
    // clicked text (see PreviewClickLocation's own docstring for why:
    // real-browser validation found the previous text-search heuristic
    // unreliable for common/repeated words — SyncTeX resolves position,
    // not text, so this is all the caller needs to send). `rect` is the
    // CANVAS's own bounding box (not the host div's — the text layer
    // sits on top of it at the identical position/size, so either would
    // give the same numbers, but measuring the canvas directly is
    // correct regardless of which overlapping layer the native event's
    // own target happened to be). pdf.js's viewport is CSS pixels = PDF
    // points * scale, top-left origin, Y increasing downward — the
    // EXACT SAME convention SyncTeX's own inverse-search coordinates
    // use (confirmed directly against real synctex output — see the
    // design report's own §7) — dividing out the current zoom `scale`
    // is the only conversion needed, no axis flip.
    function handleNativeDoubleClick(event: MouseEvent): void {
      const callback = onDoubleClickLocationRef.current;
      const canvas = canvasElRef.current;
      if (!callback || !canvas) return;
      const rect = canvas.getBoundingClientRect();
      const x = (event.clientX - rect.left) / scale;
      const y = (event.clientY - rect.top) / scale;
      callback({ page: pageNumber, x, y });
    }

    // Re-attached whenever `scale` changes (the closure above captures
    // it directly, and a zoom change must use the NEW scale to convert
    // CSS pixels back to PDF points correctly) — cheap, a single
    // listener on one already-stable host node.
    host.addEventListener('dblclick', handleNativeDoubleClick);
    return () => host.removeEventListener('dblclick', handleNativeDoubleClick);
  }, [pageNumber, scale]);

  return (
    <View
      ref={canvasHostRef}
      style={{
        marginBottom: 16,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.border,
        backgroundColor: '#fff',
        position: 'relative',
      }}
      accessibilityLabel={`Page ${pageNumber}`}
    />
  );
}

function buildStyles(theme: Theme) {
  return StyleSheet.create({
    container: { flex: 1 },
    centerFill: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8, padding: 24 },
    loadingText: { fontSize: 13, color: theme.subtext, fontFamily: theme.fonts.body },
    emptyText: {
      fontSize: 13,
      color: theme.subtext,
      fontFamily: theme.fonts.body,
      textAlign: 'center',
    },
    staleBanner: {
      backgroundColor: theme.warningSoft,
      paddingVertical: 6,
      paddingHorizontal: 12,
      alignItems: 'center',
    },
    staleBannerText: {
      fontSize: 12,
      fontFamily: theme.fonts.bodySemibold,
      color: theme.text,
    },
    scroll: { flex: 1 },
    scrollContent: { padding: 16, alignItems: 'center' },
  });
}
