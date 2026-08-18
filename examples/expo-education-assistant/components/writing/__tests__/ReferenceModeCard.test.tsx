import { act, create } from 'react-test-renderer';
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import type { WritingProjectReferenceMode } from 'education-assistant-client';
import { ReferenceModeCard } from '../ReferenceModeCard';

/**
 * Bibliography Source Detection — ReferenceModeCard is the UI that
 * explains a project's real reference setup and, when a safe automatic
 * rewrite exists, offers a confirm-before-apply "Use EduM8 references"
 * switch. Covers: rendering each mode's own labels, showing the
 * no-key-source warning, the two distinct confirm-step branches
 * (a real proposal vs. instructions-only), and that the switch action
 * is NEVER called just by opening the confirm step — only by explicitly
 * pressing "Apply change".
 */

function buildMode(
  overrides: Partial<WritingProjectReferenceMode> = {}
): WritingProjectReferenceMode {
  return {
    mode: 'edum8_library',
    bibliography_source: 'references.bib',
    citation_key_source: 'edum8',
    keys: [],
    edum8_available: false,
    no_key_source_reason: null,
    edum8_switch_proposal: null,
    edum8_switch_instructions: null,
    ...overrides,
  };
}

let activeRenderer: ReactTestRenderer | null = null;
afterEach(() => {
  if (activeRenderer) {
    act(() => {
      activeRenderer!.unmount();
    });
    activeRenderer = null;
  }
});

function renderCard(
  referenceMode: WritingProjectReferenceMode | null,
  onSwitchToEdum8: () => Promise<unknown> = () => Promise.resolve()
): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <ReferenceModeCard referenceMode={referenceMode} onSwitchToEdum8={onSwitchToEdum8} />
    );
  });
  activeRenderer = renderer;
  return renderer;
}

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

function findButtonByLabel(root: ReactTestInstance, label: string): ReactTestInstance {
  const [found] = root.findAll(
    (node) => node.props.accessibilityRole === 'button' && hasTextIncluding(node, label)
  );
  if (!found) throw new Error(`button "${label}" not found`);
  return found;
}

describe('ReferenceModeCard', () => {
  it('renders nothing while reference mode is still loading (null)', () => {
    const renderer = renderCard(null);
    expect(renderer.toJSON()).toBeNull();
  });

  it('shows the EduM8 library mode without a switch button', () => {
    const renderer = renderCard(buildMode({ mode: 'edum8_library' }));
    expect(hasTextIncluding(renderer.root, 'EduM8 Reference Library')).toBe(true);
    expect(hasTextIncluding(renderer.root, 'references.bib')).toBe(true);
    expect(() => findButtonByLabel(renderer.root, 'Use EduM8 references')).toThrow();
  });

  it('shows imported_bib mode with its bibliography source and an "available, not connected" note', () => {
    const renderer = renderCard(
      buildMode({
        mode: 'imported_bib',
        bibliography_source: 'sn-bibliography.bib',
        citation_key_source: 'bib_file',
        edum8_available: true,
      })
    );
    expect(hasTextIncluding(renderer.root, 'Imported BibTeX')).toBe(true);
    expect(hasTextIncluding(renderer.root, 'sn-bibliography.bib')).toBe(true);
    expect(hasTextIncluding(renderer.root, 'Available, not currently connected')).toBe(true);
  });

  it('shows template_tex mode with a "Template-managed" label', () => {
    const renderer = renderCard(
      buildMode({
        mode: 'template_tex',
        bibliography_source: 'Bibliography.tex',
        citation_key_source: 'bibitem',
      })
    );
    expect(hasTextIncluding(renderer.root, 'Template-managed')).toBe(true);
    expect(hasTextIncluding(renderer.root, 'Bibliography.tex')).toBe(true);
  });

  it('shows the no-key-source warning when citation_key_source is "none"', () => {
    const renderer = renderCard(
      buildMode({
        mode: 'template_tex',
        citation_key_source: 'none',
        no_key_source_reason: 'No \\bibitem entries found in Bibliography.tex.',
      })
    );
    expect(hasTextIncluding(renderer.root, 'No \\bibitem entries found')).toBe(true);
  });

  it('shows a real proposal diff and applies it only when "Apply change" is pressed, never on opening the confirm step', async () => {
    const onSwitchToEdum8 = jest.fn().mockResolvedValue(undefined);
    const renderer = renderCard(
      buildMode({
        mode: 'imported_bib',
        bibliography_source: 'mydb.bib',
        edum8_switch_proposal: {
          file_path: 'main.tex',
          find: '\\bibliography{mydb}',
          replace: '\\bibliography{references}',
        },
      }),
      onSwitchToEdum8
    );

    act(() => {
      findButtonByLabel(renderer.root, 'Use EduM8 references').props.onPress();
    });
    expect(hasTextIncluding(renderer.root, '\\bibliography{mydb}')).toBe(true);
    expect(hasTextIncluding(renderer.root, '\\bibliography{references}')).toBe(true);
    // Opening the confirm step must never itself apply anything.
    expect(onSwitchToEdum8).not.toHaveBeenCalled();

    await act(async () => {
      findButtonByLabel(renderer.root, 'Apply change').props.onPress();
      await Promise.resolve();
    });
    expect(onSwitchToEdum8).toHaveBeenCalledTimes(1);
  });

  it('shows instructions only (no proposal) for template_tex mode, and never calls onSwitchToEdum8 from that step', () => {
    const onSwitchToEdum8 = jest.fn();
    const renderer = renderCard(
      buildMode({
        mode: 'template_tex',
        bibliography_source: 'Bibliography.tex',
        edum8_switch_proposal: null,
        edum8_switch_instructions:
          "This project's bibliography lives in Bibliography.tex as manual entries.",
      }),
      onSwitchToEdum8
    );

    act(() => {
      findButtonByLabel(renderer.root, 'Use EduM8 references').props.onPress();
    });
    expect(hasTextIncluding(renderer.root, 'manual entries')).toBe(true);
    // No "Apply change" button exists for the instructions-only branch —
    // never a fabricated automatic rewrite for a thebibliography block.
    expect(() => findButtonByLabel(renderer.root, 'Apply change')).toThrow();
    expect(onSwitchToEdum8).not.toHaveBeenCalled();
  });

  it('shows a switch error and stays in the confirm step if applying fails', async () => {
    const onSwitchToEdum8 = jest.fn().mockRejectedValue(new Error('Network error'));
    const renderer = renderCard(
      buildMode({
        mode: 'imported_bib',
        edum8_switch_proposal: { file_path: 'main.tex', find: 'a', replace: 'b' },
      }),
      onSwitchToEdum8
    );

    act(() => {
      findButtonByLabel(renderer.root, 'Use EduM8 references').props.onPress();
    });
    await act(async () => {
      findButtonByLabel(renderer.root, 'Apply change').props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(hasTextIncluding(renderer.root, 'Network error')).toBe(true);
    // Still in the confirm step — Cancel is still present.
    expect(() => findButtonByLabel(renderer.root, 'Cancel')).not.toThrow();
  });
});
