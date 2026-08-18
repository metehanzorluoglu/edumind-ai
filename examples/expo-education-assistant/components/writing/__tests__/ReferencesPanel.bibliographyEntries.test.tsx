import { act, create } from 'react-test-renderer';
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import type { WritingProjectReferenceMode } from 'education-assistant-client';
import { ReferencesPanel, type ReferencesPanelProps } from '../ReferencesPanel';

/**
 * Bibliography Source Detection — the "Bibliography entries" section
 * ReferencesPanel adds for a project whose real bibliography ISN'T
 * EduM8's own library, so citation insertion still works there without
 * first connecting EduM8 references. Deliberately scoped to just this
 * new section (the pre-existing EduM8-references list/search/select UI
 * predates this work and isn't touched by it).
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

function baseProps(overrides: Partial<ReferencesPanelProps> = {}): ReferencesPanelProps {
  return {
    references: [],
    missingCitationKeys: [],
    loading: false,
    loadError: null,
    onAddReferences: jest.fn(),
    onInsertCitation: jest.fn(),
    onInsertMultipleCitations: jest.fn(),
    onRemoveReference: jest.fn().mockResolvedValue(undefined),
    onViewBibliography: jest.fn(),
    onOpenSource: jest.fn(),
    referenceMode: null,
    onSwitchToEdum8: jest.fn().mockResolvedValue(undefined),
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

function renderPanel(props: ReferencesPanelProps): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<ReferencesPanel {...props} />);
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

describe('ReferencesPanel — Bibliography entries section', () => {
  it('does not render the section in edum8_library mode', () => {
    const renderer = renderPanel(
      baseProps({ referenceMode: buildMode({ mode: 'edum8_library' }) })
    );
    expect(hasTextIncluding(renderer.root, 'Bibliography entries')).toBe(false);
  });

  it('does not render the section when a non-edum8 mode has no resolved keys', () => {
    const renderer = renderPanel(
      baseProps({
        referenceMode: buildMode({ mode: 'template_tex', keys: [], citation_key_source: 'none' }),
      })
    );
    expect(hasTextIncluding(renderer.root, 'Bibliography entries')).toBe(false);
  });

  it('renders resolved keys for imported_bib mode with a title fallback to the key', () => {
    const renderer = renderPanel(
      baseProps({
        referenceMode: buildMode({
          mode: 'imported_bib',
          bibliography_source: 'sn-bibliography.bib',
          citation_key_source: 'bib_file',
          keys: [
            { key: 'bib1', title: 'The index of general nonlinear DAES' },
            { key: 'bib2', title: null },
          ],
        }),
      })
    );
    expect(hasTextIncluding(renderer.root, 'Bibliography entries (2)')).toBe(true);
    expect(hasTextIncluding(renderer.root, 'The index of general nonlinear DAES')).toBe(true);
    expect(hasTextIncluding(renderer.root, 'bib2')).toBe(true);
  });

  it('inserts the exact resolved key when "Insert citation" is pressed for a bibliography entry', () => {
    const onInsertCitation = jest.fn();
    const renderer = renderPanel(
      baseProps({
        onInsertCitation,
        referenceMode: buildMode({
          mode: 'template_tex',
          bibliography_source: 'Bibliography.tex',
          citation_key_source: 'bibitem',
          keys: [{ key: 'example1', title: 'Author, A. Title of the Paper.' }],
        }),
      })
    );
    const [insertBtn] = renderer.root.findAll(
      (node) =>
        node.props.accessibilityLabel === 'Insert citation for Author, A. Title of the Paper.'
    );
    if (!insertBtn) throw new Error('insert-citation button not found');
    act(() => {
      insertBtn.props.onPress();
    });
    expect(onInsertCitation).toHaveBeenCalledWith('example1');
  });
});
