import { useCallback, useState } from 'react';
import { useAsyncGuard } from './internal/useAsyncGuard';
import {
  BackendError,
  EducationAssistantError,
  RequestCancelledError,
  StreamingUnsupportedError,
} from '../client/errors';
import { hasStreamingCapability } from '../client/stream';
import type { EducationAssistantClient } from '../client/EducationAssistantClient';
import type { ChatRequest, ChatResult } from '../types/chat';
import type { RetrievedChunk } from '../types/search';

/**
 * Every distinct state a chat turn can be in, kept separate rather than
 * collapsed into a single "error" bucket — a network failure, a backend
 * error event, an unsupported runtime, and "the backend had no evidence to
 * answer from" all mean different things and warrant different UI. This
 * hook implements a single, independent turn: it holds no memory of prior
 * calls (the backend's /chat is single-turn — see README "Conversation
 * model"), and calling ask() again starts a fresh, unrelated request.
 */
export type ChatState =
  | { status: 'idle' }
  | { status: 'connecting' }
  | { status: 'streaming'; partialAnswer: string; sources: RetrievedChunk[] }
  /**
   * The backend found zero usable sources and never called the LLM — this
   * is a mechanical fact about retrieval, not a semantic judgment that
   * "nothing relevant exists" beyond what the backend itself determined.
   * `answer` is still real backend-authored text here (a fixed explanatory
   * message, sent as an ordinary token event before "done" — see
   * app/core/prompt_builder.py's NO_EVIDENCE_ANSWER), not something the SDK
   * synthesizes; render it like any other answer rather than discarding it.
   * See README "insufficient_evidence semantics" before building further UI
   * copy around this state.
   */
  | {
      status: 'insufficient_evidence';
      answer: string;
      citationWarnings: string[];
      requestId: string | null;
    }
  | { status: 'done'; result: ChatResult }
  | { status: 'cancelled' }
  | { status: 'error'; error: EducationAssistantError };

export interface UseEducationAssistantResult {
  state: ChatState;
  /** True if this runtime can deliver /chat incrementally; false means every ask() silently uses the buffered fallback (see README "Streaming support"). */
  streamingSupported: boolean;
  /** Sends one single-turn chat request, superseding any request already in flight. */
  ask: (request: ChatRequest) => void;
  /** Cancels the in-flight request, if any. A no-op otherwise. */
  cancel: () => void;
  reset: () => void;
}

function terminalStateFromResult(result: ChatResult): ChatState {
  if (result.insufficientEvidence) {
    return {
      status: 'insufficient_evidence',
      answer: result.answer,
      citationWarnings: result.citationWarnings,
      requestId: result.requestId,
    };
  }
  return { status: 'done', result };
}

function toAssistantError(error: unknown): EducationAssistantError {
  return error instanceof EducationAssistantError
    ? error
    : new EducationAssistantError(String(error));
}

async function runBufferedChat(
  client: EducationAssistantClient,
  request: ChatRequest,
  signal: AbortSignal,
  isCurrent: () => boolean,
  startedAt: number,
  setState: (state: ChatState) => void
): Promise<void> {
  try {
    const result = await client.chat(request, { signal });
    if (!isCurrent()) return;
    setState(terminalStateFromResult({ ...result, clientElapsedMs: Date.now() - startedAt }));
  } catch (error) {
    if (!isCurrent()) return;
    if (error instanceof RequestCancelledError) {
      setState({ status: 'cancelled' });
      return;
    }
    setState({ status: 'error', error: toAssistantError(error) });
  }
}

export function useEducationAssistant(
  client: EducationAssistantClient
): UseEducationAssistantResult {
  const [state, setState] = useState<ChatState>({ status: 'idle' });
  const { begin, cancel } = useAsyncGuard();

  const ask = useCallback(
    (request: ChatRequest) => {
      const { signal, isCurrent } = begin();
      setState({ status: 'connecting' });
      const startedAt = Date.now();

      (async () => {
        let partialAnswer = '';
        let sources: RetrievedChunk[] = [];

        try {
          for await (const event of client.streamChat(request, { signal })) {
            if (!isCurrent()) return;
            switch (event.type) {
              case 'token':
                partialAnswer += event.content;
                setState({ status: 'streaming', partialAnswer, sources });
                break;
              case 'sources':
                sources = event.sources;
                setState({ status: 'streaming', partialAnswer, sources });
                break;
              case 'done': {
                const result: ChatResult = {
                  answer: partialAnswer,
                  sources,
                  citations: event.citations,
                  citationWarnings: event.citation_warnings,
                  insufficientEvidence: event.insufficient_evidence,
                  clientElapsedMs: Date.now() - startedAt,
                  requestId: null,
                };
                setState(terminalStateFromResult(result));
                return;
              }
              case 'error':
                setState({ status: 'error', error: new BackendError(event.message) });
                return;
            }
          }
          if (isCurrent()) {
            setState({
              status: 'error',
              error: new BackendError('The /chat stream ended without a "done" event.'),
            });
          }
        } catch (error) {
          if (!isCurrent()) return;
          if (error instanceof StreamingUnsupportedError) {
            await runBufferedChat(client, request, signal, isCurrent, startedAt, setState);
            return;
          }
          if (error instanceof RequestCancelledError) {
            setState({ status: 'cancelled' });
            return;
          }
          setState({ status: 'error', error: toAssistantError(error) });
        }
      })();
    },
    [client, begin]
  );

  const reset = useCallback(() => {
    cancel();
    setState({ status: 'idle' });
  }, [cancel]);

  return { state, streamingSupported: hasStreamingCapability(), ask, cancel, reset };
}
