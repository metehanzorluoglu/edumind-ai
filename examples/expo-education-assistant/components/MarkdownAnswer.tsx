import type { Citation } from 'education-assistant-client';
import { splitAnswerIntoSegments } from 'education-assistant-client';
import type { ReactNode } from 'react';
import { useMemo } from 'react';
import type { TextStyle, ViewStyle } from 'react-native';
import { Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { MarkedStyles } from 'react-native-marked';
import { Renderer, useMarkdown } from 'react-native-marked';
import { useTheme, type Theme } from '@/lib/Preferences';

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
  constructor(
    private readonly onCitationPress: (sourceId: string) => void,
    // Ochre (light) / amber (dark) — [S<n>] markers are citation/evidence
    // UI specifically, and brand/BRAND_GUIDELINES.md §3 reserves orange
    // for exactly that, distinct from blue for ordinary links.
    private readonly citationStyle: TextStyle
  ) {
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
        <Text
          key={this.getKey()}
          style={[styles, this.citationStyle]}
          onPress={() => this.onCitationPress(sourceId)}
        >
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
    const codeBlockStyles = buildCodeBlockStyles(this.theme);
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

  // Set right after construction (see MarkdownAnswer below) — code() is
  // the only renderer method needing the full theme rather than one
  // pre-resolved style, since it builds a multi-part style set.
  theme!: Theme;
}

export interface MarkdownAnswerProps {
  answer: string;
  citations: readonly Citation[];
  onCitationPress: (sourceId: string) => void;
}

/** Renders assistant answer text as Markdown (headings, emphasis, lists, code, blockquotes, tables, links) while keeping [S<n>] citation markers tappable, exactly as the plain-text renderer it replaces did. Never used for user messages — those stay plain blue bubbles. */
export function MarkdownAnswer({ answer, citations, onCitationPress }: MarkdownAnswerProps) {
  const theme = useTheme();
  const renderer = useMemo(() => {
    const r = new CitationAwareRenderer(onCitationPress, {
      color: theme.citation,
      fontFamily: theme.fonts.bodyBold,
    });
    r.theme = theme;
    return r;
  }, [onCitationPress, theme]);
  const value = useMemo(
    () => preserveLineBreaks(withCitationLinks(answer, citations)),
    [answer, citations]
  );
  const markdownStyles = useMemo(() => buildMarkdownStyles(theme), [theme]);
  const blocks = useMarkdown(value, { renderer, styles: markdownStyles });

  return <View>{blocks}</View>;
}

const monospaceFont = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });

function buildCodeBlockStyles(theme: Theme) {
  return StyleSheet.create({
    // Always-dark contrast surface, same in both themes — see
    // Preferences.tsx's codeSurface/codeText docs.
    scroll: {
      backgroundColor: theme.codeSurface,
      borderRadius: theme.radius.md,
      marginVertical: 8,
    },
    content: {
      padding: 12,
    },
    text: {
      fontFamily: theme.fonts.mono !== 'monospace' ? theme.fonts.mono : monospaceFont,
      fontSize: 13,
      lineHeight: 18,
      color: theme.codeText,
    },
  });
}

function buildMarkdownStyles(theme: Theme): MarkedStyles {
  const heading: TextStyle = { fontFamily: theme.fonts.display, color: theme.text };
  return {
    text: { fontSize: 16, lineHeight: 24, color: theme.text, fontFamily: theme.fonts.body },
    paragraph: { marginBottom: 8 },
    strong: { fontWeight: '700', fontFamily: theme.fonts.bodyBold },
    em: { fontStyle: 'italic' },
    strikethrough: { textDecorationLine: 'line-through' },
    link: { color: theme.accent, fontFamily: theme.fonts.bodySemibold },
    h1: { ...heading, fontSize: 24, marginTop: 12, marginBottom: 8 },
    h2: { ...heading, fontSize: 20, marginTop: 10, marginBottom: 6 },
    h3: { ...heading, fontSize: 17, marginTop: 8, marginBottom: 4 },
    h4: { ...heading, fontSize: 16, marginTop: 6, marginBottom: 4 },
    h5: { ...heading, fontSize: 15, marginTop: 6, marginBottom: 4 },
    h6: { ...heading, fontSize: 14, marginTop: 6, marginBottom: 4 },
    blockquote: {
      borderLeftWidth: 3,
      borderLeftColor: theme.border,
      paddingLeft: 12,
      marginVertical: 8,
    },
    codespan: {
      fontFamily: theme.fonts.mono !== 'monospace' ? theme.fonts.mono : monospaceFont,
      fontSize: 14,
      backgroundColor: theme.cardPressed,
      color: theme.text,
      borderRadius: 4,
      paddingHorizontal: 4,
    },
    hr: { borderBottomWidth: 1, borderBottomColor: theme.border, marginVertical: 12 },
    list: { marginVertical: 4 },
    li: { fontSize: 16, lineHeight: 24, color: theme.text, fontFamily: theme.fonts.body },
    table: { borderWidth: 1, borderColor: theme.border, borderRadius: 6, marginVertical: 8 },
    tableRow: { borderBottomWidth: 1, borderBottomColor: theme.border },
    tableCell: { padding: 6 },
  };
}
