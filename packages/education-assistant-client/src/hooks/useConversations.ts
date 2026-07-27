import { useCallback, useEffect, useRef, useState } from 'react';
import { useAsyncGuard } from './internal/useAsyncGuard';
import { EducationAssistantError, RequestCancelledError } from '../client/errors';
import type { EducationAssistantClient } from '../client/EducationAssistantClient';
import type { ConversationSummary, ListConversationsParams } from '../types/conversations';

export type ConversationsListState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; conversations: ConversationSummary[]; total: number }
  | { status: 'cancelled' }
  | { status: 'error'; error: EducationAssistantError };

export type DeleteConversationState =
  | { status: 'deleting' }
  | { status: 'success' }
  | { status: 'error'; error: EducationAssistantError };

export interface UseConversationsResult {
  listState: ConversationsListState;
  /** Fetches (or re-fetches) the conversation list, superseding any in-flight list request. */
  refresh: (params?: ListConversationsParams) => void;
  cancelList: () => void;

  /**
   * Creates a new, empty conversation and returns it directly (not routed
   * through listState) — the caller typically navigates to it immediately
   * (e.g. `/chat/{id}`) and doesn't need an intermediate loading state for
   * that. Does not automatically refresh() the list.
   */
  createConversation: () => Promise<{ id: string }>;

  /**
   * Renames a conversation and returns the updated summary directly, for
   * the same reason as createConversation(). Optimistically patches the
   * title in the current listState (if present) so the sidebar reflects it
   * immediately without a refresh() round-trip.
   */
  renameConversation: (conversationId: string, title: string) => Promise<ConversationSummary>;

  /**
   * Per-conversation delete state, keyed by conversation id — mirrors
   * useEducationDocuments' deleteStates. A conversation with no entry has
   * never had a delete attempted.
   */
  deleteStates: Record<string, DeleteConversationState>;
  /** Deletes one conversation. A second call while one is already 'deleting' is ignored. On success, removes it from the current listState immediately. */
  deleteConversation: (conversationId: string) => void;
  resetDeleteState: (conversationId: string) => void;
}

function toAssistantError(error: unknown): EducationAssistantError {
  return error instanceof EducationAssistantError
    ? error
    : new EducationAssistantError(String(error));
}

/** GET/POST/PATCH/DELETE /conversations — the sidebar's data source. */
export function useConversations(client: EducationAssistantClient): UseConversationsResult {
  const [listState, setListState] = useState<ConversationsListState>({ status: 'idle' });
  const [deleteStates, setDeleteStates] = useState<Record<string, DeleteConversationState>>({});
  const listGuard = useAsyncGuard();

  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Same reasoning as useEducationDocuments' deletingIdsRef: a ref (not the
  // deleteStates value) is what guards against a duplicate request from two
  // back-to-back calls issued before the first re-render lands.
  const deletingIdsRef = useRef<Set<string>>(new Set());

  const refresh = useCallback(
    (params: ListConversationsParams = {}) => {
      const { signal, isCurrent } = listGuard.begin();
      setListState({ status: 'loading' });

      client
        .listConversations(params, { signal })
        .then((response) => {
          if (!isCurrent()) return;
          setListState({
            status: 'success',
            conversations: response.conversations,
            total: response.total,
          });
        })
        .catch((error: unknown) => {
          if (!isCurrent()) return;
          if (error instanceof RequestCancelledError) {
            setListState({ status: 'cancelled' });
            return;
          }
          setListState({ status: 'error', error: toAssistantError(error) });
        });
    },
    [client, listGuard]
  );

  const createConversation = useCallback(async (): Promise<{ id: string }> => {
    const conversation = await client.createConversation();
    return { id: conversation.id };
  }, [client]);

  const renameConversation = useCallback(
    async (conversationId: string, title: string): Promise<ConversationSummary> => {
      const updated = await client.renameConversation(conversationId, title);
      if (isMountedRef.current) {
        setListState((prev) =>
          prev.status === 'success'
            ? {
                status: 'success',
                conversations: prev.conversations.map((c) =>
                  c.id === conversationId ? updated : c
                ),
                total: prev.total,
              }
            : prev
        );
      }
      return updated;
    },
    [client]
  );

  const deleteConversation = useCallback(
    (conversationId: string) => {
      if (deletingIdsRef.current.has(conversationId)) return;
      deletingIdsRef.current.add(conversationId);

      setDeleteStates((prev) => ({ ...prev, [conversationId]: { status: 'deleting' } }));

      client
        .deleteConversation(conversationId)
        .then(() => {
          deletingIdsRef.current.delete(conversationId);
          if (!isMountedRef.current) return;
          setDeleteStates((prev) => ({ ...prev, [conversationId]: { status: 'success' } }));
          setListState((prev) =>
            prev.status === 'success'
              ? {
                  status: 'success',
                  conversations: prev.conversations.filter((c) => c.id !== conversationId),
                  total: Math.max(0, prev.total - 1),
                }
              : prev
          );
        })
        .catch((error: unknown) => {
          deletingIdsRef.current.delete(conversationId);
          if (!isMountedRef.current) return;
          setDeleteStates((prev) => ({
            ...prev,
            [conversationId]: { status: 'error', error: toAssistantError(error) },
          }));
        });
    },
    [client]
  );

  const resetDeleteState = useCallback((conversationId: string) => {
    setDeleteStates((prev) => {
      if (!(conversationId in prev)) return prev;
      const next = { ...prev };
      delete next[conversationId];
      return next;
    });
  }, []);

  return {
    listState,
    refresh,
    cancelList: listGuard.cancel,
    createConversation,
    renameConversation,
    deleteStates,
    deleteConversation,
    resetDeleteState,
  };
}
