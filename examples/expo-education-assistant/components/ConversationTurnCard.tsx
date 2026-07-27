import { mapSourcesToCitations, splitAnswerIntoSegments } from 'education-assistant-client';
import type { DisplayMessage, RetrievedChunk } from 'education-assistant-client';
import { useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { AttachmentChip } from '@/components/AttachmentChip';
import { AttachmentLightbox } from '@/components/AttachmentLightbox';
import { GeneratedImageGallery } from '@/components/GeneratedImageGallery';
import type { ImageGenerationFormInitialValues } from '@/components/ImageGenerationModal';
import { MarkdownAnswer } from '@/components/MarkdownAnswer';
import { SourceCard, UnavailableSourceChip } from '@/components/SourceCard';
import type { AttachmentChipInfo, PendingAttachment } from '@/lib/chatAttachments';

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
            {assistant?.streaming && answer.length === 0 && (
              <View style={styles.centered}>
                <ActivityIndicator />
                <Text style={styles.hint}>Connecting…</Text>
              </View>
            )}

            {answer.length > 0 && (
              <MarkdownAnswer
                answer={answer}
                citations={citations}
                onCitationPress={onCitationPress}
              />
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

            {mapped.length > 0 && (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>Sources</Text>
                {mapped.map((m) => (
                  <SourceCard
                    key={m.sourceId}
                    source={m}
                    highlighted={highlightedSourceId === m.sourceId}
                  />
                ))}
              </View>
            )}

            {segments.some((s) => s.type === 'citation' && s.match.citation === null) && (
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
  hint: { color: '#64748B', textAlign: 'center', marginTop: 24 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 24 },
  note: { fontSize: 12, color: '#475569', marginTop: 12, fontStyle: 'italic' },
  errorBox: { backgroundColor: '#FEF2F2', borderRadius: 8, padding: 12 },
  errorTitle: { fontWeight: '700', color: '#B91C1C' },
  errorText: { color: '#7F1D1D', marginTop: 4 },
  section: { marginTop: 20 },
  sectionTitle: { fontWeight: '700', fontSize: 14, marginBottom: 8 },
  warningHint: { fontSize: 11, color: '#94A3B8', marginBottom: 6 },
  warningText: { fontSize: 12, color: '#B45309', marginBottom: 2 },
});
