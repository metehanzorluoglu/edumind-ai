import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import type { DuplicateDocumentCandidate } from 'education-assistant-client';
import { DuplicateCandidateNotice } from '../DuplicateCandidateNotice';

function textOf(node: ReactTestInstance): string {
  return node.children
    .map((c) => (typeof c === 'string' || typeof c === 'number' ? String(c) : ''))
    .join('');
}

function findPressableByText(root: ReactTestInstance, text: string): ReactTestInstance {
  return root.find(
    (node) =>
      typeof node.props.onPress === 'function' &&
      node.findAll((n) => String(n.type) === 'Text' && textOf(n) === text).length > 0
  );
}

function findTextContaining(root: ReactTestInstance, substring: string): ReactTestInstance[] {
  return root.findAll((n) => String(n.type) === 'Text' && textOf(n).includes(substring));
}

function makeCandidate(
  overrides: Partial<DuplicateDocumentCandidate> = {}
): DuplicateDocumentCandidate {
  return {
    document_id: 'existing-1',
    title: 'A Laser Speckle Imaging Technique',
    authors: ['Forrester', 'Kim'],
    publication_year: 2019,
    source_filename: 'forrester-2019.pdf',
    match_type: 'exact_doi',
    ...overrides,
  };
}

describe('DuplicateCandidateNotice', () => {
  it('shows a compact citation-style identity for the existing document', async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <DuplicateCandidateNotice
          candidate={makeCandidate()}
          onOpenExisting={jest.fn()}
          onKeepBoth={jest.fn()}
        />
      );
    });
    expect(findTextContaining(renderer.root, 'Forrester et al. (2019)').length).toBeGreaterThan(0);
  });

  it('shows the folder location when the existing document is filed', async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <DuplicateCandidateNotice
          candidate={makeCandidate({ folder_name: 'AI Education Research' })}
          onOpenExisting={jest.fn()}
          onKeepBoth={jest.fn()}
        />
      );
    });
    expect(findTextContaining(renderer.root, 'in AI Education Research').length).toBeGreaterThan(0);
  });

  it('calls onOpenExisting when "Open existing" is pressed', async () => {
    const onOpenExisting = jest.fn();
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <DuplicateCandidateNotice
          candidate={makeCandidate()}
          onOpenExisting={onOpenExisting}
          onKeepBoth={jest.fn()}
        />
      );
    });
    act(() => {
      findPressableByText(renderer.root, 'Open existing').props.onPress();
    });
    expect(onOpenExisting).toHaveBeenCalledTimes(1);
  });

  it('calls onKeepBoth (and not onOpenExisting) when "Keep both" is pressed', async () => {
    const onOpenExisting = jest.fn();
    const onKeepBoth = jest.fn();
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <DuplicateCandidateNotice
          candidate={makeCandidate()}
          onOpenExisting={onOpenExisting}
          onKeepBoth={onKeepBoth}
        />
      );
    });
    act(() => {
      findPressableByText(renderer.root, 'Keep both').props.onPress();
    });
    expect(onKeepBoth).toHaveBeenCalledTimes(1);
    expect(onOpenExisting).not.toHaveBeenCalled();
  });

  it('falls back to the title when there are no authors', async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <DuplicateCandidateNotice
          candidate={makeCandidate({ authors: [], publication_year: null })}
          onOpenExisting={jest.fn()}
          onKeepBoth={jest.fn()}
        />
      );
    });
    expect(
      findTextContaining(renderer.root, 'A Laser Speckle Imaging Technique').length
    ).toBeGreaterThan(0);
  });
});
