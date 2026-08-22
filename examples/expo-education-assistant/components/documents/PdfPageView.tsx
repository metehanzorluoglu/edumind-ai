import { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import type { DocumentHighlight } from 'education-assistant-client';
import { useNearViewport } from '@/lib/useNearViewport';
import { projectVisualAnchor, type PdfViewportLike } from '@/lib/pdfHighlightGeometry';
import { PDF_TEXT_LAYER_CLASS_NAME } from '@/lib/pdfTextLayerStyles';
import { useTheme } from '@/lib/Preferences';

// pdf.js's own page/document types aren't imported statically (pdfjs-dist
// is loaded dynamically, web-only — see lib/pdfjs.ts); these are the only
// shapes PdfPageView actually calls methods on.
export interface PdfjsPageLike {
  getViewport(params: { scale: number }): PdfViewportLike & {
    width: number;
    height: number;
    scale: number;
  };
  render(params: { canvasContext: CanvasRenderingContext2D; viewport: unknown }): {
    promise: Promise<void>;
  };
  getTextContent(): Promise<unknown>;
}
export interface PdfjsDocumentLike {
  getPage(pageNumber: number): Promise<PdfjsPageLike>;
}
// pdfjs-dist@3's text-layer API is the `renderTextLayer()` function (v4
// replaced this with a `TextLayer` class — pinned to v3 for Metro web
// bundling compatibility, see lib/pdfjs.ts's docstring).
export type PdfjsRenderTextLayer = (params: {
  textContentSource: unknown;
  container: HTMLElement;
  viewport: unknown;
}) => { promise: Promise<void>; cancel(): void };

const A4_ASPECT = 1.294; // height / width — placeholder only, before real dimensions are known

export function PdfPageView({
  pdfDoc,
  pdfjsModule,
  pageNumber,
  scale,
  highlights,
  flashedHighlightId,
  registerViewport,
  onSelectableRangeHost,
}: {
  pdfDoc: PdfjsDocumentLike;
  pdfjsModule: { renderTextLayer: PdfjsRenderTextLayer };
  pageNumber: number;
  scale: number;
  highlights: DocumentHighlight[];
  flashedHighlightId: string | null;
  /** Reports this page's current viewport (updates on every zoom change)
   * up to PdfReader, which keeps a map used for selection capture. */
  registerViewport: (pageNumber: number, viewport: PdfViewportLike | null) => void;
  /** Called once with this page's rendered container element, tagged
   * `data-pdf-page-number`, so PdfReader's selection handler can trace a
   * live DOM selection back to a page. */
  onSelectableRangeHost?: (pageNumber: number, el: HTMLElement | null) => void;
}) {
  const theme = useTheme();
  const outerRef = useRef<View>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textLayerRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [viewport, setViewport] = useState<PdfViewportLike | null>(null);
  const renderTokenRef = useRef(0);

  const near = useNearViewport(outerRef as unknown as { current: HTMLElement | null });

  useEffect(() => {
    if (!near) return;
    let cancelled = false;
    const token = ++renderTokenRef.current;

    async function renderPage(): Promise<void> {
      const page = await pdfDoc.getPage(pageNumber);
      if (cancelled || token !== renderTokenRef.current) return;
      const vp = page.getViewport({ scale });
      setSize({ width: vp.width, height: vp.height });
      setViewport(vp);
      registerViewport(pageNumber, vp);

      const canvas = canvasRef.current;
      if (canvas) {
        // Milestone 5.5.2 Part 38-40 — real-browser HiDPI root cause:
        // the canvas's BACKING-STORE resolution (canvas.width/height,
        // a DOM property) was set to the SAME number as its CSS
        // display size (`size.width/height`, set via inline style
        // below), a 1:1 canvas-pixel-to-CSS-pixel ratio. On any
        // devicePixelRatio > 1 display (virtually all modern laptop/
        // phone screens), the browser then upscales that lower-
        // resolution bitmap to fill the same visual space — this is
        // the actual blur, not a rendering-quality setting anywhere in
        // pdf.js itself. The fix is pdf.js's own documented HiDPI
        // recipe: render into a backing store `devicePixelRatio` times
        // larger than the logical viewport, and scale the 2D context
        // by the same factor so pdf.js's drawing commands (written in
        // the viewport's own logical coordinate space) fill it
        // correctly — the CSS display size (`size`, below) is
        // deliberately UNCHANGED, so this only adds real pixel density,
        // never changes layout.
        const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
        canvas.width = Math.round(vp.width * dpr);
        canvas.height = Math.round(vp.height * dpr);
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.scale(dpr, dpr);
          await page.render({ canvasContext: ctx, viewport: vp }).promise;
        }
      }
      if (cancelled || token !== renderTokenRef.current) return;

      const textLayerEl = textLayerRef.current;
      if (textLayerEl) {
        textLayerEl.replaceChildren();
        // pdfjs-dist@3's renderTextLayer reads this CSS variable back off
        // the container to sanity-check its own `viewport.scale` argument
        // (and logs a console.error if it's missing/mismatched) — see
        // PdfjsRenderTextLayer's docstring for why v3, not v4.
        textLayerEl.style.setProperty('--scale-factor', String(vp.scale));
        const textContent = await page.getTextContent();
        if (cancelled || token !== renderTokenRef.current) return;
        const task = pdfjsModule.renderTextLayer({
          textContentSource: textContent,
          container: textLayerEl,
          viewport: vp,
        });
        await task.promise;
      }
    }

    void renderPage();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [near, pageNumber, scale, pdfDoc, pdfjsModule]);

  useEffect(() => {
    return () => registerViewport(pageNumber, null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageNumber]);

  const highlightRects =
    viewport && highlights.length > 0
      ? highlights.flatMap((h) =>
          h.visual_anchor
            ? projectVisualAnchor(h.visual_anchor, viewport).map((rect) => ({
                highlightId: h.id,
                rect,
              }))
            : []
        )
      : [];

  return (
    <View ref={outerRef} style={styles.outer}>
      <View
        style={[
          styles.pageShell,
          {
            width: size?.width ?? 700,
            height: size?.height ?? 700 * A4_ASPECT,
            backgroundColor: theme.card,
            borderColor: theme.border,
          },
        ]}
        // @ts-expect-error web-only ref target (a real DOM node, not RN View's instance type)
        ref={(node: HTMLDivElement | null) => {
          containerRef.current = node;
          onSelectableRangeHost?.(pageNumber, node);
        }}
        dataSet={{ pdfPageNumber: String(pageNumber) }}
      >
        {/* Always mounted once this page is near the viewport (never
            conditional on `size`) — the render effect below reads
            canvasRef.current/textLayerRef.current synchronously right
            after calling setSize(), before React has had a chance to
            re-render with the new size; gating these elements on `size`
            meant that first read always saw a still-null ref (the canvas
            didn't exist in the DOM yet), so the canvas silently kept its
            browser-default 300x150 size and the text layer never
            received any spans. Sizing them via inline style (from
            `size`, defaulting to 0x0 until known) instead keeps the ref
            stable across the size transition. */}
        <canvas
          ref={canvasRef}
          style={{ position: 'absolute', left: 0, top: 0, ...(size ?? { width: 0, height: 0 }) }}
        />
        <div
          ref={textLayerRef}
          className={PDF_TEXT_LAYER_CLASS_NAME}
          style={pdfTextLayerInlineStyle(size ?? { width: 0, height: 0 })}
        />
        {size && (
          <>
            {highlightRects.map(({ highlightId, rect }, i) => (
              <View
                key={`${highlightId}-${i}`}
                pointerEvents="none"
                style={[
                  styles.highlightRect,
                  {
                    left: rect.left,
                    top: rect.top,
                    width: rect.width,
                    height: rect.height,
                    backgroundColor:
                      flashedHighlightId === highlightId
                        ? theme.accentSoft
                        : 'rgba(255, 214, 90, 0.38)',
                  },
                ]}
              />
            ))}
          </>
        )}
      </View>
    </View>
  );
}

function pdfTextLayerInlineStyle(size: {
  width: number;
  height: number;
}): Record<string, string | number> {
  return { position: 'absolute', left: 0, top: 0, width: size.width, height: size.height };
}

const styles = StyleSheet.create({
  outer: { alignItems: 'center', marginBottom: 16 },
  pageShell: {
    position: 'relative',
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
    // Matches typical PDF page drop-shadow treatment without pulling in a
    // shadow lib — react-native-web passes boxShadow through on web.
    boxShadow: '0 1px 6px rgba(0,0,0,0.12)',
  },
  highlightRect: {
    position: 'absolute',
    borderRadius: 2,
    // Multiply blend keeps underlying text/figures legible through the
    // highlight color, matching how a real highlighter behaves.
    mixBlendMode: 'multiply',
  },
});
