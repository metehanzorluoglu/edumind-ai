import {
  displaySourceFromRetrievedChunk,
  EducationAssistantError,
  RequestCancelledError,
  StreamingUnsupportedError,
  thinkingContextForRequest,
  useConversations,
  useEducationDocuments,
} from 'education-assistant-client';
import type { DisplayMessage, PostConversationMessageRequest } from 'education-assistant-client';
import { useRouter } from 'expo-router';
import { createElement, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { AttachmentButton } from '@/components/AttachmentButton';
import { AttachmentPreviewRow } from '@/components/AttachmentPreviewRow';
import { ConversationTurnCard } from '@/components/ConversationTurnCard';
import { CorpusToggle } from '@/components/CorpusToggle';
import { ImageGenerateButton } from '@/components/ImageGenerateButton';
import {
  ImageGenerationModal,
  type ImageGenerationContext,
  type ImageGenerationFormInitialValues,
  type ImageGenerationRequestParams,
} from '@/components/ImageGenerationModal';
import {
  attachmentChipFromPending,
  toAttachmentUploads,
  type PendingAttachment,
} from '@/lib/chatAttachments';
import { useRefreshConversations } from '@/lib/ChatConversationsContext';
import { useClient } from '@/lib/ClientProvider';
import { useFeatureFlags } from '@/lib/FeatureFlags';
import { useChatAttachments } from '@/lib/useChatAttachments';
import { generateClientMessageId } from '@/lib/clientMessageId';
import { describeApiError } from '@/lib/errorDisplay';
import { SAMPLE_DOCUMENT_TITLE, buildSampleUploadFile } from '@/lib/sampleDocument';

/** Explicit state machine for the composer-to-persisted-answer flow — see
 * this screen's module doc for why sending must fully finish here, before
 * any navigation, rather than being handed off to chat/[id].tsx. */
type Phase = 'idle' | 'creating' | 'sending' | 'error';

function pendingAssistantTurn(
  messageAttachments: PendingAttachment[],
  messageUseCorpus: boolean
): DisplayMessage {
  return {
    id: 'pending-first-assistant-turn',
    role: 'assistant',
    content: '',
    sources: [],
    citations: [],
    citationWarnings: [],
    insufficientEvidence: false,
    createdAt: null,
    streaming: true,
    error: null,
    stage: null,
    // The thinking placeholder shows from this moment — before the
    // conversation is even created — until the first token arrives (or the
    // attempt fails/is cancelled; fail() clears it). The context mirrors
    // the request runFirstMessage will send, so the placeholder's status
    // text is truthful about what that request actually triggers.
    thinking: 'connecting',
    thinkingContext: thinkingContextForRequest({
      attachments: toAttachmentUploads(messageAttachments),
      use_corpus: messageAttachments.length > 0 ? messageUseCorpus : undefined,
    }),
    attachments: [],
    persistedStatus: 'complete',
    persistedErrorMessage: null,
  };
}

/** Real HTTP context (method, URL, status/detail — or "Network error: …"
 * for a genuine fetch() failure) when the caught error came from the SDK;
 * a plain message otherwise (e.g. a JS error unrelated to any request). */
function formatRequestError(method: string, baseUrl: string, path: string, error: unknown): string {
  if (error instanceof EducationAssistantError) {
    return describeApiError(method, baseUrl, path, error);
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * The composer-only landing screen for a not-yet-persisted conversation —
 * no `conversations` row exists until the first message is actually sent,
 * matching ChatGPT's own "new chat" behavior.
 *
 * On submit this screen creates the conversation *and* sends+streams the
 * first message itself, rendering the turn inline, and only navigates to
 * the clean `/chat/{id}` route once that first message has fully
 * succeeded. This is deliberate: chat/[id].tsx mounts fresh (its own
 * useConversationMessages() re-fetches the conversation from the backend),
 * so navigating any earlier — e.g. right after creating the still-empty
 * conversation — hands that fresh mount an empty history and destroys
 * whatever local optimistic state this screen had built up, which is the
 * exact race this design avoids. No message content is ever placed in the
 * URL; the query string is never used as chat state.
 */
export default function NewChatScreen() {
  const { client, baseUrl, hydrated } = useClient();
  const { imageGenerator: imageGeneratorEnabled } = useFeatureFlags();
  const router = useRouter();
  const refreshConversations = useRefreshConversations();
  const { createConversation } = useConversations(client);
  const {
    listState: corpusListState,
    refresh: refreshCorpusList,
    uploadState: sampleUploadState,
    upload: uploadSample,
  } = useEducationDocuments(client);

  const [query, setQuery] = useState('');
  const [useCorpus, setUseCorpus] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [submittedQuestion, setSubmittedQuestion] = useState<string | null>(null);
  const [submittedAttachments, setSubmittedAttachments] = useState<PendingAttachment[]>([]);
  const [submittedUseCorpus, setSubmittedUseCorpus] = useState(false);
  const [assistantTurn, setAssistantTurn] = useState<DisplayMessage | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const {
    attachments,
    pickAttachment,
    removeAttachment,
    clearAttachments,
    dropZoneRefCallback,
    isDragOver,
  } = useChatAttachments();

  // Identifies the conversation + idempotency key for the *current*
  // submission attempt — populated once createConversation() succeeds, and
  // deliberately a ref (not state): Retry reads it without needing to
  // re-render, and reusing the same client_message_id across retries is
  // what lets the backend recognize a retry and skip re-inserting the
  // user's message (see PostConversationMessageRequest.client_message_id).
  const pendingRef = useRef<{ conversationId: string; clientMessageId: string } | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  // Synchronous double-submit guard — see handleAsk for why `phase` state
  // alone isn't sufficient.
  const isSubmittingRef = useRef(false);

  // Mirrors pendingRef's own reasoning, for the "Image" composer action:
  // populated once createConversation() succeeds for the *current*
  // generation attempt, so a failed/cancelled generation's Retry (opening
  // the modal again and pressing Generate) reuses the same already-created
  // (still-empty) conversation instead of creating a second one. Cleared
  // only by a genuinely fresh createConversation() failure — see
  // handleGenerateImagesFromNew.
  const pendingImageConversationIdRef = useRef<string | null>(null);
  const [imageModalOpen, setImageModalOpen] = useState(false);
  const [imageModalInitialValues, setImageModalInitialValues] = useState<
    ImageGenerationFormInitialValues | undefined
  >(undefined);
  // See chat/[id].tsx's identical imageModalKey docs: forces a remount so
  // ImageGenerationModal's internal useState actually re-initializes from
  // a fresh `initialValues` each time the dialog is opened.
  const [imageModalKey, setImageModalKey] = useState(0);

  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (hydrated) refreshCorpusList({ limit: 1 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated]);

  useEffect(() => {
    if (sampleUploadState.status === 'success') refreshCorpusList({ limit: 1 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sampleUploadState.status]);

  const isEmptyCorpus = corpusListState.status === 'success' && corpusListState.total === 0;

  function handleLoadSampleCorpus(): void {
    const file = buildSampleUploadFile();
    uploadSample(file, { documentType: 'curriculum_document', title: SAMPLE_DOCUMENT_TITLE });
  }

  function patchAssistantTurn(patch: Partial<DisplayMessage>): void {
    setAssistantTurn((prev) => (prev ? { ...prev, ...patch } : prev));
  }

  // Only patches the assistant turn's own `.error` — ConversationTurnCard
  // already renders that inline next to the question, so a would-be second
  // copy in `errorMessage` (reserved for the "conversation was never even
  // created" case, which has no turn card to show it in) would just
  // duplicate the same text on screen. Also the cancelled path (see
  // handleCancel), which lands here with "Message generation was
  // cancelled." — clearing `thinking` is what removes the placeholder and
  // stops its animation in both cases.
  function fail(message: string): void {
    patchAssistantTurn({ streaming: false, error: message, thinking: null, thinkingContext: null });
    setPhase('error');
  }

  function succeed(conversationId: string): void {
    refreshConversations();
    router.replace(`/chat/${conversationId}`);
  }

  async function runFirstMessage(
    conversationId: string,
    question: string,
    clientMessageId: string,
    messageAttachments: PendingAttachment[],
    messageUseCorpus: boolean
  ): Promise<void> {
    setPhase('sending');
    setErrorMessage(null);
    setAssistantTurn(pendingAssistantTurn(messageAttachments, messageUseCorpus));

    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;
    const request: PostConversationMessageRequest = {
      query: question,
      client_message_id: clientMessageId,
      attachments: toAttachmentUploads(messageAttachments),
      use_corpus: messageAttachments.length > 0 ? messageUseCorpus : undefined,
    };

    try {
      let content = '';
      for await (const event of client.streamConversationMessage(conversationId, request, {
        signal: controller.signal,
      })) {
        switch (event.type) {
          case 'progress':
            patchAssistantTurn({ stage: event.stage, thinking: 'waiting_for_first_token' });
            break;
          case 'token':
            content += event.content;
            // Same patch as the content lands — the placeholder swaps for
            // the real answer in one render, never two.
            patchAssistantTurn({ content, stage: null, thinking: null });
            break;
          case 'sources':
            patchAssistantTurn({ sources: event.sources.map(displaySourceFromRetrievedChunk) });
            break;
          case 'done':
            patchAssistantTurn({
              citations: event.citations,
              citationWarnings: event.citation_warnings,
              insufficientEvidence: event.insufficient_evidence,
              streaming: false,
              thinking: null,
            });
            succeed(conversationId);
            return;
          case 'error':
            fail(event.message);
            return;
        }
      }
      fail('The message stream ended without a "done" event.');
    } catch (error) {
      if (error instanceof StreamingUnsupportedError) {
        try {
          const result = await client.postConversationMessage(conversationId, request, {
            signal: controller.signal,
          });
          patchAssistantTurn({
            content: result.answer,
            sources: result.sources.map(displaySourceFromRetrievedChunk),
            citations: result.citations,
            citationWarnings: result.citationWarnings,
            insufficientEvidence: result.insufficientEvidence,
            streaming: false,
            thinking: null,
          });
          succeed(conversationId);
        } catch (bufferedError) {
          // Same reasoning as the outer catch below: a transport failure
          // here doesn't mean generation stopped server-side, and an
          // explicit cancel already updated the UI itself — see
          // handleCancel — so neither case should show a dead-end error
          // on this composer.
          if (bufferedError instanceof RequestCancelledError) return;
          refreshConversations();
          router.replace(`/chat/${conversationId}`);
        }
        return;
      }
      // Silent, exactly as before this milestone added a Cancel button:
      // this fires for both a user's explicit Cancel (which already
      // updates the UI itself — see handleCancel — synchronously, without
      // waiting on this catch, since the underlying fetch's abort-to-
      // rejection timing isn't something the UI should depend on) and this
      // screen unmounting mid-stream (the cleanup effect above also
      // aborts), where there is nothing left to update.
      if (error instanceof RequestCancelledError) return;
      // A transport-level failure here (e.g. a dropped connection — QA
      // finding BUG-1, observed as net::ERR_QUIC_PROTOCOL_ERROR) does NOT
      // mean generation stopped: the backend's worker keeps running and
      // persists the answer regardless of this browser tab (see
      // rag-backend's app/core/generation_manager.py). The conversation
      // already exists, so land the user there instead of stranding them
      // on this composer with a dead-end error box — chat/[id].tsx polls
      // a still-'generating' reply to completion, or shows a clear status
      // for one that ended in 'error'/'cancelled'/'interrupted'.
      refreshConversations();
      router.replace(`/chat/${conversationId}`);
    }
  }

  async function handleAsk(): Promise<void> {
    const question = query.trim();
    // A plain `phase` check isn't enough: two onPress calls fired back to
    // back (a fast double-click, or — the same failure mode — React Strict
    // Mode invoking a handler twice before either state update has landed)
    // would both read the same pre-update `phase` and both pass. The ref is
    // mutated synchronously, so the second call always sees the first's claim.
    if (!question || isSubmittingRef.current) return;
    if (attachments.some((a) => a.error !== null)) return;
    isSubmittingRef.current = true;
    const attachmentsSnapshot = attachments;
    const useCorpusSnapshot = useCorpus;
    setQuery('');
    clearAttachments();
    setUseCorpus(false);
    setErrorMessage(null);
    setSubmittedQuestion(question);
    setSubmittedAttachments(attachmentsSnapshot);
    setSubmittedUseCorpus(useCorpusSnapshot);
    setAssistantTurn(pendingAssistantTurn(attachmentsSnapshot, useCorpusSnapshot));
    setPhase('creating');

    try {
      const { id } = await createConversation();
      const clientMessageId = generateClientMessageId();
      pendingRef.current = { conversationId: id, clientMessageId };
      await runFirstMessage(id, question, clientMessageId, attachmentsSnapshot, useCorpusSnapshot);
    } catch (error) {
      // No conversation exists yet, so there's nothing for Retry to target
      // — restore the input instead and let the user resubmit from scratch.
      isSubmittingRef.current = false;
      pendingRef.current = null;
      setSubmittedQuestion(null);
      setSubmittedAttachments([]);
      setAssistantTurn(null);
      setPhase('error');
      setErrorMessage(formatRequestError('POST', baseUrl, '/conversations', error));
      setQuery(question);
    }
  }

  function handleCancel(): void {
    // Aborts the in-flight request (best-effort — frees the connection/
    // server resources) but does not wait for that to reject the stream:
    // the UI reflects cancellation immediately, matching chat/[id].tsx's
    // cancelSend().
    abortControllerRef.current?.abort();
    fail('Message generation was cancelled.');
  }

  function handleRetry(): void {
    const pending = pendingRef.current;
    if (!pending || !submittedQuestion) return;
    void runFirstMessage(
      pending.conversationId,
      submittedQuestion,
      pending.clientMessageId,
      submittedAttachments,
      submittedUseCorpus
    );
  }

  /**
   * The "Image" composer action's onGenerate, for a not-yet-persisted
   * conversation: creates the conversation first (only once per attempt —
   * see pendingImageConversationIdRef), then streams generation into it
   * exactly like chat/[id].tsx's own handleGenerateImages, and — mirroring
   * runFirstMessage's own "navigate only once the turn has fully
   * succeeded" rule (see this screen's module doc) — navigates to the new
   * conversation only after the image(s) have actually been generated
   * *and* persisted (the `done` event), never right after creation alone.
   * A failure at any point leaves the user on this screen with the error
   * shown inline in the modal (see ImageGenerationModal's own catch), and
   * — if the conversation was already created — reachable again by
   * simply pressing Generate again.
   */
  async function handleGenerateImagesFromNew(
    params: ImageGenerationRequestParams,
    context: ImageGenerationContext
  ): Promise<void> {
    let conversationId = pendingImageConversationIdRef.current;
    if (!conversationId) {
      const created = await createConversation();
      conversationId = created.id;
      pendingImageConversationIdRef.current = conversationId;
    }

    for await (const event of client.streamImageGeneration(
      {
        prompt: params.prompt,
        negative_prompt: params.negativePrompt,
        width: params.width,
        height: params.height,
        num_images: params.numImages,
        conversation_id: conversationId,
        reference_images: params.referenceImages.length
          ? params.referenceImages.map((r) => ({ data_url: r.dataUrl, mime: r.mimeType }))
          : undefined,
      },
      { signal: context.signal }
    )) {
      switch (event.type) {
        case 'progress':
          context.onProgress(event.completed, event.total);
          break;
        case 'done':
          refreshConversations();
          router.replace(`/chat/${conversationId}`);
          return;
        case 'error':
          throw new Error(event.message);
      }
    }
    throw new Error('The image generation stream ended without a "done" event.');
  }

  const isBusy = phase === 'creating' || phase === 'sending';
  const hasAttachmentErrors = attachments.some((a) => a.error !== null);

  if (!hydrated) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator />
      </View>
    );
  }

  const composerBody = (
    <>
      <AttachmentPreviewRow attachments={attachments} onRemove={removeAttachment} />
      {attachments.length > 0 && (
        <CorpusToggle value={useCorpus} onValueChange={setUseCorpus} disabled={isBusy} />
      )}
      <View style={styles.inputRow}>
        <AttachmentButton onPress={pickAttachment} disabled={phase !== 'idle'} />
        {imageGeneratorEnabled && (
          <ImageGenerateButton
            onPress={() => {
              setImageModalInitialValues(undefined);
              setImageModalKey((k) => k + 1);
              setImageModalOpen(true);
            }}
            disabled={phase !== 'idle'}
          />
        )}
        <TextInput
          style={styles.input}
          value={query}
          onChangeText={setQuery}
          placeholder="Ask about the corpus…"
          editable={phase === 'idle'}
          onSubmitEditing={handleAsk}
          returnKeyType="send"
        />
        {isBusy ? (
          <Pressable style={[styles.button, styles.cancelButton]} onPress={handleCancel}>
            <Text style={styles.buttonText}>Cancel</Text>
          </Pressable>
        ) : (
          <Pressable
            style={styles.button}
            onPress={handleAsk}
            disabled={!query.trim() || hasAttachmentErrors}
          >
            <Text style={styles.buttonText}>Ask</Text>
          </Pressable>
        )}
      </View>
    </>
  );

  // See chat/[id].tsx's identical composer/dropZoneRefCallback split for
  // why this must be a raw host <div> on web and why native renders
  // composerBody directly.
  const composer =
    Platform.OS === 'web'
      ? createElement(
          'div',
          { ref: dropZoneRefCallback, 'data-testid': 'chat-attachment-drop-zone' },
          <View key="composer" style={isDragOver ? styles.composerDragOver : undefined}>
            {composerBody}
          </View>
        )
      : composerBody;

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.body}>
        {submittedQuestion ? (
          <ScrollView contentContainerStyle={styles.turnScrollContent}>
            <ConversationTurnCard
              userContent={submittedQuestion}
              assistant={assistantTurn}
              userAttachments={submittedAttachments.map(attachmentChipFromPending)}
              onCitationPress={() => {}}
            />
            {phase === 'error' && (
              <View style={styles.retryBox}>
                <Pressable style={styles.button} onPress={handleRetry}>
                  <Text style={styles.buttonText}>Retry</Text>
                </Pressable>
              </View>
            )}
          </ScrollView>
        ) : (
          <View style={styles.hintBody}>
            {isEmptyCorpus ? (
              <View style={styles.emptyCorpusBox}>
                <Text style={styles.emptyCorpusText}>
                  No research documents have been indexed yet.{'\n'}
                  Add documents from the Documents screen or load the development sample corpus.
                </Text>
                {__DEV__ && (
                  <Pressable
                    style={[styles.button, styles.secondaryButton]}
                    onPress={handleLoadSampleCorpus}
                    disabled={sampleUploadState.status === 'uploading'}
                  >
                    <Text style={styles.buttonText}>
                      {sampleUploadState.status === 'uploading'
                        ? 'Loading sample corpus…'
                        : 'Load sample corpus (dev only)'}
                    </Text>
                  </Pressable>
                )}
                {sampleUploadState.status === 'error' && (
                  <Text style={styles.error}>{sampleUploadState.error.message}</Text>
                )}
              </View>
            ) : (
              <Text style={styles.hint}>Ask a question about the ingested corpus.</Text>
            )}
            {errorMessage && <Text style={styles.error}>{errorMessage}</Text>}
          </View>
        )}
      </View>

      {composer}

      {imageGeneratorEnabled && (
        <ImageGenerationModal
          key={imageModalKey}
          visible={imageModalOpen}
          onClose={() => setImageModalOpen(false)}
          onGenerate={handleGenerateImagesFromNew}
          initialValues={imageModalInitialValues}
        />
      )}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F8FAFC' },
  composerDragOver: { backgroundColor: '#EFF8FF' },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  body: { flex: 1 },
  hintBody: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 16 },
  hint: { color: '#64748B', textAlign: 'center' },
  turnScrollContent: { padding: 16, flexGrow: 1 },
  emptyCorpusBox: { alignItems: 'center', gap: 12, paddingHorizontal: 16 },
  emptyCorpusText: { color: '#334155', textAlign: 'center', fontSize: 14, lineHeight: 20 },
  secondaryButton: { backgroundColor: '#64748B' },
  retryBox: { alignItems: 'center', gap: 8, marginTop: 12 },
  error: { fontSize: 12, color: '#B91C1C', textAlign: 'center' },
  inputRow: {
    flexDirection: 'row',
    padding: 12,
    gap: 8,
    borderTopWidth: 1,
    borderTopColor: '#E2E8F0',
  },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#CBD5E1',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: '#FFFFFF',
  },
  button: {
    backgroundColor: '#208AEF',
    borderRadius: 8,
    paddingHorizontal: 16,
    justifyContent: 'center',
    alignItems: 'center',
    minWidth: 64,
  },
  buttonText: { color: '#FFFFFF', fontWeight: '600' },
  cancelButton: { backgroundColor: '#B91C1C' },
});
