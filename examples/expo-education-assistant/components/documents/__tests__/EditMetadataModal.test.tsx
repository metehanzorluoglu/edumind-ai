import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import type { DocumentSummary } from 'education-assistant-client';
import {
  buildMetadataDiff,
  EditMetadataModal,
  type EditMetadataFormState,
} from '../EditMetadataModal';

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

function findFieldByLabel(root: ReactTestInstance, label: string): ReactTestInstance {
  return root.find((n) => String(n.type) === 'TextInput' && n.props.accessibilityLabel === label);
}

function makeDocument(overrides: Partial<DocumentSummary> = {}): DocumentSummary {
  return {
    document_id: 'd1',
    source_filename: 'paper.pdf',
    title: 'A Study of Something Real',
    document_type: 'report',
    authors: ['Jane Doe'],
    chunk_count: 3,
    ingested_at: '2026-01-01T00:00:00Z',
    original_file_available: false,
    has_usable_doi: false,
    ...overrides,
  };
}

function formFromDocument(document: DocumentSummary): EditMetadataFormState {
  return {
    title: document.title ?? document.source_filename,
    authorsText: (document.authors ?? []).join(', '),
    documentType: document.document_type,
    publicationYearText: document.publication_year ? String(document.publication_year) : '',
    sourceVenue: document.source_venue ?? '',
    doi: document.doi ?? '',
    sourceUrl: document.source_url ?? '',
    volume: document.volume ?? '',
    issue: document.issue ?? '',
    pageStartText: document.page_start ? String(document.page_start) : '',
    pageEndText: document.page_end ? String(document.page_end) : '',
    publisher: document.publisher ?? '',
    abstract: document.abstract ?? '',
    keywordsText: (document.keywords ?? []).join(', '),
    language: document.language ?? '',
  };
}

describe('buildMetadataDiff', () => {
  it('returns an empty diff when nothing changed', () => {
    const document = makeDocument();
    expect(buildMetadataDiff(document, formFromDocument(document))).toEqual({});
  });

  it('includes only the title when only the title changed', () => {
    const document = makeDocument();
    const form = { ...formFromDocument(document), title: 'A Corrected Title' };
    expect(buildMetadataDiff(document, form)).toEqual({ title: 'A Corrected Title' });
  });

  it('detects an authors change and splits/trims the comma list', () => {
    const document = makeDocument();
    const form = { ...formFromDocument(document), authorsText: 'Ada Lovelace,  Grace Hopper ' };
    expect(buildMetadataDiff(document, form)).toEqual({
      authors: ['Ada Lovelace', 'Grace Hopper'],
    });
  });

  it('detects a document type change', () => {
    const document = makeDocument();
    const form = { ...formFromDocument(document), documentType: 'book' as const };
    expect(buildMetadataDiff(document, form)).toEqual({ documentType: 'book' });
  });

  it('detects a publication year change and parses it as a number', () => {
    const document = makeDocument();
    const form = { ...formFromDocument(document), publicationYearText: '2020' };
    expect(buildMetadataDiff(document, form)).toEqual({ publicationYear: 2020 });
  });

  it('detects clearing an optional field to null', () => {
    const document = makeDocument({ source_venue: 'A Journal' });
    const form = { ...formFromDocument(document), sourceVenue: '' };
    expect(buildMetadataDiff(document, form)).toEqual({ sourceVenue: null });
  });

  it('detects a keywords change', () => {
    const document = makeDocument({ keywords: ['a'] });
    const form = { ...formFromDocument(document), keywordsText: 'a, b, c' };
    expect(buildMetadataDiff(document, form)).toEqual({ keywords: ['a', 'b', 'c'] });
  });

  it('never includes an unrelated field that did not change', () => {
    const document = makeDocument({ doi: '10.1000/abc', source_venue: 'A Journal' });
    const form = { ...formFromDocument(document), title: 'New Title' };
    const diff = buildMetadataDiff(document, form);
    expect(diff).toEqual({ title: 'New Title' });
    expect('doi' in diff).toBe(false);
    expect('sourceVenue' in diff).toBe(false);
  });

  it('handles volume/issue/page fields', () => {
    const document = makeDocument();
    const form = {
      ...formFromDocument(document),
      volume: '12',
      issue: '3',
      pageStartText: '100',
      pageEndText: '120',
    };
    expect(buildMetadataDiff(document, form)).toEqual({
      volume: '12',
      issue: '3',
      pageStart: 100,
      pageEnd: 120,
    });
  });
});

describe('EditMetadataModal', () => {
  it('prefills every field from the document', async () => {
    const document = makeDocument({
      authors: ['Jane Doe', 'John Smith'],
      source_venue: 'A Journal',
      doi: '10.1000/abc',
    });
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <EditMetadataModal
          document={document}
          saving={false}
          error={null}
          onCancel={jest.fn()}
          onSave={jest.fn()}
        />
      );
    });
    expect(findFieldByLabel(renderer.root, 'Title').props.value).toBe('A Study of Something Real');
    expect(findFieldByLabel(renderer.root, 'Authors').props.value).toBe('Jane Doe, John Smith');
    expect(findFieldByLabel(renderer.root, 'Venue / journal').props.value).toBe('A Journal');
    expect(findFieldByLabel(renderer.root, 'DOI').props.value).toBe('10.1000/abc');
  });

  it('Save is disabled until something actually changes', async () => {
    const document = makeDocument();
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <EditMetadataModal
          document={document}
          saving={false}
          error={null}
          onCancel={jest.fn()}
          onSave={jest.fn()}
        />
      );
    });
    expect(findPressableByText(renderer.root, 'Save').props.disabled).toBe(true);

    act(() => {
      findFieldByLabel(renderer.root, 'DOI').props.onChangeText('10.1000/new');
    });
    expect(findPressableByText(renderer.root, 'Save').props.disabled).toBe(false);
  });

  it('Save is disabled when the title is blanked to empty', async () => {
    const document = makeDocument();
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <EditMetadataModal
          document={document}
          saving={false}
          error={null}
          onCancel={jest.fn()}
          onSave={jest.fn()}
        />
      );
    });
    act(() => {
      findFieldByLabel(renderer.root, 'Title').props.onChangeText('   ');
    });
    expect(findPressableByText(renderer.root, 'Save').props.disabled).toBe(true);
  });

  it('calls onSave with only the changed fields', async () => {
    const document = makeDocument();
    const onSave = jest.fn();
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <EditMetadataModal
          document={document}
          saving={false}
          error={null}
          onCancel={jest.fn()}
          onSave={onSave}
        />
      );
    });
    act(() => {
      findFieldByLabel(renderer.root, 'DOI').props.onChangeText('10.1000/new');
    });
    act(() => {
      findPressableByText(renderer.root, 'Save').props.onPress();
    });
    expect(onSave).toHaveBeenCalledWith({ doi: '10.1000/new' });
  });

  it('calls onCancel without saving anything, when Cancel is pressed', async () => {
    const document = makeDocument();
    const onCancel = jest.fn();
    const onSave = jest.fn();
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <EditMetadataModal
          document={document}
          saving={false}
          error={null}
          onCancel={onCancel}
          onSave={onSave}
        />
      );
    });
    act(() => {
      findFieldByLabel(renderer.root, 'DOI').props.onChangeText('10.1000/new');
    });
    act(() => {
      findPressableByText(renderer.root, 'Cancel').props.onPress();
    });
    expect(onCancel).toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('shows a server-side error via the error prop', async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <EditMetadataModal
          document={makeDocument()}
          saving={false}
          error="Something went wrong."
          onCancel={jest.fn()}
          onSave={jest.fn()}
        />
      );
    });
    const matches = renderer.root.findAll(
      (n) => String(n.type) === 'Text' && textOf(n) === 'Something went wrong.'
    );
    expect(matches.length).toBeGreaterThan(0);
  });
});

function findTextContaining(root: ReactTestInstance, substring: string): ReactTestInstance[] {
  return root.findAll((n) => String(n.type) === 'Text' && textOf(n).includes(substring));
}

describe('EditMetadataModal — Refresh metadata (Milestone 4.1)', () => {
  it('does not render the action at all when onRefreshMetadata is omitted', async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <EditMetadataModal
          document={makeDocument({ has_usable_doi: true })}
          saving={false}
          error={null}
          onCancel={jest.fn()}
          onSave={jest.fn()}
        />
      );
    });
    expect(
      renderer.root.findAll((n) => n.props.accessibilityLabel === 'Refresh metadata')
    ).toHaveLength(0);
  });

  it('disables Refresh metadata and explains why when the document has no usable DOI', async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <EditMetadataModal
          document={makeDocument({ has_usable_doi: false })}
          saving={false}
          error={null}
          onCancel={jest.fn()}
          onSave={jest.fn()}
          onRefreshMetadata={jest.fn()}
        />
      );
    });
    expect(findPressableByText(renderer.root, 'Refresh metadata').props.disabled).toBe(true);
    expect(findTextContaining(renderer.root, 'a DOI is required').length).toBeGreaterThan(0);
  });

  it('enables Refresh metadata when the document has a usable DOI', async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <EditMetadataModal
          document={makeDocument({ has_usable_doi: true, doi: '10.1000/abc' })}
          saving={false}
          error={null}
          onCancel={jest.fn()}
          onSave={jest.fn()}
          onRefreshMetadata={jest.fn()}
        />
      );
    });
    expect(findPressableByText(renderer.root, 'Refresh metadata').props.disabled).toBe(false);
  });

  it('shows a loading state while refreshingMetadata is true', async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <EditMetadataModal
          document={makeDocument({ has_usable_doi: true, doi: '10.1000/abc' })}
          saving={false}
          error={null}
          onCancel={jest.fn()}
          onSave={jest.fn()}
          onRefreshMetadata={jest.fn()}
          refreshingMetadata
        />
      );
    });
    // Button swaps its label Text for a spinner while loading, so this
    // finds it by accessibilityLabel (always set, regardless of loading
    // state) rather than by its usual visible text.
    const button = renderer.root.find(
      (n) => n.props.accessibilityLabel === 'Refresh metadata' && n.props.accessibilityRole
    );
    expect(button.props.disabled).toBe(true);
    expect(button.props.accessibilityState.busy).toBe(true);
  });

  it('applies only the fields the response reports as updated, preserving an unsaved edit', async () => {
    const document = makeDocument({
      has_usable_doi: true,
      doi: '10.1000/abc',
      title: 'Old Title',
      publisher: null,
    });
    const onRefreshMetadata = jest.fn().mockResolvedValue({
      ok: true,
      status: 'succeeded',
      fields_updated: ['title'],
      manual_fields_preserved: 0,
      qdrant_sync_failed: false,
      document: { ...document, title: 'Authoritative Title' },
    });
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <EditMetadataModal
          document={document}
          saving={false}
          error={null}
          onCancel={jest.fn()}
          onSave={jest.fn()}
          onRefreshMetadata={onRefreshMetadata}
        />
      );
    });
    // Mid-typing an unsaved edit to a field the mocked response does NOT
    // report as updated — this must survive the refresh untouched.
    act(() => {
      findFieldByLabel(renderer.root, 'Publisher').props.onChangeText('My Own Publisher Note');
    });

    await act(async () => {
      findPressableByText(renderer.root, 'Refresh metadata').props.onPress();
    });

    expect(findFieldByLabel(renderer.root, 'Title').props.value).toBe('Authoritative Title');
    expect(findFieldByLabel(renderer.root, 'Publisher').props.value).toBe('My Own Publisher Note');
    expect(findTextContaining(renderer.root, 'Updated 1 field from Crossref').length).toBe(1);
  });

  it('shows a non-alarming message and leaves fields untouched on provider failure', async () => {
    const document = makeDocument({
      has_usable_doi: true,
      doi: '10.1000/abc',
      title: 'Existing Title',
    });
    const onRefreshMetadata = jest.fn().mockResolvedValue({
      ok: false,
      status: 'not_found',
      fields_updated: [],
      manual_fields_preserved: 0,
      qdrant_sync_failed: false,
      document,
    });
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <EditMetadataModal
          document={document}
          saving={false}
          error={null}
          onCancel={jest.fn()}
          onSave={jest.fn()}
          onRefreshMetadata={onRefreshMetadata}
        />
      );
    });

    await act(async () => {
      findPressableByText(renderer.root, 'Refresh metadata').props.onPress();
    });

    expect(findFieldByLabel(renderer.root, 'Title').props.value).toBe('Existing Title');
    expect(
      findTextContaining(renderer.root, 'No scholarly metadata was found for this DOI').length
    ).toBe(1);
  });
});
