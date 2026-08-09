import { useCallback, useState } from 'react';
import { useAsyncGuard } from './internal/useAsyncGuard';
import { EducationAssistantError, RequestCancelledError } from '../client/errors';
import type { EducationAssistantClient } from '../client/EducationAssistantClient';
import type { ConversationDocumentListResponse } from '../types/conversations';

export type ConversationDocumentsState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; documents: ConversationDocumentListResponse['documents']; total: number }
  | { status: 'cancelled' }
  | { status: 'error'; error: EducationAssistantError };

export interface UseConversationDocumentsResult {
  documentsState: ConversationDocumentsState;
  /** Fetches (or re-fetches) the conversation's current chat-scope selection, superseding any in-flight load. */
  refresh: (conversationId: string) => void;
  cancel: () => void;

  /** Adds one or more documents to the selection (additive — see EducationAssistantClient.addConversationDocuments), then refreshes. */
  addDocuments: (conversationId: string, documentIds: string[]) => Promise<void>;
  /** Makes `documentIds` the ENTIRE selection (documents not listed are removed), then refreshes. */
  replaceDocuments: (conversationId: string, documentIds: string[]) => Promise<void>;
  /** Removes one document from the selection, then refreshes. */
  removeDocument: (conversationId: string, documentId: string) => Promise<void>;
  /** Clears the entire selection (replaceDocuments with an empty list), then refreshes. */
  clearDocuments: (conversationId: string) => Promise<void>;
}

function toAssistantError(error: unknown): EducationAssistantError {
  return error instanceof EducationAssistantError
    ? error
    : new EducationAssistantError(String(error));
}

/**
 * Milestone 2 (conversation document scope) — GET/POST/PUT/DELETE
 * /conversations/{id}/documents, following the exact async-guard/refresh
 * pattern useFolderLibrary/useEducationDocuments already establish.
 *
 * Deliberately minimal and NOT wired into any screen yet (see the
 * Milestone 2 report §12: "minimal frontend support only" — the final
 * "Add Sources" picker UX is Milestone 3's job). This hook exists so the
 * architecture can be exercised end-to-end (and unit-tested) ahead of that
 * UI work, exactly the way useFolderLibrary existed before documents.tsx
 * consumed it.
 */
export function useConversationDocuments(
  client: EducationAssistantClient
): UseConversationDocumentsResult {
  const [documentsState, setDocumentsState] = useState<ConversationDocumentsState>({
    status: 'idle',
  });
  const guard = useAsyncGuard();

  const refresh = useCallback(
    (conversationId: string) => {
      const { signal, isCurrent } = guard.begin();
      setDocumentsState({ status: 'loading' });

      client
        .listConversationDocuments(conversationId, { signal })
        .then((response) => {
          if (!isCurrent()) return;
          setDocumentsState({
            status: 'success',
            documents: response.documents,
            total: response.total,
          });
        })
        .catch((error: unknown) => {
          if (!isCurrent()) return;
          if (error instanceof RequestCancelledError) {
            setDocumentsState({ status: 'cancelled' });
            return;
          }
          setDocumentsState({ status: 'error', error: toAssistantError(error) });
        });
    },
    [client, guard]
  );

  const addDocuments = useCallback(
    async (conversationId: string, documentIds: string[]): Promise<void> => {
      await client.addConversationDocuments(conversationId, documentIds);
      refresh(conversationId);
    },
    [client, refresh]
  );

  const replaceDocuments = useCallback(
    async (conversationId: string, documentIds: string[]): Promise<void> => {
      await client.replaceConversationDocuments(conversationId, documentIds);
      refresh(conversationId);
    },
    [client, refresh]
  );

  const removeDocument = useCallback(
    async (conversationId: string, documentId: string): Promise<void> => {
      await client.removeConversationDocument(conversationId, documentId);
      refresh(conversationId);
    },
    [client, refresh]
  );

  const clearDocuments = useCallback(
    async (conversationId: string): Promise<void> => {
      await client.clearConversationDocuments(conversationId);
      refresh(conversationId);
    },
    [client, refresh]
  );

  return {
    documentsState,
    refresh,
    cancel: guard.cancel,
    addDocuments,
    replaceDocuments,
    removeDocument,
    clearDocuments,
  };
}
