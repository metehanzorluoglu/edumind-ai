import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
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
      <View style={styles.zoomBar}>
        <IconButton
          label="Zoom out"
          icon={<Text style={styles.zoomGlyph}>−</Text>}
          size="sm"
          variant="outline"
          disabled={scale <= MIN_SCALE}
          onPress={() => setScale((s) => Math.max(MIN_SCALE, s - SCALE_STEP))}
        />
        <Text style={styles.zoomLabel}>{Math.round(scale * 100)}%</Text>
        <IconButton
          label="Zoom in"
          icon={<Text style={styles.zoomGlyph}>+</Text>}
          size="sm"
          variant="outline"
          disabled={scale >= MAX_SCALE}
          onPress={() => setScale((s) => Math.min(MAX_SCALE, s + SCALE_STEP))}
        />
        <Pressable
          onPress={() => {
            if (containerWidth && basePageWidthRef.current) {
              const available = Math.max(200, containerWidth - PAGE_HORIZONTAL_PADDING_PX);
              setScale(Math.min(MAX_SCALE, available / basePageWidthRef.current));
            }
          }}
          accessibilityRole="button"
          accessibilityLabel="Fit width"
          style={styles.fitWidthButton}
        >
          <Text style={styles.fitWidthText}>Fit width</Text>
        </Pressable>
      </View>

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
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
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
    fitWidthButton: { paddingHorizontal: 8, paddingVertical: 6 },
    fitWidthText: { fontSize: 12.5, color: theme.accent, fontFamily: theme.fonts.bodySemibold },
    scroll: { flex: 1 },
    scrollContent: { padding: 16, alignItems: 'center' },
  });
}
