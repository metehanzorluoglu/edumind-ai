import type {
  WritingProjectReference,
  WritingProjectReferenceMode,
} from 'education-assistant-client';
import { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Notice } from '@/components/ui/Notice';
import { TextField } from '@/components/ui/TextField';
import { formatSourceIdentity } from '@/lib/format';
import { useTheme, type Theme } from '@/lib/Preferences';
import { ReferenceModeCard } from './ReferenceModeCard';

export interface ReferencesPanelProps {
  references: WritingProjectReference[];
  missingCitationKeys: string[];
  loading: boolean;
  loadError: string | null;
  onAddReferences: () => void;
  /** Inserts `\cite{key}` at the editor's cursor — Part 9. Mode-agnostic:
   * `\cite{}` resolves against whatever bibliography mechanism the
   * project's root document actually uses, so the SAME insertion path
   * is reused for an EduM8 canonical key, a real imported-.bib key, or
   * a `\bibitem` key — see referenceMode.citation_key_source below for
   * which one `key` actually came from. */
  onInsertCitation: (citationKey: string) => void;
  /** Inserts `\cite{KeyOne,KeyTwo,...}` in the exact order the caller
   * selected them — Part 10. */
  onInsertMultipleCitations: (citationKeys: string[]) => void;
  onRemoveReference: (documentId: string) => Promise<void>;
  onViewBibliography: () => void;
  /** Milestone 5.5 Part 15 — opens the Reader for this reference's
   * document (the Reader remains canonical — never a second document
   * viewer here). */
  onOpenSource: (documentId: string) => void;
  /** Bibliography Source Detection — how this project ACTUALLY manages
   * its citations/references (rag-backend's app/core/reference_mode.py),
   * null while still loading. */
  referenceMode: WritingProjectReferenceMode | null;
  /** Applies EXACTLY referenceMode's current edum8_switch_proposal —
   * see ReferenceModeCard's own docstring. */
  onSwitchToEdum8: () => Promise<unknown>;
}

/**
 * Milestone 5 (Academic Writing & LaTeX Foundation) Parts 4/5/9/10/12/27,
 * extended by 5.5 Part 15 — the References panel: current project
 * references with a compact identity, search, single/multi
 * "Insert citation", "Open source", "Remove" (association only — Part
 * 5), a missing-citation-key warning (Part 26), and "View BibTeX" (Part
 * 13). Extended by Bibliography Source Detection with a mode card
 * (ReferenceModeCard) explaining this project's ACTUAL bibliography
 * setup, and — for a project whose real bibliography ISN'T EduM8's own
 * library (imported_bib/template_tex/inline_template) — a "Bibliography
 * entries" list sourced from the deterministically-parsed real keys,
 * so citation insertion still works for those projects too (never
 * gated behind first connecting EduM8 references).
 */
export function ReferencesPanel({
  references,
  missingCitationKeys,
  loading,
  loadError,
  onAddReferences,
  onInsertCitation,
  onInsertMultipleCitations,
  onRemoveReference,
  onViewBibliography,
  onOpenSource,
  referenceMode,
  onSwitchToEdum8,
}: ReferencesPanelProps) {
  const theme = useTheme();
  const styles = useMemo(() => buildStyles(theme), [theme]);
  const [selectMode, setSelectMode] = useState(false);
  // Order of selection (not list order) — Part 10's "deterministic
  // selection order" requirement.
  const [selectedOrder, setSelectedOrder] = useState<string[]>([]);
  const [removingIds, setRemovingIds] = useState<Set<string>>(new Set());
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [searchText, setSearchText] = useState('');

  const visibleReferences = useMemo(() => {
    const needle = searchText.trim().toLowerCase();
    if (!needle) return references;
    return references.filter((ref) => {
      const haystack = [ref.title, ref.source_filename, ref.citation_key, ...(ref.authors ?? [])]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(needle);
    });
  }, [references, searchText]);

  function exitSelectMode(): void {
    setSelectMode(false);
    setSelectedOrder([]);
  }

  function toggleSelected(documentId: string): void {
    setSelectedOrder((prev) =>
      prev.includes(documentId) ? prev.filter((id) => id !== documentId) : [...prev, documentId]
    );
  }

  async function handleRemove(documentId: string): Promise<void> {
    setRemoveError(null);
    setRemovingIds((prev) => new Set(prev).add(documentId));
    try {
      await onRemoveReference(documentId);
    } catch (error) {
      setRemoveError(error instanceof Error ? error.message : 'Could not remove this reference.');
    } finally {
      setRemovingIds((prev) => {
        const next = new Set(prev);
        next.delete(documentId);
        return next;
      });
    }
  }

  function handleInsertSelected(): void {
    const keys = selectedOrder
      .map((id) => references.find((r) => r.document_id === id)?.citation_key)
      .filter((key): key is string => Boolean(key));
    if (keys.length === 0) return;
    onInsertMultipleCitations(keys);
    exitSelectMode();
  }

  const showBibliographyEntries =
    referenceMode !== null &&
    referenceMode.mode !== 'edum8_library' &&
    referenceMode.keys.length > 0;

  return (
    <View style={styles.container}>
      {/* M5.5.3 final acceptance — real reproduction with the 13-entry
          Springer Nature bibliography: this ScrollView previously
          wrapped ONLY the project-references list at the bottom
          (visibleReferences.map below); ReferenceModeCard and the
          "Bibliography entries" list — the actual content a project
          in imported_bib/template_tex/inline_template mode has, and
          exactly what was unreachable in the real repro — sat OUTSIDE
          it as un-scrolled siblings, so they simply grew the whole
          container's height past the viewport with nothing to clip or
          scroll it. Everything now shares ONE scroll region — mode
          card, bibliography entries, toolbar, search, View BibTeX,
          the unresolved-citations warning, the selection bar, and the
          project-references list — matching what the spec's own
          worked layout and the "must be able to scroll to reach: ...
          Add / Select controls" requirement both call for. */}
      <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
        <ReferenceModeCard referenceMode={referenceMode} onSwitchToEdum8={onSwitchToEdum8} />

        {showBibliographyEntries && referenceMode && (
          <View style={styles.bibEntriesSection}>
            <Text style={styles.bibEntriesLabel}>
              Bibliography entries ({referenceMode.keys.length})
            </Text>
            <View style={styles.bibEntriesList}>
              {referenceMode.keys.map((entry) => (
                <View key={entry.key} style={styles.bibEntryRow}>
                  <View style={styles.bibEntryBody}>
                    <Text style={styles.bibEntryTitle} numberOfLines={1}>
                      {entry.title ?? entry.key}
                    </Text>
                    <Text style={styles.bibEntryKey} numberOfLines={1}>
                      {entry.key}
                    </Text>
                  </View>
                  <Pressable
                    onPress={() => onInsertCitation(entry.key)}
                    accessibilityRole="button"
                    accessibilityLabel={`Insert citation for ${entry.title ?? entry.key}`}
                    hitSlop={6}
                  >
                    <Text style={styles.actionText}>Insert citation</Text>
                  </Pressable>
                </View>
              ))}
            </View>
          </View>
        )}

        <View style={styles.toolbar}>
          <Text style={styles.count}>
            {references.length} {references.length === 1 ? 'reference' : 'references'}
          </Text>
          <View style={styles.toolbarActions}>
            <Button label="+ Add" variant="secondary" size="sm" onPress={onAddReferences} />
            <Button
              label={selectMode ? 'Cancel' : 'Select'}
              variant="ghost"
              size="sm"
              disabled={references.length === 0}
              onPress={() => (selectMode ? exitSelectMode() : setSelectMode(true))}
            />
          </View>
        </View>

        {references.length > 0 && (
          <TextField
            label="Search references"
            value={searchText}
            onChangeText={setSearchText}
            placeholder="Search title, author, or filename…"
          />
        )}

        {references.length > 0 && (
          <Button
            label="View BibTeX"
            variant="ghost"
            size="sm"
            onPress={onViewBibliography}
            style={styles.bibtexButton}
          />
        )}

        {missingCitationKeys.length > 0 && (
          <Notice
            tone="warning"
            title="Unresolved citations"
            body={missingCitationKeys
              .map((key) => `Citation key '${key}' is not in this project's references.`)
              .join('\n')}
          />
        )}
        {removeError && <Notice tone="danger" body={removeError} />}

        {selectMode && (
          <View style={styles.selectionBar}>
            <Text style={styles.selectionText}>{selectedOrder.length} selected</Text>
            <Button
              label="Insert citations"
              variant="primary"
              size="sm"
              disabled={selectedOrder.length === 0}
              onPress={handleInsertSelected}
            />
          </View>
        )}

        {loading && <ActivityIndicator color={theme.accent} style={styles.spinner} />}
        {!loading && loadError && <Notice tone="danger" body={loadError} />}
        {!loading && !loadError && references.length === 0 && (
          <EmptyState
            title="No references yet."
            description="Add documents from your library to build this manuscript's bibliography."
            actionLabel="+ Add references"
            onAction={onAddReferences}
          />
        )}
        {!loading && !loadError && references.length > 0 && visibleReferences.length === 0 && (
          <Text style={styles.emptyText}>No references match “{searchText.trim()}”.</Text>
        )}
        {!loading &&
          !loadError &&
          visibleReferences.map((ref) => {
            const selected = selectedOrder.includes(ref.document_id);
            const identity = formatSourceIdentity(ref.authors, ref.publication_year, ref.title);
            return (
              <Pressable
                key={ref.document_id}
                onPress={selectMode ? () => toggleSelected(ref.document_id) : undefined}
                accessibilityRole={selectMode ? 'checkbox' : undefined}
                accessibilityState={selectMode ? { checked: selected } : undefined}
                accessibilityLabel={selectMode ? `Select ${identity}` : undefined}
                style={[styles.row, selectMode && selected && styles.rowSelected]}
              >
                {selectMode && (
                  <View style={[styles.checkbox, selected && styles.checkboxActive]} />
                )}
                <View style={styles.rowBody}>
                  <View style={styles.rowHeader}>
                    <Text style={styles.rowIdentity} numberOfLines={1}>
                      {identity}
                    </Text>
                    <Badge
                      label={ref.cited ? 'Cited' : 'Not cited'}
                      tone={ref.cited ? 'citation' : 'neutral'}
                    />
                  </View>
                  <Text style={styles.rowTitle} numberOfLines={1}>
                    {ref.title ?? ref.source_filename}
                  </Text>
                  {!selectMode && (
                    <View style={styles.actionsRow}>
                      <Pressable
                        onPress={() => ref.citation_key && onInsertCitation(ref.citation_key)}
                        disabled={!ref.citation_key}
                        accessibilityRole="button"
                        accessibilityLabel={`Insert citation for ${identity}`}
                        hitSlop={6}
                      >
                        <Text
                          style={ref.citation_key ? styles.actionText : styles.actionTextDisabled}
                        >
                          Insert citation
                        </Text>
                      </Pressable>
                      <Pressable
                        onPress={() => onOpenSource(ref.document_id)}
                        accessibilityRole="button"
                        accessibilityLabel={`Open source for ${identity}`}
                        hitSlop={6}
                      >
                        <Text style={styles.actionText}>Open source</Text>
                      </Pressable>
                      <Pressable
                        onPress={() => void handleRemove(ref.document_id)}
                        disabled={removingIds.has(ref.document_id)}
                        accessibilityRole="button"
                        accessibilityLabel={`Remove ${identity} from this project`}
                        hitSlop={6}
                      >
                        <Text style={styles.removeText}>
                          {removingIds.has(ref.document_id) ? 'Removing…' : 'Remove'}
                        </Text>
                      </Pressable>
                    </View>
                  )}
                </View>
              </Pressable>
            );
          })}
      </ScrollView>
    </View>
  );
}

function buildStyles(theme: Theme) {
  return StyleSheet.create({
    // M5.5.3 final acceptance — minHeight: 0 on BOTH this and `list`
    // below is load-bearing, not decorative: without it this panel's
    // own ScrollView (list) never actually gets a bounded height to
    // scroll within — it just grows to fit all content, same root
    // cause as [id].tsx's own panelBodyPadded fix this pairs with.
    container: { flex: 1, minHeight: 0, gap: 10 },
    bibEntriesSection: { gap: 6 },
    bibEntriesLabel: { fontSize: 12, fontFamily: theme.fonts.bodySemibold, color: theme.faint },
    bibEntriesList: { gap: 2 },
    bibEntryRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingVertical: 8,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.border,
    },
    bibEntryBody: { flex: 1, gap: 1 },
    bibEntryTitle: { fontSize: 13, fontFamily: theme.fonts.body, color: theme.text },
    bibEntryKey: { fontSize: 11, fontFamily: theme.fonts.mono, color: theme.faint },
    toolbar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    count: { fontSize: 12, fontFamily: theme.fonts.bodySemibold, color: theme.faint },
    toolbarActions: { flexDirection: 'row', gap: 6 },
    bibtexButton: { alignSelf: 'flex-start' },
    selectionBar: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 10,
      backgroundColor: theme.accentSoft,
      borderRadius: theme.radius.md,
      paddingHorizontal: 12,
      paddingVertical: 8,
    },
    selectionText: { fontSize: 12, fontFamily: theme.fonts.bodySemibold, color: theme.accent },
    list: { flex: 1, minHeight: 0 },
    listContent: { gap: 2, paddingBottom: 12 },
    emptyText: {
      fontSize: 13,
      color: theme.subtext,
      fontFamily: theme.fonts.body,
      paddingVertical: 20,
      textAlign: 'center',
    },
    spinner: { marginTop: 20 },
    row: {
      flexDirection: 'row',
      gap: 8,
      paddingVertical: 10,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.border,
    },
    rowSelected: { backgroundColor: theme.accentSoft, borderRadius: theme.radius.sm },
    checkbox: {
      width: 16,
      height: 16,
      marginTop: 3,
      borderRadius: 4,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
    },
    checkboxActive: { backgroundColor: theme.accent, borderColor: theme.accent },
    rowBody: { flex: 1, gap: 3 },
    rowHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 6,
    },
    rowIdentity: { flex: 1, fontSize: 13, fontFamily: theme.fonts.bodySemibold, color: theme.text },
    rowTitle: { fontSize: 12, fontFamily: theme.fonts.body, color: theme.subtext },
    actionsRow: { flexDirection: 'row', gap: 14, marginTop: 2 },
    actionText: { fontSize: 12, fontFamily: theme.fonts.bodySemibold, color: theme.accent },
    actionTextDisabled: { fontSize: 12, fontFamily: theme.fonts.body, color: theme.faint },
    removeText: { fontSize: 12, fontFamily: theme.fonts.bodySemibold, color: theme.danger },
  });
}
