/**
 * @jest-environment jsdom
 *
 * jsdom (rather than this repo's usual node/react-test-renderer default,
 * same precedent as SidebarContextMenuContext.test.tsx) because the hook's
 * mousemove/mouseup handlers are real `window.addEventListener` listeners
 * that need a real `window`/`MouseEvent` to dispatch against — jest-expo's
 * "web" Platform.OS with no real DOM makes the hook's effect a no-op (see
 * the hook's own guard), which is exactly why this bug went uncaught by
 * every other (non-jsdom) test in this repo until Milestone 5.5's
 * real-browser validation (Part 32) found it. No fetch involved here, so
 * this file doesn't hit the jsdom+fetch-mock conflict documented in
 * [id].desktopWorkspace.test.tsx's own comment about that combination.
 */
import { useEffect } from 'react';
import { Platform, View } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { useDragResizeWidth } from '../useDragResizeWidth';

const originalOS = Platform.OS;
beforeAll(() => {
  Platform.OS = 'web';
});
afterAll(() => {
  Platform.OS = originalOS;
});

type KeyDownFn = (e: { key: string; preventDefault: () => void }) => void;

function Harness({
  onResizeEnd,
  onMouseDownRef,
  onKeyDownRef,
  width = 320,
}: {
  onResizeEnd: (w: number) => void;
  onMouseDownRef: { current: ((e: { clientX: number }) => void) | null };
  onKeyDownRef?: { current: KeyDownFn | null };
  width?: number;
}) {
  const { handleMouseDown, handleKeyDown } = useDragResizeWidth({
    width,
    min: 240,
    max: 480,
    onResizeEnd,
  });
  useEffect(() => {
    onMouseDownRef.current = handleMouseDown;
    if (onKeyDownRef) onKeyDownRef.current = handleKeyDown;
  });
  return <View />;
}

function renderWithAct(
  onResizeEnd: (w: number) => void,
  onMouseDownRef: { current: ((e: { clientX: number }) => void) | null },
  onKeyDownRef?: { current: KeyDownFn | null },
  width?: number
): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <Harness
        onResizeEnd={onResizeEnd}
        onMouseDownRef={onMouseDownRef}
        onKeyDownRef={onKeyDownRef}
        width={width}
      />
    );
  });
  return renderer;
}

describe('useDragResizeWidth', () => {
  it('calls onResizeEnd exactly once, with the final clamped width, on mouseup', () => {
    const onResizeEnd = jest.fn();
    const ref: { current: ((e: { clientX: number }) => void) | null } = { current: null };
    const renderer = renderWithAct(onResizeEnd, ref);

    act(() => {
      ref.current!({ clientX: 100 });
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 150 }));
      window.dispatchEvent(new MouseEvent('mouseup'));
    });

    expect(onResizeEnd).toHaveBeenCalledTimes(1);
    expect(onResizeEnd).toHaveBeenCalledWith(370); // 320 start + (150-100) delta
    renderer.unmount();
  });

  // Milestone 5.5 Part 32 regression — real-browser validation caught
  // React logging "Cannot update a component while rendering a different
  // component" here: the old implementation called onResizeEnd(current)
  // INSIDE the functional updater passed to setDragWidth, which React can
  // invoke during another component's render. A parent whose own state
  // update is driven by onResizeEnd (exactly what Preferences' `update`
  // does) reproduces the warning if the side effect isn't hoisted out.
  it('never triggers a React setState-during-render warning on mouseup', () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const onResizeEnd = jest.fn();
    const ref: { current: ((e: { clientX: number }) => void) | null } = { current: null };
    const renderer = renderWithAct(onResizeEnd, ref);

    act(() => {
      ref.current!({ clientX: 100 });
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 150 }));
      window.dispatchEvent(new MouseEvent('mouseup'));
    });

    const badCalls = errorSpy.mock.calls.filter((args) =>
      String(args[0]).includes('Cannot update a component')
    );
    expect(badCalls).toHaveLength(0);
    errorSpy.mockRestore();
    renderer.unmount();
  });

  it('clamps to max/min and ignores mousemove before mousedown / after mouseup', () => {
    const onResizeEnd = jest.fn();
    const ref: { current: ((e: { clientX: number }) => void) | null } = { current: null };
    renderWithAct(onResizeEnd, ref);

    act(() => {
      // No mousedown yet — this mousemove must be a no-op.
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 999 }));
      window.dispatchEvent(new MouseEvent('mouseup'));
    });
    expect(onResizeEnd).not.toHaveBeenCalled();

    act(() => {
      ref.current!({ clientX: 0 });
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 10_000 })); // far past max
      window.dispatchEvent(new MouseEvent('mouseup'));
    });
    expect(onResizeEnd).toHaveBeenCalledWith(480); // clamped to max

    act(() => {
      // A stray mousemove/mouseup after release must not resurrect a
      // drag or call onResizeEnd again — still just the one call above.
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 0 }));
      window.dispatchEvent(new MouseEvent('mouseup'));
    });
    expect(onResizeEnd).toHaveBeenCalledTimes(1);
  });

  // Milestone 5.5.1 Part 10 — a role="slider" control needs to actually
  // be keyboard-operable, not just carry the ARIA attributes.
  describe('keyboard resize (Part 10)', () => {
    function fakeKeyEvent(key: string): { key: string; preventDefault: jest.Mock } {
      return { key, preventDefault: jest.fn() };
    }

    it('ArrowRight widens by one step and ArrowLeft narrows by one step', () => {
      // A single stale-width call each — real callers (e.g. [id].tsx) feed
      // onResizeEnd's result back in as the next `width` prop via
      // Preferences; this harness's `width` prop is static within one
      // `renderWithAct` call, so each assertion here starts fresh from the
      // same committed 320 rather than chaining off the previous result.
      const onResizeEndA = jest.fn();
      const keyRefA: { current: KeyDownFn | null } = { current: null };
      renderWithAct(onResizeEndA, { current: null }, keyRefA, 320);
      act(() => keyRefA.current!(fakeKeyEvent('ArrowRight')));
      expect(onResizeEndA).toHaveBeenLastCalledWith(336); // default step 16

      const onResizeEndB = jest.fn();
      const keyRefB: { current: KeyDownFn | null } = { current: null };
      renderWithAct(onResizeEndB, { current: null }, keyRefB, 320);
      act(() => keyRefB.current!(fakeKeyEvent('ArrowLeft')));
      expect(onResizeEndB).toHaveBeenLastCalledWith(304);
    });

    it('ArrowUp/ArrowDown behave the same as ArrowRight/ArrowLeft', () => {
      const onResizeEndA = jest.fn();
      const keyRefA: { current: KeyDownFn | null } = { current: null };
      renderWithAct(onResizeEndA, { current: null }, keyRefA, 320);
      act(() => keyRefA.current!(fakeKeyEvent('ArrowUp')));
      expect(onResizeEndA).toHaveBeenLastCalledWith(336);

      const onResizeEndB = jest.fn();
      const keyRefB: { current: KeyDownFn | null } = { current: null };
      renderWithAct(onResizeEndB, { current: null }, keyRefB, 320);
      act(() => keyRefB.current!(fakeKeyEvent('ArrowDown')));
      expect(onResizeEndB).toHaveBeenLastCalledWith(304);
    });

    it('Home jumps to min, End jumps to max, both clamped', () => {
      const onResizeEnd = jest.fn();
      const mouseRef: { current: ((e: { clientX: number }) => void) | null } = { current: null };
      const keyRef: { current: KeyDownFn | null } = { current: null };
      renderWithAct(onResizeEnd, mouseRef, keyRef, 320);

      act(() => keyRef.current!(fakeKeyEvent('Home')));
      expect(onResizeEnd).toHaveBeenLastCalledWith(240);
      act(() => keyRef.current!(fakeKeyEvent('End')));
      expect(onResizeEnd).toHaveBeenLastCalledWith(480);
    });

    it('clamps at the boundary instead of going out of range', () => {
      const onResizeEnd = jest.fn();
      const mouseRef: { current: ((e: { clientX: number }) => void) | null } = { current: null };
      const keyRef: { current: KeyDownFn | null } = { current: null };
      // Start already at max.
      renderWithAct(onResizeEnd, mouseRef, keyRef, 480);

      act(() => keyRef.current!(fakeKeyEvent('ArrowRight')));
      // Already at max and staying there — the hook only calls onResizeEnd
      // when the value actually changes.
      expect(onResizeEnd).not.toHaveBeenCalled();
    });

    it('calls preventDefault only for keys it actually handles', () => {
      const onResizeEnd = jest.fn();
      const mouseRef: { current: ((e: { clientX: number }) => void) | null } = { current: null };
      const keyRef: { current: KeyDownFn | null } = { current: null };
      renderWithAct(onResizeEnd, mouseRef, keyRef, 320);

      const tabEvent = fakeKeyEvent('Tab');
      act(() => keyRef.current!(tabEvent));
      expect(tabEvent.preventDefault).not.toHaveBeenCalled();
      expect(onResizeEnd).not.toHaveBeenCalled();

      const rightEvent = fakeKeyEvent('ArrowRight');
      act(() => keyRef.current!(rightEvent));
      expect(rightEvent.preventDefault).toHaveBeenCalled();
    });
  });
});
