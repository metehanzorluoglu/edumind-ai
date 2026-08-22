import { useMemo } from 'react';
import { Pressable, ScrollView, StyleSheet, Text } from 'react-native';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { useTheme, type Theme } from '@/lib/Preferences';

export interface OutlineEntry {
  /** 0 = \chapter, 1 = \section, 2 = \subsection, 3 = \subsubsection —
   * drives indentation only, never clamped/validated beyond that. */
  level: number;
  title: string;
  /** 1-indexed, matching every other line number in this app. */
  line: number;
  /** Character offset of the heading text itself (inside the command's
   * braces) — what navigation actually jumps to; `line` is only used to
   * drive LatexCodeEditor's whole-line flash highlight. */
  offset: number;
}

export interface LabelEntry {
  name: string;
  line: number;
  offset: number;
}

const HEADING_COMMANDS: { pattern: RegExp; level: number }[] = [
  { pattern: /\\chapter\*?\{/, level: 0 },
  { pattern: /\\section\*?\{/, level: 1 },
  { pattern: /\\subsection\*?\{/, level: 2 },
  { pattern: /\\subsubsection\*?\{/, level: 3 },
];

/** Finds the index of the `}` matching the `{` at `content[openIndex]`. */
function findMatchingBrace(content: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < content.length; i++) {
    if (content[i] === '\\') {
      i++;
      continue;
    }
    if (content[i] === '{') depth++;
    else if (content[i] === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function lineForOffset(content: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < content.length; i++) {
    if (content[i] === '\n') line += 1;
  }
  return line;
}

/** Writing UX Refinement milestone — a lightweight, regex-based outline
 * parser (deliberately NOT a real LaTeX parser: this app has none, and
 * building one just for a jump-list would be wildly disproportionate to
 * what it needs to do). Good enough for the common, well-formed case;
 * malformed/unbalanced braces simply stop contributing further entries
 * rather than throwing or misparsing the rest of the document. */
export function parseOutline(content: string): { headings: OutlineEntry[]; labels: LabelEntry[] } {
  const headings: OutlineEntry[] = [];
  const labelRe = /\\label\{([^}]*)\}/g;
  const labels: LabelEntry[] = [];
  let labelMatch: RegExpExecArray | null = labelRe.exec(content);
  while (labelMatch !== null) {
    const nameStart = labelMatch.index + labelMatch[0].indexOf('{') + 1;
    labels.push({
      name: labelMatch[1] ?? '',
      line: lineForOffset(content, nameStart),
      offset: nameStart,
    });
    labelMatch = labelRe.exec(content);
  }

  for (const { pattern, level } of HEADING_COMMANDS) {
    const re = new RegExp(pattern.source, 'g');
    let match: RegExpExecArray | null = re.exec(content);
    while (match !== null) {
      const openBrace = match.index + match[0].length - 1;
      const close = findMatchingBrace(content, openBrace);
      if (close !== -1) {
        const titleStart = openBrace + 1;
        const title = content.slice(titleStart, close).trim();
        if (title) {
          headings.push({
            level,
            title,
            line: lineForOffset(content, titleStart),
            offset: titleStart,
          });
        }
      }
      match = re.exec(content);
    }
  }
  headings.sort((a, b) => a.offset - b.offset);
  return { headings, labels };
}

export interface DocumentOutlinePanelProps {
  content: string;
  editable: boolean;
  onNavigateToOffset: (offset: number) => void;
  onViewBibliography: () => void;
}

/**
 * Writing UX Refinement milestone — the Writing drawer's new STRUCTURE
 * tab: a clickable outline of the currently open file's own headings
 * and labels, plus a shortcut to the existing Bibliography view. Every
 * click reuses [id].tsx's own navigateToOffsetRange (via
 * onNavigateToOffset) — the exact same selection/flashLine/focus
 * mechanism compiler-diagnostic "go to line" already uses, so there is
 * no new editor-navigation code path here, only a new way to reach it.
 */
export function DocumentOutlinePanel({
  content,
  editable,
  onNavigateToOffset,
  onViewBibliography,
}: DocumentOutlinePanelProps) {
  const theme = useTheme();
  const styles = useMemo(() => buildStyles(theme), [theme]);
  const { headings, labels } = useMemo(() => parseOutline(content), [content]);

  if (!editable) {
    return (
      <EmptyState
        title="No outline available"
        description="Open a .tex file to see its sections and labels here."
      />
    );
  }

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
      <Button label="Bibliography" variant="secondary" size="sm" onPress={onViewBibliography} />

      <Text style={styles.sectionHeading}>Sections</Text>
      {headings.length === 0 ? (
        <Text style={styles.emptyText}>
          No \section/\subsection headings found in this file yet.
        </Text>
      ) : (
        headings.map((entry, index) => (
          <Pressable
            key={`${entry.offset}-${index}`}
            style={({ pressed }) => [
              styles.row,
              { paddingLeft: 12 + entry.level * 16 },
              pressed && styles.rowPressed,
            ]}
            onPress={() => onNavigateToOffset(entry.offset)}
            accessibilityRole="button"
            accessibilityLabel={`Go to heading: ${entry.title}`}
          >
            <Text style={styles.rowText} numberOfLines={1}>
              {entry.title}
            </Text>
            <Text style={styles.rowLine}>L{entry.line}</Text>
          </Pressable>
        ))
      )}

      <Text style={styles.sectionHeading}>Labels</Text>
      {labels.length === 0 ? (
        <Text style={styles.emptyText}>
          No \label{'{'}...{'}'} commands found in this file yet.
        </Text>
      ) : (
        labels.map((entry, index) => (
          <Pressable
            key={`${entry.offset}-${index}`}
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            onPress={() => onNavigateToOffset(entry.offset)}
            accessibilityRole="button"
            accessibilityLabel={`Go to label: ${entry.name}`}
          >
            <Text style={styles.rowText} numberOfLines={1}>
              {entry.name}
            </Text>
            <Text style={styles.rowLine}>L{entry.line}</Text>
          </Pressable>
        ))
      )}
    </ScrollView>
  );
}

function buildStyles(theme: Theme) {
  return StyleSheet.create({
    scroll: { flex: 1 },
    scrollContent: { paddingBottom: 24, gap: 4 },
    sectionHeading: {
      fontSize: 12,
      fontFamily: theme.fonts.bodySemibold,
      color: theme.subtext,
      textTransform: 'uppercase',
      letterSpacing: 0.4,
      marginTop: 16,
      marginBottom: 4,
    },
    emptyText: {
      fontSize: 12.5,
      fontFamily: theme.fonts.body,
      color: theme.subtext,
      paddingVertical: 4,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingVertical: 7,
      paddingRight: 12,
      borderRadius: 6,
      gap: 8,
    },
    rowPressed: { backgroundColor: theme.cardPressed },
    rowText: { flex: 1, fontSize: 13, fontFamily: theme.fonts.body, color: theme.text },
    rowLine: { fontSize: 11, fontFamily: theme.fonts.body, color: theme.subtext },
  });
}
