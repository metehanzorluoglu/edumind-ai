import { Platform } from 'react-native';
import { act, create } from 'react-test-renderer';
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import { CompiledPdfPreview } from '../CompiledPdfPreview';

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

function textOf(node: ReactTestInstance): string {
  return node.children
    .map((c) => (typeof c === 'string' || typeof c === 'number' ? String(c) : ''))
    .join('');
}

function hasTextIncluding(root: ReactTestInstance, substring: string): boolean {
  return (
    root.findAll((node) => String(node.type) === 'Text' && textOf(node).includes(substring))
      .length > 0
  );
}

function renderPreview(props: Parameters<typeof CompiledPdfPreview>[0]): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<CompiledPdfPreview {...props} />);
  });
  activeRenderer = renderer;
  return renderer;
}

/**
 * Milestone 5.1 Part 25/31/32/36 — CompiledPdfPreview's own UI states.
 * Deliberately never exercises `pdfBlob !== null` here (that path calls
 * lib/pdfjs.ts's real `getPdfjs()`, which loads pdfjs-dist and spawns a
 * PDF worker — real-browser validation covers actual page rendering, the
 * same convention this app already follows for the Document Reader's own
 * PdfPageView, which has no jest-level render test either). Every state
 * covered here (empty/loading/error) is reachable without pdfBlob, and is
 * exactly what a jest environment can safely assert on. Every render is
 * wrapped in act() + unmounted in afterEach — this component's own
 * `pdfBlob === null` effect branch still calls setState, and leaving it
 * unflushed across test boundaries causes flaky "import after teardown"
 * failures in this monorepo's jest-expo environment.
 */
describe('CompiledPdfPreview', () => {
  it('shows the empty message when there is no compiled PDF yet', () => {
    const renderer = renderPreview({
      pdfBlob: null,
      loading: false,
      error: null,
      stale: false,
      emptyMessage: 'Compile to see a preview.',
    });
    expect(hasTextIncluding(renderer.root, 'Compile to see a preview.')).toBe(true);
  });

  it('shows a loading indicator while compiling', () => {
    const renderer = renderPreview({
      pdfBlob: null,
      loading: true,
      error: null,
      stale: false,
      emptyMessage: 'Compile to see a preview.',
    });
    expect(hasTextIncluding(renderer.root, 'Compiling…')).toBe(true);
  });

  it('shows an error message when the PDF failed to load', () => {
    const renderer = renderPreview({
      pdfBlob: null,
      loading: false,
      error: 'Could not load the compiled PDF.',
      stale: false,
      emptyMessage: 'Compile to see a preview.',
    });
    expect(hasTextIncluding(renderer.root, 'Could not load the compiled PDF.')).toBe(true);
  });

  it('never shows the stale banner when there is no compiled PDF (nothing to be stale)', () => {
    const renderer = renderPreview({
      pdfBlob: null,
      loading: false,
      error: null,
      stale: true,
      emptyMessage: 'Compile to see a preview.',
    });
    // stale is only meaningful once a PDF is actually displayed —
    // pdfBlob === null short-circuits to the empty state first.
    expect(hasTextIncluding(renderer.root, 'Source changed since last compile')).toBe(false);
  });
});
