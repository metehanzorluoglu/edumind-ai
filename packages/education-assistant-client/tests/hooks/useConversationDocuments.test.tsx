import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useConversationDocuments } from '../../src/hooks/useConversationDocuments';
import type { EducationAssistantClient } from '../../src/client/EducationAssistantClient';
import type { ConversationDocument } from '../../src/types/conversations';

function makeDocument(overrides: Partial<ConversationDocument> = {}): ConversationDocument {
  return {
    document_id: 'd1',
    source_filename: 'notes.pdf',
    document_type: 'report',
    added_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('useConversationDocuments', () => {
  it('refresh() transitions idle -> loading -> success with the returned documents', async () => {
    const listConversationDocuments = vi
      .fn()
      .mockResolvedValue({ documents: [makeDocument()], total: 1 });
    const client = { listConversationDocuments } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useConversationDocuments(client));

    expect(result.current.documentsState.status).toBe('idle');

    act(() => {
      result.current.refresh('c1');
    });
    expect(result.current.documentsState.status).toBe('loading');

    await waitFor(() => expect(result.current.documentsState.status).toBe('success'));
    const state = result.current.documentsState;
    if (state.status !== 'success') throw new Error('expected success');
    expect(state.documents).toHaveLength(1);
    expect(state.total).toBe(1);
    expect(listConversationDocuments).toHaveBeenCalledWith('c1', expect.anything());
  });

  it('a failed load produces an error state', async () => {
    const listConversationDocuments = vi.fn().mockRejectedValue(new Error('network down'));
    const client = { listConversationDocuments } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useConversationDocuments(client));

    act(() => {
      result.current.refresh('c1');
    });
    await waitFor(() => expect(result.current.documentsState.status).toBe('error'));
  });

  it('addDocuments() calls addConversationDocuments and refreshes', async () => {
    const listConversationDocuments = vi
      .fn()
      .mockResolvedValue({ documents: [makeDocument()], total: 1 });
    const addConversationDocuments = vi
      .fn()
      .mockResolvedValue({ documents: [makeDocument()], total: 1 });
    const client = {
      listConversationDocuments,
      addConversationDocuments,
    } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useConversationDocuments(client));

    await act(async () => {
      await result.current.addDocuments('c1', ['d1', 'd2']);
    });

    expect(addConversationDocuments).toHaveBeenCalledWith('c1', ['d1', 'd2']);
    expect(listConversationDocuments).toHaveBeenCalledWith('c1', expect.anything());
    await waitFor(() => expect(result.current.documentsState.status).toBe('success'));
  });

  it('replaceDocuments() calls replaceConversationDocuments and refreshes', async () => {
    const listConversationDocuments = vi.fn().mockResolvedValue({ documents: [], total: 0 });
    const replaceConversationDocuments = vi.fn().mockResolvedValue({ documents: [], total: 0 });
    const client = {
      listConversationDocuments,
      replaceConversationDocuments,
    } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useConversationDocuments(client));

    await act(async () => {
      await result.current.replaceDocuments('c1', ['d3']);
    });

    expect(replaceConversationDocuments).toHaveBeenCalledWith('c1', ['d3']);
    expect(listConversationDocuments).toHaveBeenCalledTimes(1);
  });

  it('removeDocument() calls removeConversationDocument and refreshes', async () => {
    const listConversationDocuments = vi.fn().mockResolvedValue({ documents: [], total: 0 });
    const removeConversationDocument = vi.fn().mockResolvedValue(undefined);
    const client = {
      listConversationDocuments,
      removeConversationDocument,
    } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useConversationDocuments(client));

    await act(async () => {
      await result.current.removeDocument('c1', 'd1');
    });

    expect(removeConversationDocument).toHaveBeenCalledWith('c1', 'd1');
    expect(listConversationDocuments).toHaveBeenCalledTimes(1);
  });

  it('clearDocuments() calls clearConversationDocuments and refreshes', async () => {
    const listConversationDocuments = vi.fn().mockResolvedValue({ documents: [], total: 0 });
    const clearConversationDocuments = vi.fn().mockResolvedValue({ documents: [], total: 0 });
    const client = {
      listConversationDocuments,
      clearConversationDocuments,
    } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useConversationDocuments(client));

    await act(async () => {
      await result.current.clearDocuments('c1');
    });

    expect(clearConversationDocuments).toHaveBeenCalledWith('c1');
    expect(listConversationDocuments).toHaveBeenCalledTimes(1);
  });

  it('a mutation failure propagates without refreshing', async () => {
    const listConversationDocuments = vi.fn().mockResolvedValue({ documents: [], total: 0 });
    const addConversationDocuments = vi.fn().mockRejectedValue(new Error('not found'));
    const client = {
      listConversationDocuments,
      addConversationDocuments,
    } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useConversationDocuments(client));

    await expect(
      act(() => result.current.addDocuments('c1', ['missing']))
    ).rejects.toThrow('not found');
    expect(listConversationDocuments).not.toHaveBeenCalled();
  });
});
