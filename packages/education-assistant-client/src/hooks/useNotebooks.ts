import { useCallback, useState } from 'react';
import { useAsyncGuard } from './internal/useAsyncGuard';
import { EducationAssistantError, RequestCancelledError } from '../client/errors';
import type { EducationAssistantClient } from '../client/EducationAssistantClient';
import type { ListNotebooksParams, Notebook } from '../types/notebooks';

export type NotebooksState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; notebooks: Notebook[]; total: number }
  | { status: 'cancelled' }
  | { status: 'error'; error: EducationAssistantError };

export interface UseNotebooksResult {
  notebooksState: NotebooksState;
  /** Fetches (or re-fetches) the caller's notebooks, superseding any in-flight load. */
  refresh: (params?: ListNotebooksParams) => void;
  cancel: () => void;
  /** Creates a notebook, then refreshes. Returns the created Notebook so a
   * caller (e.g. the add-to-notebook picker) can immediately add an entry
   * to it without a second round trip to find its id. */
  create: (name: string) => Promise<Notebook>;
  rename: (notebookId: string, name: string) => Promise<void>;
  remove: (notebookId: string) => Promise<void>;
}

function toAssistantError(error: unknown): EducationAssistantError {
  return error instanceof EducationAssistantError
    ? error
    : new EducationAssistantError(String(error));
}

/**
 * Frontend Milestone 3.1 — M3.1 Notebook spec ("Research Notes
 * Workspace"): GET/POST/PATCH/DELETE /notebooks, following the exact
 * async-guard/refresh pattern useDocumentHighlights/useConversationDocuments
 * already establish — every mutation re-fetches the authoritative server
 * list afterward rather than optimistically patching local state.
 */
export function useNotebooks(client: EducationAssistantClient): UseNotebooksResult {
  const [notebooksState, setNotebooksState] = useState<NotebooksState>({ status: 'idle' });
  const guard = useAsyncGuard();
  const [lastParams, setLastParams] = useState<ListNotebooksParams>({});

  const refresh = useCallback(
    (params: ListNotebooksParams = lastParams) => {
      const { signal, isCurrent } = guard.begin();
      setLastParams(params);
      setNotebooksState({ status: 'loading' });

      client
        .listNotebooks(params, { signal })
        .then((response) => {
          if (!isCurrent()) return;
          setNotebooksState({
            status: 'success',
            notebooks: response.notebooks,
            total: response.total,
          });
        })
        .catch((error: unknown) => {
          if (!isCurrent()) return;
          if (error instanceof RequestCancelledError) {
            setNotebooksState({ status: 'cancelled' });
            return;
          }
          setNotebooksState({ status: 'error', error: toAssistantError(error) });
        });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [client, guard]
  );

  const create = useCallback(
    async (name: string): Promise<Notebook> => {
      const notebook = await client.createNotebook({ name });
      refresh();
      return notebook;
    },
    [client, refresh]
  );

  const rename = useCallback(
    async (notebookId: string, name: string): Promise<void> => {
      await client.renameNotebook(notebookId, { name });
      refresh();
    },
    [client, refresh]
  );

  const remove = useCallback(
    async (notebookId: string): Promise<void> => {
      await client.deleteNotebook(notebookId);
      refresh();
    },
    [client, refresh]
  );

  return { notebooksState, refresh, cancel: guard.cancel, create, rename, remove };
}
