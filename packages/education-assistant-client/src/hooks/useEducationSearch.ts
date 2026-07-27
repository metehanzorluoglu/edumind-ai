import { useCallback, useState } from 'react';
import { useAsyncGuard } from './internal/useAsyncGuard';
import { EducationAssistantError, RequestCancelledError } from '../client/errors';
import type { EducationAssistantClient } from '../client/EducationAssistantClient';
import type { RetrievedChunk, SearchRequest } from '../types/search';

export type SearchState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; results: RetrievedChunk[] }
  | { status: 'cancelled' }
  | { status: 'error'; error: EducationAssistantError };

export interface UseEducationSearchResult {
  state: SearchState;
  /** Runs a search, superseding any in-flight search from a previous call. */
  search: (request: SearchRequest) => void;
  /** Cancels the in-flight search, if any. A no-op otherwise. */
  cancel: () => void;
  reset: () => void;
}

/**
 * POST /search only — retrieval with no generation, no citations, no
 * "insufficient evidence" concept (that's a /chat-only idea). Race-safe:
 * calling search() again, or unmounting, discards any earlier in-flight
 * result rather than letting it clobber newer state.
 */
export function useEducationSearch(client: EducationAssistantClient): UseEducationSearchResult {
  const [state, setState] = useState<SearchState>({ status: 'idle' });
  const { begin, cancel } = useAsyncGuard();

  const search = useCallback(
    (request: SearchRequest) => {
      const { signal, isCurrent } = begin();
      setState({ status: 'loading' });

      client
        .search(request, { signal })
        .then((response) => {
          if (!isCurrent()) return;
          setState({ status: 'success', results: response.results });
        })
        .catch((error: unknown) => {
          if (!isCurrent()) return;
          if (error instanceof RequestCancelledError) {
            setState({ status: 'cancelled' });
            return;
          }
          setState({
            status: 'error',
            error:
              error instanceof EducationAssistantError
                ? error
                : new EducationAssistantError(String(error)),
          });
        });
    },
    [client, begin]
  );

  const reset = useCallback(() => {
    cancel();
    setState({ status: 'idle' });
  }, [cancel]);

  return { state, search, cancel, reset };
}
