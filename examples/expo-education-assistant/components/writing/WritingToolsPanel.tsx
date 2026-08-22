import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { TextField } from '@/components/ui/TextField';
import { useTheme, type Theme } from '@/lib/Preferences';

export interface WritingToolsPanelProps {
  content: string;
  editable: boolean;
  onNavigateToOffsetRange: (range: { start: number; end: number }) => void;
  onReplaceContent: (next: string) => void;
  onInsertSnippet: (text: string) => void;
}

/** Plain, case-insensitive substring search (no regex) — matches this
 * panel's own "small and appropriate to the existing architecture"
 * scope: a full regex find/replace is a meaningfully bigger feature
 * this milestone doesn't ask for. */
function findAllOffsets(content: string, query: string): { start: number; end: number }[] {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const hay = content.toLowerCase();
  const needle = trimmed.toLowerCase();
  const results: { start: number; end: number }[] = [];
  let from = 0;
  for (;;) {
    const idx = hay.indexOf(needle, from);
    if (idx === -1) break;
    results.push({ start: idx, end: idx + trimmed.length });
    from = idx + trimmed.length;
  }
  return results;
}

const SNIPPETS: { label: string; text: string }[] = [
  { label: 'Section', text: '\\section{}' },
  { label: 'Subsection', text: '\\subsection{}' },
  {
    label: 'Figure',
    text: '\\begin{figure}[h]\n  \\centering\n  \\caption{}\n  \\label{fig:}\n\\end{figure}',
  },
  {
    label: 'Table',
    text: '\\begin{table}[h]\n  \\centering\n  \\caption{}\n  \\label{tab:}\n\\end{table}',
  },
  { label: 'Citation', text: '\\cite{}' },
  { label: 'Label', text: '\\label{}' },
];

/**
 * Writing UX Refinement milestone — the Writing drawer's new TOOLS tab:
 * a live word/character count, a small Find & Replace (plain substring,
 * no regex), and a short list of common LaTeX snippet inserts. Every
 * navigation/insertion action here calls straight through to primitives
 * [id].tsx already owns (onNavigateToOffsetRange, onInsertSnippet ==
 * insertAtCursor) — this component holds no editor state of its own.
 */
export function WritingToolsPanel({
  content,
  editable,
  onNavigateToOffsetRange,
  onReplaceContent,
  onInsertSnippet,
}: WritingToolsPanelProps) {
  const theme = useTheme();
  const styles = useMemo(() => buildStyles(theme), [theme]);
  const [query, setQuery] = useState('');
  const [replacement, setReplacement] = useState('');
  const [matchIndex, setMatchIndex] = useState(0);

  const wordCount = useMemo(() => {
    const trimmed = content.trim();
    return trimmed ? trimmed.split(/\s+/).length : 0;
  }, [content]);
  const charCount = content.length;

  const matches = useMemo(() => findAllOffsets(content, query), [content, query]);
  const clampedIndex =
    matches.length > 0 ? ((matchIndex % matches.length) + matches.length) % matches.length : 0;
  const currentMatch = matches[clampedIndex] ?? null;

  function goToMatch(index: number): void {
    if (matches.length === 0) return;
    const wrapped = ((index % matches.length) + matches.length) % matches.length;
    setMatchIndex(wrapped);
    const match = matches[wrapped];
    if (match) onNavigateToOffsetRange(match);
  }

  function handleFindNext(): void {
    goToMatch(clampedIndex + 1);
  }

  function handleFindPrevious(): void {
    goToMatch(clampedIndex - 1);
  }

  function handleReplaceCurrent(): void {
    if (!currentMatch) return;
    const next =
      content.slice(0, currentMatch.start) + replacement + content.slice(currentMatch.end);
    onReplaceContent(next);
  }

  function handleReplaceAll(): void {
    if (matches.length === 0) return;
    let next = '';
    let cursor = 0;
    for (const match of matches) {
      next += content.slice(cursor, match.start) + replacement;
      cursor = match.end;
    }
    next += content.slice(cursor);
    onReplaceContent(next);
  }

  if (!editable) {
    return (
      <EmptyState
        title="No tools available"
        description="Open a .tex file to use Find & Replace, word count, and snippets."
      />
    );
  }

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
      <Text style={styles.sectionHeading}>Word count</Text>
      <View style={styles.countRow}>
        <Text style={styles.countText}>{wordCount} words</Text>
        <Text style={styles.countText}>{charCount} characters</Text>
      </View>

      <Text style={styles.sectionHeading}>Find & replace</Text>
      <TextField
        label="Find"
        placeholder="Search this document…"
        value={query}
        onChangeText={(text) => {
          setQuery(text);
          setMatchIndex(0);
        }}
      />
      <Text style={styles.matchCountText}>
        {query.trim() ? `${matches.length} match${matches.length === 1 ? '' : 'es'}` : ' '}
      </Text>
      <View style={styles.buttonRow}>
        <Button
          label="Previous"
          variant="secondary"
          size="sm"
          disabled={matches.length === 0}
          onPress={handleFindPrevious}
        />
        <Button
          label="Next"
          variant="secondary"
          size="sm"
          disabled={matches.length === 0}
          onPress={handleFindNext}
        />
      </View>
      <View style={styles.replaceField}>
        <TextField
          label="Replace with"
          placeholder="Replacement text…"
          value={replacement}
          onChangeText={setReplacement}
        />
      </View>
      <View style={styles.buttonRow}>
        <Button
          label="Replace"
          variant="secondary"
          size="sm"
          disabled={!currentMatch}
          onPress={handleReplaceCurrent}
        />
        <Button
          label="Replace all"
          variant="secondary"
          size="sm"
          disabled={matches.length === 0}
          onPress={handleReplaceAll}
        />
      </View>

      <Text style={styles.sectionHeading}>Snippets</Text>
      <View style={styles.snippetGrid}>
        {SNIPPETS.map((snippet) => (
          <Pressable
            key={snippet.label}
            style={({ pressed }) => [styles.snippetChip, pressed && styles.snippetChipPressed]}
            onPress={() => onInsertSnippet(snippet.text)}
            accessibilityRole="button"
            accessibilityLabel={`Insert ${snippet.label} snippet`}
          >
            <Text style={styles.snippetChipText}>{snippet.label}</Text>
          </Pressable>
        ))}
      </View>
    </ScrollView>
  );
}

function buildStyles(theme: Theme) {
  return StyleSheet.create({
    scroll: { flex: 1 },
    scrollContent: { paddingBottom: 24, gap: 6 },
    sectionHeading: {
      fontSize: 12,
      fontFamily: theme.fonts.bodySemibold,
      color: theme.subtext,
      textTransform: 'uppercase',
      letterSpacing: 0.4,
      marginTop: 16,
      marginBottom: 4,
    },
    countRow: { flexDirection: 'row', gap: 16 },
    countText: { fontSize: 13, fontFamily: theme.fonts.body, color: theme.text },
    matchCountText: {
      fontSize: 11.5,
      fontFamily: theme.fonts.body,
      color: theme.subtext,
      minHeight: 16,
    },
    buttonRow: { flexDirection: 'row', gap: 8, marginTop: 6 },
    replaceField: { marginTop: 8 },
    snippetGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    snippetChip: {
      paddingVertical: 6,
      paddingHorizontal: 10,
      borderRadius: 999,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
    },
    snippetChipPressed: { backgroundColor: theme.cardPressed },
    snippetChipText: { fontSize: 12.5, fontFamily: theme.fonts.body, color: theme.text },
  });
}
