import { computeCenteredScrollTop } from '../LatexCodeEditor';

/**
 * Real-browser SyncTeX validation round 3 — double-clicking "Packages" in
 * the compiled PDF correctly resolved to line ~321 and correctly
 * highlighted it, but the editor viewport landed at lines 347-395,
 * forcing a manual scroll. Root cause: the old reveal path measured the
 * caret's position via a hidden-mirror-div DOM measurement
 * (`getCaretCoordinates`), which a real, long (300+ line) document
 * proved unreliable.
 *
 * `computeCenteredScrollTop` is the deterministic replacement: given
 * only a 0-indexed line number and the textarea's own `clientHeight` /
 * `scrollHeight`, it computes the exact `scrollTop` that centers that
 * line in the viewport — pure arithmetic, no DOM measurement, so it can
 * never drift from where the line-number gutter (same constants, same
 * formula) already draws that line.
 *
 * This is the "lowest practical level" test for the reveal logic per
 * this session's own established constraint: this repo's Jest
 * environment (jest-expo / RN's react-native-env.js) has no real DOM
 * (`document`, `Element`, `Node` are all `undefined`), so the
 * `useLayoutEffect` that actually assigns `el.scrollTop` cannot be
 * exercised here — see LatexCodeEditor.gutter.test.tsx's own docstring
 * for that same, already-accepted limitation. Only the pure function
 * extracted specifically to make this testable is covered directly.
 */
describe('computeCenteredScrollTop (SyncTeX editor reveal, real-browser validation round 3)', () => {
  it('centers a middle-of-document line: lineTop - clientHeight/2 + lineHeight/2', () => {
    // Reproduces the reported "Packages" repro shape: line 321 (index
    // 320) in a long document, comfortably away from either scroll
    // extreme so no clamping applies.
    const lineIndex = 320;
    const clientHeight = 600;
    const scrollHeight = 20000; // long document, far more than clientHeight
    const result = computeCenteredScrollTop({ lineIndex, clientHeight, scrollHeight });

    const CONTENT_PADDING_TOP_PX = 16;
    const LINE_HEIGHT_PX = 20;
    const lineTop = CONTENT_PADDING_TOP_PX + lineIndex * LINE_HEIGHT_PX; // 6416
    const expected = lineTop - clientHeight / 2 + LINE_HEIGHT_PX / 2; // 6416 - 300 + 10 = 6126
    expect(result).toBe(expected);
    expect(result).toBe(6126);
  });

  it('clamps to 0 for a line near the very top of the document', () => {
    // Line 1 (index 0): centering math alone would want a NEGATIVE
    // scrollTop (there is no content above line 1 to scroll into the
    // top half of the viewport), which must clamp to 0, not go negative.
    const result = computeCenteredScrollTop({
      lineIndex: 0,
      clientHeight: 600,
      scrollHeight: 20000,
    });
    expect(result).toBe(0);
  });

  it('clamps to the maximum scrollable offset for a line near the very bottom (e.g. an appendix)', () => {
    // A short-ish document where the last line's centered position would
    // overshoot past what the element can actually scroll to.
    const clientHeight = 600;
    const scrollHeight = 2000;
    const lastLineIndex = 99; // far enough down to exceed max scroll once centered
    const result = computeCenteredScrollTop({
      lineIndex: lastLineIndex,
      clientHeight,
      scrollHeight,
    });
    const maxScrollTop = scrollHeight - clientHeight; // 1400
    expect(result).toBe(maxScrollTop);
  });

  it('never returns a value outside [0, scrollHeight - clientHeight] for any line', () => {
    const clientHeight = 400;
    const scrollHeight = 5000;
    const maxScrollTop = scrollHeight - clientHeight;
    for (const lineIndex of [0, 1, 5, 50, 123, 244, 245, 246, 500]) {
      const result = computeCenteredScrollTop({ lineIndex, clientHeight, scrollHeight });
      expect(result).toBeGreaterThanOrEqual(0);
      expect(result).toBeLessThanOrEqual(maxScrollTop);
    }
  });

  it('handles a document shorter than the viewport (scrollHeight <= clientHeight) by clamping to 0, never negative', () => {
    const result = computeCenteredScrollTop({
      lineIndex: 3,
      clientHeight: 600,
      scrollHeight: 200, // shorter than the viewport itself
    });
    expect(result).toBe(0);
  });
});
