import {
  displaySourceFromRetrievedChunk,
  mapSourcesToCitations,
  splitAnswerIntoSegments,
  type DisplaySource,
  type NotebookEntry,
  type RetrievedChunk,
} from 'education-assistant-client';
import { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { CloseIcon } from '@/components/icons';
import { MarkdownAnswer } from '@/components/MarkdownAnswer';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Notice } from '@/components/ui/Notice';
import { TextField } from '@/components/ui/TextField';
import { ReferencePickerModal } from '@/components/writing/ReferencePickerModal';
import { ResearchNotesPickerModal } from '@/components/writing/ResearchNotesPickerModal';
import { WritingEvidenceCard } from '@/components/writing/WritingEvidenceCard';
import { useClient } from '@/lib/ClientProvider';
import { useTheme, type Theme } from '@/lib/Preferences';
import { type TransientAIContextEntry } from '@/lib/transientAIContext';
import { type WritingAskScopeKind, type WritingAskTurn, useWritingAsk } from '@/lib/useWritingAsk';

const SCOPE_TABS: { kind: WritingAskScopeKind; label: string }[] = [
  { kind: 'project-references', label: 'Project references' },
  { kind: 'selected-sources', label: 'Selected sources' },
  { kind: 'research-notes', label: 'Research notes' },
];

function toRetrievedChunk(source: DisplaySource): RetrievedChunk {
  return { ...source, document_id: source.document_id ?? '' };
}

export interface AskEduM8PanelProps {
  visible: boolean;
  onClose: () => void;
  /** The Writing Project's CURRENT reference document_ids — owned by the
   * caller's already-loaded referencesState (Part 16: no second parallel
   * fetch). Backs both the default "Project references" scope and the
   * "already a reference" badge/action split on each evidence card. */
  projectReferenceDocumentIds: string[];
  /** The editor's CURRENT text selection, or '' when nothing is
   * selected — read fresh from the parent on every render so the
   * manuscript-context checkbox always reflects what's actually
   * selected right now (Part 3). */
  manuscriptSelectionText: string;
  onOpenSource: (source: DisplaySource) => void;
  onAddReference: (documentId: string) => Promise<void>;
  onInsertCitation: (documentId: string) => Promise<void>;
}

/**
 * Milestone 5.2 Part 2/11/12 — "Ask EduM8" inside the Writing workspace: a
 * dismissible panel (never a giant permanent third column — Part 11) with
 * an always-visible research-context indicator (Part 12), an explicit
 * scope selector (Part 4), evidence-first answers (Part 5), and the
 * deterministic evidence actions (Parts 6-10) via WritingEvidenceCard.
 * Every manuscript mutation those actions trigger is the ONLY way this
 * panel ever touches the manuscript — the AI response itself never does
 * (Part 14).
 */
export function AskEduM8Panel({
  visible,
  onClose,
  projectReferenceDocumentIds,
  manuscriptSelectionText,
  onOpenSource,
  onAddReference,
  onInsertCitation,
}: AskEduM8PanelProps) {
  const theme = useTheme();
  const styles = useMemo(() => buildStyles(theme), [theme]);
  const { client } = useClient();
  const ask = useWritingAsk(client, projectReferenceDocumentIds);

  const [question, setQuestion] = useState('');
  const [includeManuscriptSelection, setIncludeManuscriptSelection] = useState(true);
  const [sourcePickerOpen, setSourcePickerOpen] = useState(false);
  const [notesPickerOpen, setNotesPickerOpen] = useState(false);

  const referenceIdSet = useMemo(
    () => new Set(projectReferenceDocumentIds),
    [projectReferenceDocumentIds]
  );

  const hasManuscriptSelection = manuscriptSelectionText.trim().length > 0;

  function handleAsk(): void {
    const manuscriptEntry: TransientAIContextEntry | null =
      hasManuscriptSelection && includeManuscriptSelection
        ? {
            sourceType: 'manuscript-selection',
            documentId: null,
            documentTitle: null,
            pageNumber: null,
            excerpt: manuscriptSelectionText.trim(),
          }
        : null;
    void ask.ask(question, manuscriptEntry).then(() => setQuestion(''));
  }

  if (!visible) return null;

  return (
    <View style={styles.panel} testID="ask-edum8-panel">
      <View style={styles.header}>
        <Text style={styles.title}>Ask EduM8</Text>
        <IconButton
          label="Close Ask EduM8"
          icon={<CloseIcon size={16} color={theme.faint} />}
          size="sm"
          onPress={onClose}
        />
      </View>

      <View style={styles.contextBlock}>
        <Text style={styles.contextHeading}>Research context</Text>
        <Text style={styles.contextLabel}>{ask.scopeLabel}</Text>
        <View style={styles.scopeTabs}>
          {SCOPE_TABS.map((tab) => (
            <Pressable
              key={tab.kind}
              onPress={() => {
                if (tab.kind === 'project-references') ask.setProjectReferencesScope();
                else if (tab.kind === 'selected-sources') setSourcePickerOpen(true);
                else setNotesPickerOpen(true);
              }}
              accessibilityRole="button"
              accessibilityState={{ selected: ask.scopeKind === tab.kind }}
              style={[styles.scopeTab, ask.scopeKind === tab.kind && styles.scopeTabActive]}
            >
              <Text
                style={[
                  styles.scopeTabText,
                  ask.scopeKind === tab.kind && styles.scopeTabTextActive,
                ]}
              >
                {tab.label}
              </Text>
            </Pressable>
          ))}
        </View>
        {!ask.canAsk && (
          <Text style={styles.scopeWarning}>
            {ask.scopeKind === 'project-references'
              ? 'This project has no references yet — add one, or switch scope.'
              : ask.scopeKind === 'selected-sources'
                ? 'Choose at least one source above.'
                : 'Choose at least one research note above.'}
          </Text>
        )}
      </View>

      <ScrollView style={styles.turns} contentContainerStyle={styles.turnsContent}>
        {ask.turns.map((turn) => (
          <AskTurnView
            key={turn.id}
            turn={turn}
            referenceIdSet={referenceIdSet}
            onOpenSource={onOpenSource}
            onAddReference={onAddReference}
            onInsertCitation={onInsertCitation}
          />
        ))}
      </ScrollView>

      <View style={styles.composer}>
        {hasManuscriptSelection && (
          <Pressable
            onPress={() => setIncludeManuscriptSelection((v) => !v)}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: includeManuscriptSelection }}
            style={styles.selectionChip}
          >
            <View style={[styles.checkbox, includeManuscriptSelection && styles.checkboxActive]} />
            <View style={styles.selectionChipText}>
              <Text style={styles.selectionChipLabel}>Include selected manuscript passage</Text>
              <Text style={styles.selectionChipExcerpt} numberOfLines={2}>
                “{manuscriptSelectionText.trim()}”
              </Text>
            </View>
          </Pressable>
        )}
        <TextField
          label="Ask a question"
          value={question}
          onChangeText={setQuestion}
          placeholder="e.g. What evidence supports this claim?"
          editable={!ask.asking}
          onSubmitEditing={handleAsk}
          returnKeyType="send"
        />
        <Button
          label={ask.asking ? 'Asking…' : 'Ask'}
          variant="primary"
          size="sm"
          loading={ask.asking}
          disabled={!ask.canAsk || !question.trim() || ask.asking}
          onPress={handleAsk}
        />
      </View>

      <ReferencePickerModal
        visible={sourcePickerOpen}
        existingDocumentIds={new Set()}
        title="Select sources for Ask EduM8"
        confirmLabelSingular="Use this source"
        confirmLabelPlural={(n) => `Use these ${n} sources`}
        onAdd={(documentIds) => {
          ask.setSelectedSourcesScope(documentIds);
          return Promise.resolve();
        }}
        onClose={() => setSourcePickerOpen(false)}
      />
      <ResearchNotesPickerModal
        visible={notesPickerOpen}
        onUse={(entries: NotebookEntry[]) => ask.setResearchNotesScope(entries)}
        onClose={() => setNotesPickerOpen(false)}
      />
    </View>
  );
}

function AskTurnView({
  turn,
  referenceIdSet,
  onOpenSource,
  onAddReference,
  onInsertCitation,
}: {
  turn: WritingAskTurn;
  referenceIdSet: Set<string>;
  onOpenSource: (source: DisplaySource) => void;
  onAddReference: (documentId: string) => Promise<void>;
  onInsertCitation: (documentId: string) => Promise<void>;
}) {
  const theme = useTheme();
  const styles = useMemo(() => buildStyles(theme), [theme]);

  const chunks = turn.sources.map(toRetrievedChunk);
  const mapped = mapSourcesToCitations(chunks, turn.citations);
  const segments = turn.answer ? splitAnswerIntoSegments(turn.answer, turn.citations) : [];
  const citedSourceIds = new Set(
    segments.flatMap((segment) => (segment.type === 'citation' ? [segment.match.sourceId] : []))
  );
  const citedSources = mapped.filter((source) => citedSourceIds.has(source.sourceId));

  return (
    <View style={styles.turn}>
      <Text style={styles.question}>{turn.question}</Text>
      <Text style={styles.turnScope}>Asked using: {turn.scopeLabel}</Text>

      {turn.status === 'sending' && (
        <ActivityIndicator color={theme.accent} style={styles.spinner} />
      )}
      {turn.status === 'error' && turn.errorMessage && (
        <Notice tone="danger" body={turn.errorMessage} />
      )}
      {turn.status === 'success' && turn.insufficientEvidence && (
        <Notice
          tone="neutral"
          body={`I couldn't find strong support for this in ${turn.scopeLabel}. Try selecting different sources, or add more project references.`}
        />
      )}
      {turn.status === 'success' && !turn.insufficientEvidence && turn.answer && (
        <MarkdownAnswer
          answer={turn.answer}
          citations={turn.citations}
          onCitationPress={() => {}}
        />
      )}

      {citedSources.length > 0 && (
        <View style={styles.evidenceSection}>
          <Text style={styles.evidenceHeading}>Evidence</Text>
          {citedSources.map((source) => (
            <WritingEvidenceCard
              key={source.sourceId}
              source={source}
              isProjectReference={
                !!source.citation.document_id && referenceIdSet.has(source.citation.document_id)
              }
              onOpenSource={() => {
                // Guarded by the same join key mapSourcesToCitations used
                // to produce this MappedSource in the first place — a
                // successful join means chunk.document_id (coerced from
                // DisplaySource by toRetrievedChunk above) is a real,
                // non-empty id equal to citation.document_id, never a
                // fabricated one (Part 18: citation provenance).
                if (!source.citation.document_id) return;
                onOpenSource(displaySourceFromRetrievedChunk(source.chunk));
              }}
              onAddReference={onAddReference}
              onInsertCitation={onInsertCitation}
            />
          ))}
        </View>
      )}
    </View>
  );
}

function buildStyles(theme: Theme) {
  return StyleSheet.create({
    panel: {
      width: 380,
      maxWidth: '100%',
      borderLeftWidth: StyleSheet.hairlineWidth,
      borderLeftColor: theme.border,
      backgroundColor: theme.background,
      flex: 1,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.border,
    },
    title: { fontSize: 15, fontFamily: theme.fonts.display, color: theme.text },
    contextBlock: {
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.border,
      gap: 6,
    },
    contextHeading: {
      fontSize: 10.5,
      fontFamily: theme.fonts.bodySemibold,
      color: theme.faint,
      textTransform: 'uppercase',
      letterSpacing: 0.4,
    },
    contextLabel: { fontSize: 13, fontFamily: theme.fonts.bodySemibold, color: theme.text },
    scopeTabs: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 4 },
    scopeTab: {
      paddingHorizontal: 10,
      paddingVertical: 5,
      borderRadius: theme.radius.sm,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
    },
    scopeTabActive: { backgroundColor: theme.accentSoft, borderColor: theme.accent },
    scopeTabText: { fontSize: 12, fontFamily: theme.fonts.body, color: theme.subtext },
    scopeTabTextActive: { color: theme.accent, fontFamily: theme.fonts.bodySemibold },
    scopeWarning: { fontSize: 12, color: theme.warning, fontFamily: theme.fonts.body },
    turns: { flex: 1 },
    turnsContent: { padding: 16, gap: 16 },
    turn: { gap: 6 },
    question: { fontSize: 13.5, fontFamily: theme.fonts.bodySemibold, color: theme.text },
    turnScope: { fontSize: 11, fontFamily: theme.fonts.body, color: theme.faint },
    spinner: { marginVertical: 12 },
    evidenceSection: { marginTop: 6, gap: 4 },
    evidenceHeading: {
      fontSize: 11,
      fontFamily: theme.fonts.bodySemibold,
      color: theme.faint,
      textTransform: 'uppercase',
      letterSpacing: 0.4,
      marginBottom: 2,
    },
    composer: {
      padding: 16,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.border,
      gap: 10,
    },
    selectionChip: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: 8,
      backgroundColor: theme.accentSoft,
      borderRadius: theme.radius.md,
      paddingVertical: 8,
      paddingHorizontal: 10,
    },
    checkbox: {
      width: 16,
      height: 16,
      borderRadius: 4,
      borderWidth: 1.5,
      borderColor: theme.border,
      marginTop: 2,
    },
    checkboxActive: { backgroundColor: theme.accent, borderColor: theme.accent },
    selectionChipText: { flex: 1, gap: 2 },
    selectionChipLabel: {
      fontSize: 10.5,
      fontFamily: theme.fonts.bodySemibold,
      color: theme.accent,
      textTransform: 'uppercase',
      letterSpacing: 0.3,
    },
    selectionChipExcerpt: {
      fontSize: 12.5,
      lineHeight: 17,
      color: theme.text,
      fontFamily: theme.fonts.body,
      fontStyle: 'italic',
    },
  });
}
