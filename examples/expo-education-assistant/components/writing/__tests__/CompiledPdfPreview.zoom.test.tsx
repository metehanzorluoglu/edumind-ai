import { useState } from 'react';
import { act, create } from 'react-test-renderer';
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import { PdfZoomBar } from '../CompiledPdfPreview';

/**
 * M5.5.3 continuation Part 8 — the direct-percentage-zoom-entry
 * interaction, exercised directly against PdfZoomBar (extracted as its
 * own presentational component precisely so it CAN be tested this way):
 * reaching CompiledPdfPreview's own `status === 'success'` branch
 * requires a real `document.createElement('canvas')` call this
 * monorepo's jest environment (react-native's own jest-preset, not
 * jsdom) has no substitute for — see CompiledPdfPreview.test.tsx's own
 * docstring for why that file deliberately never exercises
 * `pdfBlob !== null`.
 */
const MIN_SCALE = 0.5;
const MAX_SCALE = 3;

let activeRenderer: ReactTestRenderer | null = null;
afterEach(() => {
  if (activeRenderer) {
    act(() => {
      activeRenderer!.unmount();
    });
    activeRenderer = null;
  }
});

/** A tiny stateful harness — PdfZoomBar itself is a controlled
 * component (scale/onSetScale), so a real host component that actually
 * applies onSetScale is needed to observe committed changes. */
function Harness({ initialScale = 1 }: { initialScale?: number }) {
  const [scale, setScale] = useState(initialScale);
  return (
    <PdfZoomBar
      scale={scale}
      minScale={MIN_SCALE}
      maxScale={MAX_SCALE}
      onZoomOut={() => setScale((s) => Math.max(MIN_SCALE, s - 0.25))}
      onZoomIn={() => setScale((s) => Math.min(MAX_SCALE, s + 0.25))}
      onFitWidth={() => setScale(1)}
      onSetScale={setScale}
    />
  );
}

function renderHarness(initialScale?: number): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<Harness initialScale={initialScale} />);
  });
  activeRenderer = renderer;
  return renderer;
}

function zoomToggle(root: ReactTestInstance): ReactTestInstance {
  return root.find(
    (n) =>
      typeof n.props.onPress === 'function' &&
      typeof n.props.accessibilityLabel === 'string' &&
      n.props.accessibilityLabel.startsWith('Zoom level:')
  );
}

function zoomInput(root: ReactTestInstance): ReactTestInstance {
  return root.find(
    (n) => String(n.type) === 'TextInput' && n.props.accessibilityLabel === 'Zoom percentage'
  );
}

describe('PdfZoomBar — direct percentage zoom (M5.5.3 continuation Part 8)', () => {
  it('starts in read-only mode showing the current percentage', () => {
    const renderer = renderHarness();
    expect(zoomToggle(renderer.root).props.accessibilityLabel).toContain('100%');
  });

  it('tapping the percentage enters edit mode with an editable field pre-filled', () => {
    const renderer = renderHarness();
    act(() => {
      zoomToggle(renderer.root).props.onPress();
    });
    expect(zoomInput(renderer.root).props.value).toBe('100');
  });

  for (const value of [80, 99, 100, 125, 150, 200]) {
    it(`commits a valid typed value (${value}%) via Enter`, () => {
      const renderer = renderHarness();
      act(() => {
        zoomToggle(renderer.root).props.onPress();
      });
      act(() => {
        zoomInput(renderer.root).props.onChangeText(String(value));
      });
      act(() => {
        zoomInput(renderer.root).props.onSubmitEditing();
      });
      expect(zoomToggle(renderer.root).props.accessibilityLabel).toContain(`${value}%`);
    });
  }

  it('clamps a value above the maximum to 300%', () => {
    const renderer = renderHarness();
    act(() => {
      zoomToggle(renderer.root).props.onPress();
    });
    act(() => {
      zoomInput(renderer.root).props.onChangeText('999');
    });
    act(() => {
      zoomInput(renderer.root).props.onSubmitEditing();
    });
    expect(zoomToggle(renderer.root).props.accessibilityLabel).toContain('300%');
  });

  it('clamps a value below the minimum to 50%', () => {
    const renderer = renderHarness();
    act(() => {
      zoomToggle(renderer.root).props.onPress();
    });
    act(() => {
      zoomInput(renderer.root).props.onChangeText('1');
    });
    act(() => {
      zoomInput(renderer.root).props.onSubmitEditing();
    });
    expect(zoomToggle(renderer.root).props.accessibilityLabel).toContain('50%');
  });

  it('leaves the zoom unchanged when the typed value is not a number', () => {
    const renderer = renderHarness();
    act(() => {
      zoomToggle(renderer.root).props.onPress();
    });
    act(() => {
      zoomInput(renderer.root).props.onChangeText('abc');
    });
    act(() => {
      zoomInput(renderer.root).props.onSubmitEditing();
    });
    expect(zoomToggle(renderer.root).props.accessibilityLabel).toContain('100%');
  });

  it('leaves the zoom unchanged when the typed value is empty', () => {
    const renderer = renderHarness();
    act(() => {
      zoomToggle(renderer.root).props.onPress();
    });
    act(() => {
      zoomInput(renderer.root).props.onChangeText('');
    });
    act(() => {
      zoomInput(renderer.root).props.onSubmitEditing();
    });
    expect(zoomToggle(renderer.root).props.accessibilityLabel).toContain('100%');
  });

  it('Escape cancels the edit without applying the typed value', () => {
    const renderer = renderHarness();
    act(() => {
      zoomToggle(renderer.root).props.onPress();
    });
    act(() => {
      zoomInput(renderer.root).props.onChangeText('250');
    });
    act(() => {
      zoomInput(renderer.root).props.onKeyPress({ nativeEvent: { key: 'Escape' } });
    });
    expect(zoomToggle(renderer.root).props.accessibilityLabel).toContain('100%');
    expect(() => zoomInput(renderer.root)).toThrow();
  });

  it('Escape does not let a subsequent blur re-apply the discarded value', () => {
    const renderer = renderHarness();
    act(() => {
      zoomToggle(renderer.root).props.onPress();
    });
    act(() => {
      zoomInput(renderer.root).props.onChangeText('250');
    });
    const input = zoomInput(renderer.root);
    // Captured before the Escape-triggered unmount below detaches this
    // node from the tree — react-test-renderer can't re-read `.props`
    // off an already-unmounted instance, same as a real DOM element.
    const onBlurFn = input.props.onBlur;
    act(() => {
      input.props.onKeyPress({ nativeEvent: { key: 'Escape' } });
    });
    // Simulates the unmount-triggered blur a real DOM fires right after
    // the input leaves the tree.
    act(() => {
      onBlurFn?.();
    });
    expect(zoomToggle(renderer.root).props.accessibilityLabel).toContain('100%');
  });

  it('blur commits a valid typed value', () => {
    const renderer = renderHarness();
    act(() => {
      zoomToggle(renderer.root).props.onPress();
    });
    act(() => {
      zoomInput(renderer.root).props.onChangeText('175');
    });
    act(() => {
      zoomInput(renderer.root).props.onBlur();
    });
    expect(zoomToggle(renderer.root).props.accessibilityLabel).toContain('175%');
  });

  it('"Fit width" remains a distinct action, not one of the typed numeric options', () => {
    const renderer = renderHarness();
    const fitWidth = renderer.root.find(
      (n) => typeof n.props.onPress === 'function' && n.props.accessibilityLabel === 'Fit width'
    );
    expect(fitWidth).toBeTruthy();
    act(() => {
      fitWidth.props.onPress();
    });
    // Fit width applies its own computed scale (1, per the harness'
    // onFitWidth), not anything read from the zoom text field.
    expect(zoomToggle(renderer.root).props.accessibilityLabel).toContain('100%');
  });

  it('Zoom in/out buttons still work independently of the text-entry path', () => {
    const renderer = renderHarness();
    const zoomInBtn = renderer.root.find(
      (n) => typeof n.props.onPress === 'function' && n.props.accessibilityLabel === 'Zoom in'
    );
    act(() => {
      zoomInBtn.props.onPress();
    });
    expect(zoomToggle(renderer.root).props.accessibilityLabel).toContain('125%');
  });
});
