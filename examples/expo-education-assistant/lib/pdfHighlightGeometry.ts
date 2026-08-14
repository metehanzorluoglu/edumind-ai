import type { DocumentContentChunk, DocumentHighlightVisualAnchor } from 'education-assistant-client';

/**
 * Frontend Milestone 3.1 (Original Document Reader) — the VISUAL half of
 * the dual-anchor model. A highlight's position is stored in PDF
 * user-space points (via pdf.js's PageViewport.convertToPdfPoint), never
 * raw CSS/screen pixels — that's what lets a saved highlight "stay
 * aligned" across zoom levels, panel-collapse, and window resizes: the
 * PDF's own coordinate system never changes, only the CSS scale used to
 * render it does.
 *
 * Minimal shape of a pdf.js PageViewport this module needs, so it doesn't
 * take a hard dependency on pdfjs-dist's types outside PdfReader itself
 * (pdfjs-dist is dynamically imported, web-only — see lib/pdfjs.ts).
 */
export interface PdfViewportLike {
  convertToPdfPoint(x: number, y: number): number[];
  convertToViewportPoint(x: number, y: number): number[];
}

/**
 * Captures the visual anchor from a live selection Range as PDF
 * user-space rects — one rect per `getClientRects()` fragment (one per
 * visual line of the selection). `pageOrigin` is the page's own rendered
 * container's `getBoundingClientRect()` (Range client rects are
 * viewport-relative; this re-bases them to page-relative CSS pixels
 * before pdf.js's conversion, which expects page-relative coordinates at
 * the viewport's current scale).
 */
export function captureVisualAnchor(
  range: Range,
  pageOrigin: { left: number; top: number },
  viewport: PdfViewportLike
): DocumentHighlightVisualAnchor {
  const rects: number[][] = [];
  for (const r of Array.from(range.getClientRects())) {
    if (r.width === 0 && r.height === 0) continue;
    const x0 = r.left - pageOrigin.left;
    const y0 = r.top - pageOrigin.top;
    const x1 = r.right - pageOrigin.left;
    const y1 = r.bottom - pageOrigin.top;
    const p0 = viewport.convertToPdfPoint(x0, y0);
    const p1 = viewport.convertToPdfPoint(x1, y1);
    const px0 = p0[0] ?? 0;
    const py0 = p0[1] ?? 0;
    const px1 = p1[0] ?? 0;
    const py1 = p1[1] ?? 0;
    rects.push([Math.min(px0, px1), Math.min(py0, py1), Math.max(px0, px1), Math.max(py0, py1)]);
  }
  return { rects };
}

/**
 * Re-projects a stored visual anchor back to CSS-pixel rects (relative to
 * the page's own rendered container) at the CURRENT viewport/scale — this
 * is what makes a highlight redraw correctly at any zoom level.
 */
export function projectVisualAnchor(
  anchor: DocumentHighlightVisualAnchor,
  viewport: PdfViewportLike
): Array<{ left: number; top: number; width: number; height: number }> {
  return anchor.rects
    .filter((rect): rect is [number, number, number, number] => rect.length === 4)
    .map((rect) => {
      const p0 = viewport.convertToViewportPoint(rect[0], rect[1]);
      const p1 = viewport.convertToViewportPoint(rect[2], rect[3]);
      const vx0 = p0[0] ?? 0;
      const vy0 = p0[1] ?? 0;
      const vx1 = p1[0] ?? 0;
      const vy1 = p1[1] ?? 0;
      const left = Math.min(vx0, vx1);
      const top = Math.min(vy0, vy1);
      return { left, top, width: Math.abs(vx1 - vx0), height: Math.abs(vy1 - vy0) };
    });
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Best-effort mapping of a PDF text selection back to an existing chunk
 * (M3.1 §14) — the SEMANTIC half of the dual-anchor model. Restricted to
 * chunks already known to be on the same page (page_number narrows this a
 * lot); a normalized-whitespace substring match is deliberately simple —
 * never invents a match when none is found (returns null, meaning
 * "semantic anchor unavailable," not an error, and the highlight is still
 * saved as visual-only — see PdfReader).
 */
export function matchSelectionToChunk(
  pageNumber: number,
  selectedText: string,
  chunks: DocumentContentChunk[]
): DocumentContentChunk | null {
  const needle = normalize(selectedText);
  if (!needle) return null;
  const candidates = chunks.filter((c) => c.page_number === pageNumber);

  const fullMatch = candidates.find((c) => normalize(c.text).includes(needle));
  if (fullMatch) return fullMatch;

  // Selection may straddle a chunk boundary pdf.js's own text extraction
  // doesn't line up with exactly (e.g. a hyphenated line break) — fall
  // back to whichever chunk shares the longest matching prefix/suffix
  // with the selection, as long as that overlap is meaningfully long
  // (never a coincidental short-string match).
  let best: { chunk: DocumentContentChunk; overlap: number } | null = null;
  for (const c of candidates) {
    const hay = normalize(c.text);
    for (let len = Math.min(needle.length, hay.length); len >= 12; len--) {
      if (hay.includes(needle.slice(0, len)) || hay.includes(needle.slice(-len))) {
        if (!best || len > best.overlap) best = { chunk: c, overlap: len };
        break;
      }
    }
  }
  return best?.chunk ?? null;
}
