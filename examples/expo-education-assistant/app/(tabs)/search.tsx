import { useEducationSearch } from 'education-assistant-client';
import type { DocumentType, JournalQuartile } from 'education-assistant-client';
import { useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { ChunkPreview } from '@/components/ChunkPreview';
import { DOCUMENT_TYPES, DOCUMENT_TYPE_LABELS, JOURNAL_QUARTILES } from '@/lib/enums';
import { useClient } from '@/lib/ClientProvider';

export default function SearchScreen() {
  const { client } = useClient();
  const { state, search, cancel } = useEducationSearch(client);
  const [query, setQuery] = useState('');
  const [documentType, setDocumentType] = useState<DocumentType | null>(null);
  const [journalQuartile, setJournalQuartile] = useState<JournalQuartile | null>(null);

  const isBusy = state.status === 'loading';

  function handleSearch(): void {
    const trimmed = query.trim();
    if (!trimmed || isBusy) return;
    search({
      query: trimmed,
      top_k: 8,
      filters:
        documentType || journalQuartile
          ? {
              document_type: documentType ?? undefined,
              journal_quartile: journalQuartile ?? undefined,
            }
          : undefined,
    });
  }

  return (
    <View style={styles.container}>
      <View style={styles.form}>
        <TextInput
          style={styles.input}
          value={query}
          onChangeText={setQuery}
          placeholder="Search the corpus…"
          onSubmitEditing={handleSearch}
          returnKeyType="search"
        />

        <Text style={styles.filterLabel}>Document type</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipRow}>
          <FilterChip
            label="Any"
            selected={documentType === null}
            onPress={() => setDocumentType(null)}
          />
          {DOCUMENT_TYPES.map((type) => (
            <FilterChip
              key={type}
              label={DOCUMENT_TYPE_LABELS[type]}
              selected={documentType === type}
              onPress={() => setDocumentType(documentType === type ? null : type)}
            />
          ))}
        </ScrollView>

        <Text style={styles.filterLabel}>Journal quartile</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipRow}>
          <FilterChip
            label="Any"
            selected={journalQuartile === null}
            onPress={() => setJournalQuartile(null)}
          />
          {JOURNAL_QUARTILES.map((quartile) => (
            <FilterChip
              key={quartile}
              label={quartile}
              selected={journalQuartile === quartile}
              onPress={() => setJournalQuartile(journalQuartile === quartile ? null : quartile)}
            />
          ))}
        </ScrollView>

        <Pressable style={styles.button} onPress={isBusy ? cancel : handleSearch}>
          <Text style={styles.buttonText}>{isBusy ? 'Cancel' : 'Search'}</Text>
        </Pressable>
      </View>

      <ScrollView style={styles.results} contentContainerStyle={styles.resultsContent}>
        {state.status === 'idle' && (
          <Text style={styles.hint}>Retrieval only — no generation, no citations.</Text>
        )}
        {state.status === 'loading' && <ActivityIndicator style={styles.spinner} />}
        {state.status === 'cancelled' && <Text style={styles.hint}>Search cancelled.</Text>}
        {state.status === 'error' && <Text style={styles.error}>{state.error.message}</Text>}
        {state.status === 'success' && state.results.length === 0 && (
          <Text style={styles.hint}>No results.</Text>
        )}
        {state.status === 'success' &&
          state.results.map((chunk, i) => (
            <ChunkPreview key={`${chunk.document_id}-${chunk.chunk_id}-${i}`} chunk={chunk} />
          ))}
      </ScrollView>
    </View>
  );
}

function FilterChip({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable style={[chipStyles.chip, selected && chipStyles.chipSelected]} onPress={onPress}>
      <Text style={[chipStyles.chipText, selected && chipStyles.chipTextSelected]}>{label}</Text>
    </Pressable>
  );
}

const chipStyles = StyleSheet.create({
  chip: {
    borderWidth: 1,
    borderColor: '#CBD5E1',
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginRight: 6,
  },
  chipSelected: { backgroundColor: '#2F5FE0', borderColor: '#2F5FE0' },
  chipText: { fontSize: 12, color: '#334155' },
  chipTextSelected: { color: '#FFFFFF', fontWeight: '600' },
});

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F6F7FA' },
  form: {
    padding: 16,
    gap: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#E2E8F0',
    backgroundColor: '#FFFFFF',
  },
  input: {
    borderWidth: 1,
    borderColor: '#CBD5E1',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  filterLabel: { fontSize: 12, fontWeight: '600', color: '#475569', marginTop: 4 },
  chipRow: { flexDirection: 'row' },
  button: {
    backgroundColor: '#2F5FE0',
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
    marginTop: 8,
  },
  buttonText: { color: '#FFFFFF', fontWeight: '600' },
  results: { flex: 1 },
  resultsContent: { padding: 16 },
  hint: { color: '#64748B', textAlign: 'center', marginTop: 24 },
  spinner: { marginTop: 24 },
  error: { color: '#B91C1C', textAlign: 'center', marginTop: 24 },
});
