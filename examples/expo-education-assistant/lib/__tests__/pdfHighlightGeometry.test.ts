import {
  captureVisualAnchor,
  matchSelectionToChunk,
  projectVisualAnchor,
  type PdfViewportLike,
} from '../pdfHighlightGeometry';
import type { DocumentContentChunk } from 'education-assistant-client';

function chunk(overrides: Partial<DocumentContentChunk> = {}): DocumentContentChunk {
  return { chunk_id: 'c0', chunk_index: 0, page_number: 1, text: 'Some chunk text.', ...overrides };
}

describe('matchSelectionToChunk', () => {
  it('matches a selection fully contained in a same-page chunk', () => {
    const chunks = [chunk({ text: 'The sample consisted of 42 fifth-grade students.' })];
    const result = matchSelectionToChunk(1, '42 fifth-grade students', chunks);
    expect(result?.chunk_id).toBe('c0');
  });

  it('is case- and whitespace-insensitive', () => {
    const chunks = [chunk({ text: 'Results   showed   a   significant   effect.' })];
    const result = matchSelectionToChunk(1, 'SIGNIFICANT EFFECT', chunks);
    expect(result?.chunk_id).toBe('c0');
  });

  it('never matches a chunk on a different page', () => {
    const chunks = [chunk({ page_number: 2, text: 'The sample consisted of 42 students.' })];
    const result = matchSelectionToChunk(1, '42 students', chunks);
    expect(result).toBeNull();
  });

  it('returns null (never a fabricated match) when no chunk contains anything close', () => {
    const chunks = [chunk({ text: 'Completely unrelated content about something else entirely.' })];
    const result = matchSelectionToChunk(1, 'xyz never appears anywhere at all', chunks);
    expect(result).toBeNull();
  });

  it('falls back to prefix/suffix overlap for a selection straddling a chunk boundary', () => {
    const chunks = [
      chunk({ chunk_id: 'a', chunk_index: 0, text: 'This paragraph ends mid-sen' }),
      chunk({ chunk_id: 'b', chunk_index: 1, text: 'tence and continues here with more text.' }),
    ];
    const result = matchSelectionToChunk(1, 'ends mid-sentence and continues', chunks);
    expect(result).not.toBeNull();
    expect(['a', 'b']).toContain(result?.chunk_id);
  });

  it('returns null for an empty/whitespace-only selection', () => {
    expect(matchSelectionToChunk(1, '   ', [chunk()])).toBeNull();
  });
});

describe('captureVisualAnchor / projectVisualAnchor round trip', () => {
  function makeViewport(scale: number): PdfViewportLike {
    // A trivial, invertible viewport: viewport = pdf * scale (Y not flipped,
    // for test simplicity — real pdf.js does flip Y, which this module
    // never assumes anything about beyond "convert" being provided).
    return {
      convertToPdfPoint: (x: number, y: number) => [x / scale, y / scale],
      convertToViewportPoint: (x: number, y: number) => [x * scale, y * scale],
    };
  }

  function fakeRange(rects: DOMRect[]): Range {
    return { getClientRects: () => rects } as unknown as Range;
  }

  function fakeRect(left: number, top: number, width: number, height: number): DOMRect {
    return {
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
      x: left,
      y: top,
      toJSON: () => ({}),
    } as DOMRect;
  }

  it('captures a selection at scale 1 and re-projects it identically at scale 1', () => {
    const viewport = makeViewport(1);
    const range = fakeRange([fakeRect(10, 20, 100, 15)]);
    const anchor = captureVisualAnchor(range, { left: 0, top: 0 }, viewport);
    expect(anchor.rects).toHaveLength(1);

    const projected = projectVisualAnchor(anchor, viewport);
    expect(projected[0]).toEqual({ left: 10, top: 20, width: 100, height: 15 });
  });

  it('re-projects the SAME stored anchor correctly at a DIFFERENT (zoomed) scale', () => {
    const captureViewport = makeViewport(1);
    const range = fakeRange([fakeRect(10, 20, 100, 15)]);
    const anchor = captureVisualAnchor(range, { left: 0, top: 0 }, captureViewport);

    // Highlight was made at 100% zoom; user zooms to 200% — projecting the
    // SAME PDF-space anchor at the new scale must scale proportionally,
    // which is the entire point of storing PDF-space (not CSS-pixel) rects.
    const zoomedViewport = makeViewport(2);
    const projected = projectVisualAnchor(anchor, zoomedViewport);
    expect(projected[0]).toEqual({ left: 20, top: 40, width: 200, height: 30 });
  });

  it('subtracts the page origin before converting, so a selection is anchored page-relative', () => {
    const viewport = makeViewport(1);
    // The page's own container is offset 500px down the scrollable reader.
    const range = fakeRange([fakeRect(10, 520, 100, 15)]);
    const anchor = captureVisualAnchor(range, { left: 0, top: 500 }, viewport);
    expect(anchor.rects[0]).toEqual([10, 20, 110, 35]);
  });

  it('skips a zero-size client rect (e.g. a collapsed line fragment)', () => {
    const viewport = makeViewport(1);
    const range = fakeRange([fakeRect(0, 0, 0, 0), fakeRect(10, 20, 50, 10)]);
    const anchor = captureVisualAnchor(range, { left: 0, top: 0 }, viewport);
    expect(anchor.rects).toHaveLength(1);
  });
});
