import { useCallback, useState } from 'react';
import { useAsyncGuard } from './internal/useAsyncGuard';
import { EducationAssistantError, RequestCancelledError } from '../client/errors';
import type { EducationAssistantClient } from '../client/EducationAssistantClient';
import type { AddNotebookEntryRequest, NotebookEntry } from '../types/notebooks';

export type NotebookEntriesState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; entries: NotebookEntry[]; total: number }
  | { status: 'cancelled' }
  | { status: 'error'; error: EducationAssistantError };

export interface UseNotebookEntriesResult {
  entriesState: NotebookEntriesState;
  /** Fetches (or re-fetches) one notebook's entries, superseding any in-flight load. */
  refresh: (notebookId: string) => void;
  cancel: () => void;
  /** Adds an entry (highlight-derived or manual), then refreshes. Returns
   * the resulting entry — for a highlight-derived add this is the SAME
   * entry whether it was newly created or already existed (idempotent —
   * see NotebooksRepository.add_highlight_entry's docstring). */
  addEntry: (notebookId: string, request: AddNotebookEntryRequest) => Promise<NotebookEntry>;
  updateEntryNote: (notebookId: string, entryId: string, noteText: string | null) => Promise<void>;
  removeEntry: (notebookId: string, entryId: string) => Promise<void>;
}

function toAssistantError(error: unknown): EducationAssistantError {
  return error instanceof EducationAssistantError
    ? error
    : new EducationAssistantError(String(error));
}

/**
 * Frontend Milestone 3.1 — M3.1 Notebook spec: GET/POST/PATCH/DELETE
 * /notebooks/{id}/entries. Same refresh-after-mutation pattern as
 * useNotebooks/useDocumentHighlights.
 */
export function useNotebookEntries(client: EducationAssistantClient): UseNotebookEntriesResult {
  const [entriesState, setEntriesState] = useState<NotebookEntriesState>({ status: 'idle' });
  const guard = useAsyncGuard();

  const refresh = useCallback(
    (notebookId: string) => {
      const { signal, isCurrent } = guard.begin();
      setEntriesState({ status: 'loading' });

      client
        .listNotebookEntries(notebookId, {}, { signal })
        .then((response) => {
          if (!isCurrent()) return;
          setEntriesState({ status: 'success', entries: response.entries, total: response.total });
        })
        .catch((error: unknown) => {
          if (!isCurrent()) return;
          if (error instanceof RequestCancelledError) {
            setEntriesState({ status: 'cancelled' });
            return;
          }
          setEntriesState({ status: 'error', error: toAssistantError(error) });
        });
    },
    [client, guard]
  );

  const addEntry = useCallback(
    async (notebookId: string, request: AddNotebookEntryRequest): Promise<NotebookEntry> => {
      const entry = await client.addNotebookEntry(notebookId, request);
      refresh(notebookId);
      return entry;
    },
    [client, refresh]
  );

  const updateEntryNote = useCallback(
    async (notebookId: string, entryId: string, noteText: string | null): Promise<void> => {
      await client.updateNotebookEntry(notebookId, entryId, { noteText });
      refresh(notebookId);
    },
    [client, refresh]
  );

  const removeEntry = useCallback(
    async (notebookId: string, entryId: string): Promise<void> => {
      await client.removeNotebookEntry(notebookId, entryId);
      refresh(notebookId);
    },
    [client, refresh]
  );

  return { entriesState, refresh, cancel: guard.cancel, addEntry, updateEntryNote, removeEntry };
}
