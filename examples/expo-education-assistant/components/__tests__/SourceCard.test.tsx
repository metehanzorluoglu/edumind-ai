import type { Citation, MappedSource, RetrievedChunk } from 'education-assistant-client';
import { Clipboard, Linking, Platform } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { AttachmentSourceCard, SourceCard } from '../SourceCard';

// Milestone 4.2 (Citation & BibTeX Foundation) — SourceCard now reads
// useClient() for its "Copy citation" action (Section 27). Same
// jest.mock pattern AddToProjectPicker.test.tsx already uses for any
// component that needs a client but isn't testing network behavior
// itself.
const mockGetDocumentCitation = jest.fn().mockResolvedValue({
  style: 'apa7',
  formatted: 'Lovelace, A. (2021). A Study. Journal of Education Research.',
});
jest.mock('@/lib/ClientProvider', () => ({
  useClient: () => ({ client: { getDocumentCitation: mockGetDocumentCitation } }),
}));

const SHORT_TEXT = 'Guided reading improves outcomes for early readers.';
// Comfortably past the component's own truncation-estimate threshold, so
// tests don't sit on the boundary of an internal implementation constant.
const LONG_TEXT = 'Guided reading improves outcomes for early readers. '.repeat(10).trim();

function buildChunk(overrides: Partial<RetrievedChunk> = {}): RetrievedChunk {
  return {
    score: 0.9,
    text: SHORT_TEXT,
    document_id: 'doc-1',
    chunk_id: 'chunk-1',
    document_type: 'journal_article',
    journal_quartile: 'Q1',
    title: 'A Study',
    authors: ['Ada Lovelace'],
    publication_year: 2021,
    source_venue: 'Journal of Education Research',
    doi: null,
    source_url: null,
    source_filename: 'sample.pdf',
    chunk_index: 0,
    page_number: 17,
    scope: 'general',
    ...overrides,
  };
}

function buildCitation(overrides: Partial<Citation> = {}): Citation {
  return {
    source_id: 'S1',
    document_id: 'doc-1',
    chunk_id: 'chunk-1',
    title: 'A Study',
    authors: ['Ada Lovelace'],
    publication_year: 2021,
    source_venue: 'Journal of Education Research',
    document_type: 'journal_article',
    journal_quartile: 'Q1',
    page_start: 17,
    page_end: 17,
    doi: null,
    source_url: null,
    score: 0.9,
    ...overrides,
  };
}

function buildSource(
  overrides: {
    chunk?: Partial<RetrievedChunk>;
    citation?: Partial<Citation>;
    sourceId?: string;
  } = {}
): MappedSource {
  return {
    sourceId: overrides.sourceId ?? 'S1',
    chunk: buildChunk(overrides.chunk),
    citation: buildCitation(overrides.citation),
  };
}

function queryByText(root: ReactTestInstance, text: string): ReactTestInstance | null {
  const matches = root.findAll(
    (node) =>
      String(node.type) === 'Text' &&
      node.children.filter((c): c is string => typeof c === 'string').join('') === text
  );
  return matches[0] ?? null;
}

function findByText(root: ReactTestInstance, text: string): ReactTestInstance {
  const found = queryByText(root, text);
  if (!found) throw new Error(`No Text node found with content "${text}"`);
  return found;
}

function findPressableByText(root: ReactTestInstance, text: string): ReactTestInstance {
  return root.find(
    (node) => typeof node.props?.onPress === 'function' && queryByText(node, text) !== null
  );
}

function findExcerptNode(root: ReactTestInstance): ReactTestInstance {
  return root.find((node) => String(node.type) === 'Text' && node.props.selectable === true);
}

async function renderSourceCard(source: MappedSource): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<SourceCard source={source} />);
  });
  return renderer;
}

describe('SourceCard', () => {
  const originalOS = Platform.OS;
  let activeRenderer: ReactTestRenderer | null = null;

  afterEach(async () => {
    if (activeRenderer) {
      await act(async () => {
        activeRenderer!.unmount();
      });
      activeRenderer = null;
    }
    Platform.OS = originalOS;
    jest.clearAllMocks();
  });

  it('shows a collapsed preview (numberOfLines set) with a "Show more" toggle when the excerpt is long', async () => {
    const renderer = (activeRenderer = await renderSourceCard(
      buildSource({ chunk: { text: LONG_TEXT } })
    ));

    const excerpt = findExcerptNode(renderer.root);
    expect(excerpt.props.numberOfLines).toBe(4);
    expect(findByText(renderer.root, 'Show more')).toBeTruthy();
    expect(queryByText(renderer.root, 'Show less')).toBeNull();
  });

  it('does not show a "Show more" toggle when the excerpt already fits — never truncates something that isn\'t actually truncated', async () => {
    const renderer = (activeRenderer = await renderSourceCard(
      buildSource({ chunk: { text: SHORT_TEXT } })
    ));

    const excerpt = findExcerptNode(renderer.root);
    expect(excerpt.props.numberOfLines).toBeUndefined();
    expect(queryByText(renderer.root, 'Show more')).toBeNull();
    expect(queryByText(renderer.root, 'Show less')).toBeNull();
    expect(findByText(renderer.root, SHORT_TEXT)).toBeTruthy();
  });

  it('expands to the complete stored excerpt on "Show more", with no numberOfLines cap and no appended "…"', async () => {
    const renderer = (activeRenderer = await renderSourceCard(
      buildSource({ chunk: { text: LONG_TEXT } })
    ));

    await act(async () => {
      findPressableByText(renderer.root, 'Show more').props.onPress();
    });

    const excerpt = findExcerptNode(renderer.root);
    expect(excerpt.props.numberOfLines).toBeUndefined();
    const rendered = excerpt.children.filter((c): c is string => typeof c === 'string').join('');
    expect(rendered).toBe(LONG_TEXT);
    expect(rendered.endsWith('…')).toBe(false);
    expect(rendered.endsWith('...')).toBe(false);
    expect(findByText(renderer.root, 'Show less')).toBeTruthy();
  });

  it('collapses back on "Show less"', async () => {
    const renderer = (activeRenderer = await renderSourceCard(
      buildSource({ chunk: { text: LONG_TEXT } })
    ));

    await act(async () => {
      findPressableByText(renderer.root, 'Show more').props.onPress();
    });
    await act(async () => {
      findPressableByText(renderer.root, 'Show less').props.onPress();
    });

    const excerpt = findExcerptNode(renderer.root);
    expect(excerpt.props.numberOfLines).toBe(4);
    expect(findByText(renderer.root, 'Show more')).toBeTruthy();
  });

  it('expands and collapses each card independently', async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <>
          <SourceCard
            source={buildSource({
              sourceId: 'S1',
              chunk: { text: LONG_TEXT },
              citation: { source_id: 'S1' },
            })}
          />
          <SourceCard
            source={buildSource({
              sourceId: 'S2',
              chunk: { text: LONG_TEXT },
              citation: { source_id: 'S2' },
            })}
          />
        </>
      );
    });
    activeRenderer = renderer;

    const toggles = renderer.root.findAll(
      (node) => typeof node.props?.onPress === 'function' && queryByText(node, 'Show more') !== null
    );
    expect(toggles).toHaveLength(2);

    await act(async () => {
      toggles[0]!.props.onPress();
    });

    const showMoreRemaining = renderer.root.findAll(
      (node) => typeof node.props?.onPress === 'function' && queryByText(node, 'Show more') !== null
    );
    const showLess = renderer.root.findAll(
      (node) => typeof node.props?.onPress === 'function' && queryByText(node, 'Show less') !== null
    );
    // One card expanded (now shows "Show less"), the other untouched
    // (still shows "Show more") — expansion state isn't shared.
    expect(showMoreRemaining).toHaveLength(1);
    expect(showLess).toHaveLength(1);
  });

  it('formats a single page as "Page N"', async () => {
    const renderer = (activeRenderer = await renderSourceCard(
      buildSource({ citation: { page_start: 17, page_end: 17 } })
    ));

    expect(findByText(renderer.root, 'Page 17')).toBeTruthy();
  });

  it('formats a genuine page range as "Pages N–M"', async () => {
    const renderer = (activeRenderer = await renderSourceCard(
      buildSource({ citation: { page_start: 17, page_end: 18 } })
    ));

    expect(findByText(renderer.root, 'Pages 17–18')).toBeTruthy();
  });

  it('preserves [S<n>], title, authors, publication year, and source venue', async () => {
    const renderer = (activeRenderer = await renderSourceCard(
      buildSource({
        sourceId: 'S3',
        citation: {
          source_id: 'S3',
          title: 'Reading Fluency in Practice',
          authors: ['Grace Hopper', 'Ada Lovelace'],
          publication_year: 2019,
          source_venue: 'Journal of Applied Literacy',
        },
      })
    ));

    expect(findByText(renderer.root, '[S3]')).toBeTruthy();
    expect(findByText(renderer.root, 'Reading Fluency in Practice')).toBeTruthy();
    expect(findByText(renderer.root, 'Journal of Applied Literacy')).toBeTruthy();
    // Compact display shows only the first author's last name + "et al.",
    // not the full joined author list — see the dedicated compact-display
    // tests below for the reasoning.
    expect(queryByText(renderer.root, 'Hopper et al. · 2019')).toBeTruthy();
  });

  it('renders the IJAIED-style regression case with compact authors, decomposed venue, and DOI', async () => {
    const renderer = (activeRenderer = await renderSourceCard(
      buildSource({
        sourceId: 'S1',
        citation: {
          source_id: 'S1',
          title: 'Lessons Learned for AI Education with Elementary Students and Teachers',
          authors: [
            'Anne Ottenbreit-Leftwich',
            'Krista Glazewski',
            'Minji Jeon',
            'Katie Jantaraweragul',
            'Cindy E. Hmelo-Silver',
            'Adam Scribner',
            'Seung Lee',
            'Bradford Mott',
            'James Lester',
          ],
          publication_year: 2023,
          source_venue:
            'International Journal of Artificial Intelligence in Education (2023) 33:267-289',
          doi: '10.1007/s40593-022-00304-3',
          page_start: 1,
          page_end: 1,
        },
      })
    ));

    expect(findByText(renderer.root, '[S1]')).toBeTruthy();
    expect(
      findByText(
        renderer.root,
        'Lessons Learned for AI Education with Elementary Students and Teachers'
      )
    ).toBeTruthy();
    expect(queryByText(renderer.root, 'Ottenbreit-Leftwich et al. · 2023')).toBeTruthy();
    // Bare journal name, not the full "(2023) 33:267-289" citation string.
    expect(
      findByText(renderer.root, 'International Journal of Artificial Intelligence in Education')
    ).toBeTruthy();
    // The journal's published page range, not the chunk's own PDF page
    // (page_start/page_end are both 1 above, which must NOT be shown).
    expect(findByText(renderer.root, 'Pages 267–289')).toBeTruthy();
    expect(queryByText(renderer.root, 'Page 1')).toBeNull();
    expect(findByText(renderer.root, 'DOI: 10.1007/s40593-022-00304-3')).toBeTruthy();
  });

  it('shows an honest "unavailable" message rather than "Unknown author(s)" when no authors were extracted', async () => {
    const renderer = (activeRenderer = await renderSourceCard(
      buildSource({ citation: { authors: [], publication_year: null } })
    ));

    expect(queryByText(renderer.root, 'Unknown author(s)')).toBeNull();
    expect(findByText(renderer.root, 'Author information unavailable')).toBeTruthy();
  });

  it('shows "Open source" and opens the URL via Linking on mobile when an https source_url exists', async () => {
    Platform.OS = 'ios';
    const renderer = (activeRenderer = await renderSourceCard(
      buildSource({ citation: { source_url: 'https://example.com/paper' } })
    ));

    await act(async () => {
      findPressableByText(renderer.root, 'Open source').props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(Linking.openURL).toHaveBeenCalledWith('https://example.com/paper');
  });

  it('never offers a javascript: source_url as a clickable link, even as the "unencrypted" fallback', async () => {
    const renderer = (activeRenderer = await renderSourceCard(
      buildSource({
        citation: { source_url: 'javascript:alert(document.cookie)', doi: null },
      })
    ));

    expect(queryByText(renderer.root, 'Open source')).toBeNull();
    expect(queryByText(renderer.root, 'Open source (unencrypted link)')).toBeNull();
    expect(findByText(renderer.root, 'No link available')).toBeTruthy();
  });

  it('shows "No link available" when neither source_url nor a valid DOI exists', async () => {
    const renderer = (activeRenderer = await renderSourceCard(
      buildSource({ citation: { source_url: null, doi: null } })
    ));

    expect(findByText(renderer.root, 'No link available')).toBeTruthy();
    expect(queryByText(renderer.root, 'Open source')).toBeNull();
  });

  it('is keyboard-accessible: the "Show more" toggle is a real button, and its onPress (what Enter/Space ultimately invoke on web) toggles state', async () => {
    // react-test-renderer never dispatches real DOM keydown events, so this
    // verifies the two things that make Enter/Space work on web via
    // react-native-web's Pressable: accessibilityRole="button" (which
    // react-native-web maps to role="button", enabling Space activation
    // alongside Enter) and that the shared onPress handler — the same one
    // triggered by a keyboard activation — does the right thing.
    const renderer = (activeRenderer = await renderSourceCard(
      buildSource({ chunk: { text: LONG_TEXT } })
    ));

    const toggle = findPressableByText(renderer.root, 'Show more');
    expect(toggle.props.accessibilityRole).toBe('button');

    await act(async () => {
      toggle.props.onPress();
    });

    expect(findByText(renderer.root, 'Show less')).toBeTruthy();
  });

  it('copies the excerpt to the clipboard on native and shows brief confirmation', async () => {
    Platform.OS = 'ios';
    const renderer = (activeRenderer = await renderSourceCard(
      buildSource({ chunk: { text: SHORT_TEXT } })
    ));

    await act(async () => {
      findPressableByText(renderer.root, 'Copy excerpt').props.onPress();
      await Promise.resolve();
    });

    expect(Clipboard.setString).toHaveBeenCalledWith(SHORT_TEXT);
    expect(findByText(renderer.root, 'Copied!')).toBeTruthy();
  });

  describe('Reference citation (Milestone 4.2 §27)', () => {
    it('shows a "Copy citation" action distinct from "Copy excerpt" when the citation maps to a document', async () => {
      const renderer = (activeRenderer = await renderSourceCard(
        buildSource({ citation: { document_id: 'doc-1' } })
      ));

      expect(findByText(renderer.root, 'Copy excerpt')).toBeTruthy();
      expect(findByText(renderer.root, 'Copy citation')).toBeTruthy();
    });

    it('fetches the current formatted citation and copies it, never the excerpt text', async () => {
      mockGetDocumentCitation.mockClear();
      const renderer = (activeRenderer = await renderSourceCard(
        buildSource({ citation: { document_id: 'doc-1' }, chunk: { text: SHORT_TEXT } })
      ));

      await act(async () => {
        findPressableByText(renderer.root, 'Copy citation').props.onPress();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(mockGetDocumentCitation).toHaveBeenCalledWith('doc-1', 'apa7');
      expect(findByText(renderer.root, 'Copied!')).toBeTruthy();
    });

    it('is not offered for a citation with no document_id (Section 27: provenance UI stays intact)', async () => {
      const renderer = (activeRenderer = await renderSourceCard(
        buildSource({ citation: { document_id: null } })
      ));

      expect(queryByText(renderer.root, 'Copy citation')).toBeNull();
      // The excerpt/provenance action is entirely unaffected.
      expect(findByText(renderer.root, 'Copy excerpt')).toBeTruthy();
    });
  });

  describe('Project scope badge (Frontend Milestone 2.1 §19)', () => {
    it('shows a "Project" badge for a source retrieved from the project tier', async () => {
      const renderer = (activeRenderer = await renderSourceCard(
        buildSource({ chunk: { scope: 'project' } })
      ));
      expect(findByText(renderer.root, 'Project')).toBeTruthy();
    });

    it('shows no badge for a source retrieved from the chat (selected-sources) tier', async () => {
      const renderer = (activeRenderer = await renderSourceCard(
        buildSource({ chunk: { scope: 'chat' } })
      ));
      expect(queryByText(renderer.root, 'Project')).toBeNull();
    });

    it('shows no badge for a source retrieved from the general library tier', async () => {
      const renderer = (activeRenderer = await renderSourceCard(
        buildSource({ chunk: { scope: 'general' } })
      ));
      expect(queryByText(renderer.root, 'Project')).toBeNull();
    });
  });
});

// Frontend/Platform Milestone 3.2.2 Part C — the display half of making a
// message attachment a real, citeable source.
function buildAttachmentCitation(overrides: Partial<Citation> = {}): Citation {
  return {
    source_id: 'S1',
    source_kind: 'attachment',
    document_id: null,
    chunk_id: null,
    attachment_id: 'att-1',
    display_name: 'notes.pdf',
    title: null,
    authors: [],
    publication_year: null,
    source_venue: null,
    document_type: null,
    journal_quartile: null,
    page_start: null,
    page_end: null,
    doi: null,
    source_url: null,
    score: null,
    ...overrides,
  };
}

describe('AttachmentSourceCard', () => {
  it('shows the source label and the attachment filename, never a fabricated excerpt or metadata', async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<AttachmentSourceCard citation={buildAttachmentCitation()} />);
    });
    expect(findByText(renderer.root, '[S1]')).toBeTruthy();
    expect(findByText(renderer.root, 'notes.pdf')).toBeTruthy();
  });

  it('falls back to an honest placeholder rather than blank when display_name is missing', async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <AttachmentSourceCard citation={buildAttachmentCitation({ display_name: null })} />
      );
    });
    expect(findByText(renderer.root, 'Attached file')).toBeTruthy();
  });

  it('is not pressable when no onPress is given (nothing to open)', async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<AttachmentSourceCard citation={buildAttachmentCitation()} />);
    });
    const pressable = renderer.root.findAll((node) => typeof node.props.onPress === 'function');
    expect(pressable).toHaveLength(0);
  });

  it('calls onPress when tapped, when one is given', async () => {
    const onPress = jest.fn();
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <AttachmentSourceCard citation={buildAttachmentCitation()} onPress={onPress} />
      );
    });
    const pressable = renderer.root.find((node) => typeof node.props.onPress === 'function');
    act(() => {
      pressable.props.onPress();
    });
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});
