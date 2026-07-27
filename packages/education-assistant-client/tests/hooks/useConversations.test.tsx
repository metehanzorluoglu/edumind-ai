import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useConversations } from '../../src/hooks/useConversations';
import type { EducationAssistantClient } from '../../src/client/EducationAssistantClient';
import type { ConversationSummary } from '../../src/types/conversations';

function makeSummary(overrides: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    id: 'c1',
    title: 'New conversation',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    message_count: 0,
    last_message_preview: null,
    ...overrides,
  };
}

describe('useConversations', () => {
  it('refresh() transitions loading -> success with the returned conversations', async () => {
    const listConversations = vi
      .fn()
      .mockResolvedValue({ conversations: [makeSummary()], total: 1 });
    const client = { listConversations } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useConversations(client));

    act(() => {
      result.current.refresh();
    });
    expect(result.current.listState.status).toBe('loading');

    await waitFor(() => expect(result.current.listState.status).toBe('success'));
    const state = result.current.listState;
    if (state.status !== 'success') throw new Error('expected success');
    expect(state.conversations).toHaveLength(1);
    expect(state.total).toBe(1);
  });

  it('refresh() failure produces an error state', async () => {
    const listConversations = vi.fn().mockRejectedValue(new Error('network down'));
    const client = { listConversations } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useConversations(client));

    act(() => {
      result.current.refresh();
    });

    await waitFor(() => expect(result.current.listState.status).toBe('error'));
  });

  it('createConversation() returns the new id without touching listState', async () => {
    const createConversation = vi.fn().mockResolvedValue({
      id: 'new-id',
      title: 'New conversation',
      title_is_custom: false,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      messages: [],
    });
    const client = { createConversation } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useConversations(client));

    const created = await act(() => result.current.createConversation());

    expect(created.id).toBe('new-id');
    expect(result.current.listState.status).toBe('idle');
  });

  it('renameConversation() patches the matching entry in an already-loaded list', async () => {
    const listConversations = vi
      .fn()
      .mockResolvedValue({ conversations: [makeSummary({ id: 'c1', title: 'Old' })], total: 1 });
    const renameConversation = vi.fn().mockResolvedValue(makeSummary({ id: 'c1', title: 'New' }));
    const client = { listConversations, renameConversation } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useConversations(client));

    act(() => {
      result.current.refresh();
    });
    await waitFor(() => expect(result.current.listState.status).toBe('success'));

    await act(() => result.current.renameConversation('c1', 'New'));

    const state = result.current.listState;
    if (state.status !== 'success') throw new Error('expected success');
    expect(state.conversations[0]!.title).toBe('New');
  });

  it('deleteConversation() removes the entry from listState on success and updates deleteStates', async () => {
    const listConversations = vi
      .fn()
      .mockResolvedValue({ conversations: [makeSummary({ id: 'c1' })], total: 1 });
    const deleteConversation = vi.fn().mockResolvedValue(undefined);
    const client = { listConversations, deleteConversation } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useConversations(client));

    act(() => {
      result.current.refresh();
    });
    await waitFor(() => expect(result.current.listState.status).toBe('success'));

    act(() => {
      result.current.deleteConversation('c1');
    });
    expect(result.current.deleteStates['c1']?.status).toBe('deleting');

    await waitFor(() => expect(result.current.deleteStates['c1']?.status).toBe('success'));
    const state = result.current.listState;
    if (state.status !== 'success') throw new Error('expected success');
    expect(state.conversations).toHaveLength(0);
    expect(state.total).toBe(0);
  });

  it('deleteConversation() ignores a second call while the first is still in flight', async () => {
    let resolveDelete: () => void = () => {};
    const deleteConversation = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveDelete = resolve;
        })
    );
    const client = {
      listConversations: vi.fn().mockResolvedValue({ conversations: [], total: 0 }),
      deleteConversation,
    } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useConversations(client));

    act(() => {
      result.current.deleteConversation('c1');
      result.current.deleteConversation('c1');
    });

    expect(deleteConversation).toHaveBeenCalledTimes(1);
    resolveDelete();
    await waitFor(() => expect(result.current.deleteStates['c1']?.status).toBe('success'));
  });
});
