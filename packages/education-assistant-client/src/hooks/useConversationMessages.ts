import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAsyncGuard } from './internal/useAsyncGuard';
import {
  BackendError,
  EducationAssistantError,
  RequestCancelledError,
  StreamingUnsupportedError,
} from '../client/errors';
import type { EducationAssistantClient } from '../client/EducationAssistantClient';
import type { ChatStage } from '../types/chat';
import type { Citation } from '../types/citations';
import {
  displaySourceFromMessageSource,
  displaySourceFromRetrievedChunk,
  type ConversationDetail,
  type ConversationMessageAttachment,
  type DisplaySource,
  type PostConversationMessageRequest,
} from '../types/conversations';

export type ConversationLoadState =
  | { status: 'loading' }
  | { status: 'success' }
  | { status: 'error'; error: EducationAssistantError };

/**
 * The assistant turn's pre-first-token lifecycle, for the UI's "thinking
 * preview" placeholder (a muted shadow of the eventual answer shown inside
 * the same message bubble while waiting on the backend):
 * - `connecting` — the request was sent but no SSE event has arrived yet;
 * - `waiting_for_first_token` — progress events have arrived, but no real
 *   output token has.
 * null once the turn is past that point — the first token, an error, a
 * cancellation, or completion all clear it, so the placeholder shows only
 * during these two states and never alongside real answer text (the first
 * token clears it in the same patch that sets `content`, so one state
 * update flips the UI, never two).
 */
export type ThinkingState = 'connecting' | 'waiting_for_first_token';

/**
 * Truthful facts about an in-flight request that the thinking placeholder
 * needs to pick safe status text — never claims an operation the request
 * doesn't actually trigger. Computed from the outgoing request by
 * thinkingContextForRequest() at send time; null for a persisted (already
 * loaded) message, which is never in a thinking state.
 */
export interface ThinkingContext {
  /** The request carries file attachments (routes it to the vision model). */
  hasAttachments: boolean;
  /**
   * Document retrieval actually runs for this request: always true for a
   * text-only message (retrieval has always run unconditionally for those —
   * see PostConversationMessageRequest.use_corpus), true for an attachment
   * message only with `use_corpus`, false for a vision-only message.
   */
  retrievalEnabled: boolean;
}

/**
 * Derives a ThinkingContext from an outgoing request — the single source of
 * truth for which placeholder status texts are truthful about that request
 * (mirrors the backend's routing: rag-backend's routes_conversations.py runs
 * retrieval unconditionally for text-only messages, and for attachment
 * messages only when use_corpus is set). Only the two fields that drive
 * routing are inspected, so callers that don't hold a complete request
 * (e.g. a screen building its pending turn before the idempotency key is
 * minted) may pass just those.
 */
export function thinkingContextForRequest(
  request: Pick<PostConversationMessageRequest, 'attachments' | 'use_corpus'>
): ThinkingContext {
  const hasAttachments = (request.attachments?.length ?? 0) > 0;
  return {
    hasAttachments,
    retrievalEnabled: !hasAttachments || request.use_corpus === true,
  };
}

/**
 * One turn as rendered by the UI — unifies a message already persisted and
 * returned by GET /conversations/{id} with one still streaming in from a
 * just-sent request, so chat/[id].tsx can render a single list without a
 * union-type branch per source. `id` for an in-flight turn is a local,
 * session-only placeholder (never a real backend message id) — turns are
 * finalized in place once their SSE stream completes, never replaced by a
 * server round-trip, so scroll position is never disturbed by a refetch.
 */
/**
 * A persisted message's generation status (see rag-backend's
 * app/core/generation_manager.py / migration 0017) — 'complete' for every
 * message that finished normally (including all history predating this
 * field) and for a purely local, not-yet-persisted turn (see DisplayMessage
 * below). 'generating' is what a refresh/reopen can observe for a turn
 * whose original browser connection dropped mid-stream (QA finding BUG-1)
 * — the backend's worker keeps running regardless, so this is a real,
 * temporary state, not a stuck one: useConversationMessages polls until it
 * resolves (see the polling effect below).
 */
export type PersistedGenerationStatus =
  | 'generating'
  | 'complete'
  | 'error'
  | 'cancelled'
  | 'interrupted';

export interface DisplayMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  sources: DisplaySource[];
  citations: Citation[];
  citationWarnings: string[];
  insufficientEvidence: boolean;
  createdAt: string | null;
  streaming: boolean;
  error: string | null;
  /**
   * The most recent ChatProgressEvent stage received for this turn, e.g.
   * 'loading_model' or 'generating'. null for a persisted (already-loaded)
   * message, and cleared back to null the moment the first token arrives
   * (there is no more-specific status once real output is flowing). Still
   * maintained for SDK consumers, but the UI's thinking placeholder no
   * longer displays these raw stages — their fixed advisory ordering makes
   * them untruthful as literal "what is happening now" text; see `thinking`
   * below for the state that drives the placeholder instead.
   */
  stage: ChatStage | null;
  /**
   * The turn's pre-first-token lifecycle state (see ThinkingState) — while
   * non-null the UI shows a muted "thinking preview" placeholder inside the
   * assistant message bubble. Set to 'connecting' the moment the optimistic
   * assistant turn is appended, advanced to 'waiting_for_first_token' by the
   * first progress event, and cleared back to null by the first token, an
   * error, a cancellation, or completion — never left non-null on any exit
   * path, so the placeholder can never run indefinitely. null for a
   * persisted (already-loaded) message.
   */
  thinking: ThinkingState | null;
  /**
   * Truthful request context for the placeholder's status-text selection
   * (see ThinkingContext) — captured at send time, since the turn's own
   * `attachments` are empty until a post-send reload (see `attachments`
   * below) and would misreport a pending vision request as text-only. null
   * for a persisted (already-loaded) message.
   */
  thinkingContext: ThinkingContext | null;
  /**
   * Empty for an in-flight (not-yet-persisted) turn even when attachments
   * were sent along with it — the real metadata (id, size, page count)
   * only exists once the backend has stored it, so sendMessage() triggers
   * a reload() right after a send that included attachments succeeds,
   * which replaces this placeholder with the persisted message carrying
   * its real attachments.
   */
  attachments: ConversationMessageAttachment[];
  /**
   * The backend's persisted generation status for this turn — see
   * PersistedGenerationStatus. Always 'complete' for a local, in-flight
   * turn (that turn's own `streaming`/`thinking`/`error` fields already
   * describe its live state in more detail); meaningful once a turn comes
   * from GET /conversations/{id}, where 'generating' means "a background
   * worker on the backend is still producing this — see
   * generatingMessageIds / cancelPersistedGeneration on the hook result."
   */
  persistedStatus: PersistedGenerationStatus;
  /** Set only when persistedStatus === 'error' — a backend-provided, user-safe message. */
  persistedErrorMessage: string | null;
}

export type SendState =
  { status: 'idle' } | { status: 'sending' } | { status: 'error'; error: EducationAssistantError };

export interface UseConversationMessagesResult {
  conversation: ConversationDetail | null;
  loadState: ConversationLoadState;
  messages: DisplayMessage[];
  sendState: SendState;
  /** Sends one message in this conversation. A no-op while already sending — wait for the current turn to finish (or cancelSend()) first. */
  sendMessage: (request: PostConversationMessageRequest) => void;
  cancelSend: () => void;
  /** Re-fetches the conversation from the backend, discarding any local-only state. */
  reload: () => void;
  /**
   * True while any *persisted* message (loaded from the backend, not a
   * local in-flight turn) has status 'generating' — a real backend
   * worker (see rag-backend's app/core/generation_manager.py) is still
   * producing it, most commonly because a previous browser session's
   * connection to it was dropped (QA finding BUG-1) and this is a
   * refresh/reopen/re-login catching up. While true, this hook silently
   * re-fetches the conversation every couple of seconds until it
   * resolves — no permanent spinner, no action needed from the caller
   * beyond rendering `persistedStatus` (see DisplayMessage).
   */
  isResumingGeneration: boolean;
  /** Explicit cancel for a persisted 'generating' message (see EducationAssistantClient.cancelMessage) — distinct from cancelSend(), which only ever aborts a local, still-connected send. */
  cancelPersistedGeneration: (messageId: string) => void;
}

let placeholderIdCounter = 0;
function nextPlaceholderId(prefix: string): string {
  placeholderIdCounter += 1;
  return `${prefix}-${placeholderIdCounter}`;
}

function toAssistantError(error: unknown): EducationAssistantError {
  return error instanceof EducationAssistantError
    ? error
    : new EducationAssistantError(String(error));
}

function toDisplayMessages(conversation: ConversationDetail): DisplayMessage[] {
  return conversation.messages.map((m) => ({
    id: m.id,
    role: m.role,
    content: m.content,
    sources: (m.sources ?? []).map(displaySourceFromMessageSource),
    citations: (m.citations ?? []) as Citation[],
    citationWarnings: m.citation_warnings ?? [],
    insufficientEvidence: m.insufficient_evidence,
    createdAt: m.created_at,
    streaming: false,
    error: null,
    stage: null,
    thinking: null,
    thinkingContext: null,
    attachments: m.attachments ?? [],
    persistedStatus: (m.status ?? 'complete') as PersistedGenerationStatus,
    persistedErrorMessage: m.error_message ?? null,
  }));
}

/**
 * A single persistent conversation's messages: loads existing history on
 * mount/conversationId change, and sends+streams new turns into it. Each
 * turn is still generated independently by the stateless backend pipeline
 * (see rag-backend's app/core/rag_service.py) — prior turns are persisted
 * for redisplay only, never fed back as prompt context.
 */
export function useConversationMessages(
  client: EducationAssistantClient,
  conversationId: string
): UseConversationMessagesResult {
  const [conversation, setConversation] = useState<ConversationDetail | null>(null);
  const [loadState, setLoadState] = useState<ConversationLoadState>({ status: 'loading' });
  const [localMessages, setLocalMessages] = useState<DisplayMessage[]>([]);
  const [sendState, setSendState] = useState<SendState>({ status: 'idle' });
  const loadGuard = useAsyncGuard();
  const sendGuard = useAsyncGuard();
  // A ref, not sendState itself, guards against a duplicate send: two
  // sendMessage() calls issued back to back (e.g. a double-click) both run
  // before React has re-rendered with the first call's 'sending' status, so
  // reading `sendState` from the closure would let both through — same
  // reasoning as useEducationDocuments' deletingIdsRef.
  const isSendingRef = useRef(false);
  // The (userMessage.id, assistantId) pair of the most recently *failed*
  // local turn, so the next sendMessage() call (e.g. a Retry button) can
  // drop it before appending its own new pair — see that call site below.
  // Filtering by `.error` truthy alone would miss the user half of the
  // pair, since a user message's `error` is always null; this tracks the
  // pair explicitly instead. Cleared at the start of every sendMessage()
  // call and only ever (re)set on a failure, so a successful send never
  // leaves a stale pair here for some later failure to incorrectly remove.
  const lastFailedTurnIdsRef = useRef<{ userId: string; assistantId: string } | null>(null);

  // Deliberately keyed on [client, conversationId] only, not on `loadGuard`
  // itself: useAsyncGuard() returns a fresh { begin, cancel } object every
  // render (its identity is not memoized), so including it here would give
  // `load` a new identity every render too — and since `load` also drives
  // the mount/conversationId-change effect below, that would re-run the
  // effect every render (infinite loop). `loadGuard.begin`/`.cancel` are
  // themselves individually useCallback-memoized (stable), so reading them
  // via closure here is safe even though the wrapping object isn't.
  const load = useCallback(() => {
    const { signal, isCurrent } = loadGuard.begin();
    setLoadState({ status: 'loading' });
    setLocalMessages([]);

    client
      .getConversation(conversationId, { signal })
      .then((detail) => {
        if (!isCurrent()) return;
        setConversation(detail);
        setLoadState({ status: 'success' });
      })
      .catch((error: unknown) => {
        if (!isCurrent()) return;
        if (error instanceof RequestCancelledError) return;
        setLoadState({ status: 'error', error: toAssistantError(error) });
      });
  }, [client, conversationId]);

  useEffect(() => {
    load();
  }, [load]);

  const sendMessage = useCallback(
    (request: PostConversationMessageRequest) => {
      if (isSendingRef.current) return;
      isSendingRef.current = true;
      const finishSend = (state: SendState) => {
        isSendingRef.current = false;
        setSendState(state);
      };
      const { signal, isCurrent } = sendGuard.begin();

      const userMessage: DisplayMessage = {
        id: nextPlaceholderId('local-user'),
        role: 'user',
        content: request.query,
        sources: [],
        citations: [],
        citationWarnings: [],
        insufficientEvidence: false,
        createdAt: null,
        streaming: false,
        error: null,
        stage: null,
        thinking: null,
        thinkingContext: null,
        attachments: [],
        persistedStatus: 'complete',
        persistedErrorMessage: null,
      };
      const assistantId = nextPlaceholderId('local-assistant');
      const assistantMessage: DisplayMessage = {
        id: assistantId,
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
        // The UI's thinking placeholder shows from this moment (before any
        // network round-trip completes) until the first token — see
        // ThinkingState. The context is captured here, not derived from the
        // message's own (still-empty) attachments, so a pending vision
        // request's status text stays truthful.
        thinking: 'connecting',
        thinkingContext: thinkingContextForRequest(request),
        attachments: [],
        persistedStatus: 'complete',
        persistedErrorMessage: null,
      };
      // Drops the previously-failed local turn (if any) before appending
      // the new attempt (milestone V4 — supports a Retry button that just
      // calls sendMessage() again with the same request): without this,
      // retrying would leave the old failed turn's user bubble + error box
      // on screen, stacked above the new attempt, rather than replacing
      // it. Persisted (server-loaded) messages are never in localMessages
      // and so are never affected.
      // Read then immediately clear the ref *before* enqueuing the updater
      // below, and close over the captured `failedTurn` value inside it —
      // not the ref itself. React does not guarantee a setState updater
      // runs synchronously, so reading `lastFailedTurnIdsRef.current`
      // inside the updater would race against this same line clearing it.
      const failedTurn = lastFailedTurnIdsRef.current;
      lastFailedTurnIdsRef.current = null;
      setLocalMessages((prev) => {
        const withoutFailedTurn = failedTurn
          ? prev.filter((m) => m.id !== failedTurn.userId && m.id !== failedTurn.assistantId)
          : prev;
        return [...withoutFailedTurn, userMessage, assistantMessage];
      });
      setSendState({ status: 'sending' });
      const hasAttachments = (request.attachments?.length ?? 0) > 0;
      // The placeholder user message above always has empty `attachments`
      // (see DisplayMessage's doc) — reloading from the backend once a
      // send that included attachments finishes is what replaces it with
      // the real, persisted attachment metadata (id, size, page count).
      const reloadIfAttachmentsWereSent = (): void => {
        if (hasAttachments && isCurrent()) load();
      };

      const patchAssistant = (patch: Partial<DisplayMessage>) => {
        setLocalMessages((prev) =>
          prev.map((m) => (m.id === assistantId ? { ...m, ...patch } : m))
        );
      };

      (async () => {
        let content = '';
        try {
          for await (const event of client.streamConversationMessage(conversationId, request, {
            signal,
          })) {
            if (!isCurrent()) return;
            switch (event.type) {
              case 'progress':
                // The stream is established, so the turn has moved past
                // 'connecting' — every exit path below that ends the wait
                // clears `thinking` back to null (never left dangling).
                patchAssistant({ stage: event.stage, thinking: 'waiting_for_first_token' });
                break;
              case 'token':
                content += event.content;
                // `thinking` clears in this same patch as `content` lands:
                // one state update swaps the placeholder for the real text,
                // so the two can never render at once (or in two bubbles).
                patchAssistant({ content, stage: null, thinking: null });
                break;
              case 'sources':
                patchAssistant({ sources: event.sources.map(displaySourceFromRetrievedChunk) });
                break;
              case 'done':
                patchAssistant({
                  citations: event.citations,
                  citationWarnings: event.citation_warnings,
                  insufficientEvidence: event.insufficient_evidence,
                  streaming: false,
                  thinking: null,
                });
                finishSend({ status: 'idle' });
                reloadIfAttachmentsWereSent();
                return;
              case 'error':
                patchAssistant({ streaming: false, error: event.message, thinking: null });
                lastFailedTurnIdsRef.current = { userId: userMessage.id, assistantId };
                finishSend({ status: 'error', error: new BackendError(event.message) });
                return;
            }
          }
          if (isCurrent()) {
            const message = 'The message stream ended without a "done" event.';
            patchAssistant({ streaming: false, error: message, thinking: null });
            lastFailedTurnIdsRef.current = { userId: userMessage.id, assistantId };
            finishSend({ status: 'error', error: new BackendError(message) });
          }
        } catch (error) {
          if (!isCurrent()) return;
          if (error instanceof StreamingUnsupportedError) {
            try {
              const result = await client.postConversationMessage(conversationId, request, {
                signal,
              });
              if (!isCurrent()) return;
              patchAssistant({
                content: result.answer,
                sources: result.sources.map(displaySourceFromRetrievedChunk),
                citations: result.citations,
                citationWarnings: result.citationWarnings,
                insufficientEvidence: result.insufficientEvidence,
                streaming: false,
                thinking: null,
              });
              finishSend({ status: 'idle' });
              reloadIfAttachmentsWereSent();
            } catch (bufferedError) {
              if (!isCurrent()) return;
              const assistantError = toAssistantError(bufferedError);
              patchAssistant({ streaming: false, error: assistantError.message, thinking: null });
              lastFailedTurnIdsRef.current = { userId: userMessage.id, assistantId };
              finishSend({ status: 'error', error: assistantError });
            }
            return;
          }
          if (error instanceof RequestCancelledError) {
            patchAssistant({ streaming: false, thinking: null });
            finishSend({ status: 'idle' });
            return;
          }
          const assistantError = toAssistantError(error);
          patchAssistant({ streaming: false, error: assistantError.message, thinking: null });
          lastFailedTurnIdsRef.current = { userId: userMessage.id, assistantId };
          finishSend({ status: 'error', error: assistantError });
        }
      })();
    },
    [client, conversationId, sendGuard, load]
  );

  const cancelSend = useCallback(() => {
    sendGuard.cancel();
    isSendingRef.current = false;
    setSendState({ status: 'idle' });
  }, [sendGuard]);

  const messages = useMemo<DisplayMessage[]>(
    () => [...(conversation ? toDisplayMessages(conversation) : []), ...localMessages],
    [conversation, localMessages]
  );

  const isResumingGeneration = useMemo(
    () => messages.some((m) => m.persistedStatus === 'generating'),
    [messages]
  );

  // Silent recovery poll (QA finding BUG-1): re-fetches the conversation
  // every couple of seconds for as long as any persisted message is still
  // 'generating', so a refresh/reopen/re-login that lands mid-generation
  // eventually shows the finished answer without the caller doing
  // anything — never touches `loadState`/`localMessages`, unlike load(),
  // so it can never flash the screen back to a loading state or drop an
  // in-flight local send.
  useEffect(() => {
    if (!isResumingGeneration) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      if (cancelled) return;
      client
        .getConversation(conversationId)
        .then((detail) => {
          if (!cancelled) setConversation(detail);
        })
        .catch(() => {
          // Transient network hiccup while polling — the next tick (this
          // effect re-runs whenever `isResumingGeneration` is still true
          // after the state update above) tries again; never surfaces a
          // poll failure as a user-facing error.
        });
    }, 2000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [client, conversationId, isResumingGeneration, messages]);

  const cancelPersistedGeneration = useCallback(
    (messageId: string) => {
      client.cancelMessage(conversationId, messageId).catch(() => {
        // Best-effort — see EducationAssistantClient.cancelMessage's own
        // docstring: a failure here just means the next poll still shows
        // 'generating' until the worker finishes or is retried, not a
        // silent data-loss risk.
      });
    },
    [client, conversationId]
  );

  return {
    conversation,
    loadState,
    messages,
    sendState,
    sendMessage,
    cancelSend,
    reload: load,
    isResumingGeneration,
    cancelPersistedGeneration,
  };
}
