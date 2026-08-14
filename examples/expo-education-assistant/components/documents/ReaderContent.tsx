import { useMemo, type ComponentType } from 'react';
import { Pressable, StyleSheet, Text, View, type TextProps } from 'react-native';
import type { DocumentContentChunk, DocumentHighlight } from 'education-assistant-client';
import { useTheme, type Theme } from '@/lib/Preferences';

// react-native-web forwards a `dataSet` prop straight through to real
// `data-*` DOM attributes (see forwardedProps.defaultProps) — exactly
// what useReaderSelection needs to trace a selection back to its chunk —
// but @types/react-native's own TextProps doesn't declare it (native has
// no such concept). This is the one, narrowly-scoped cast for that.
type TextPropsWithDataSet = TextProps & { dataSet?: Record<string, string> };
const SelectableText = Text as unknown as ComponentType<TextPropsWithDataSet>;

export interface ReaderPage {
  pageNumber: number;
  chunks: DocumentContentChunk[];
}

/** Groups chunks (already in reading order) into pages — a page can span
 * more than one chunk for unusually long pages (see the backend's
 * DocumentContentResponse docstring), so this groups consecutive chunks
 * sharing a page_number rather than assuming one chunk per page. */
export function groupChunksIntoPages(chunks: DocumentContentChunk[]): ReaderPage[] {
  const pages: ReaderPage[] = [];
  for (const chunk of chunks) {
    const last = pages[pages.length - 1];
    if (last && last.pageNumber === chunk.page_number) {
      last.chunks.push(chunk);
    } else {
      pages.push({ pageNumber: chunk.page_number, chunks: [chunk] });
    }
  }
  return pages;
}

/** Splits `text` into plain/highlighted segments for every highlight
 * anchored to this exact chunk, by locating each highlight's stored
 * selected_text snapshot within the chunk's current text. Deliberately
 * simple (§10: "keep this simple") — highlights are located in order by
 * their found start index and never allowed to re-overlap an
 * already-claimed range; a highlight whose snapshot no longer appears
 * verbatim in the chunk (should not happen — chunk text is immutable
 * once ingested) is silently skipped rather than crashing the reader. */
function splitWithHighlights(
  text: string,
  highlights: DocumentHighlight[]
): { text: string; highlighted: boolean; highlightId?: string }[] {
  if (highlights.length === 0) return [{ text, highlighted: false }];

  const ranges: { start: number; end: number; id: string }[] = [];
  for (const h of highlights) {
    if (!h.selected_text) continue;
    let searchFrom = 0;
    let found = -1;
    // Skip past any already-claimed range so two highlights that share
    // identical text don't both anchor to the same occurrence.
    while (searchFrom <= text.length) {
      const idx = text.indexOf(h.selected_text, searchFrom);
      if (idx === -1) break;
      const overlaps = ranges.some((r) => idx < r.end && idx + h.selected_text.length > r.start);
      if (!overlaps) {
        found = idx;
        break;
      }
      searchFrom = idx + 1;
    }
    if (found !== -1) {
      ranges.push({ start: found, end: found + h.selected_text.length, id: h.id });
    }
  }
  ranges.sort((a, b) => a.start - b.start);

  const segments: { text: string; highlighted: boolean; highlightId?: string }[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start > cursor)
      segments.push({ text: text.slice(cursor, range.start), highlighted: false });
    segments.push({
      text: text.slice(range.start, range.end),
      highlighted: true,
      highlightId: range.id,
    });
    cursor = range.end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), highlighted: false });
  return segments.length > 0 ? segments : [{ text, highlighted: false }];
}

export interface ReaderContentProps {
  pages: ReaderPage[];
  highlights: DocumentHighlight[];
  onPressHighlight?: (highlightId: string) => void;
  /** Mobile fallback (§30/§31): long-pressing a chunk offers the same
   * Highlight/Add note/Ask EduM8 actions over the WHOLE chunk's text,
   * since real-DOM text selection tracking (useReaderSelection) is
   * web-only. */
  onLongPressChunk?: (chunk: DocumentContentChunk) => void;
  highlightedChunkId?: string | null;
}

/**
 * Frontend Milestone 3 (Document Reader) — renders the document's
 * extracted text (see DocumentContentResponse) grouped into pages. Each
 * chunk carries `dataSet` attributes (chunk-id/chunk-index/page-number —
 * react-native-web forwards `dataSet` to real `data-*` DOM attributes)
 * so useReaderSelection can trace a real browser text selection back to
 * exactly which chunk it started in.
 */
export function ReaderContent({
  pages,
  highlights,
  onPressHighlight,
  onLongPressChunk,
  highlightedChunkId,
}: ReaderContentProps) {
  const theme = useTheme();
  const styles = useMemo(() => buildStyles(theme), [theme]);

  const highlightsByChunk = useMemo(() => {
    const map = new Map<string, DocumentHighlight[]>();
    for (const h of highlights) {
      // Frontend Milestone 3.1: a visual-only PDF highlight (no semantic
      // anchor — see DocumentHighlight's chunk_id docstring) has nothing
      // to attach to in THIS (extracted-text) view; it still renders
      // fine in the original-PDF view via its visual anchor. Never
      // dropped from the Highlights panel — only from this inline
      // per-chunk rendering.
      if (!h.chunk_id) continue;
      const list = map.get(h.chunk_id) ?? [];
      list.push(h);
      map.set(h.chunk_id, list);
    }
    return map;
  }, [highlights]);

  return (
    <View>
      {pages.map((page) => (
        <View key={page.pageNumber} style={styles.pageSection}>
          <Text style={styles.pageLabel}>Page {page.pageNumber}</Text>
          {page.chunks.map((chunk) => {
            const chunkHighlights = highlightsByChunk.get(chunk.chunk_id) ?? [];
            const segments = splitWithHighlights(chunk.text, chunkHighlights);
            return (
              <Pressable
                key={chunk.chunk_id}
                delayLongPress={450}
                onLongPress={onLongPressChunk ? () => onLongPressChunk(chunk) : undefined}
                style={[styles.chunk, highlightedChunkId === chunk.chunk_id && styles.chunkFlashed]}
              >
                <SelectableText
                  selectable
                  style={styles.chunkText}
                  dataSet={{
                    chunkId: chunk.chunk_id,
                    chunkIndex: String(chunk.chunk_index),
                    pageNumber: String(chunk.page_number),
                  }}
                >
                  {segments.map((segment, i) =>
                    segment.highlighted ? (
                      <Text
                        key={i}
                        style={styles.highlightMark}
                        onPress={
                          onPressHighlight && segment.highlightId
                            ? () => onPressHighlight(segment.highlightId!)
                            : undefined
                        }
                      >
                        {segment.text}
                      </Text>
                    ) : (
                      <Text key={i}>{segment.text}</Text>
                    )
                  )}
                </SelectableText>
              </Pressable>
            );
          })}
        </View>
      ))}
    </View>
  );
}

function buildStyles(theme: Theme) {
  return StyleSheet.create({
    pageSection: { marginBottom: 28 },
    pageLabel: {
      fontSize: 11,
      fontFamily: theme.fonts.bodySemibold,
      color: theme.faint,
      textTransform: 'uppercase',
      letterSpacing: 0.4,
      marginBottom: 10,
    },
    chunk: { marginBottom: 16, borderRadius: theme.radius.sm },
    chunkFlashed: { backgroundColor: theme.accentSoft },
    chunkText: {
      fontSize: 15.5,
      lineHeight: 26,
      color: theme.text,
      fontFamily: theme.fonts.body,
    },
    highlightMark: {
      backgroundColor: theme.warningSoft,
      color: theme.text,
    },
  });
}
