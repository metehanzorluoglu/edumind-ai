import type { RetrievedChunk } from 'education-assistant-client';
import { StyleSheet, Text, View } from 'react-native';
import { formatAuthorsCompact, safeText } from '@/lib/format';

/**
 * For raw /search results — these have no [S#] citation id (that's only
 * assigned inside /chat's citation-building step), so this is intentionally
 * a separate, simpler component from SourceCard rather than a variant of it.
 */
export function ChunkPreview({ chunk }: { chunk: RetrievedChunk }) {
  return (
    <View style={styles.card}>
      <Text style={styles.title}>{safeText(chunk.title, 'Untitled source')}</Text>
      <Text style={styles.meta}>
        {formatAuthorsCompact(chunk.authors)}
        {chunk.publication_year ? ` · ${chunk.publication_year}` : ''} · score{' '}
        {chunk.score.toFixed(3)}
      </Text>
      <Text style={styles.meta}>
        {safeText(chunk.source_filename, 'unknown file')} (p. {chunk.page_number})
      </Text>
      <Text style={styles.excerpt} numberOfLines={4}>
        {safeText(chunk.text, '(no excerpt available)')}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderColor: '#E2E8F0',
    borderRadius: 8,
    padding: 12,
    marginBottom: 8,
    backgroundColor: '#FFFFFF',
  },
  title: { fontWeight: '600', fontSize: 15, marginBottom: 2 },
  meta: { fontSize: 12, color: '#475569' },
  excerpt: { fontSize: 13, color: '#334155', marginTop: 6 },
});
