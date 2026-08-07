import { hasStreamingCapability, useConversationMessages } from 'education-assistant-client';
import type { DisplayMessage, PostConversationMessageRequest } from 'education-assistant-client';
import { useLocalSearchParams } from 'expo-router';
import { createElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ListRenderItemInfo, NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { AttachmentButton } from '@/components/AttachmentButton';
import { AttachmentPreviewRow } from '@/components/AttachmentPreviewRow';
import { ChatComposer } from '@/components/ChatComposer';
import { ConversationTurnCard } from '@/components/ConversationTurnCard';
import { CorpusToggle } from '@/components/CorpusToggle';
import { EduM8Symbol } from '@/components/EduM8Logo';
import { ImageGenerateButton } from '@/components/ImageGenerateButton';
import { Notice } from '@/components/ui/Notice';
import {
  ImageGenerationModal,
  type ImageGenerationContext,
  type ImageGenerationFormInitialValues,
  type ImageGenerationRequestParams,
} from '@/components/ImageGenerationModal';
import { attachmentChipFromPersisted, toAttachmentUploads } from '@/lib/chatAttachments';
import { useClient } from '@/lib/ClientProvider';
import { useFeatureFlags } from '@/lib/FeatureFlags';
import { usePreferences, useTheme, type Theme } from '@/lib/Preferences';
import { useChatAttachments } from '@/lib/useChatAttachments';
import { useRefreshConversations } from '@/lib/ChatConversationsContext';
import { generateClientMessageId } from '@/lib/clientMessageId';
import { describeApiError } from '@/lib/errorDisplay';

const NEAR_BOTTOM_THRESHOLD_PX = 96;

interface Highlighted {
  messageId: string;
  sourceId: string;
}

interface RenderTurn {
  id: string;
  userContent: string;
  userAttachments: DisplayMessage['attachments'];
  assistant: DisplayMessage | null;
}

/**
 * Pairs the flat message list into user+assistant turns for rendering — a
 * persisted conversation normally alternates user/assistant, one answer per
 * question (see rag-backend's routes_conversations.py). The one exception:
 * an assistant message carrying attachments is always a standalone
 * image-generation turn (see rag-backend's
 * ConversationsRepository.add_generated_image_message) — never the reply
 * to a pending question, since no other code path ever puts attachments on
 * an assistant message. Without this check, such a message would either
 * get wrongly glued onto an unrelated pending user turn, or silently
 * dropped if no turn were pending.
 */
function pairMessages(messages: DisplayMessage[]): RenderTurn[] {
  const turns: RenderTurn[] = [];
  for (const message of messages) {
    if (message.role === 'user') {
      turns.push({
        id: message.id,
        userContent: message.content,
        userAttachments: message.attachments,
        assistant: null,
      });
    } else if (message.attachments.length > 0) {
      turns.push({ id: message.id, userContent: '', userAttachments: [], assistant: message });
    } else if (turns.length > 0 && turns[turns.length - 1]!.assistant === null) {
      turns[turns.length - 1]!.assistant = message;
    }
  }
  return turns;
}

/**
 * Loads and displays an already-persisted conversation (the first message
 * is sent, and the conversation created, entirely by chat/new.tsx *before*
 * this screen is ever navigated to — see that screen's docs for why). This
 * screen therefore never bootstraps a pending first message from the URL:
 * on mount it only ever fetches history and lets the user send follow-up
 * turns.
 */
function ChatConversationScreen({ conversationId }: { conversationId: string }) {
  const theme = useTheme();
  const styles = useMemo(() => buildStyles(theme), [theme]);
  const { client, baseUrl, hydrated } = useClient();
  const { imageGenerator: imageGeneratorEnabled } = useFeatureFlags();
  const { preferences } = usePreferences();
  const refreshConversations = useRefreshConversations();
  const {
    conversation,
    loadState,
    messages,
    sendState,
    sendMessage,
    cancelSend,
    reload,
    isResumingGeneration,
    cancelPersistedGeneration,
  } = useConversationMessages(client, conversationId);
  // The (at most one, by backend construction) message this screen is
  // currently polling to completion — see isResumingGeneration's own docs.
  // Only its id is needed here, to target the explicit Cancel action below.
  const resumingMessageId = messages.find((m) => m.persistedStatus === 'generating')?.id ?? null;
  const [query, setQuery] = useState('');
  const [useCorpus, setUseCorpus] = useState(false);
  const [highlighted, setHighlighted] = useState<Highlighted | null>(null);
  const listRef = useRef<FlatList<RenderTurn>>(null);
  const isNearBottomRef = useRef(true);
  const prevContentHeightRef = useRef(0);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const {
    attachments,
    pickAttachment,
    addAttachment,
    removeAttachment,
    clearAttachments,
    dropZoneRefCallback,
    isDragOver,
  } = useChatAttachments();
  const [imageModalOpen, setImageModalOpen] = useState(false);
  const [imageModalInitialValues, setImageModalInitialValues] = useState<
    ImageGenerationFormInitialValues | undefined
  >(undefined);
  // ImageGenerationModal's form fields are plain useState, initialized
  // once from `initialValues` at mount — since the modal is always mounted
  // (only `visible` toggles), changing `initialValues` on an already-open
  // instance would never re-prefill it. Remounting via a changing `key`
  // (bumped every single time the modal is opened, by either path below)
  // is what forces a fresh useState initialization each time.
  const [imageModalKey, setImageModalKey] = useState(0);

  async function handleGenerateImages(
    params: ImageGenerationRequestParams,
    context: ImageGenerationContext
  ): Promise<void> {
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
          reload();
          return;
        case 'error':
          throw new Error(event.message);
      }
    }
    throw new Error('The image generation stream ended without a "done" event.');
  }

  const handleRegenerateImage = useCallback(
    (initialValues: ImageGenerationFormInitialValues): void => {
      setImageModalInitialValues(initialValues);
      setImageModalKey((k) => k + 1);
      setImageModalOpen(true);
    },
    []
  );

  // The sidebar's title/preview/ordering only change once a message is
  // actually persisted — refresh it right when a send finishes (success or
  // error both change nothing sidebar-relevant on error, but re-checking is
  // cheap and keeps this simple rather than special-casing which outcomes
  // matter).
  const prevSendStatusRef = useRef(sendState.status);
  useEffect(() => {
    if (prevSendStatusRef.current === 'sending' && sendState.status !== 'sending') {
      refreshConversations();
    }
    prevSendStatusRef.current = sendState.status;
  }, [sendState.status, refreshConversations]);

  const isBusy = sendState.status === 'sending';
  const hasAttachmentErrors = attachments.some((a) => a.error !== null);

  // Remembers the exact last-sent request (including its client_message_id)
  // so Retry can resend it unchanged after a failure — reusing the same
  // client_message_id lets the backend recognize a retry and skip
  // re-inserting the user's message if it was already persisted before the
  // failure occurred (see PostConversationMessageRequest.client_message_id),
  // same reasoning as chat/new.tsx's pendingRef.
  const lastRequestRef = useRef<PostConversationMessageRequest | null>(null);

  function handleAsk(): void {
    const question = query.trim();
    if (!question || isBusy || hasAttachmentErrors) return;
    setQuery('');
    isNearBottomRef.current = true;
    setShowJumpToLatest(false);
    const request: PostConversationMessageRequest = {
      query: question,
      client_message_id: generateClientMessageId(),
      attachments: toAttachmentUploads(attachments),
      use_corpus: attachments.length > 0 ? useCorpus : undefined,
    };
    lastRequestRef.current = request;
    sendMessage(request);
    clearAttachments();
    setUseCorpus(false);
  }

  function handleRetry(): void {
    if (lastRequestRef.current) sendMessage(lastRequestRef.current);
  }

  const turns = pairMessages(messages);

  const scrollToSource = useCallback(
    (messageId: string, sourceId: string) => {
      const index = turns.findIndex((t) => t.id === messageId);
      if (index === -1) return;
      listRef.current?.scrollToIndex({ index, viewPosition: 0, animated: true });
      setHighlighted({ messageId, sourceId });
      setTimeout(() => {
        setHighlighted((current) =>
          current?.messageId === messageId && current.sourceId === sourceId ? null : current
        );
      }, 1500);
    },
    [turns]
  );

  function handleScrollToIndexFailed(info: {
    index: number;
    highestMeasuredFrameIndex: number;
    averageItemLength: number;
  }): void {
    listRef.current?.scrollToOffset({
      offset: info.averageItemLength * info.index,
      animated: true,
    });
    setTimeout(() => {
      listRef.current?.scrollToIndex({ index: info.index, animated: true });
    }, 100);
  }

  function handleScroll(event: NativeSyntheticEvent<NativeScrollEvent>): void {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const distanceFromBottom = contentSize.height - contentOffset.y - layoutMeasurement.height;
    const nearBottom = distanceFromBottom < NEAR_BOTTOM_THRESHOLD_PX;
    isNearBottomRef.current = nearBottom;
    if (nearBottom) setShowJumpToLatest(false);
  }

  function handleContentSizeChange(_width: number, height: number): void {
    const grew = height > prevContentHeightRef.current;
    prevContentHeightRef.current = height;
    // The Settings screen's "Auto-scroll while streaming" preference —
    // default true, i.e. the historical behavior; when off, growth only
    // ever surfaces the "Jump to latest" chip, never a forced scroll.
    if (isNearBottomRef.current && preferences.autoScrollDuringStreaming) {
      listRef.current?.scrollToEnd({ animated: true });
    } else if (grew) {
      setShowJumpToLatest(true);
    }
  }

  function jumpToLatest(): void {
    isNearBottomRef.current = true;
    setShowJumpToLatest(false);
    listRef.current?.scrollToEnd({ animated: true });
  }

  const renderTurn = useCallback(
    ({ item: turn }: ListRenderItemInfo<RenderTurn>) => (
      <View style={styles.turnWrap} testID="chat-turn-wrap">
        <ConversationTurnCard
          userContent={turn.userContent}
          assistant={turn.assistant}
          userAttachments={turn.userAttachments.map((a) =>
            attachmentChipFromPersisted(a, { conversationId, messageId: turn.id })
          )}
          highlightedSourceId={highlighted?.messageId === turn.id ? highlighted.sourceId : null}
          onCitationPress={(sourceId) => scrollToSource(turn.id, sourceId)}
          conversationId={conversationId}
          onUseImageAsAttachment={addAttachment}
          onRegenerateImage={handleRegenerateImage}
        />
      </View>
    ),
    [conversationId, highlighted, scrollToSource, addAttachment, handleRegenerateImage, styles]
  );

  if (!hydrated || loadState.status === 'loading') {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={theme.accent} />
      </View>
    );
  }

  if (loadState.status === 'error') {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorText}>
          {describeApiError('GET', baseUrl, `/conversations/${conversationId}`, loadState.error)}
        </Text>
      </View>
    );
  }

  const composerBody = (
    <View>
      <ChatComposer
        value={query}
        onChangeText={setQuery}
        placeholder={conversation ? `Ask ${conversation.title}…` : 'Ask about the corpus…'}
        inputAccessibilityLabel="Ask a question"
        editable={!isBusy}
        canSubmit={Boolean(query.trim()) && !hasAttachmentErrors}
        onSubmit={handleAsk}
        busy={isBusy}
        onCancel={cancelSend}
        leadingActions={
          <>
            <AttachmentButton onPress={pickAttachment} disabled={isBusy} />
            {imageGeneratorEnabled && (
              <ImageGenerateButton
                onPress={() => {
                  setImageModalInitialValues(undefined);
                  setImageModalKey((k) => k + 1);
                  setImageModalOpen(true);
                }}
                disabled={isBusy}
              />
            )}
          </>
        }
      >
        <AttachmentPreviewRow attachments={attachments} onRemove={removeAttachment} />
        {attachments.length > 0 && (
          <CorpusToggle value={useCorpus} onValueChange={setUseCorpus} disabled={isBusy} />
        )}
      </ChatComposer>
      {sendState.status === 'error' && (
        <View style={styles.retryRow}>
          <Notice
            tone="danger"
            body={describeApiError(
              'POST',
              baseUrl,
              `/conversations/${conversationId}/messages`,
              sendState.error
            )}
            actionLabel="Retry"
            onAction={handleRetry}
            style={styles.retryNotice}
          />
        </View>
      )}
    </View>
  );

  // A plain host <div>, not <View> — see documents.tsx's
  // dropZoneRefCallback docs for why react-native-web's View can't be
  // used for native drag-and-drop listeners. Native platforms render
  // composerBody directly; there is no drag-and-drop concept there.
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
      testID="chat-container"
    >
      {!hasStreamingCapability() && (
        <View style={styles.topBannerOuter}>
          <View style={styles.topBannerInner}>
            <Notice
              tone="warning"
              body="Incremental streaming isn't available in this runtime — answers arrive all at once instead."
            />
          </View>
        </View>
      )}

      {isResumingGeneration && resumingMessageId && (
        <View style={styles.topBannerOuter} testID="chat-recovery-banner-outer">
          <View style={styles.topBannerInner} testID="chat-recovery-banner">
            <Notice
              tone="info"
              body="Picking up a response that was still being generated…"
              actionLabel="Cancel"
              onAction={() => cancelPersistedGeneration(resumingMessageId)}
            />
          </View>
        </View>
      )}

      <View style={styles.listWrap} testID="chat-list-wrap">
        <FlatList
          ref={listRef}
          style={styles.list}
          data={turns}
          keyExtractor={(item) => item.id}
          renderItem={renderTurn}
          contentContainerStyle={styles.listContent}
          onContentSizeChange={handleContentSizeChange}
          onScroll={handleScroll}
          scrollEventThrottle={16}
          keyboardShouldPersistTaps="handled"
          onScrollToIndexFailed={handleScrollToIndexFailed}
          ListEmptyComponent={
            <View style={styles.emptyConversation}>
              <EduM8Symbol size={28} style={styles.emptyConversationMark} />
              <Text
                style={[
                  styles.emptyConversationText,
                  { color: theme.subtext, fontFamily: theme.fonts.body },
                ]}
              >
                Ask a question about the corpus.
              </Text>
            </View>
          }
          ListFooterComponent={<View style={styles.listFooterSpacer} />}
        />
        {showJumpToLatest && (
          <Pressable
            style={styles.jumpButton}
            onPress={jumpToLatest}
            accessibilityRole="button"
            accessibilityLabel="Jump to latest message"
          >
            <Text style={styles.jumpButtonText}>↓ Jump to latest</Text>
          </Pressable>
        )}
      </View>

      {composer}

      {imageGeneratorEnabled && (
        <ImageGenerationModal
          key={imageModalKey}
          visible={imageModalOpen}
          onClose={() => setImageModalOpen(false)}
          onGenerate={handleGenerateImages}
          initialValues={imageModalInitialValues}
        />
      )}
    </KeyboardAvoidingView>
  );
}

/**
 * `key={id}` forces Expo Router to remount ChatConversationScreen (and
 * every hook inside it, including useConversationMessages' local state and
 * every scroll/highlight ref) when navigating between two different
 * conversations — Expo Router otherwise reuses the same component instance
 * across a dynamic-segment param change, which would leak one
 * conversation's scroll position/highlight state into the next.
 */
export default function ChatConversationRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <ChatConversationScreen key={id} conversationId={id} />;
}

function buildStyles(theme: Theme) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: theme.background },
    composerDragOver: { backgroundColor: theme.accentSoft },
    // Same two-layer width discipline as the message column (listContent's
    // padding + turnWrap's maxWidth) and the composer (ChatComposer's own
    // outer/inner split): an edge-inset OUTER wrapper (full width, 16px
    // horizontal padding) around a width-capped, centered INNER one. A
    // banner above the conversation is still part of "the chat canvas" —
    // giving it a *different* width rule (the old version just used
    // marginHorizontal, no maxWidth) is what made it visually mismatched
    // against the narrower reading column beneath it on any viewport wider
    // than 720px+32px, reading as "the chat shrank" by contrast even
    // though the message column/composer/sidebar never actually changed
    // size. Purely a width fix — this never wraps listWrap/the composer
    // themselves, and never changes their own flex/width.
    topBannerOuter: { paddingHorizontal: 16, paddingTop: 8 },
    topBannerInner: { width: '100%', maxWidth: 720, alignSelf: 'center' },
    listWrap: { flex: 1 },
    list: { flex: 1 },
    // Deliberately NOT `alignItems: 'center'` here — see turnWrap's own
    // comment for why that combination is exactly what caused the
    // "chat shrinks while the thinking placeholder/recovery banner is
    // showing" bug: `alignItems: 'center'` stops FlatList's per-row
    // wrapper from stretching to this container's width, which leaves
    // turnWrap's own `width: '100%'` resolving against an *indeterminate*
    // (content-fitted) parent instead of a fixed one — so turnWrap's
    // rendered width silently tracked whatever was inside it (a full
    // answer vs. an empty/compact thinking placeholder) rather than
    // staying a stable reading-column width. Default `alignItems: 'stretch'`
    // makes every row (and therefore turnWrap's immediate parent) always
    // span this container's full width, giving turnWrap's own
    // `width: '100%'` a real, content-independent value to resolve against.
    listContent: { padding: 16, flexGrow: 1 },
    // The centered "research notebook" reading column: `alignSelf: 'center'`
    // does the centering directly on this element (the same technique
    // ChatComposer's own `inner` style already uses successfully — see
    // that component), rather than depending on an ancestor's
    // `alignItems: 'center'`, which is what made this element's own
    // `width: '100%'` unreliable (see listContent's comment above).
    turnWrap: { width: '100%', maxWidth: 720, alignSelf: 'center' },
    listFooterSpacer: { height: 8 },
    emptyConversation: { alignItems: 'center', gap: 8, marginTop: 32, padding: 16 },
    emptyConversationMark: { opacity: 0.5 },
    emptyConversationText: { fontSize: theme.scale(14), textAlign: 'center' },
    centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 24 },
    errorText: { color: theme.danger, marginTop: 4, fontFamily: theme.fonts.body },
    // Inverted-ink pill: theme.text on theme.background flips correctly in
    // both modes (near-black chip on light, near-white chip on dark) —
    // maximum contrast against the canvas it floats over, zero hardcoded
    // hexes.
    jumpButton: {
      position: 'absolute',
      bottom: 12,
      alignSelf: 'center',
      backgroundColor: theme.text,
      borderRadius: theme.radius.pill,
      paddingHorizontal: 14,
      paddingVertical: 8,
    },
    jumpButtonText: {
      color: theme.background,
      fontSize: 13,
      fontFamily: theme.fonts.bodySemibold,
    },
    retryRow: { alignItems: 'center', paddingHorizontal: 16, paddingBottom: 12 },
    retryNotice: { width: '100%', maxWidth: 720 },
  });
}
