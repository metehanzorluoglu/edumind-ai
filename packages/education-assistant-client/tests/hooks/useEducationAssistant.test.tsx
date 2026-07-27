import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useEducationAssistant } from '../../src/hooks/useEducationAssistant';
import { RequestCancelledError, StreamingUnsupportedError } from '../../src/client/errors';
import type { ChatEvent, ChatResult } from '../../src/types/chat';
import type { EducationAssistantClient } from '../../src/client/EducationAssistantClient';

/**
 * A streaming fake whose progress past the first token is gated behind an
 * explicitly-released promise, rather than a fixed timer delay: a timer
 * race against testing-library's polling interval makes the 'streaming'
 * state's window flaky (either too short to observe, or slow enough to
 * bloat the suite) — an explicit gate makes the intermediate state
 * deterministically observable instead.
 */
function makeStreamingClient(): {
  client: EducationAssistantClient;
  getSignal: () => AbortSignal | undefined;
  finishStream: () => void;
} {
  let capturedSignal: AbortSignal | undefined;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const streamChat = vi.fn((_req: unknown, options: { signal?: AbortSignal }) => {
    capturedSignal = options.signal;
    // Mirrors how the real stream.ts generator learns of cancellation: the
    // abort event rejects a pending promise the generator is awaiting,
    // rather than something the generator has to poll for.
    const aborted = new Promise<never>((_resolve, reject) => {
      options.signal?.addEventListener('abort', () =>
        reject(new RequestCancelledError('cancelled'))
      );
    });
    return (async function* (): AsyncGenerator<ChatEvent, void, void> {
      yield { type: 'token', content: 'Hel' };
      await Promise.race([gate, aborted]);
      yield { type: 'token', content: 'lo' };
      yield { type: 'done', citations: [], citation_warnings: [], insufficient_evidence: false };
    })();
  });
  const client = { streamChat, chat: vi.fn() } as unknown as EducationAssistantClient;
  return { client, getSignal: () => capturedSignal, finishStream: () => release() };
}

describe('useEducationAssistant', () => {
  it('streams tokens and reaches a done state with the assembled answer', async () => {
    const { client, finishStream } = makeStreamingClient();
    const { result } = renderHook(() => useEducationAssistant(client));

    act(() => {
      result.current.ask({ query: 'x', top_k: 1 });
    });
    expect(result.current.state.status).toBe('connecting');

    await waitFor(() => expect(result.current.state.status).toBe('streaming'));
    act(() => {
      finishStream();
    });

    await waitFor(() => expect(result.current.state.status).toBe('done'));
    const state = result.current.state;
    if (state.status !== 'done') throw new Error('expected done');
    expect(state.result.answer).toBe('Hello');
  });

  it('cancel() during streaming reaches a cancelled state and aborts the signal', async () => {
    const { client, getSignal } = makeStreamingClient();
    const { result } = renderHook(() => useEducationAssistant(client));

    act(() => {
      result.current.ask({ query: 'x', top_k: 1 });
    });
    await waitFor(() => expect(result.current.state.status).toBe('streaming'));

    act(() => {
      result.current.cancel();
    });

    await waitFor(() => expect(result.current.state.status).toBe('cancelled'));
    expect(getSignal()?.aborted).toBe(true);
  });

  it('reaches insufficient_evidence with the backend-authored explanation, not a done result', async () => {
    // Mirrors the real backend (routes_chat.py): even the insufficient_evidence
    // branch sends a token event first (NO_EVIDENCE_ANSWER) — the hook must
    // surface that text, not discard it.
    const streamChat = vi.fn(() =>
      (async function* (): AsyncGenerator<ChatEvent, void, void> {
        yield {
          type: 'token',
          content: 'The corpus does not contain enough evidence to answer this question.',
        };
        yield { type: 'sources', sources: [] };
        yield { type: 'done', citations: [], citation_warnings: [], insufficient_evidence: true };
      })()
    );
    const client = { streamChat, chat: vi.fn() } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useEducationAssistant(client));

    act(() => {
      result.current.ask({ query: 'x', top_k: 1 });
    });

    await waitFor(() => expect(result.current.state.status).toBe('insufficient_evidence'));
    const state = result.current.state;
    if (state.status !== 'insufficient_evidence') throw new Error('expected insufficient_evidence');
    expect(state.answer).toBe(
      'The corpus does not contain enough evidence to answer this question.'
    );
  });

  it('falls back to buffered chat() when streaming is unsupported, without an intermediate streaming state', async () => {
    const bufferedResult: ChatResult = {
      answer: 'Buffered answer',
      sources: [],
      citations: [],
      citationWarnings: [],
      insufficientEvidence: false,
      clientElapsedMs: 5,
      requestId: null,
    };
    const chat = vi.fn().mockResolvedValue(bufferedResult);
    const streamChat = vi.fn(() =>
      (async function* (): AsyncGenerator<ChatEvent, void, void> {
        throw new StreamingUnsupportedError('no streaming here');
      })()
    );
    const client = { streamChat, chat } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useEducationAssistant(client));

    act(() => {
      result.current.ask({ query: 'x', top_k: 1 });
    });

    await waitFor(() => expect(result.current.state.status).toBe('done'));
    expect(chat).toHaveBeenCalled();
    const state = result.current.state;
    if (state.status !== 'done') throw new Error('expected done');
    expect(state.result.answer).toBe('Buffered answer');
  });

  it('reset() returns to idle and aborts any in-flight request', async () => {
    const { client, getSignal } = makeStreamingClient();
    const { result } = renderHook(() => useEducationAssistant(client));

    act(() => {
      result.current.ask({ query: 'x', top_k: 1 });
    });
    await waitFor(() => expect(result.current.state.status).toBe('streaming'));

    act(() => {
      result.current.reset();
    });

    expect(result.current.state).toEqual({ status: 'idle' });
    expect(getSignal()?.aborted).toBe(true);
  });
});
