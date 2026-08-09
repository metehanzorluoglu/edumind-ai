import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useConversationScope } from '../../src/hooks/useConversationScope';
import type { EducationAssistantClient } from '../../src/client/EducationAssistantClient';
import type { ConversationScope } from '../../src/types/conversations';

function makeScope(overrides: Partial<ConversationScope> = {}): ConversationScope {
  return {
    chat_enabled: true,
    project_enabled: true,
    general_enabled: true,
    include_other_project_summaries: false,
    zoom_in_mode: false,
    ...overrides,
  };
}

describe('useConversationScope', () => {
  it('refresh() transitions idle -> loading -> success with the returned scope', async () => {
    const getConversationScope = vi.fn().mockResolvedValue(makeScope({ zoom_in_mode: true }));
    const client = { getConversationScope } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useConversationScope(client));

    expect(result.current.scopeState.status).toBe('idle');

    act(() => {
      result.current.refresh('c1');
    });
    expect(result.current.scopeState.status).toBe('loading');

    await waitFor(() => expect(result.current.scopeState.status).toBe('success'));
    const state = result.current.scopeState;
    if (state.status !== 'success') throw new Error('expected success');
    expect(state.scope.zoom_in_mode).toBe(true);
    expect(getConversationScope).toHaveBeenCalledWith('c1', expect.anything());
  });

  it('a failed load produces an error state', async () => {
    const getConversationScope = vi.fn().mockRejectedValue(new Error('network down'));
    const client = { getConversationScope } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useConversationScope(client));

    act(() => {
      result.current.refresh('c1');
    });
    await waitFor(() => expect(result.current.scopeState.status).toBe('error'));
  });

  it('update() calls updateConversationScope and refreshes', async () => {
    const getConversationScope = vi.fn().mockResolvedValue(makeScope({ zoom_in_mode: true }));
    const updateConversationScope = vi.fn().mockResolvedValue(makeScope({ zoom_in_mode: true }));
    const client = {
      getConversationScope,
      updateConversationScope,
    } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useConversationScope(client));

    await act(async () => {
      await result.current.update('c1', { zoomInMode: true });
    });

    expect(updateConversationScope).toHaveBeenCalledWith('c1', { zoomInMode: true });
    await waitFor(() => expect(result.current.scopeState.status).toBe('success'));
    const state = result.current.scopeState;
    if (state.status !== 'success') throw new Error('expected success');
    expect(state.scope.zoom_in_mode).toBe(true);
  });

  it('a failed update rejects and does not silently clear the current state', async () => {
    const updateConversationScope = vi.fn().mockRejectedValue(new Error('server error'));
    const client = { updateConversationScope } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useConversationScope(client));

    await expect(
      act(async () => {
        await result.current.update('c1', { zoomInMode: true });
      })
    ).rejects.toThrow('server error');
  });
});
