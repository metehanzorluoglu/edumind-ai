import type { DocumentSummary } from 'education-assistant-client';
import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { CloseIcon } from '@/components/icons';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Notice } from '@/components/ui/Notice';
import { TextField } from '@/components/ui/TextField';
import { useClient } from '@/lib/ClientProvider';
import { formatSourceIdentity } from '@/lib/format';
import { useTheme, type Theme } from '@/lib/Preferences';

export interface ReferencePickerModalProps {
  visible: boolean;
  /** document_ids already in this project — excluded from the results so
   * the picker never re-offers an existing reference. Milestone 5.2 —
   * pass an empty Set when reusing this picker for a purpose OTHER than
   * "add as reference" (e.g. Ask EduM8's "Selected sources" scope,
   * which should offer every library document, including ones already
   * referenced). */
  existingDocumentIds: Set<string>;
  onAdd: (documentIds: string[]) => Promise<void>;
  onClose: () => void;
  /** Milestone 5.2 Part 4B — generalizes this picker beyond "Add
   * references" (Part 4B: "Reuse the existing source picker wherever
   * practical. Do not invent another unrelated source-selection UX")
   * without changing the M5 call site's behavior at all — every prop
   * below defaults to the exact original "Add references" copy. */
  title?: string;
  /** Button label for exactly 1 selected item. */
  confirmLabelSingular?: string;
  /** Button label for 2+ selected items — receives the count. */
  confirmLabelPlural?: (count: number) => string;
  emptyMessage?: string;
}

/**
 * Milestone 5 (Academic Writing & LaTeX Foundation) Part 4 — the
 * References picker: search the caller's own library, multi-select, add.
 * Compact identity display ("Forrester et al. (2004)"), never a giant
 * metadata card — reuses the exact search-on-submit convention Documents'
 * own library search already established (see documents/index.tsx),
 * rather than duplicating a second picker component tree.
 */
export function ReferencePickerModal({
  visible,
  existingDocumentIds,
  onAdd,
  onClose,
  title = 'Add references',
  confirmLabelSingular = 'Add reference',
  confirmLabelPlural = (count) => `Add ${count} references`,
  emptyMessage,
}: ReferencePickerModalProps) {
  const theme = useTheme();
  const styles = useMemo(() => buildStyles(theme), [theme]);
  const { client } = useClient();

  const [searchInput, setSearchInput] = useState('');
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  function loadDocuments(q: string): void {
    setLoading(true);
    setLoadError(null);
    client
      .listDocuments({ q: q || undefined, limit: 50 })
      .then((response) => setDocuments(response.documents))
      .catch((error: unknown) => {
        setLoadError(error instanceof Error ? error.message : 'Could not load your library.');
      })
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    if (!visible) return;
    setSearchInput('');
    setSelectedIds(new Set());
    setAddError(null);
    loadDocuments('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  function toggleSelected(documentId: string): void {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(documentId)) next.delete(documentId);
      else next.add(documentId);
      return next;
    });
  }

  async function handleAdd(): Promise<void> {
    if (selectedIds.size === 0 || adding) return;
    setAdding(true);
    setAddError(null);
    try {
      await onAdd(Array.from(selectedIds));
      onClose();
    } catch (error) {
      setAddError(error instanceof Error ? error.message : 'Could not add these references.');
    } finally {
      setAdding(false);
    }
  }

  const selectableDocuments = documents.filter((d) => !existingDocumentIds.has(d.document_id));

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <Pressable
          style={styles.backdrop}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close reference picker"
        />
        <View style={styles.panel}>
          <View style={styles.header}>
            <Text style={styles.title}>{title}</Text>
            <IconButton
              label="Close"
              icon={<CloseIcon size={16} color={theme.faint} />}
              size="sm"
              onPress={onClose}
            />
          </View>

          <View style={styles.searchRow}>
            <View style={styles.searchField}>
              <TextField
                label="Search your library"
                value={searchInput}
                onChangeText={setSearchInput}
                placeholder="Search by title, author, year, or DOI…"
                onSubmitEditing={() => loadDocuments(searchInput.trim())}
                returnKeyType="search"
              />
            </View>
            <Button
              label="Search"
              variant="secondary"
              size="sm"
              onPress={() => loadDocuments(searchInput.trim())}
            />
          </View>

          <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
            {loading && <ActivityIndicator color={theme.accent} style={styles.spinner} />}
            {!loading && loadError && <Notice tone="danger" body={loadError} />}
            {!loading && !loadError && selectableDocuments.length === 0 && (
              <Text style={styles.emptyText}>
                {documents.length === 0
                  ? 'No documents found.'
                  : (emptyMessage ??
                    'Every matching document is already a reference in this project.')}
              </Text>
            )}
            {!loading &&
              !loadError &&
              selectableDocuments.map((doc) => {
                const selected = selectedIds.has(doc.document_id);
                return (
                  <Pressable
                    key={doc.document_id}
                    onPress={() => toggleSelected(doc.document_id)}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: selected }}
                    accessibilityLabel={`Select ${formatSourceIdentity(doc.authors, doc.publication_year, doc.title)}`}
                    style={[styles.row, selected && styles.rowSelected]}
                  >
                    <View style={[styles.checkbox, selected && styles.checkboxActive]} />
                    <View style={styles.rowBody}>
                      <Text style={styles.rowIdentity} numberOfLines={1}>
                        {formatSourceIdentity(doc.authors, doc.publication_year, doc.title)}
                      </Text>
                      <Text style={styles.rowTitle} numberOfLines={1}>
                        {doc.title ?? doc.source_filename}
                      </Text>
                    </View>
                  </Pressable>
                );
              })}
          </ScrollView>

          {addError && <Notice tone="danger" body={addError} />}

          <View style={styles.actions}>
            <Text style={styles.selectionCount}>{selectedIds.size} selected</Text>
            <Button
              label={
                selectedIds.size > 1 ? confirmLabelPlural(selectedIds.size) : confirmLabelSingular
              }
              variant="primary"
              size="sm"
              disabled={selectedIds.size === 0}
              loading={adding}
              onPress={() => void handleAdd()}
            />
          </View>
        </View>
      </View>
    </Modal>
  );
}

function buildStyles(theme: Theme) {
  return StyleSheet.create({
    overlay: {
      ...StyleSheet.absoluteFillObject,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 45,
      elevation: 45,
    },
    backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: theme.overlay },
    panel: {
      width: 480,
      maxWidth: '92%',
      maxHeight: '80%',
      backgroundColor: theme.card,
      borderRadius: theme.radius.lg,
      padding: 16,
      gap: 10,
    },
    header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    title: { fontSize: 16, fontFamily: theme.fonts.display, color: theme.text },
    searchRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
    searchField: { flex: 1 },
    list: { maxHeight: 360 },
    listContent: { gap: 2, paddingVertical: 4 },
    spinner: { marginVertical: 20 },
    emptyText: {
      fontSize: 13,
      color: theme.subtext,
      fontFamily: theme.fonts.body,
      paddingVertical: 20,
      textAlign: 'center',
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      paddingVertical: 9,
      paddingHorizontal: 6,
      borderRadius: theme.radius.sm,
    },
    rowSelected: { backgroundColor: theme.accentSoft },
    checkbox: {
      width: 16,
      height: 16,
      borderRadius: 4,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
    },
    checkboxActive: { backgroundColor: theme.accent, borderColor: theme.accent },
    rowBody: { flex: 1, gap: 1 },
    rowIdentity: { fontSize: 13, fontFamily: theme.fonts.bodySemibold, color: theme.text },
    rowTitle: { fontSize: 12, fontFamily: theme.fonts.body, color: theme.subtext },
    actions: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 10,
    },
    selectionCount: { fontSize: 12, color: theme.faint, fontFamily: theme.fonts.body },
  });
}
