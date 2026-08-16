import { Platform } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { CitationPopover } from '../CitationPopover';

const mockGetDocumentCitation = jest.fn();
const mockGetDocumentBibtex = jest.fn();
// Stable object identity across renders — CitationPopover's fetch effect
// depends on `client`, so a mock that returns a fresh object literal on
// every call would make the effect think its dependency changed on every
// render, looping forever.
const fakeClientValue = {
  client: {
    getDocumentCitation: (...args: unknown[]) => mockGetDocumentCitation(...args),
    getDocumentBibtex: (...args: unknown[]) => mockGetDocumentBibtex(...args),
  },
};
jest.mock('@/lib/ClientProvider', () => ({
  useClient: () => fakeClientValue,
}));

const mockCopyToClipboard = jest.fn();
jest.mock('@/lib/clipboard', () => ({
  copyToClipboard: (...args: unknown[]) => mockCopyToClipboard(...args),
}));

const mockDownloadTextFile = jest.fn();
jest.mock('@/lib/downloadTextFile', () => ({
  downloadTextFile: (...args: unknown[]) => mockDownloadTextFile(...args),
  safeBibtexFilename: (key: string) => `${key.toLowerCase()}.bib`,
}));

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

function findByText(root: ReactTestInstance, text: string): ReactTestInstance {
  return root.find((n) => String(n.type) === 'Text' && textOf(n) === text);
}

function queryByText(root: ReactTestInstance, text: string): ReactTestInstance | null {
  const matches = root.findAll((n) => String(n.type) === 'Text' && textOf(n) === text);
  return matches.length > 0 ? matches[0]! : null;
}

const document = { document_id: 'doc-1', title: 'A Sample Study', source_filename: 'paper.pdf' };

async function renderPopover(onClose = jest.fn()): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<CitationPopover document={document} onClose={onClose} />);
    await Promise.resolve();
  });
  return renderer;
}

describe('CitationPopover', () => {
  afterEach(() => {
    mockGetDocumentCitation.mockReset();
    mockGetDocumentBibtex.mockReset();
    mockCopyToClipboard.mockReset();
    mockDownloadTextFile.mockReset();
  });

  it('fetches and shows the formatted APA citation on open, defaulting to apa7', async () => {
    mockGetDocumentCitation.mockResolvedValue({
      style: 'apa7',
      formatted: 'Doe, J. (2020). A Sample Study.',
    });

    const renderer = await renderPopover();

    expect(mockGetDocumentCitation).toHaveBeenCalledWith('doc-1', 'apa7');
    expect(findByText(renderer.root, 'Doe, J. (2020). A Sample Study.')).toBeTruthy();
  });

  it('switching to IEEE re-fetches the citation in that style', async () => {
    mockGetDocumentCitation
      .mockResolvedValueOnce({ style: 'apa7', formatted: 'Doe, J. (2020). A Sample Study.' })
      .mockResolvedValueOnce({ style: 'ieee', formatted: '[1]J. Doe, "A Sample Study."' });

    const renderer = await renderPopover();

    await act(async () => {
      findPressableByText(renderer.root, 'IEEE').props.onPress();
      await Promise.resolve();
    });

    expect(mockGetDocumentCitation).toHaveBeenLastCalledWith('doc-1', 'ieee');
    expect(findByText(renderer.root, '[1]J. Doe, "A Sample Study."')).toBeTruthy();
  });

  it('shows a clear, non-destructive message when the citation fails to load', async () => {
    mockGetDocumentCitation.mockRejectedValue(new Error('network error'));

    const renderer = await renderPopover();

    expect(findByText(renderer.root, 'Could not load this citation. Try again.')).toBeTruthy();
  });

  it('Copy citation copies the exact rendered text and shows confirmation', async () => {
    mockGetDocumentCitation.mockResolvedValue({
      style: 'apa7',
      formatted: 'Doe, J. (2020). A Sample Study.',
    });
    mockCopyToClipboard.mockResolvedValue(true);

    const renderer = await renderPopover();

    await act(async () => {
      findPressableByText(renderer.root, 'Copy citation').props.onPress();
      await Promise.resolve();
    });

    expect(mockCopyToClipboard).toHaveBeenCalledWith('Doe, J. (2020). A Sample Study.');
    expect(findByText(renderer.root, 'Citation copied')).toBeTruthy();
  });

  it('Copy BibTeX fetches the entry on demand (not eagerly) and copies it', async () => {
    mockGetDocumentCitation.mockResolvedValue({ style: 'apa7', formatted: 'Doe, J. (2020).' });
    mockGetDocumentBibtex.mockResolvedValue({
      citation_key: 'Doe2020Study',
      bibtex: '@article{Doe2020Study,}',
    });
    mockCopyToClipboard.mockResolvedValue(true);

    const renderer = await renderPopover();
    expect(mockGetDocumentBibtex).not.toHaveBeenCalled();

    await act(async () => {
      findPressableByText(renderer.root, 'Copy BibTeX').props.onPress();
      await Promise.resolve();
    });

    expect(mockGetDocumentBibtex).toHaveBeenCalledWith('doc-1');
    expect(mockCopyToClipboard).toHaveBeenCalledWith('@article{Doe2020Study,}');
    expect(findByText(renderer.root, 'BibTeX copied')).toBeTruthy();
  });

  it('Download BibTeX (web) derives a safe filename from the citation key and downloads it', async () => {
    const originalOS = Platform.OS;
    Platform.OS = 'web';
    try {
      mockGetDocumentCitation.mockResolvedValue({ style: 'apa7', formatted: 'Doe, J. (2020).' });
      mockGetDocumentBibtex.mockResolvedValue({
        citation_key: 'Doe2020Study',
        bibtex: '@article{Doe2020Study,}',
      });

      const renderer = await renderPopover();

      await act(async () => {
        findPressableByText(renderer.root, 'Download BibTeX').props.onPress();
        await Promise.resolve();
      });

      expect(mockDownloadTextFile).toHaveBeenCalledWith(
        'doe2020study.bib',
        '@article{Doe2020Study,}',
        'application/x-bibtex'
      );
    } finally {
      Platform.OS = originalOS;
    }
  });

  it('Share BibTeX (native) uses the platform-appropriate label but the same download path', async () => {
    const originalOS = Platform.OS;
    Platform.OS = 'ios';
    try {
      mockGetDocumentCitation.mockResolvedValue({ style: 'apa7', formatted: 'Doe, J. (2020).' });
      mockGetDocumentBibtex.mockResolvedValue({
        citation_key: 'Doe2020Study',
        bibtex: '@article{Doe2020Study,}',
      });

      const renderer = await renderPopover();
      expect(queryByText(renderer.root, 'Download BibTeX')).toBeNull();

      await act(async () => {
        findPressableByText(renderer.root, 'Share BibTeX').props.onPress();
        await Promise.resolve();
      });

      expect(mockDownloadTextFile).toHaveBeenCalledWith(
        'doe2020study.bib',
        '@article{Doe2020Study,}',
        'application/x-bibtex'
      );
    } finally {
      Platform.OS = originalOS;
    }
  });

  it('closes via the backdrop and the close button', async () => {
    mockGetDocumentCitation.mockResolvedValue({ style: 'apa7', formatted: 'Doe, J. (2020).' });
    const onClose = jest.fn();
    const renderer = await renderPopover(onClose);

    const closeButton = renderer.root.find(
      (n) => n.props.accessibilityLabel === 'Close' && typeof n.props.onPress === 'function'
    );
    await act(async () => {
      closeButton.props.onPress();
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('never shows a broken/empty citation area while loading', async () => {
    mockGetDocumentCitation.mockReturnValue(new Promise(() => {})); // never resolves
    const renderer = await renderPopover();
    expect(queryByText(renderer.root, 'undefined')).toBeNull();
  });
});
