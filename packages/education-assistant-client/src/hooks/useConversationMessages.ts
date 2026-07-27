import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAsyncGuard } from './internal/useAsyncGuard';
import {
  BackendError,
  EducationAssistantError,
  RequestCancelledError,
  StreamingUnsupportedError,
} from '../client/errors';
import type { EducationAssistantClient } from '../client/EducationAssistantClient';
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
 * One turn as rendered by the UI — unifies a message already persisted and
 * returned by GET /conversations/{id} with one still streaming in from a
 * just-sent request, so chat/[id].tsx can render a single list without a
 * union-type branch per source. `id` for an in-flight turn is a local,
 * session-only placeholder (never a real backend message id) — turns are
 * finalized in place once their SSE stream completes, never replaced by a
 * server round-trip, so scroll position is never disturbed by a refetch.
 */
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
   * Empty for an in-flight (not-yet-persisted) turn even when attachments
   * were sent along with it — the real metadata (id, size, page count)
   * only exists once the backend has stored it, so sendMessage() triggers
   * a reload() right after a send that included attachments succeeds,
   * which replaces this placeholder with the persisted message carrying
   * its real attachments.
   */
  attachments: ConversationMessageAttachment[];
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
    attachments: m.attachments ?? [],
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
        attachments: [],
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
        attachments: [],
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
              case 'token':
                content += event.content;
                patchAssistant({ content });
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
                });
                finishSend({ status: 'idle' });
                reloadIfAttachmentsWereSent();
                return;
              case 'error':
                patchAssistant({ streaming: false, error: event.message });
                lastFailedTurnIdsRef.current = { userId: userMessage.id, assistantId };
                finishSend({ status: 'error', error: new BackendError(event.message) });
                return;
            }
          }
          if (isCurrent()) {
            const message = 'The message stream ended without a "done" event.';
            patchAssistant({ streaming: false, error: message });
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
              });
              finishSend({ status: 'idle' });
              reloadIfAttachmentsWereSent();
            } catch (bufferedError) {
              if (!isCurrent()) return;
              const assistantError = toAssistantError(bufferedError);
              patchAssistant({ streaming: false, error: assistantError.message });
              lastFailedTurnIdsRef.current = { userId: userMessage.id, assistantId };
              finishSend({ status: 'error', error: assistantError });
            }
            return;
          }
          if (error instanceof RequestCancelledError) {
            patchAssistant({ streaming: false });
            finishSend({ status: 'idle' });
            return;
          }
          const assistantError = toAssistantError(error);
          patchAssistant({ streaming: false, error: assistantError.message });
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

  return {
    conversation,
    loadState,
    messages,
    sendState,
    sendMessage,
    cancelSend,
    reload: load,
  };
}
