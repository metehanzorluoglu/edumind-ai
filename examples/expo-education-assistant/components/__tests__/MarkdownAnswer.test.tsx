import type { Citation } from 'education-assistant-client';
import { act, create } from 'react-test-renderer';
import { MarkdownAnswer } from '../MarkdownAnswer';

/** react-test-renderer's toJSON() shape: RN host nodes reduced to plain type/props/children. */
interface JsonNode {
  type: string;
  props: Record<string, unknown>;
  children: (JsonNode | string)[] | null;
}

function flattenStyle(style: unknown): Record<string, unknown> {
  if (!style) return {};
  if (Array.isArray(style)) return Object.assign({}, ...style.map(flattenStyle));
  return style as Record<string, unknown>;
}

function flattenText(node: JsonNode | string | null): string {
  if (node === null) return '';
  if (typeof node === 'string') return node;
  return (node.children ?? []).map(flattenText).join('');
}

/** Depth-first collection of every host node in the tree, self included. */
function collectNodes(node: JsonNode | string | null, out: JsonNode[] = []): JsonNode[] {
  if (node === null || typeof node === 'string') return out;
  out.push(node);
  (node.children ?? []).forEach((child) => collectNodes(child, out));
  return out;
}

/** Finds Text nodes whose flattened subtree text includes `substring`, optionally also matching a style predicate. */
function findTextNodes(
  root: JsonNode,
  substring: string,
  styleMatch?: (style: Record<string, unknown>) => boolean
): JsonNode[] {
  return collectNodes(root).filter((node) => {
    if (node.type !== 'Text') return false;
    if (!flattenText(node).includes(substring)) return false;
    if (!styleMatch) return true;
    return styleMatch(flattenStyle(node.props.style));
  });
}

function renderMarkdown(answer: string, citations: readonly Citation[] = []) {
  const onCitationPress = jest.fn();
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(
      <MarkdownAnswer answer={answer} citations={citations} onCitationPress={onCitationPress} />
    );
  });
  const json = renderer.toJSON();
  if (!json || Array.isArray(json)) throw new Error('expected a single root node');
  return { root: json as JsonNode, onCitationPress };
}

describe('MarkdownAnswer', () => {
  it('renders **bold** text with a bold style, not literal asterisks', () => {
    const { root } = renderMarkdown('**Intrinsic Motivation** is key.');
    expect(findTextNodes(root, '**')).toHaveLength(0);
    const bold = findTextNodes(root, 'Intrinsic Motivation', (s) => s.fontWeight === '700');
    expect(bold.length).toBeGreaterThan(0);
  });

  it('renders *italic* text with an italic style, not literal asterisks', () => {
    const { root } = renderMarkdown('*Extrinsic motivation* can also influence teaching.');
    expect(findTextNodes(root, '*Extrinsic')).toHaveLength(0);
    const italic = findTextNodes(root, 'Extrinsic motivation', (s) => s.fontStyle === 'italic');
    expect(italic.length).toBeGreaterThan(0);
  });

  it('renders ***bold italic*** text with both styles applied', () => {
    const { root } = renderMarkdown('***Both*** styles.');
    const boldItalic = findTextNodes(
      root,
      'Both',
      (s) => s.fontWeight === '700' && s.fontStyle === 'italic'
    );
    expect(boldItalic.length).toBeGreaterThan(0);
  });

  it.each([
    ['# ', 24],
    ['## ', 20],
    ['### ', 17],
  ])('renders "%s" as a heading with the matching font size', (prefix, fontSize) => {
    const { root } = renderMarkdown(`${prefix}Teacher Motivation`);
    expect(findTextNodes(root, prefix.trim())).toHaveLength(0);
    const heading = findTextNodes(root, 'Teacher Motivation', (s) => s.fontSize === fontSize);
    expect(heading.length).toBeGreaterThan(0);
  });

  it('renders an ordered (numbered) list item', () => {
    const { root } = renderMarkdown('1. intrinsic motivation\n2. extrinsic motivation');
    expect(flattenText(root)).toContain('intrinsic motivation');
    expect(flattenText(root)).toContain('extrinsic motivation');
  });

  it('renders an unordered (bullet) list item', () => {
    const { root } = renderMarkdown('- intrinsic motivation\n- self-efficacy');
    const text = flattenText(root);
    expect(text).toContain('intrinsic motivation');
    expect(text).toContain('self-efficacy');
  });

  it('renders a nested list correctly (parent and child items both present)', () => {
    const { root } = renderMarkdown('- motivation\n  - intrinsic\n  - extrinsic');
    const text = flattenText(root);
    expect(text).toContain('motivation');
    expect(text).toContain('intrinsic');
    expect(text).toContain('extrinsic');
  });

  it('renders a fenced code block in a monospace font with a distinct background, not literal backticks', () => {
    const { root } = renderMarkdown('```python\nprint("Hello")\n```');
    expect(flattenText(root)).not.toContain('```');
    const code = findTextNodes(
      root,
      'print("Hello")',
      (s) => typeof s.fontFamily === 'string' && /mono|Menlo/i.test(s.fontFamily as string)
    );
    expect(code.length).toBeGreaterThan(0);
    // ScrollView's host type name (e.g. "RCTScrollView") is a react-native
    // internal implementation detail — match loosely so this doesn't break
    // if the test renderer's mock naming changes.
    const scrollView = collectNodes(root).find(
      (n) => /scrollview/i.test(n.type) && flattenText(n).includes('print("Hello")')
    );
    expect(scrollView?.props.horizontal).toBe(true);
  });

  it('renders inline `code` with a monospace font, not literal backticks', () => {
    const { root } = renderMarkdown('Use `Self-Determination Theory` here.');
    expect(flattenText(root)).not.toContain('`');
    const codespan = findTextNodes(
      root,
      'Self-Determination Theory',
      (s) => typeof s.fontFamily === 'string' && /mono|Menlo/i.test(s.fontFamily as string)
    );
    expect(codespan.length).toBeGreaterThan(0);
  });

  it('renders a blockquote inside a distinctly styled container', () => {
    const { root } = renderMarkdown('> A quoted sentence.');
    expect(flattenText(root)).toContain('A quoted sentence.');
    const quoteContainer = collectNodes(root).find(
      (n) =>
        n.type === 'View' &&
        flattenStyle(n.props.style).borderLeftWidth &&
        flattenText(n).includes('A quoted sentence.')
    );
    expect(quoteContainer).toBeDefined();
  });

  it('renders a real markdown link as a pressable, accessible link', () => {
    const { root } = renderMarkdown('See [the docs](https://example.com/docs) for more.');
    const link = collectNodes(root).find(
      (n) => n.props.accessibilityRole === 'link' && flattenText(n).includes('the docs')
    );
    expect(link).toBeDefined();
    expect(typeof link?.props.onPress).toBe('function');
  });

  it('renders a horizontal rule as a distinct divider element', () => {
    const { root } = renderMarkdown('Above.\n\n---\n\nBelow.');
    expect(flattenText(root)).not.toContain('---');
    const divider = collectNodes(root).find(
      (n) => n.type === 'View' && flattenStyle(n.props.style).borderBottomWidth
    );
    expect(divider).toBeDefined();
  });

  it('preserves a single backend-produced line break as a hard break, not a collapsed space', () => {
    const { root } = renderMarkdown('First line.\nSecond line.');
    const text = flattenText(root);
    expect(text).toContain('First line.\nSecond line.');
  });

  it('leaves a resolvable [S<n>] citation marker as tappable text that calls onCitationPress, not a URL-opening link', () => {
    const citations: Citation[] = [
      {
        source_id: 'S1',
        document_id: 'doc-1',
        chunk_id: 'chunk-1',
        title: 'A Paper',
        authors: [],
        publication_year: null,
        source_venue: null,
        doi: null,
        source_url: null,
        document_type: 'journal_article',
        journal_quartile: null,
        page_start: null,
        page_end: null,
        score: 0.9,
      },
    ];
    const { root, onCitationPress } = renderMarkdown('Motivation matters [S1].', citations);
    const marker = findTextNodes(root, 'S1').find((n) => typeof n.props.onPress === 'function');
    expect(marker).toBeDefined();
    act(() => {
      (marker?.props.onPress as () => void)();
    });
    expect(onCitationPress).toHaveBeenCalledWith('S1');
  });

  it('leaves an unresolvable [S<n>] citation marker as plain, non-pressable text', () => {
    const { root } = renderMarkdown('Motivation matters [S9].', []);
    const markerNodes = findTextNodes(root, 'S9 — unavailable');
    expect(markerNodes.length).toBeGreaterThan(0);
    expect(markerNodes.every((n) => typeof n.props.onPress !== 'function')).toBe(true);
  });

  it('renders the full milestone example (headings, list, bold, italic, inline code, fenced code) without throwing', () => {
    const answer = [
      '# Teacher Motivation',
      '',
      '## Overview',
      '',
      'Teacher motivation consists of:',
      '',
      '- intrinsic motivation',
      '- extrinsic motivation',
      '- self-efficacy',
      '',
      '### Important',
      '',
      '**Intrinsic Motivation** is the strongest predictor.',
      '',
      '*Extrinsic motivation* can also influence teaching.',
      '',
      '`Self-Determination Theory`',
      '',
      '```python',
      'print("Hello")',
      '```',
    ].join('\n');

    const { root } = renderMarkdown(answer);
    const text = flattenText(root);
    expect(text).toContain('Teacher Motivation');
    expect(text).toContain('Overview');
    expect(text).toContain('intrinsic motivation');
    expect(text).toContain('extrinsic motivation');
    expect(text).toContain('self-efficacy');
    expect(text).toContain('Important');
    expect(text).toContain('Intrinsic Motivation');
    expect(text).toContain('Extrinsic motivation');
    expect(text).toContain('Self-Determination Theory');
    expect(text).toContain('print("Hello")');
    expect(text).not.toContain('**');
    expect(text).not.toContain('##');
    expect(text).not.toContain('```');
  });
});
