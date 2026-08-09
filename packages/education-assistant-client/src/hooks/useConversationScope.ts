import { useCallback, useState } from 'react';
import { useAsyncGuard } from './internal/useAsyncGuard';
import { EducationAssistantError, RequestCancelledError } from '../client/errors';
import type { EducationAssistantClient } from '../client/EducationAssistantClient';
import type { ConversationScope, UpdateConversationScopeRequest } from '../types/conversations';

export type ConversationScopeState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; scope: ConversationScope }
  | { status: 'cancelled' }
  | { status: 'error'; error: EducationAssistantError };

export interface UseConversationScopeResult {
  scopeState: ConversationScopeState;
  /** Fetches (or re-fetches) the conversation's current scope settings, superseding any in-flight load. */
  refresh: (conversationId: string) => void;
  cancel: () => void;
  /** Partial update (see EducationAssistantClient.updateConversationScope), then refreshes. */
  update: (conversationId: string, request: UpdateConversationScopeRequest) => Promise<void>;
}

function toAssistantError(error: unknown): EducationAssistantError {
  return error instanceof EducationAssistantError
    ? error
    : new EducationAssistantError(String(error));
}

/**
 * Milestone 4 (Zoom-In / strict selected-source mode) — GET/PATCH
 * /conversations/{id}/scope, following the exact async-guard/refresh
 * pattern useConversationDocuments already establishes. Exposes the
 * conversation's `zoomInMode` (and the pre-existing chat/project/general
 * toggle-bar fields) so a screen can restore both the selected sources
 * (useConversationDocuments) AND the mode together — see
 * ChatSourcesPicker's `initialMode` prop, which this hook feeds in
 * app/(tabs)/chat/[id].tsx.
 */
export function useConversationScope(
  client: EducationAssistantClient
): UseConversationScopeResult {
  const [scopeState, setScopeState] = useState<ConversationScopeState>({ status: 'idle' });
  const guard = useAsyncGuard();

  const refresh = useCallback(
    (conversationId: string) => {
      const { signal, isCurrent } = guard.begin();
      setScopeState({ status: 'loading' });

      client
        .getConversationScope(conversationId, { signal })
        .then((scope) => {
          if (!isCurrent()) return;
          setScopeState({ status: 'success', scope });
        })
        .catch((error: unknown) => {
          if (!isCurrent()) return;
          if (error instanceof RequestCancelledError) {
            setScopeState({ status: 'cancelled' });
            return;
          }
          setScopeState({ status: 'error', error: toAssistantError(error) });
        });
    },
    [client, guard]
  );

  const update = useCallback(
    async (conversationId: string, request: UpdateConversationScopeRequest): Promise<void> => {
      await client.updateConversationScope(conversationId, request);
      refresh(conversationId);
    },
    [client, refresh]
  );

  return { scopeState, refresh, cancel: guard.cancel, update };
}
