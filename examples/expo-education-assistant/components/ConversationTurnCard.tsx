import { mapSourcesToCitations, splitAnswerIntoSegments } from 'education-assistant-client';
import type { DisplayMessage, RetrievedChunk } from 'education-assistant-client';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { AttachmentChip } from '@/components/AttachmentChip';
import { AttachmentLightbox } from '@/components/AttachmentLightbox';
import { GeneratedImageGallery } from '@/components/GeneratedImageGallery';
import type { ImageGenerationFormInitialValues } from '@/components/ImageGenerationModal';
import { MarkdownAnswer } from '@/components/MarkdownAnswer';
import { SourceCard, UnavailableSourceChip } from '@/components/SourceCard';
import { ThinkingPlaceholder } from '@/components/ThinkingPlaceholder';
import type { AttachmentChipInfo, PendingAttachment } from '@/lib/chatAttachments';
import { usePreferences } from '@/lib/Preferences';

/** How long the card keeps the thinking placeholder mounted after the turn
 * leaves the thinking state, so its ~180ms exit fade finishes before the
 * streamed answer (or error state) takes its place — see thinkingLinger. */
const THINKING_FADE_OUT_MS = 200;

/** DisplaySource unifies persisted/live sources but allows a null document_id (a since-deleted document); mapSourcesToCitations only uses document_id for its join key, never for display, so substituting '' here is safe — see types/conversations.ts. */
function toRetrievedChunk(source: DisplayMessage['sources'][number]): RetrievedChunk {
  return { ...source, document_id: source.document_id ?? '' };
}

export interface ConversationTurnCardProps {
  userContent: string;
  assistant: DisplayMessage | null;
  /** Files the user attached to this turn's question (milestone V2) — never auto-ingested into the RAG corpus and not yet read by any vision model; this is purely a record of what was attached. Empty for a plain text-only turn. */
  userAttachments?: AttachmentChipInfo[];
  /** The sourceId currently scrolled-to/highlighted within *this* turn, or null if none. */
  highlightedSourceId?: string | null;
  onCitationPress: (sourceId: string) => void;
  /** Needed only when `assistant` is a standalone image-generation turn (see chat/[id].tsx's pairMessages) — every other turn ignores these. */
  conversationId?: string;
  onUseImageAsAttachment?: (pending: PendingAttachment) => void;
  onRegenerateImage?: (initialValues: ImageGenerationFormInitialValues) => void;
}

/**
 * One user question + assistant answer, with sources/citations — shared by
 * chat/[id].tsx's scrollable history and chat/new.tsx's single in-progress
 * first turn, so the two screens never duplicate this rendering logic (see
 * both call sites' docs for why the first turn is ever shown outside a
 * FlatList at all).
 */
export function ConversationTurnCard({
  userContent,
  assistant,
  userAttachments = [],
  highlightedSourceId = null,
  onCitationPress,
  conversationId,
  onUseImageAsAttachment,
  onRegenerateImage,
}: ConversationTurnCardProps) {
  const answer = assistant?.content ?? '';
  const sources = assistant?.sources ?? [];
  const citations = assistant?.citations ?? [];

  const chunks = sources.map(toRetrievedChunk);
  const mapped = mapSourcesToCitations(chunks, citations);
  const segments = answer ? splitAnswerIntoSegments(answer, citations) : [];

  // The backend's citations list labels EVERY retrieved chunk (S1..SN — see
  // rag-backend's build_citations), not just the ones the model actually
  // used, so `mapped` alone would show a card for every retrieved document
  // even when the answer only cites a few. The inline [S#] markers parsed
  // out of the answer text (same pattern the backend validates with) are
  // the ground truth for "this source contributed to the response" — the
  // Sources section renders exactly those cards, in the backend's own
  // S-number order (mapSourcesToCitations already sorts by source_id), with
  // numbering never renumbered. During streaming, cards appear as their
  // citation lands in the partial answer; a source that is retrieved but
  // never cited is simply never shown.
  const citedSourceIds = new Set(
    segments.flatMap((segment) => (segment.type === 'citation' ? [segment.match.sourceId] : []))
  );
  const citedSources = mapped.filter((source) => citedSourceIds.has(source.sourceId));

  // The Settings screen's "Show citations" preference — 'shown' is the
  // default, so a screen rendered without a PreferencesProvider (tests,
  // previews) behaves exactly as it always did. Inline citation LINKS stay
  // in the answer text either way; this only hides the source-card surface.
  const { preferences } = usePreferences();
  const citationsVisible = preferences.citationDisplay === 'shown';

  // A standalone image-generation turn (see chat/[id].tsx's pairMessages) —
  // no other code path ever puts attachments on an assistant message, so
  // this is a reliable, sufficient signal rather than a dedicated flag.
  const generatedImages = (assistant?.attachments ?? []).filter((a) => a.source === 'generated');
  // Reference images persisted alongside this batch (source="reference") — not
  // shown as gallery tiles, but handed to the gallery so Regenerate can prefill
  // them in the modal (which re-fetches + re-encodes them).
  const referenceImages = (assistant?.attachments ?? []).filter((a) => a.source === 'reference');
  const isImageGenerationTurn = generatedImages.length > 0;

  // Only already-persisted attachments (`.remote` set) can be opened full-
  // size — a not-yet-sent one has no server-rendered preview to fetch yet
  // (see AttachmentChip's onPress docs).
  const viewableAttachments = userAttachments.filter((a) => a.remote !== null);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  // Thinking-preview lifecycle. `thinkingActive` is the SDK's state machine
  // as-is (placeholder while `thinking` is set and no token has landed);
  // `thinkingLinger` extends the placeholder's mount for the duration of its
  // exit fade once that state clears, and holds the streamed answer back
  // until the fade is done — so the placeholder and the real answer are
  // never on screen at the same time. A retry that lands within the window
  // simply flips `visible` back on and the box fades straight back in.
  const thinkingActive = assistant?.thinking != null && answer.length === 0;
  // A message loaded from GET /conversations/{id} whose backend worker is
  // still running (QA finding BUG-1's recovery redesign — see
  // rag-backend's app/core/generation_manager.py): distinct from
  // `thinkingActive` above, which only ever describes a *local*,
  // just-sent turn (`thinking` is always null for a loaded message — see
  // useConversationMessages' toDisplayMessages). Shown as a full
  // thinking-placeholder only while there's no partial content yet;
  // once a periodic flush has landed some text, a smaller inline note
  // sits below the real (partial) answer instead, so the two never
  // visually compete for the same space the way the placeholder and a
  // completed answer are kept from doing.
  const isResumingGeneration = assistant?.persistedStatus === 'generating';
  const [thinkingLinger, setThinkingLinger] = useState(false);
  useEffect(() => {
    if (thinkingActive) {
      setThinkingLinger(true);
      return;
    }
    // Reading thinkingLinger from this render's closure is intentional: the
    // only transition that matters is thinkingActive flipping to false, at
    // which point the captured value is the fresh one.
    if (!thinkingLinger) return;
    const timer = setTimeout(() => setThinkingLinger(false), THINKING_FADE_OUT_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thinkingActive]);

  return (
    <View style={styles.turn}>
      {userContent.length > 0 && (
        <View style={styles.userBubble}>
          <Text style={styles.userBubbleText}>{userContent}</Text>
        </View>
      )}

      {userAttachments.length > 0 && (
        <View style={styles.userAttachmentsRow}>
          {userAttachments.map((info) => {
            const viewableIndex = viewableAttachments.findIndex((a) => a.key === info.key);
            return (
              <AttachmentChip
                key={info.key}
                info={info}
                onPress={viewableIndex >= 0 ? () => setLightboxIndex(viewableIndex) : undefined}
              />
            );
          })}
        </View>
      )}

      {viewableAttachments.length > 0 && (
        <AttachmentLightbox
          visible={lightboxIndex !== null}
          attachments={viewableAttachments}
          initialIndex={lightboxIndex ?? 0}
          onClose={() => setLightboxIndex(null)}
        />
      )}

      <View style={styles.assistantBlock}>
        {isImageGenerationTurn && conversationId && assistant ? (
          <>
            {answer.length > 0 && <Text style={styles.imagePromptCaption}>{`“${answer}”`}</Text>}
            <GeneratedImageGallery
              conversationId={conversationId}
              messageId={assistant.id}
              images={generatedImages}
              referenceImages={referenceImages}
              onUseAsAttachment={onUseImageAsAttachment ?? (() => {})}
              onRegenerate={onRegenerateImage ?? (() => {})}
            />
          </>
        ) : (
          <>
            {(thinkingActive || thinkingLinger || (isResumingGeneration && answer.length === 0)) && (
              <ThinkingPlaceholder
                context={assistant?.thinkingContext ?? null}
                visible={thinkingActive || (isResumingGeneration && answer.length === 0)}
              />
            )}

            {answer.length > 0 && !thinkingLinger && (
              <MarkdownAnswer
                answer={answer}
                citations={citations}
                onCitationPress={onCitationPress}
              />
            )}

            {isResumingGeneration && answer.length > 0 && (
              <Text style={styles.note}>Still generating…</Text>
            )}

            {assistant?.persistedStatus === 'cancelled' && (
              <Text style={styles.note}>Generation was cancelled.</Text>
            )}

            {assistant?.persistedStatus === 'interrupted' && (
              <Text style={styles.note}>
                Generation was interrupted by a server restart before it finished. Press Retry to
                try again.
              </Text>
            )}

            {assistant?.persistedStatus === 'error' && assistant.persistedErrorMessage && (
              <View style={styles.errorBox}>
                <Text style={styles.errorTitle}>Error</Text>
                <Text style={styles.errorText}>{assistant.persistedErrorMessage}</Text>
              </View>
            )}

            {assistant?.insufficientEvidence && (
              <Text style={styles.note}>
                No sources survived retrieval for this query — the LLM was never called. The text
                above is the backend&apos;s fixed explanation, not a generated answer, and this does
                not mean nothing relevant exists anywhere, only that retrieval returned nothing
                usable for this exact query.
              </Text>
            )}

            {assistant?.error && (
              <View style={styles.errorBox}>
                <Text style={styles.errorTitle}>Error</Text>
                <Text style={styles.errorText}>{assistant.error}</Text>
              </View>
            )}

            {citationsVisible && citedSources.length > 0 && (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>Sources</Text>
                {citedSources.map((m) => (
                  <SourceCard
                    key={m.sourceId}
                    source={m}
                    highlighted={highlightedSourceId === m.sourceId}
                  />
                ))}
              </View>
            )}

            {citationsVisible &&
              segments.some((s) => s.type === 'citation' && s.match.citation === null) && (
                <View style={styles.section}>
                  {segments
                    .filter((s) => s.type === 'citation' && s.match.citation === null)
                    .map((s, i) =>
                      s.type === 'citation' ? (
                        <UnavailableSourceChip key={i} sourceId={s.match.sourceId} />
                      ) : null
                    )}
                </View>
              )}

            {assistant && !assistant.streaming && assistant.citationWarnings.length > 0 && (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>Backend citation warnings</Text>
                <Text style={styles.warningHint}>
                  These are the backend&apos;s own citation-format checks — they do not block or
                  rewrite the answer above.
                </Text>
                {assistant.citationWarnings.map((warning, i) => (
                  <Text key={i} style={styles.warningText}>
                    • {warning}
                  </Text>
                ))}
              </View>
            )}
          </>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  turn: { marginBottom: 20 },
  userBubble: {
    alignSelf: 'flex-end',
    backgroundColor: '#208AEF',
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginBottom: 8,
    maxWidth: '85%',
  },
  userBubbleText: { color: '#FFFFFF', fontSize: 15 },
  userAttachmentsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
    gap: 6,
    marginBottom: 8,
  },
  assistantBlock: {},
  imagePromptCaption: { fontSize: 13, color: '#475569', fontStyle: 'italic', marginBottom: 8 },
  note: { fontSize: 12, color: '#475569', marginTop: 12, fontStyle: 'italic' },
  errorBox: { backgroundColor: '#FEF2F2', borderRadius: 8, padding: 12 },
  errorTitle: { fontWeight: '700', color: '#B91C1C' },
  errorText: { color: '#7F1D1D', marginTop: 4 },
  section: { marginTop: 20 },
  sectionTitle: { fontWeight: '700', fontSize: 14, marginBottom: 8 },
  warningHint: { fontSize: 11, color: '#94A3B8', marginBottom: 6 },
  warningText: { fontSize: 12, color: '#B45309', marginBottom: 2 },
});
