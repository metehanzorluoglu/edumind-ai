import {
  WRITING_PREVIEW_PANEL_WIDTH_MAX,
  WRITING_PREVIEW_PANEL_WIDTH_MIN,
} from '@/lib/Preferences';
import { computeDefaultPreviewPanelWidth, computePreviewSafeWidth } from '../[id]';

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

  // Writing UX Refinement milestone — "the compiled preview can expand
  // to use the full available workspace size", not the old hard 640px
  // cap. WRITING_PREVIEW_PANEL_WIDTH_MAX (the ceiling
  // useDragResizeWidth's own `max` prop enforces — see [id].tsx's
  // previewPanelResize) is raised well past any real desktop width;
  // computePreviewSafeWidth's own dynamic, editor-floor-aware ceiling
  // (unchanged by this milestone) becomes the sole real constraint.
  it('WRITING_PREVIEW_PANEL_WIDTH_MAX is no longer a realistic-desktop-width ceiling', () => {
    expect(WRITING_PREVIEW_PANEL_WIDTH_MAX).toBeGreaterThan(3000);
  });

  it('lets Preview claim nearly the full window on a large desktop when dragged wide, closed Research drawer', () => {
    const result = computePreviewSafeWidth({
      windowWidth: 2560,
      targetWidth: WRITING_PREVIEW_PANEL_WIDTH_MAX,
      researchPanelWidth: 0,
    });
    // Old behavior would have capped this at 640 (the previous static
    // max) regardless of how much room the window actually had — this
    // proves the real ceiling now tracks the window, well past that.
    expect(result).toBeGreaterThan(1500);
  });

  it('still leaves the Editor its own minimum width even at an enormous requested target', () => {
    const windowWidth = 2560;
    const result = computePreviewSafeWidth({
      windowWidth,
      targetWidth: WRITING_PREVIEW_PANEL_WIDTH_MAX,
      researchPanelWidth: 320,
    });
    // NAV_RAIL_WIDTH_PX(60) + result + researchPanelWidth(320) +
    // EDITOR_MIN_WIDTH_PX(320) must never exceed windowWidth — Preview
    // being able to grow large must never come at the cost of the
    // Editor's own documented hard floor.
    expect(60 + result + 320 + 320).toBeLessThanOrEqual(windowWidth);
  });
});

/**
 * Writing UX Refinement milestone — real-browser validation found a
 * fresh Writing session (no saved drag-resize width yet) always opened
 * with Editor substantially wider than Preview: the only default ever
 * used was a fixed 420px, unrelated to the actual window width. This
 * covers `computeDefaultPreviewPanelWidth`, the fix — an actual ~50/50
 * split of whatever room is really available, used only as the very
 * first mount's lazy initial value (see [id].tsx's own
 * `previewPanelWidth` useState initializer, which falls back to this
 * ONLY when no session-cache width already exists — an existing saved
 * resize preference is untouched by this at all).
 */
describe('computeDefaultPreviewPanelWidth (Writing UX Refinement milestone)', () => {
  it('splits the available Editor+Preview room roughly in half on a normal desktop width', () => {
    // 1440 - 60 (nav) - 320 (drawer) - 80 (margin) = 980 available; half = 490.
    const result = computeDefaultPreviewPanelWidth({ windowWidth: 1440, drawerWidth: 320 });
    expect(result).toBe(490);
  });

  it('is NOT a hard-coded pixel width — it scales with the actual window width', () => {
    const narrow = computeDefaultPreviewPanelWidth({ windowWidth: 1200, drawerWidth: 320 });
    const wide = computeDefaultPreviewPanelWidth({ windowWidth: 2560, drawerWidth: 320 });
    expect(wide).toBeGreaterThan(narrow);
    // Exactly half of the same available-room formula computePreviewSafeWidth
    // itself uses (minus the drawer/nav/margin), for both widths.
    expect(narrow).toBe((1200 - 60 - 320 - 80) / 2);
    expect(wide).toBe((2560 - 60 - 320 - 80) / 2);
  });

  it('accounts for the Writing drawer currently being closed (0-width) vs open', () => {
    const drawerOpen = computeDefaultPreviewPanelWidth({ windowWidth: 1440, drawerWidth: 320 });
    const drawerClosed = computeDefaultPreviewPanelWidth({ windowWidth: 1440, drawerWidth: 0 });
    expect(drawerClosed).toBeGreaterThan(drawerOpen);
  });

  it('never returns less than the Preview panel minimum, even on a narrow window', () => {
    const result = computeDefaultPreviewPanelWidth({ windowWidth: 700, drawerWidth: 320 });
    expect(result).toBe(WRITING_PREVIEW_PANEL_WIDTH_MIN);
  });

  it('never exceeds the Preview panel maximum on an enormous window', () => {
    const result = computeDefaultPreviewPanelWidth({ windowWidth: 20000, drawerWidth: 320 });
    expect(result).toBeLessThanOrEqual(WRITING_PREVIEW_PANEL_WIDTH_MAX);
  });

  it('still leaves the Editor its own minimum width once run through computePreviewSafeWidth (the real render-time cap)', () => {
    for (const windowWidth of [1024, 1280, 1440, 1920, 2560]) {
      const target = computeDefaultPreviewPanelWidth({ windowWidth, drawerWidth: 320 });
      const safe = computePreviewSafeWidth({
        windowWidth,
        targetWidth: target,
        researchPanelWidth: 320,
      });
      expect(60 + safe + 320 + 320).toBeLessThanOrEqual(windowWidth);
      // And it's genuinely a roughly-50/50 split, not still lopsided —
      // the Editor's own remaining share (windowWidth minus everything
      // Preview/drawer/nav/margin claim) should land within the same
      // ballpark as Preview's own share, not be many times larger.
      const editorShare = windowWidth - 60 - 320 - safe - 80;
      expect(editorShare).toBeLessThan(safe * 1.5);
      expect(safe).toBeLessThan(editorShare * 1.5);
    }
  });
});
