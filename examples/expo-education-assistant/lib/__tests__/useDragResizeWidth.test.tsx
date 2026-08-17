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

function Harness({
  onResizeEnd,
  onMouseDownRef,
}: {
  onResizeEnd: (w: number) => void;
  onMouseDownRef: { current: ((e: { clientX: number }) => void) | null };
}) {
  const { handleMouseDown } = useDragResizeWidth({
    width: 320,
    min: 240,
    max: 480,
    onResizeEnd,
  });
  useEffect(() => {
    onMouseDownRef.current = handleMouseDown;
  });
  return <View />;
}

function renderWithAct(
  onResizeEnd: (w: number) => void,
  onMouseDownRef: { current: ((e: { clientX: number }) => void) | null }
): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<Harness onResizeEnd={onResizeEnd} onMouseDownRef={onMouseDownRef} />);
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
});
