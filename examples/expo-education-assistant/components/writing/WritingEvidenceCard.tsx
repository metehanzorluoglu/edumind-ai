import type { DocumentHighlight, MappedSource } from 'education-assistant-client';
import { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { AddToNotebookPicker } from '@/components/documents/AddToNotebookPicker';
import { Notice } from '@/components/ui/Notice';
import { useClient } from '@/lib/ClientProvider';
import { copyToClipboard } from '@/lib/clipboard';
import { formatAuthorsCompact, safeText } from '@/lib/format';
import { useTheme, type Theme } from '@/lib/Preferences';

const COPY_FEEDBACK_MS = 1500;

export interface WritingEvidenceCardProps {
  source: MappedSource;
  /** Whether this evidence's document is already a reference in the
   * CURRENT Writing Project — decides which single citation action shows
   * (Part 8: "Insert citation" for documents already in project
   * references"; Part 7: "Add reference" for evidence not yet one" —
   * never both at once, and never a fabricated citation key when the
   * document isn't a reference yet). */
  isProjectReference: boolean;
  highlighted?: boolean;
  /** Part 6 — opens the Reader at this evidence's page/chunk. Reader
   * remains canonical; this card never renders its own document view. */
  onOpenSource: (source: MappedSource) => void;
  /** Part 7 — explicit "Add reference", using the project's existing
   * reference system. Never called automatically. */
  onAddReference: (documentId: string) => Promise<void>;
  /** Part 8 — resolves the document's REAL, already-assigned citation
   * key and inserts `\cite{key}` at the manuscript cursor. Never invents
   * a key here — see writing/[id].tsx's handleInsertCitationForDocument,
   * which this always delegates to. */
  onInsertCitation: (documentId: string) => Promise<void>;
}

/**
 * Milestone 5.2 Part 5/6/7/8/9/10 — one piece of retrieved evidence
 * inside the Writing workspace's Ask EduM8 panel: document identity,
 * author/year, page, and the ACTUAL retrieved excerpt (never a
 * paraphrase), plus the deterministic evidence actions. Deliberately a
 * new, Writing-specific component rather than reusing chat's SourceCard
 * directly — SourceCard's actions (copy excerpt, copy formatted
 * citation) don't cover Writing's manuscript-mutation actions (Add
 * reference / Insert citation / Add to notebook), which must never be
 * available from ordinary chat. Both share the same underlying data
 * shape (MappedSource, via the SDK's mapSourcesToCitations) and the same
 * "never fabricate metadata" discipline — see the Citation Integrity
 * tests this card's actions are covered by.
 */
export function WritingEvidenceCard({
  source,
  isProjectReference,
  highlighted = false,
  onOpenSource,
  onAddReference,
  onInsertCitation,
}: WritingEvidenceCardProps) {
  const theme = useTheme();
  const styles = useMemo(() => buildStyles(theme), [theme]);
  const { client } = useClient();
  const { citation, chunk } = source;

  const [copied, setCopied] = useState(false);
  const [addingReference, setAddingReference] = useState(false);
  const [addReferenceError, setAddReferenceError] = useState<string | null>(null);
  const [insertingCitation, setInsertingCitation] = useState(false);
  const [insertCitationError, setInsertCitationError] = useState<string | null>(null);
  const [savingHighlight, setSavingHighlight] = useState(false);
  const [saveHighlightError, setSaveHighlightError] = useState<string | null>(null);
  const [notebookHighlight, setNotebookHighlight] = useState<DocumentHighlight | null>(null);

  const excerpt = safeText(chunk.text, '(no excerpt available)');
  const pageLabel = citation.page_start ? `Page ${citation.page_start}` : null;

  async function handleCopyExcerpt(): Promise<void> {
    const ok = await copyToClipboard(excerpt);
    if (!ok) return;
    setCopied(true);
    setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
  }

  async function handleAddReference(): Promise<void> {
    if (!citation.document_id || addingReference) return;
    setAddingReference(true);
    setAddReferenceError(null);
    try {
      await onAddReference(citation.document_id);
    } catch (error) {
      setAddReferenceError(
        error instanceof Error ? error.message : 'Could not add this reference.'
      );
    } finally {
      setAddingReference(false);
    }
  }

  async function handleInsertCitation(): Promise<void> {
    if (!citation.document_id || insertingCitation) return;
    setInsertingCitation(true);
    setInsertCitationError(null);
    try {
      await onInsertCitation(citation.document_id);
    } catch (error) {
      setInsertCitationError(
        error instanceof Error ? error.message : 'Could not resolve a citation key.'
      );
    } finally {
      setInsertingCitation(false);
    }
  }

  // Part 9/10 — "Add to notebook" for evidence that isn't yet a saved
  // Highlight: first creates a REAL highlight anchored to this exact
  // chunk (backend-validated against the document's actual content —
  // never a fabricated anchor), then hands it to the EXISTING
  // AddToNotebookPicker, reusing 100% of the Notebook's own UI (Part 10:
  // "Do NOT create a second Writing-specific notes database").
  async function handleAddToNotebook(): Promise<void> {
    if (!citation.document_id || savingHighlight) return;
    setSavingHighlight(true);
    setSaveHighlightError(null);
    try {
      const highlight = await client.createDocumentHighlight(citation.document_id, {
        chunkId: chunk.chunk_id,
        chunkIndex: chunk.chunk_index,
        pageNumber: chunk.page_number,
        selectedText: chunk.text,
      });
      setNotebookHighlight(highlight);
    } catch (error) {
      setSaveHighlightError(
        error instanceof Error ? error.message : 'Could not save this evidence.'
      );
    } finally {
      setSavingHighlight(false);
    }
  }

  return (
    <View
      style={[
        styles.card,
        highlighted && { borderColor: theme.citation, backgroundColor: theme.citationSoft },
      ]}
    >
      <View style={styles.headerRow}>
        <Text style={styles.sourceId}>[{source.sourceId}]</Text>
        {isProjectReference && (
          <View style={styles.referenceBadge}>
            <Text style={styles.referenceBadgeText}>Project reference</Text>
          </View>
        )}
      </View>
      <Text style={styles.title}>{safeText(citation.title, 'Untitled source')}</Text>
      <Text style={styles.meta}>
        {formatAuthorsCompact(citation.authors)}
        {citation.publication_year ? ` · ${citation.publication_year}` : ''}
      </Text>
      {pageLabel && <Text style={styles.meta}>{pageLabel}</Text>}

      <Text style={styles.excerpt} selectable>
        {excerpt}
      </Text>

      {addReferenceError && <Notice tone="danger" body={addReferenceError} />}
      {insertCitationError && <Notice tone="danger" body={insertCitationError} />}
      {saveHighlightError && <Notice tone="danger" body={saveHighlightError} />}

      <View style={styles.actionsRow}>
        <Pressable
          onPress={() => onOpenSource(source)}
          style={styles.actionButton}
          accessibilityRole="button"
          hitSlop={8}
        >
          <Text style={styles.actionText}>Open source</Text>
        </Pressable>
        <Pressable
          onPress={() => void handleCopyExcerpt()}
          style={styles.actionButton}
          accessibilityRole="button"
          hitSlop={8}
        >
          <Text style={styles.actionText}>{copied ? 'Copied!' : 'Copy excerpt'}</Text>
        </Pressable>
        {citation.document_id && (
          <Pressable
            onPress={() => void handleAddToNotebook()}
            style={styles.actionButton}
            accessibilityRole="button"
            hitSlop={8}
            disabled={savingHighlight}
          >
            {savingHighlight ? (
              <ActivityIndicator size="small" color={theme.accent} />
            ) : (
              <Text style={styles.actionText}>Add to notebook</Text>
            )}
          </Pressable>
        )}
        {citation.document_id && !isProjectReference && (
          <Pressable
            onPress={() => void handleAddReference()}
            style={styles.actionButton}
            accessibilityRole="button"
            hitSlop={8}
            disabled={addingReference}
          >
            {addingReference ? (
              <ActivityIndicator size="small" color={theme.accent} />
            ) : (
              <Text style={styles.actionText}>Add reference</Text>
            )}
          </Pressable>
        )}
        {citation.document_id && isProjectReference && (
          <Pressable
            onPress={() => void handleInsertCitation()}
            style={styles.actionButton}
            accessibilityRole="button"
            hitSlop={8}
            disabled={insertingCitation}
          >
            {insertingCitation ? (
              <ActivityIndicator size="small" color={theme.accent} />
            ) : (
              <Text style={styles.actionText}>Insert citation</Text>
            )}
          </Pressable>
        )}
      </View>

      {notebookHighlight && citation.document_id && (
        <AddToNotebookPicker
          client={client}
          documentId={citation.document_id}
          highlight={notebookHighlight}
          onClose={() => setNotebookHighlight(null)}
        />
      )}
    </View>
  );
}

function buildStyles(theme: Theme) {
  return StyleSheet.create({
    card: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      backgroundColor: theme.card,
      borderRadius: theme.radius.md,
      padding: 12,
      marginBottom: 8,
      gap: 3,
    },
    headerRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 2 },
    sourceId: { fontSize: 12, color: theme.citation, fontFamily: theme.fonts.bodyBold },
    referenceBadge: {
      backgroundColor: theme.accentSoft,
      borderRadius: theme.radius.sm,
      paddingHorizontal: 6,
      paddingVertical: 2,
    },
    referenceBadgeText: {
      fontSize: 10,
      color: theme.accent,
      fontFamily: theme.fonts.bodyBold,
      textTransform: 'uppercase',
      letterSpacing: 0.3,
    },
    title: { fontSize: 14, fontFamily: theme.fonts.bodySemibold, color: theme.text },
    meta: { fontSize: 12, fontFamily: theme.fonts.body, color: theme.subtext },
    excerpt: {
      fontSize: 13,
      lineHeight: 19,
      color: theme.text,
      fontFamily: theme.fonts.body,
      marginTop: 4,
      marginBottom: 4,
    },
    actionsRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      alignItems: 'center',
      gap: 14,
      marginTop: 4,
    },
    actionButton: { paddingVertical: 2 },
    actionText: { fontSize: 12.5, color: theme.accent, fontFamily: theme.fonts.bodySemibold },
  });
}
