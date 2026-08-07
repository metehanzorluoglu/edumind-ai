import { useEducationSearch } from 'education-assistant-client';
import type { DocumentType, JournalQuartile } from 'education-assistant-client';
import { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { ChunkPreview } from '@/components/ChunkPreview';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { FilterChip } from '@/components/ui/FilterChip';
import { Notice } from '@/components/ui/Notice';
import { PageHeader } from '@/components/ui/PageHeader';
import { Skeleton } from '@/components/ui/Skeleton';
import { TextField } from '@/components/ui/TextField';
import { DOCUMENT_TYPES, DOCUMENT_TYPE_LABELS, JOURNAL_QUARTILES } from '@/lib/enums';
import { useClient } from '@/lib/ClientProvider';
import { useTheme, type Theme } from '@/lib/Preferences';

export default function SearchScreen() {
  const theme = useTheme();
  const styles = useMemo(() => buildStyles(theme), [theme]);
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
      <PageHeader title="Search" />
      <View style={styles.formOuter}>
        <View style={styles.form}>
          <TextField
            label="Search"
            value={query}
            onChangeText={setQuery}
            placeholder="Search the corpus…"
            onSubmitEditing={handleSearch}
            returnKeyType="search"
            accessibilityLabel="Search the corpus"
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

          <Button
            label={isBusy ? 'Cancel' : 'Search'}
            onPress={isBusy ? cancel : handleSearch}
            variant={isBusy ? 'secondary' : 'primary'}
            fullWidth
            style={styles.searchButton}
          />
        </View>
      </View>

      <ScrollView style={styles.results} contentContainerStyle={styles.resultsContent}>
        <View style={styles.resultsInner}>
          {state.status === 'idle' && (
            <Text style={styles.hint}>Retrieval only — no generation, no citations.</Text>
          )}
          {state.status === 'loading' && (
            <View style={styles.skeletonList}>
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} width="100%" height={104} radius={theme.radius.md} />
              ))}
            </View>
          )}
          {state.status === 'cancelled' && <Text style={styles.hint}>Search cancelled.</Text>}
          {state.status === 'error' && <Notice tone="danger" body={state.error.message} />}
          {state.status === 'success' && state.results.length === 0 && (
            <EmptyState
              title="No results"
              description="Try a different query or clear the document type / journal quartile filters."
            />
          )}
          {state.status === 'success' &&
            state.results.map((chunk, i) => (
              <ChunkPreview key={`${chunk.document_id}-${chunk.chunk_id}-${i}`} chunk={chunk} />
            ))}
        </View>
      </ScrollView>
    </View>
  );
}

function buildStyles(theme: Theme) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: theme.background },
    formOuter: {
      alignItems: 'center',
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.border,
      backgroundColor: theme.card,
    },
    form: {
      width: '100%',
      maxWidth: 760,
      padding: 20,
      gap: 8,
    },
    filterLabel: {
      fontSize: 12,
      color: theme.subtext,
      fontFamily: theme.fonts.bodySemibold,
      marginTop: 4,
    },
    chipRow: { flexDirection: 'row' },
    searchButton: { marginTop: 8 },
    results: { flex: 1 },
    resultsContent: { padding: 20, alignItems: 'center' },
    resultsInner: { width: '100%', maxWidth: 760 },
    hint: {
      color: theme.subtext,
      textAlign: 'center',
      marginTop: 24,
      fontFamily: theme.fonts.body,
    },
    skeletonList: { gap: 10, marginTop: 12, width: '100%' },
  });
}
