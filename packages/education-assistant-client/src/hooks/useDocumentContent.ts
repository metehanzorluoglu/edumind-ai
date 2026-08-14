import { useCallback, useState } from 'react';
import { useAsyncGuard } from './internal/useAsyncGuard';
import { EducationAssistantError, RequestCancelledError } from '../client/errors';
import type { EducationAssistantClient } from '../client/EducationAssistantClient';
import type { DocumentContentResponse } from '../types/documents';

export type DocumentContentState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; content: DocumentContentResponse }
  | { status: 'cancelled' }
  | { status: 'error'; error: EducationAssistantError };

export interface UseDocumentContentResult {
  contentState: DocumentContentState;
  /** Fetches (or re-fetches) a document's extracted text, superseding any in-flight load. */
  refresh: (documentId: string) => void;
  cancel: () => void;
}

function toAssistantError(error: unknown): EducationAssistantError {
  return error instanceof EducationAssistantError
    ? error
    : new EducationAssistantError(String(error));
}

/**
 * Frontend Milestone 3 (Document Reader) — GET /documents/{id}/content,
 * following the exact async-guard/refresh pattern every other data hook
 * in this SDK already establishes (useConversationScope,
 * useConversationDocuments, ...).
 */
export function useDocumentContent(client: EducationAssistantClient): UseDocumentContentResult {
  const [contentState, setContentState] = useState<DocumentContentState>({ status: 'idle' });
  const guard = useAsyncGuard();

  const refresh = useCallback(
    (documentId: string) => {
      const { signal, isCurrent } = guard.begin();
      setContentState({ status: 'loading' });

      client
        .getDocumentContent(documentId, { signal })
        .then((content) => {
          if (!isCurrent()) return;
          setContentState({ status: 'success', content });
        })
        .catch((error: unknown) => {
          if (!isCurrent()) return;
          if (error instanceof RequestCancelledError) {
            setContentState({ status: 'cancelled' });
            return;
          }
          setContentState({ status: 'error', error: toAssistantError(error) });
        });
    },
    [client, guard]
  );

  return { contentState, refresh, cancel: guard.cancel };
}
