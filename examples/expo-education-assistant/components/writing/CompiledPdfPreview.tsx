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
import { getPdfjs } from '@/lib/pdfjs';
import { useTheme, type Theme } from '@/lib/Preferences';

const MIN_SCALE = 0.5;
const MAX_SCALE = 3;
const SCALE_STEP = 0.25;
const PAGE_HORIZONTAL_PADDING_PX = 32;

interface PdfjsPageLike {
  getViewport(params: { scale: number }): { width: number; height: number };
  render(params: { canvasContext: CanvasRenderingContext2D; viewport: unknown }): {
    promise: Promise<void>;
  };
}
interface PdfjsDocumentLike {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfjsPageLike>;
}

/**
 * Milestone 5.1 Part 25/31 — the compiled-manuscript PDF preview.
 * Deliberately NOT the Document Reader (components/documents/PdfReader.tsx
 * + PdfPageView.tsx): no highlights, no text-layer/selection, no saved
 * reading position — a compiled Writing preview is a disposable build
 * artifact, not a library document a user annotates. Reuses only the
 * lowest-level shared piece, lib/pdfjs.ts's lazy web-only loader, and
 * reimplements a minimal page-to-canvas render loop rather than pulling in
 * PdfPageView's highlight-geometry/text-layer machinery this screen has no
 * use for (Part 31: "Do not overbuild").
 */
export function CompiledPdfPreview({
  pdfBlob,
  loading,
  error,
  stale,
  emptyMessage,
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
}) {
  const theme = useTheme();
  const styles = useMemo(() => buildStyles(theme), [theme]);
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pdfDoc, setPdfDoc] = useState<PdfjsDocumentLike | null>(null);
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
}: {
  pdfDoc: PdfjsDocumentLike;
  pageNumber: number;
  scale: number;
}) {
  const theme = useTheme();
  const canvasHostRef = useRef<View>(null);

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
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.scale(dpr, dpr);
      host.innerHTML = '';
      host.appendChild(canvas);
      await page.render({ canvasContext: ctx, viewport }).promise;
    }
    void render();
    return () => {
      cancelled = true;
    };
  }, [pdfDoc, pageNumber, scale]);

  return (
    <View
      ref={canvasHostRef}
      style={{
        marginBottom: 16,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.border,
        backgroundColor: '#fff',
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
