import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useEducationSearch } from '../../src/hooks/useEducationSearch';
import { RequestCancelledError } from '../../src/client/errors';
import type { EducationAssistantClient } from '../../src/client/EducationAssistantClient';

describe('useEducationSearch', () => {
  it('does not let a slower, superseded search overwrite a newer result', async () => {
    let resolveSlow!: (value: { results: unknown[] }) => void;
    const slowPromise = new Promise<{ results: unknown[] }>((resolve) => {
      resolveSlow = resolve;
    });

    const search = vi
      .fn()
      .mockImplementationOnce(() => slowPromise)
      .mockImplementationOnce(() => Promise.resolve({ results: [{ chunk_id: 'fast' }] }));

    const client = { search } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useEducationSearch(client));

    act(() => {
      result.current.search({ query: 'first', top_k: 1 });
    });
    act(() => {
      result.current.search({ query: 'second', top_k: 1 });
    });

    await waitFor(() => expect(result.current.state.status).toBe('success'));
    expect(result.current.state).toMatchObject({
      status: 'success',
      results: [{ chunk_id: 'fast' }],
    });

    await act(async () => {
      resolveSlow({ results: [{ chunk_id: 'slow' }] });
      await Promise.resolve();
    });

    expect(result.current.state).toMatchObject({
      status: 'success',
      results: [{ chunk_id: 'fast' }],
    });
  });

  it('cancel() while a search is in flight sets status to cancelled', async () => {
    const search = vi.fn().mockImplementation(
      (_request: unknown, options: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options.signal?.addEventListener('abort', () =>
            reject(new RequestCancelledError('cancelled'))
          );
        })
    );
    const client = { search } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useEducationSearch(client));

    act(() => {
      result.current.search({ query: 'x', top_k: 1 });
    });
    await waitFor(() => expect(search).toHaveBeenCalled());

    act(() => {
      result.current.cancel();
    });

    await waitFor(() => expect(result.current.state.status).toBe('cancelled'));
  });

  it('aborts the in-flight request signal on unmount', () => {
    let capturedSignal: AbortSignal | undefined;
    const search = vi
      .fn()
      .mockImplementation((_request: unknown, options: { signal?: AbortSignal }) => {
        capturedSignal = options.signal;
        return new Promise(() => {
          // never resolves — only unmount should end this
        });
      });
    const client = { search } as unknown as EducationAssistantClient;
    const { result, unmount } = renderHook(() => useEducationSearch(client));

    act(() => {
      result.current.search({ query: 'x', top_k: 1 });
    });
    expect(capturedSignal?.aborted).toBe(false);

    unmount();
    expect(capturedSignal?.aborted).toBe(true);
  });

  it('surfaces a non-cancellation error as an error state', async () => {
    const search = vi.fn().mockRejectedValue(new Error('network down'));
    const client = { search } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useEducationSearch(client));

    act(() => {
      result.current.search({ query: 'x', top_k: 1 });
    });

    await waitFor(() => expect(result.current.state.status).toBe('error'));
  });
});
