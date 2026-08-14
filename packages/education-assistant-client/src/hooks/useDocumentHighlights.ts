import { useCallback, useState } from 'react';
import { useAsyncGuard } from './internal/useAsyncGuard';
import { EducationAssistantError, RequestCancelledError } from '../client/errors';
import type { EducationAssistantClient } from '../client/EducationAssistantClient';
import type { CreateHighlightRequest, DocumentHighlight } from '../types/documents';

export type DocumentHighlightsState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; highlights: DocumentHighlight[] }
  | { status: 'cancelled' }
  | { status: 'error'; error: EducationAssistantError };

export interface UseDocumentHighlightsResult {
  highlightsState: DocumentHighlightsState;
  /** Fetches (or re-fetches) a document's saved highlights, superseding any in-flight load. */
  refresh: (documentId: string) => void;
  cancel: () => void;
  /** Creates a highlight (optionally with a note), then refreshes. */
  createHighlight: (documentId: string, request: CreateHighlightRequest) => Promise<void>;
  /** Sets (or clears, with `null`) a highlight's note, then refreshes. */
  updateHighlightNote: (
    documentId: string,
    highlightId: string,
    noteText: string | null
  ) => Promise<void>;
  /** Deletes a highlight, then refreshes. */
  deleteHighlight: (documentId: string, highlightId: string) => Promise<void>;
}

function toAssistantError(error: unknown): EducationAssistantError {
  return error instanceof EducationAssistantError
    ? error
    : new EducationAssistantError(String(error));
}

/**
 * Frontend Milestone 3 (Document Reader) — GET/POST/PATCH/DELETE
 * /documents/{id}/highlights, following the exact async-guard/refresh
 * pattern useConversationDocuments/useConversationScope already
 * establish: every mutation re-fetches the authoritative server list
 * afterward rather than optimistically patching local state, so the
 * annotation panel never drifts from what's actually persisted.
 */
export function useDocumentHighlights(
  client: EducationAssistantClient
): UseDocumentHighlightsResult {
  const [highlightsState, setHighlightsState] = useState<DocumentHighlightsState>({
    status: 'idle',
  });
  const guard = useAsyncGuard();

  const refresh = useCallback(
    (documentId: string) => {
      const { signal, isCurrent } = guard.begin();
      setHighlightsState({ status: 'loading' });

      client
        .listDocumentHighlights(documentId, { signal })
        .then((response) => {
          if (!isCurrent()) return;
          setHighlightsState({ status: 'success', highlights: response.highlights });
        })
        .catch((error: unknown) => {
          if (!isCurrent()) return;
          if (error instanceof RequestCancelledError) {
            setHighlightsState({ status: 'cancelled' });
            return;
          }
          setHighlightsState({ status: 'error', error: toAssistantError(error) });
        });
    },
    [client, guard]
  );

  const createHighlight = useCallback(
    async (documentId: string, request: CreateHighlightRequest): Promise<void> => {
      await client.createDocumentHighlight(documentId, request);
      refresh(documentId);
    },
    [client, refresh]
  );

  const updateHighlightNote = useCallback(
    async (documentId: string, highlightId: string, noteText: string | null): Promise<void> => {
      await client.updateDocumentHighlight(documentId, highlightId, { noteText });
      refresh(documentId);
    },
    [client, refresh]
  );

  const deleteHighlight = useCallback(
    async (documentId: string, highlightId: string): Promise<void> => {
      await client.deleteDocumentHighlight(documentId, highlightId);
      refresh(documentId);
    },
    [client, refresh]
  );

  return {
    highlightsState,
    refresh,
    cancel: guard.cancel,
    createHighlight,
    updateHighlightNote,
    deleteHighlight,
  };
}
