import { Platform } from 'react-native';
import { act, create } from 'react-test-renderer';
import type { ReactTestRenderer } from 'react-test-renderer';
import { fontFamilies } from '@/lib/fonts';
import { DARK_PALETTE, radius, space, type Theme } from '@/lib/Preferences';
import { LatexCodeEditor } from '../LatexCodeEditor';

/**
 * Milestone 5.5.3 continuation — PERSISTENT compiler-error decoration
 * (distinct from the temporary `flashLine` navigation highlight, which
 * already has its own real-browser-verified coverage from the prior
 * round). `errorLines` is plain render output (no `document` needed —
 * only the SCROLL-SYNC of these layers is DOM-effect-gated, which is a
 * real-browser-only concern per this session's own established split),
 * so its geometry/dedup/clamp logic is directly testable here.
 */

function fakeTheme(): Theme {
  return {
    ...DARK_PALETTE,
    mode: 'dark',
    effective: 'dark',
    scale: (n: number) => n,
    reduceMotion: false,
    fonts: fontFamilies(false),
    space,
    radius,
  };
}

const originalOS = Platform.OS;
beforeAll(() => {
  Platform.OS = 'web';
});
afterAll(() => {
  Platform.OS = originalOS;
});

let activeRenderer: ReactTestRenderer | null = null;
afterEach(() => {
  if (activeRenderer) {
    act(() => {
      activeRenderer!.unmount();
    });
    activeRenderer = null;
  }
});

function renderEditor(
  value: string,
  errorLines?: { line: number; message: string }[]
): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <LatexCodeEditor
        value={value}
        onValueChange={() => {}}
        selection={{ start: 0, end: 0 }}
        onSelectionChange={() => {}}
        editable
        theme={fakeTheme()}
        autocompleteData={{ citationKeys: [], filePaths: [] }}
        errorLines={errorLines}
      />
    );
  });
  activeRenderer = renderer;
  return renderer;
}

function errorLineBands(renderer: ReactTestRenderer) {
  const [layer] = renderer.root.findAll((node) => 'data-latex-error-lines' in node.props);
  if (!layer) return [];
  return layer.children.filter(
    (c): c is Exclude<typeof c, string | number> => typeof c !== 'string' && typeof c !== 'number'
  );
}

function gutterMarkCount(renderer: ReactTestRenderer): number {
  const [numbers] = renderer.root.findAll((node) => 'data-latex-gutter-numbers' in node.props);
  if (!numbers) return 0;
  // Marks are the numbers div's own PRECEDING siblings inside the same
  // `[data-latex-gutter-lines]` wrapper — count that wrapper's children
  // minus the numbers div itself.
  const wrapper = numbers.parent!;
  return wrapper.children.length - 1;
}

const FIVE_LINES = 'one\ntwo\nthree\nfour\nfive';

describe('LatexCodeEditor persistent error decoration (Milestone 5.5.3 continuation)', () => {
  it('renders nothing when errorLines is omitted', () => {
    const renderer = renderEditor(FIVE_LINES);
    expect(errorLineBands(renderer)).toHaveLength(0);
    expect(gutterMarkCount(renderer)).toBe(0);
  });

  it('renders nothing for an empty errorLines array (the successful-compile / cleared state)', () => {
    const renderer = renderEditor(FIVE_LINES, []);
    expect(errorLineBands(renderer)).toHaveLength(0);
  });

  it('renders one band per error line, positioned at the correct fixed-geometry offset', () => {
    const renderer = renderEditor(FIVE_LINES, [{ line: 3, message: 'Missing number.' }]);
    const bands = errorLineBands(renderer);
    expect(bands).toHaveLength(1);
    // CONTENT_PADDING_TOP_PX(16) + (3-1)*LINE_HEIGHT_PX(20) = 56
    expect(bands[0]!.props.style.top).toBe(56);
  });

  it('renders a matching gutter marker for each error line', () => {
    const renderer = renderEditor(FIVE_LINES, [
      { line: 1, message: 'a' },
      { line: 4, message: 'b' },
    ]);
    expect(errorLineBands(renderer)).toHaveLength(2);
    expect(gutterMarkCount(renderer)).toBe(2);
  });

  it('deduplicates two diagnostics that land on the same line into one mark', () => {
    const renderer = renderEditor(FIVE_LINES, [
      { line: 2, message: 'first problem' },
      { line: 2, message: 'a related second problem' },
    ]);
    expect(errorLineBands(renderer)).toHaveLength(1);
  });

  it('clamps a stale diagnostic line past the current (edited-since) end of the file', () => {
    const renderer = renderEditor(FIVE_LINES, [{ line: 999, message: 'stale' }]);
    const bands = errorLineBands(renderer);
    expect(bands).toHaveLength(1);
    // Clamped to line 5 (the last real line): 16 + (5-1)*20 = 96
    expect(bands[0]!.props.style.top).toBe(96);
  });

  it('replaces old marks with new ones when errorLines changes (a different failed compile)', () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <LatexCodeEditor
          value={FIVE_LINES}
          onValueChange={() => {}}
          selection={{ start: 0, end: 0 }}
          onSelectionChange={() => {}}
          editable
          theme={fakeTheme()}
          autocompleteData={{ citationKeys: [], filePaths: [] }}
          errorLines={[{ line: 1, message: 'old problem' }]}
        />
      );
    });
    activeRenderer = renderer;
    expect(errorLineBands(renderer)).toHaveLength(1);

    act(() => {
      renderer.update(
        <LatexCodeEditor
          value={FIVE_LINES}
          onValueChange={() => {}}
          selection={{ start: 0, end: 0 }}
          onSelectionChange={() => {}}
          editable
          theme={fakeTheme()}
          autocompleteData={{ citationKeys: [], filePaths: [] }}
          errorLines={[{ line: 4, message: 'new problem' }]}
        />
      );
    });
    const bands = errorLineBands(renderer);
    expect(bands).toHaveLength(1);
    expect(bands[0]!.props.style.top).toBe(76); // line 4: 16 + 3*20
  });

  it('clears every mark when the next update passes an empty array (a successful compile)', () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <LatexCodeEditor
          value={FIVE_LINES}
          onValueChange={() => {}}
          selection={{ start: 0, end: 0 }}
          onSelectionChange={() => {}}
          editable
          theme={fakeTheme()}
          autocompleteData={{ citationKeys: [], filePaths: [] }}
          errorLines={[{ line: 2, message: 'problem' }]}
        />
      );
    });
    activeRenderer = renderer;
    expect(errorLineBands(renderer)).toHaveLength(1);

    act(() => {
      renderer.update(
        <LatexCodeEditor
          value={FIVE_LINES}
          onValueChange={() => {}}
          selection={{ start: 0, end: 0 }}
          onSelectionChange={() => {}}
          editable
          theme={fakeTheme()}
          autocompleteData={{ citationKeys: [], filePaths: [] }}
          errorLines={[]}
        />
      );
    });
    expect(errorLineBands(renderer)).toHaveLength(0);
  });
});
