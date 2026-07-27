import type { Citation } from 'education-assistant-client';
import { splitAnswerIntoSegments } from 'education-assistant-client';
import type { ReactNode } from 'react';
import { useMemo } from 'react';
import type { TextStyle, ViewStyle } from 'react-native';
import { Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { MarkedStyles } from 'react-native-marked';
import { Renderer, useMarkdown } from 'react-native-marked';

const CITATION_LINK_SCHEME = 'citation:';
const FENCED_CODE_BLOCK_PATTERN = /```[\s\S]*?```/g;

/**
 * Rewrites resolvable [S<n>] citation markers (see splitAnswerIntoSegments)
 * into real markdown links pointing at a `citation:` pseudo-scheme, so
 * `marked` parses them as ordinary link tokens and CitationAwareRenderer
 * below can intercept the press to scroll to the matching source card
 * instead of trying to open a URL. Markers with no matching citation are
 * left as plain literal text — no parens follow the brackets, so `marked`
 * has no reason to parse them as a link — matching the requirement that
 * bare "[S1]"-style markers stay plain text unless they're real links.
 */
function withCitationLinks(answer: string, citations: readonly Citation[]): string {
  return splitAnswerIntoSegments(answer, citations)
    .map((segment) => {
      if (segment.type === 'text') return segment.content;
      const { match } = segment;
      return match.citation
        ? `${match.raw}(${CITATION_LINK_SCHEME}${match.sourceId})`
        : `[${match.sourceId} — unavailable]`;
    })
    .join('');
}

/**
 * Standard CommonMark collapses a single newline inside a paragraph into a
 * space, which would silently reflow whatever line breaks the backend
 * actually produced. Appending two trailing spaces before each newline
 * turns every one of them into an explicit hard break instead, so the
 * rendered output preserves line breaks exactly as written. Skips fenced
 * code blocks entirely — their content (including whitespace) must render
 * byte-exact, never rewritten.
 */
function preserveLineBreaks(markdown: string): string {
  const codeBlocks = markdown.match(FENCED_CODE_BLOCK_PATTERN) ?? [];
  const parts = markdown.split(FENCED_CODE_BLOCK_PATTERN);
  return parts.map((part, i) => part.replace(/\n/g, '  \n') + (codeBlocks[i] ?? '')).join('');
}

class CitationAwareRenderer extends Renderer {
  constructor(private readonly onCitationPress: (sourceId: string) => void) {
    super();
  }

  override link(
    children: string | ReactNode[],
    href: string,
    styles?: TextStyle,
    title?: string
  ): ReactNode {
    if (href.startsWith(CITATION_LINK_SCHEME)) {
      const sourceId = href.slice(CITATION_LINK_SCHEME.length);
      return (
        <Text key={this.getKey()} style={styles} onPress={() => this.onCitationPress(sourceId)}>
          {children}
        </Text>
      );
    }
    return super.link(children, href, styles, title);
  }

  // Overridden (rather than relying on the `styles.code` theme key) because
  // upstream react-native-marked passes the *emphasis* style as a fenced
  // code block's text style — reusing it here would make code font styling
  // fight with italic text styling. This keeps them independent and gives
  // fenced blocks their own monospace font, background, and horizontal
  // scroll for long lines.
  override code(text: string, _language?: string, containerStyle?: ViewStyle): ReactNode {
    return (
      <ScrollView
        key={this.getKey()}
        horizontal
        style={codeBlockStyles.scroll}
        contentContainerStyle={[codeBlockStyles.content, containerStyle]}
      >
        <Text style={codeBlockStyles.text} selectable>
          {text}
        </Text>
      </ScrollView>
    );
  }
}

export interface MarkdownAnswerProps {
  answer: string;
  citations: readonly Citation[];
  onCitationPress: (sourceId: string) => void;
}

/** Renders assistant answer text as Markdown (headings, emphasis, lists, code, blockquotes, tables, links) while keeping [S<n>] citation markers tappable, exactly as the plain-text renderer it replaces did. Never used for user messages — those stay plain blue bubbles. */
export function MarkdownAnswer({ answer, citations, onCitationPress }: MarkdownAnswerProps) {
  const renderer = useMemo(() => new CitationAwareRenderer(onCitationPress), [onCitationPress]);
  const value = useMemo(
    () => preserveLineBreaks(withCitationLinks(answer, citations)),
    [answer, citations]
  );
  const blocks = useMarkdown(value, { renderer, styles: markdownStyles });

  return <View>{blocks}</View>;
}

const codeBlockStyles = StyleSheet.create({
  scroll: {
    backgroundColor: '#0F172A',
    borderRadius: 8,
    marginVertical: 8,
  },
  content: {
    padding: 12,
  },
  text: {
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
    fontSize: 13,
    lineHeight: 18,
    color: '#E2E8F0',
  },
});

const monospaceFont = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });

const markdownStyles: MarkedStyles = {
  text: { fontSize: 16, lineHeight: 24, color: '#0F172A' },
  paragraph: { marginBottom: 8 },
  strong: { fontWeight: '700' },
  em: { fontStyle: 'italic' },
  strikethrough: { textDecorationLine: 'line-through' },
  link: { color: '#208AEF', fontWeight: '600' },
  h1: { fontSize: 24, fontWeight: '700', color: '#0F172A', marginTop: 12, marginBottom: 8 },
  h2: { fontSize: 20, fontWeight: '700', color: '#0F172A', marginTop: 10, marginBottom: 6 },
  h3: { fontSize: 17, fontWeight: '700', color: '#0F172A', marginTop: 8, marginBottom: 4 },
  h4: { fontSize: 16, fontWeight: '700', color: '#0F172A', marginTop: 6, marginBottom: 4 },
  h5: { fontSize: 15, fontWeight: '700', color: '#0F172A', marginTop: 6, marginBottom: 4 },
  h6: { fontSize: 14, fontWeight: '700', color: '#0F172A', marginTop: 6, marginBottom: 4 },
  blockquote: {
    borderLeftWidth: 3,
    borderLeftColor: '#CBD5E1',
    paddingLeft: 12,
    marginVertical: 8,
  },
  codespan: {
    fontFamily: monospaceFont,
    fontSize: 14,
    backgroundColor: '#E2E8F0',
    color: '#0F172A',
    borderRadius: 4,
    paddingHorizontal: 4,
  },
  hr: { borderBottomWidth: 1, borderBottomColor: '#E2E8F0', marginVertical: 12 },
  list: { marginVertical: 4 },
  li: { fontSize: 16, lineHeight: 24, color: '#0F172A' },
  table: { borderWidth: 1, borderColor: '#E2E8F0', borderRadius: 6, marginVertical: 8 },
  tableRow: { borderBottomWidth: 1, borderBottomColor: '#E2E8F0' },
  tableCell: { padding: 6 },
};
