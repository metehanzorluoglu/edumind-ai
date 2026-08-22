import {
  displaySourceFromRetrievedChunk,
  mapSourcesToCitations,
  splitAnswerIntoSegments,
  thinkingContextForRequest,
  type DisplaySource,
  type NotebookEntry,
  type RetrievedChunk,
  type WritingContextSummary,
} from 'education-assistant-client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { CloseIcon } from '@/components/icons';
import { MarkdownAnswer } from '@/components/MarkdownAnswer';
import { ThinkingPlaceholder } from '@/components/ThinkingPlaceholder';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Notice } from '@/components/ui/Notice';
import { TextField } from '@/components/ui/TextField';
import { ReferencePickerModal } from '@/components/writing/ReferencePickerModal';
import { ResearchNotesPickerModal } from '@/components/writing/ResearchNotesPickerModal';
import { WritingEvidenceCard } from '@/components/writing/WritingEvidenceCard';
import { useTheme, type Theme } from '@/lib/Preferences';
import {
  type UseWritingAskResult,
  type WritingAskEditorContext,
  type WritingAskScopeKind,
  type WritingAskTurn,
} from '@/lib/useWritingAsk';

// Writing's requests are always text-only (no attachments) — so this is a
// fixed, not per-turn, context. Writing UX Refinement milestone, Blocker 2
// fix — no longer "always retrieval-backed": the currently open document
// alone is enough context to ask (see useWritingAsk's canAsk); a selected
// RAG scope is optional, additive evidence search on top of it.
const WRITING_THINKING_CONTEXT = thinkingContextForRequest({});

const SCOPE_TABS: { kind: WritingAskScopeKind; label: string }[] = [
  { kind: 'project-references', label: 'Project references' },
  { kind: 'selected-sources', label: 'Selected sources' },
  { kind: 'research-notes', label: 'Research notes' },
];

function toRetrievedChunk(source: DisplaySource): RetrievedChunk {
  return { ...source, document_id: source.document_id ?? '' };
}

/** Milestone 5.5 Part 4 — a truthful "Generating… Ns" line: a real
 * client-side clock ticking against a real start time, never a fabricated
 * percentage. Its own small component so the 1s tick only re-renders this
 * one line, not the whole turn (and its answer text mid-stream). */
function ElapsedIndicator({ startedAt }: { startedAt: number }) {
  const theme = useTheme();
  const styles = useMemo(() => buildStyles(theme), [theme]);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const seconds = Math.max(0, (now - startedAt) / 1000);
  return <Text style={styles.elapsedLabel}>Generating… {seconds.toFixed(0)}s</Text>;
}

/** Milestone 6.2 Parts 11/12 — the compact, honest, non-debug context
 * indicator: exactly what this turn's WritingContextPacket actually
 * included (see WritingContextSummary's own docstring), plus the real
 * RAG evidence count already carried on the turn (`turn.sources`, always
 * genuine retrieved evidence — reference-metadata items never appear
 * there, see WritingEvidenceCard/mapSourcesToCitations). Never says
 * "Evidence from a paper" for a metadata-only reference — that case
 * shows the separate, honestly-worded "Reference metadata" label
 * instead. Returns null (renders nothing) when there's genuinely
 * nothing to report, rather than forcing an empty indicator line. */
function writingContextIndicatorLabel(
  summary: WritingContextSummary | null,
  evidenceCount: number
): string | null {
  const parts: string[] = [];
  if (summary?.selection_included) parts.push('Current selection');
  if (summary?.section_included) parts.push('Current section');
  if (summary && summary.notes_included > 0) {
    parts.push(`${summary.notes_included} research note${summary.notes_included === 1 ? '' : 's'}`);
  }
  if (summary && summary.highlights_included > 0) {
    parts.push(
      `${summary.highlights_included} highlight${summary.highlights_included === 1 ? '' : 's'}`
    );
  }
  if (summary && summary.reference_metadata_included > 0) parts.push('Reference metadata');
  // Real RAG evidence (turn.sources) is tracked independently of the
  // writing_context_summary field's own presence (see this turn's own
  // `sources` SSE event) — a summary-less turn (e.g. a reconnect/replay
  // that couldn't reconstruct it, see _final_reply_events' docstring)
  // still honestly reports genuine evidence if there is any.
  if (evidenceCount > 0) {
    parts.push(`Evidence from ${evidenceCount} source${evidenceCount === 1 ? '' : 's'}`);
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

/** A short, honest "answered in Ns" caption — Part 4's "record time to
 * first token / time to completed answer" surfaced as a small transparency
 * note, not a prominent metric. */
function latencyCaption(
  startedAt: number,
  firstTokenAt: number | null,
  completedAt: number
): string {
  const totalSeconds = (completedAt - startedAt) / 1000;
  if (firstTokenAt === null) return `Answered in ${totalSeconds.toFixed(1)}s`;
  const firstTokenSeconds = (firstTokenAt - startedAt) / 1000;
  return `Answered in ${totalSeconds.toFixed(1)}s · first token ${firstTokenSeconds.toFixed(1)}s`;
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
   * selected right now (Part 3). Display-only in this panel; the actual
   * context sent to the model is built from the structured fields below
   * and reconstructed server-side by the M6.1 engine (Milestone 6.2
   * Part 2 — this string is never itself sent as/folded into the query
   * text anymore). */
  manuscriptSelectionText: string;
  /** Milestone 6.2 Part 3 — the current Writing project/file/selection
   * state, sent structured on every Ask so the M6.1 engine can build
   * (and validate) manuscript context server-side. `activeFileContent`
   * is the LIVE editor buffer (possibly unsaved) for `activeFileId` —
   * always sent so a question never has to wait for autosave (Part 21). */
  projectId: string;
  activeFileId: string | null;
  selectionStart: number;
  selectionEnd: number;
  activeFileContent: string;
  /** Writing UX Refinement milestone, Blocker 2 fix — true whenever an
   * editable text file is open, independent of `activeFileId` alone
   * (which can point at a non-text node). Drives the always-on "Current
   * document" context indicator below and, via useWritingAsk's
   * `hasCurrentDocument` param, whether Ask EduM8 stays usable with zero
   * project references. */
  hasCurrentDocument: boolean;
  /** Milestone 6.2 Part 10 — lifted up to the parent screen (was
   * previously instantiated internally via useWritingAsk()) so the
   * selection-aware quick-action bar next to the editor can share the
   * exact same turns/asking state and conversation as this panel. See
   * writing/[id].tsx's own comment on why this is still exactly as
   * durable as the old internal call (the parent never unmounts). */
  ask: UseWritingAskResult;
  onOpenSource: (source: DisplaySource) => void;
  onAddReference: (documentId: string) => Promise<void>;
  onInsertCitation: (documentId: string) => Promise<void>;
  /** Milestone 5.5 Part 6 — true when this is rendered as the "Ask
   * EduM8" tab of the unified desktop Research panel rather than its own
   * fixed-width right-side drawer: drops the own width/left-border
   * styling (the parent panel already owns both) since content should
   * simply fill whatever width the shared panel has. Mobile is
   * unaffected — it always mounts this full-width regardless. */
  embedded?: boolean;
}

/**
 * Milestone 5.2 Part 2/11/12, folded into the unified Research panel by
 * 5.5 Part 6 — "Ask EduM8" inside the Writing workspace: an always-visible
 * research-context indicator (Part 12), an explicit scope selector (Part
 * 4), evidence-first answers (Part 5), and the deterministic evidence
 * actions (Parts 6-10) via WritingEvidenceCard. Every manuscript mutation
 * those actions trigger is the ONLY way this panel ever touches the
 * manuscript — the AI response itself never does (Part 14).
 */
export function AskEduM8Panel({
  visible,
  onClose,
  projectReferenceDocumentIds,
  manuscriptSelectionText,
  projectId,
  activeFileId,
  selectionStart,
  selectionEnd,
  activeFileContent,
  hasCurrentDocument,
  ask,
  onOpenSource,
  onAddReference,
  onInsertCitation,
  embedded = false,
}: AskEduM8PanelProps) {
  const theme = useTheme();
  const styles = useMemo(() => buildStyles(theme), [theme]);

  const [question, setQuestion] = useState('');
  const [includeManuscriptSelection, setIncludeManuscriptSelection] = useState(true);
  const [sourcePickerOpen, setSourcePickerOpen] = useState(false);
  const [notesPickerOpen, setNotesPickerOpen] = useState(false);

  // Milestone 6.2 real-model validation — a real bug found and fixed
  // here: this ScrollView never auto-scrolled to the newest turn, so a
  // researcher asking a second (or third, ...) question had to manually
  // scroll down to see it — including a still-streaming answer, which
  // otherwise renders entirely off-screen below the fold. Keeps pinned
  // to the bottom as a new turn starts AND as its answer streams in
  // (mirrors ordinary chat-app behavior), via a lightweight "does the
  // latest turn's own rendered shape look different" signature rather
  // than a per-token effect dependency on `turns` itself.
  const turnsScrollRef = useRef<ScrollView>(null);
  const latestTurn = ask.turns[ask.turns.length - 1];
  const latestTurnSignature = latestTurn
    ? `${ask.turns.length}:${latestTurn.id}:${latestTurn.status}:${latestTurn.answer.length}:${latestTurn.sources.length}`
    : '0';
  useEffect(() => {
    if (!latestTurn) return;
    turnsScrollRef.current?.scrollToEnd({ animated: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latestTurnSignature]);

  const referenceIdSet = useMemo(
    () => new Set(projectReferenceDocumentIds),
    [projectReferenceDocumentIds]
  );

  const hasManuscriptSelection = manuscriptSelectionText.trim().length > 0;

  function handleAsk(): void {
    // Milestone 6.2 Part 2/3 — the manuscript-context checkbox still
    // lets the researcher opt OUT of sending their current selection
    // (matching the pre-M6.2 UX exactly); when included, the actual
    // selection range/content travel structured, not as flattened text.
    const includeSelection = hasManuscriptSelection && includeManuscriptSelection;
    const editorContext: WritingAskEditorContext = {
      projectId,
      activeFileId,
      cursorPosition: includeSelection ? selectionStart : selectionEnd,
      selectionStart: includeSelection ? selectionStart : selectionEnd,
      selectionEnd: includeSelection ? selectionEnd : selectionEnd,
      selectedText: includeSelection ? manuscriptSelectionText : '',
      activeFileUnsavedContent: activeFileContent,
    };
    void ask.ask(question, editorContext).then(() => setQuestion(''));
  }

  if (!visible) return null;

  return (
    <View style={[styles.panel, embedded && styles.panelEmbedded]} testID="ask-edum8-panel">
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
        <Text style={styles.contextHeading}>Writing context</Text>
        {/* Writing UX Refinement milestone, Blocker 2 fix — always-on,
            non-interactive: the currently open document is baseline
            Writing context regardless of which RAG scope (below) is
            selected, or whether it has anything in it. Distinguishing
            this from the scope tabs (which pick WHICH extra evidence to
            search) rather than adding a fourth mutually-exclusive tab —
            "current document" isn't a scope you switch to, it's always
            included. */}
        <View style={styles.currentDocRow}>
          <View style={[styles.currentDocDot, hasCurrentDocument && styles.currentDocDotActive]} />
          <Text style={styles.currentDocLabel}>
            {hasCurrentDocument ? 'Current document — always included' : 'No document open yet'}
          </Text>
        </View>
        <Text style={styles.contextHeading}>Research context (optional)</Text>
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
        {/* Writing UX Refinement milestone, Blocker 2 fix — this used to
            be a `scopeWarning` gated on `!ask.canAsk`, which disabled the
            composer entirely whenever the default Project References
            scope was empty. Zero references is now purely informational
            (Ask EduM8 still works from the current document alone) —
            `hasScopeContent`, not `canAsk`, drives this note, and nothing
            here disables the Ask button. `!ask.canAsk` can still happen
            (no document open AND an empty scope) and is handled by the
            Ask button's own disabled state below. */}
        {!ask.hasScopeContent && (
          <Text style={styles.scopeNote}>
            {ask.scopeKind === 'project-references'
              ? 'No project references attached — add one to include them as evidence.'
              : ask.scopeKind === 'selected-sources'
                ? 'No sources selected — choose some above to include them as evidence.'
                : 'No research notes selected — choose some above to include them as evidence.'}
          </Text>
        )}
      </View>

      <ScrollView
        ref={turnsScrollRef}
        style={styles.turns}
        contentContainerStyle={styles.turnsContent}
      >
        {ask.turns.map((turn, index) => (
          <AskTurnView
            key={turn.id}
            turn={turn}
            referenceIdSet={referenceIdSet}
            onOpenSource={onOpenSource}
            onAddReference={onAddReference}
            onInsertCitation={onInsertCitation}
            // Only the most recent turn can still be live — every earlier
            // one is necessarily already 'success'/'error'/'cancelled' by
            // construction (useWritingAsk.ask() is single-flight via its
            // own `asking` guard), so Stop only ever needs to target it.
            onStop={index === ask.turns.length - 1 ? ask.cancel : undefined}
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
  onStop,
}: {
  turn: WritingAskTurn;
  referenceIdSet: Set<string>;
  onOpenSource: (source: DisplaySource) => void;
  onAddReference: (documentId: string) => Promise<void>;
  onInsertCitation: (documentId: string) => Promise<void>;
  /** Undefined for any turn that isn't the current live one — see the
   * caller's own comment on why only the last turn ever needs this. */
  onStop?: () => void;
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

  // Part 4: no fabricated progress percentage — just whether generation
  // is genuinely still live, and for how long.
  const isLive = turn.status === 'sending' || turn.status === 'streaming';
  // The placeholder shows until the first real token lands, exactly like
  // Chat's own thinking-preview lifecycle (ThinkingPlaceholder's docs).
  const showThinking = turn.status === 'sending' || (turn.status === 'streaming' && !turn.answer);

  const contextIndicator = writingContextIndicatorLabel(turn.contextSummary, turn.sources.length);

  return (
    <View style={styles.turn}>
      <Text style={styles.question}>{turn.question}</Text>
      <Text style={styles.turnScope}>Asked using: {turn.scopeLabel}</Text>
      {contextIndicator && <Text style={styles.contextIndicator}>{contextIndicator}</Text>}

      <ThinkingPlaceholder
        context={WRITING_THINKING_CONTEXT}
        visible={showThinking}
        progressDetail={turn.progressDetail}
      />
      {isLive && onStop && (
        <View style={styles.liveRow}>
          <ElapsedIndicator startedAt={turn.firstTokenAt ?? turn.startedAt} />
          <Pressable onPress={onStop} accessibilityRole="button" style={styles.stopButton}>
            <Text style={styles.stopButtonLabel}>Stop</Text>
          </Pressable>
        </View>
      )}
      {turn.status === 'cancelled' && <Notice tone="neutral" body="Stopped." />}
      {turn.status === 'error' && turn.errorMessage && (
        <Notice tone="danger" body={turn.errorMessage} />
      )}
      {turn.status === 'success' && turn.insufficientEvidence && (
        <Notice
          tone="neutral"
          body={`I couldn't find strong support for this in ${turn.scopeLabel}. Try selecting different sources, or add more project references.`}
        />
      )}
      {(turn.status === 'streaming' || turn.status === 'success') &&
        !turn.insufficientEvidence &&
        turn.answer && (
          <MarkdownAnswer
            answer={turn.answer}
            citations={turn.citations}
            onCitationPress={() => {}}
          />
        )}
      {turn.status === 'success' && turn.completedAt && (
        <Text style={styles.latencyCaption}>
          {latencyCaption(turn.startedAt, turn.firstTokenAt, turn.completedAt)}
        </Text>
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
    // Milestone 5.5 Part 6 — as the Research panel's "Ask EduM8" tab, the
    // parent already owns width and its own left border; this just fills
    // whatever space it's given.
    panelEmbedded: {
      width: undefined,
      borderLeftWidth: 0,
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
    currentDocRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 2 },
    currentDocDot: {
      width: 7,
      height: 7,
      borderRadius: 4,
      backgroundColor: theme.border,
    },
    currentDocDotActive: { backgroundColor: theme.accent },
    currentDocLabel: { fontSize: 12.5, fontFamily: theme.fonts.body, color: theme.subtext },
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
    // Writing UX Refinement milestone, Blocker 2 fix — deliberately
    // `theme.faint`/subtext-toned, not `theme.warning`: an empty RAG
    // scope is informational, never an error state (it no longer blocks
    // anything).
    scopeNote: { fontSize: 12, color: theme.faint, fontFamily: theme.fonts.body },
    turns: { flex: 1 },
    turnsContent: { padding: 16, gap: 16 },
    turn: { gap: 6 },
    question: { fontSize: 13.5, fontFamily: theme.fonts.bodySemibold, color: theme.text },
    turnScope: { fontSize: 11, fontFamily: theme.fonts.body, color: theme.faint },
    // Milestone 6.2 Parts 11/12 — deliberately styled as quietly as
    // turnScope (a fact about the request, not a headline metric).
    contextIndicator: {
      fontSize: 11,
      fontFamily: theme.fonts.body,
      color: theme.faint,
      marginTop: -2,
    },
    spinner: { marginVertical: 12 },
    liveRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginVertical: 8,
    },
    elapsedLabel: { fontSize: 11.5, fontFamily: theme.fonts.body, color: theme.faint },
    stopButton: {
      paddingHorizontal: 10,
      paddingVertical: 4,
      borderRadius: theme.radius.sm,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
    },
    stopButtonLabel: { fontSize: 11.5, fontFamily: theme.fonts.bodySemibold, color: theme.danger },
    latencyCaption: {
      fontSize: 10.5,
      fontFamily: theme.fonts.body,
      color: theme.faint,
      marginTop: 2,
    },
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
