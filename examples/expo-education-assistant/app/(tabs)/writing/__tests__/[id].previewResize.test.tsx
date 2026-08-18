import { computePreviewSafeWidth } from '../[id]';

/**
 * M5.5.3 final acceptance Part 14-21 — the Editor↔Preview drag-resize
 * split. useDragResizeWidth itself (lib/__tests__/useDragResizeWidth.test.tsx)
 * already covers the drag/clamp/keyboard mechanics generically; this
 * file covers the NEW logic this milestone added on top of it:
 * computePreviewSafeWidth's own viewport-adaptive cap, discovered via
 * real-browser reproduction (a Preview panel dragged wide, then the
 * browser window narrowed, overflowed the page horizontally by 300+px).
 */
describe('computePreviewSafeWidth (M5.5.3 final acceptance Part 21)', () => {
  it('returns the target width unchanged when there is plenty of room', () => {
    expect(
      computePreviewSafeWidth({ windowWidth: 1440, targetWidth: 573, researchPanelWidth: 320 })
    ).toBe(573);
  });

  it('clamps down once the window narrows enough that the target would overflow', () => {
    // Reproduces the real finding: 573 requested at a 1000px window with
    // a 320px-wide open Research panel doesn't fit within
    // 1000 - 60 (nav) - 320 (research) - 320 (editor floor) - 80 (margin) = 220,
    // so it clamps up to the panel's own 280px floor instead.
    const result = computePreviewSafeWidth({
      windowWidth: 1000,
      targetWidth: 573,
      researchPanelWidth: 320,
    });
    expect(result).toBe(280); // WRITING_PREVIEW_PANEL_WIDTH_MIN
  });

  it("never returns less than the Preview panel's own minimum width, even at an extremely narrow window", () => {
    const result = computePreviewSafeWidth({
      windowWidth: 400,
      targetWidth: 573,
      researchPanelWidth: 320,
    });
    expect(result).toBe(280);
  });

  it('gives Preview back its full target once there is room again (never permanently truncated)', () => {
    const narrow = computePreviewSafeWidth({
      windowWidth: 900,
      targetWidth: 573,
      researchPanelWidth: 320,
    });
    const wide = computePreviewSafeWidth({
      windowWidth: 1440,
      targetWidth: 573,
      researchPanelWidth: 320,
    });
    expect(narrow).toBeLessThan(573);
    expect(wide).toBe(573);
  });

  it('accounts for a closed Research drawer freeing up room', () => {
    const researchOpen = computePreviewSafeWidth({
      windowWidth: 1000,
      targetWidth: 573,
      researchPanelWidth: 320,
    });
    const researchClosed = computePreviewSafeWidth({
      windowWidth: 1000,
      targetWidth: 573,
      researchPanelWidth: 0,
    });
    expect(researchClosed).toBeGreaterThan(researchOpen);
  });

  it('never returns a value the panel could not actually render (result is always a positive, finite number)', () => {
    for (const windowWidth of [200, 500, 860, 1000, 1440, 2560]) {
      const result = computePreviewSafeWidth({
        windowWidth,
        targetWidth: 640,
        researchPanelWidth: 320,
      });
      expect(Number.isFinite(result)).toBe(true);
      expect(result).toBeGreaterThan(0);
    }
  });
});
