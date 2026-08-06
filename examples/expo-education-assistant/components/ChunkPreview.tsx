import type { RetrievedChunk } from 'education-assistant-client';
import { StyleSheet, Text, View } from 'react-native';
import { formatAuthorsCompact, safeText } from '@/lib/format';
import { useTheme } from '@/lib/Preferences';

/**
 * For raw /search results — these have no [S#] citation id (that's only
 * assigned inside /chat's citation-building step), so this is intentionally
 * a separate, simpler component from SourceCard rather than a variant of it.
 */
export function ChunkPreview({ chunk }: { chunk: RetrievedChunk }) {
  const theme = useTheme();
  return (
    <View
      style={[
        styles.card,
        { backgroundColor: theme.card, borderColor: theme.border, borderRadius: theme.radius.md },
      ]}
    >
      <Text style={[styles.title, { color: theme.text, fontFamily: theme.fonts.bodySemibold }]}>
        {safeText(chunk.title, 'Untitled source')}
      </Text>
      <Text style={[styles.meta, { color: theme.subtext, fontFamily: theme.fonts.body }]}>
        {formatAuthorsCompact(chunk.authors)}
        {chunk.publication_year ? ` · ${chunk.publication_year}` : ''} · score{' '}
        {chunk.score.toFixed(3)}
      </Text>
      <Text style={[styles.meta, { color: theme.subtext, fontFamily: theme.fonts.body }]}>
        {safeText(chunk.source_filename, 'unknown file')} (p. {chunk.page_number})
      </Text>
      <Text
        style={[styles.excerpt, { color: theme.text, fontFamily: theme.fonts.body }]}
        numberOfLines={4}
      >
        {safeText(chunk.text, '(no excerpt available)')}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    padding: 12,
    marginBottom: 8,
  },
  title: { fontSize: 15, marginBottom: 2 },
  meta: { fontSize: 12 },
  excerpt: { fontSize: 13, marginTop: 6, lineHeight: 19 },
});
