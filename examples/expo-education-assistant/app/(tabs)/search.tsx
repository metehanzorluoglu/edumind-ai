import { useEducationSearch } from 'education-assistant-client';
import type { DocumentType, JournalQuartile } from 'education-assistant-client';
import { useMemo, useState } from 'react';
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
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader } from '@/components/ui/PageHeader';
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
          <TextInput
            style={styles.input}
            value={query}
            onChangeText={setQuery}
            placeholder="Search the corpus…"
            placeholderTextColor={theme.faint}
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
            <ActivityIndicator style={styles.spinner} color={theme.accent} />
          )}
          {state.status === 'cancelled' && <Text style={styles.hint}>Search cancelled.</Text>}
          {state.status === 'error' && <Text style={styles.error}>{state.error.message}</Text>}
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

function FilterChip({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  const chipStyles = useMemo(() => buildChipStyles(theme), [theme]);
  return (
    <Pressable
      style={[chipStyles.chip, selected && chipStyles.chipSelected]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={label}
    >
      <Text style={[chipStyles.chipText, selected && chipStyles.chipTextSelected]}>{label}</Text>
    </Pressable>
  );
}

function buildChipStyles(theme: Theme) {
  return StyleSheet.create({
    chip: {
      borderWidth: StyleSheet.hairlineWidth * 2,
      borderColor: theme.border,
      borderRadius: theme.radius.pill,
      paddingHorizontal: 12,
      paddingVertical: 6,
      marginRight: 6,
    },
    chipSelected: { backgroundColor: theme.accent, borderColor: theme.accent },
    chipText: { fontSize: 12, color: theme.text, fontFamily: theme.fonts.body },
    chipTextSelected: { color: theme.accentContrast, fontFamily: theme.fonts.bodySemibold },
  });
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
    input: {
      borderWidth: StyleSheet.hairlineWidth * 2,
      borderColor: theme.border,
      borderRadius: theme.radius.md,
      paddingHorizontal: 12,
      paddingVertical: 10,
      color: theme.text,
      fontFamily: theme.fonts.body,
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
    spinner: { marginTop: 24 },
    error: {
      color: theme.danger,
      textAlign: 'center',
      marginTop: 24,
      fontFamily: theme.fonts.body,
    },
  });
}
