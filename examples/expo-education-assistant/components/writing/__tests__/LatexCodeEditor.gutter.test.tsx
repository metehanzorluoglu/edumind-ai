import { Platform } from 'react-native';
import { act, create } from 'react-test-renderer';
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import { fontFamilies } from '@/lib/fonts';
import { DARK_PALETTE, radius, space, type Theme } from '@/lib/Preferences';
import { LatexCodeEditor } from '../LatexCodeEditor';

/**
 * Milestone 5.5.3 — "EDITOR LINE NUMBERS": the Overleaf-style gutter
 * added to LatexCodeEditor. Per this session's own established split,
 * the DOM-manipulation half of this feature (scroll-sync transform,
 * flash-highlight positioning) is gated behind `typeof document ===
 * 'undefined'` checks and is real-browser territory only (jest's own
 * RN test environment has no `document`, so those effects are no-ops
 * here regardless). What IS plain React output — the gutter's line
 * NUMBERS themselves (`gutterText`, a single `useMemo` derived purely
 * from `value`) and its WIDTH formula (`gutterWidth`, purely from line
 * count) — are ordinary render output, verifiable directly here.
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

function renderEditor(value: string): ReactTestRenderer {
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
      />
    );
  });
  activeRenderer = renderer;
  return renderer;
}

function gutterDiv(renderer: ReactTestRenderer): ReactTestInstance {
  // Milestone 5.5.3 continuation — the numbers text block itself now
  // lives one level deeper than the scroll-synced `[data-latex-gutter-
  // lines]` wrapper (which also holds the persistent error-marker
  // bands as siblings — see the component's own comment), so this
  // queries the more specific `data-latex-gutter-numbers` attribute
  // added for exactly this purpose.
  const [found] = renderer.root.findAll((node) => 'data-latex-gutter-numbers' in node.props);
  if (!found) throw new Error('gutter numbers div not found — did the component structure change?');
  return found;
}

function gutterOuterDiv(renderer: ReactTestRenderer): ReactTestInstance {
  // The gutter's fixed-width wrapping div, two levels up: numbers ->
  // `[data-latex-gutter-lines]` (the scroll-synced wrapper) -> the
  // fixed-width bordered outer div, which carries the `width:
  // gutterWidth` style asserted on below.
  return gutterDiv(renderer).parent!.parent!;
}

describe('LatexCodeEditor line-number gutter (Milestone 5.5.3)', () => {
  it('renders one line number per line, 1-indexed, for a short file', () => {
    const renderer = renderEditor('\\documentclass{article}\n\\begin{document}\n\\end{document}');
    const gutter = gutterDiv(renderer);
    expect(gutter.children.join('')).toBe('1\n2\n3');
  });

  it("counts a trailing newline as one more (empty) line — the same convention `value.split('\\n')` and every offsetForLine caller in this app already uses", () => {
    const renderer = renderEditor('a\nb\n');
    const gutter = gutterDiv(renderer);
    expect(gutter.children.join('')).toBe('1\n2\n3');
  });

  it('scales past 1,000 lines without truncating (the "must scale safely past 1,000+ lines" requirement)', () => {
    const bigValue = Array.from({ length: 1200 }, (_, i) => `line ${i + 1}`).join('\n');
    const renderer = renderEditor(bigValue);
    const gutter = gutterDiv(renderer);
    const text = gutter.children.join('');
    const numbers = text.split('\n');
    expect(numbers).toHaveLength(1200);
    expect(numbers[0]).toBe('1');
    expect(numbers[1199]).toBe('1200');
  });

  it('is a SINGLE text node, not one element per line — the explicit perf requirement ("not another independently scrolling text copy" / no per-line DOM cost at 1,000+ lines)', () => {
    const bigValue = Array.from({ length: 1200 }, (_, i) => `line ${i + 1}`).join('\n');
    const renderer = renderEditor(bigValue);
    const gutter = gutterDiv(renderer);
    // Exactly one child: the joined "1\n2\n...\n1200" string, not 1200
    // separate child elements.
    expect(gutter.children).toHaveLength(1);
    expect(typeof gutter.children[0]).toBe('string');
  });

  it('keeps a small fixed gutter width for single-digit line counts', () => {
    const renderer = renderEditor('one line only');
    const outer = gutterOuterDiv(renderer);
    expect(outer.props.style.width).toBe(32); // Math.max(32, ...) floor
  });

  it('widens the gutter as line count grows into 4+ digits, so numbers never clip', () => {
    const bigValue = Array.from({ length: 1200 }, (_, i) => `line ${i + 1}`).join('\n');
    const renderer = renderEditor(bigValue);
    const outer = gutterOuterDiv(renderer);
    // Math.ceil(log10(1201)) * 8 + 24 = 4*8+24 = 56
    expect(outer.props.style.width).toBe(56);
  });

  it('recomputes the gutter on every value change (re-render), not just on mount', () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <LatexCodeEditor
          value={'a\nb'}
          onValueChange={() => {}}
          selection={{ start: 0, end: 0 }}
          onSelectionChange={() => {}}
          editable
          theme={fakeTheme()}
          autocompleteData={{ citationKeys: [], filePaths: [] }}
        />
      );
    });
    activeRenderer = renderer;
    expect(gutterDiv(renderer).children.join('')).toBe('1\n2');

    act(() => {
      renderer.update(
        <LatexCodeEditor
          value={'a\nb\nc\nd'}
          onValueChange={() => {}}
          selection={{ start: 0, end: 0 }}
          onSelectionChange={() => {}}
          editable
          theme={fakeTheme()}
          autocompleteData={{ citationKeys: [], filePaths: [] }}
        />
      );
    });
    expect(gutterDiv(renderer).children.join('')).toBe('1\n2\n3\n4');
  });
});
